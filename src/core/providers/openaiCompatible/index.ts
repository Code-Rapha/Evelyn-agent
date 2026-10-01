/**
 * First concrete provider: any server that speaks the OpenAI `/models` and
 * chat-completions dialect.
 *
 * Design notes:
 *
 * - `fetch` is injected. This module never reaches for the global, so tests
 *   drive it with a fake and no test touches the network.
 * - The API key is resolved from the `SecretStore` at call time using the
 *   descriptor's `apiKeyRef`. The key is optional: servers such as a local
 *   runtime expose `/models` without authentication, and then no `Authorization`
 *   header is sent at all.
 * - No error message, error `details` field or log line ever contains the key.
 *   `ProviderError` messages are built from status codes and endpoint paths only.
 *
 * This module imports neither `vscode` nor any other project module except the
 * error taxonomy and the secret port, keeping it unit-testable in isolation.
 */
import { ProviderError, ValidationError } from '../../errors';
import type { SecretStore } from '../secrets';
import type {
	ModelInfo,
	Provider,
	ProviderCapability,
	ProviderDescriptor,
	ProviderStatus,
} from '../types';

/** The subset of `fetch` this provider relies on. */
export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
	},
) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
}>;

export interface OpenAICompatibleProviderOptions {
	/** Stable provider id, e.g. `local-llm`. Also namespaces the secret ref. */
	readonly id: string;
	readonly name: string;
	/** API root, e.g. `https://api.openai.com/v1`. Required. */
	readonly baseUrl: string;
	/**
	 * Reference to the API key inside the `SecretStore`. When omitted, the
	 * provider sends no authorization header.
	 */
	readonly apiKeyRef?: string;
	readonly enabled?: boolean;
	readonly capabilities?: readonly ProviderCapability[];
	/** Injected for tests; defaults to the global `fetch`. */
	readonly fetch?: FetchLike;
	/** Required only when `apiKeyRef` is set. */
	readonly secrets?: SecretStore;
}

interface ModelsResponseShape {
	readonly data?: unknown;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Trims trailing slashes so `${baseUrl}/models` never doubles the separator. */
function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (trimmed.length === 0) {
		throw new ValidationError('baseUrl is required for an OpenAI-compatible provider');
	}
	return trimmed.replace(/\/+$/, '');
}

export class OpenAICompatibleProvider implements Provider {
	private readonly baseUrl: string;
	private readonly fetchImpl: FetchLike;
	private readonly secrets: SecretStore | undefined;
	private readonly apiKeyRef: string | undefined;
	/**
	 * The immutable half of the descriptor. `status` and `models` are supplied
	 * by the getter, so they are deliberately absent here.
	 */
	private readonly base: Omit<ProviderDescriptor, 'status' | 'models'>;

	/**
	 * Reactive status: `configured` until a call succeeds (`available`) or
	 * fails (`error`); `unconfigured` while an expected key is missing.
	 */
	private status: ProviderStatus;
	private models: readonly ModelInfo[];

	/**
	 * Built on read so callers always observe the current status and model
	 * list, and never a stale snapshot taken at construction.
	 */
	get descriptor(): ProviderDescriptor {
		return { ...this.base, status: this.status, models: this.models };
	}

	constructor(options: OpenAICompatibleProviderOptions) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl);

		const injected = options.fetch;
		this.fetchImpl = injected ?? ((input, init) => fetch(input, init));

		this.secrets = options.secrets;
		this.apiKeyRef = options.apiKeyRef;

		this.status = options.apiKeyRef === undefined ? 'configured' : 'unconfigured';
		this.models = [];

		this.base = {
			id: options.id,
			name: options.name,
			type: 'custom-openai-compatible',
			configuration: {
				baseUrl: this.baseUrl,
				...(options.apiKeyRef !== undefined ? { apiKeyRef: options.apiKeyRef } : {}),
				...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
			},
			capabilities: options.capabilities ?? ['chat'],
		};
	}

	/**
	 * `GET {baseUrl}/models`, mapped to `ModelInfo[]`.
	 *
	 * The response only carries an `id` per model, so the display name is the
	 * id: inventing a friendlier name would misreport what the server called it.
	 */
	async listModels(): Promise<readonly ModelInfo[]> {
		const endpoint = `${this.baseUrl}/models`;

		let models: ModelInfo[];
		try {
			const headers = await this.buildHeaders();
			models = await this.requestModels(endpoint, headers);
		} catch (error) {
			// Every failure mode (auth, HTTP, malformed payload, transport)
			// lands here. The error is rethrown unchanged; only the status moves.
			this.status = 'error';
			this.models = [];
			throw error;
		}

		this.models = models;
		this.status = 'available';
		return models;
	}

	/** Performs the request and maps the response, without touching status. */
	private async requestModels(
		endpoint: string,
		headers: Record<string, string>,
	): Promise<ModelInfo[]> {
		let response: Awaited<ReturnType<FetchLike>>;
		try {
			response = await this.fetchImpl(endpoint, { method: 'GET', headers });
		} catch (cause) {
			throw new ProviderError(
				`Could not reach the model endpoint at ${endpoint}`,
				{ cause, details: { providerId: this.base.id, endpoint } },
			);
		}

		if (response.status === 401 || response.status === 403) {
			throw new ProviderError(
				`Authentication failed at ${endpoint} (HTTP ${response.status}). Check the API key for this provider.`,
				{ details: { providerId: this.base.id, status: response.status } },
			);
		}

		if (!response.ok) {
			throw new ProviderError(
				`The model endpoint ${endpoint} returned HTTP ${response.status}`,
				{ details: { providerId: this.base.id, status: response.status } },
			);
		}

		return this.parseModels(await response.text(), endpoint);
	}

	/**
	 * Builds the request headers. The authorization header is added only when a
	 * key reference resolves to a non-empty value; the key itself is never
	 * copied anywhere else.
	 */
	private async buildHeaders(): Promise<Record<string, string>> {
		const headers: Record<string, string> = { accept: 'application/json' };

		const ref = this.apiKeyRef;
		if (ref === undefined) {
			return headers;
		}
		if (this.secrets === undefined) {
			throw new ProviderError(
				`Provider "${this.base.id}" declares an API key reference but no secret store was provided`,
				{ details: { providerId: this.base.id } },
			);
		}

		let key: string | undefined;
		try {
			key = await this.secrets.get(ref);
		} catch (cause) {
			throw new ProviderError(
				`Could not read the stored API key for provider "${this.base.id}"`,
				{ cause, details: { providerId: this.base.id } },
			);
		}

		if (key !== undefined && key.trim().length > 0) {
			headers.authorization = `Bearer ${key}`;
			// A key reference with a stored key moves the provider out of
			// `unconfigured` before the first call is ever attempted.
			this.status = 'configured';
		}
		return headers;
	}

	/** Parses `{ data: [{ id }] }`, rejecting anything else. */
	private parseModels(body: string, endpoint: string): ModelInfo[] {
		const providerId = this.base.id;
		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch (cause) {
			throw new ProviderError(
				`The model endpoint ${endpoint} returned a response that is not valid JSON`,
				{ cause, details: { providerId } },
			);
		}

		const data = (payload as ModelsResponseShape | null)?.data;
		if (!Array.isArray(data)) {
			throw new ProviderError(
				`The model endpoint ${endpoint} returned JSON without a "data" array`,
				{ details: { providerId } },
			);
		}

		const models: ModelInfo[] = [];
		for (const entry of data) {
			const id = (entry as { id?: unknown } | null)?.id;
			if (typeof id !== 'string' || id.length === 0) {
				throw new ProviderError(
					`The model endpoint ${endpoint} returned a model entry without a usable "id"`,
					{ details: { providerId } },
				);
			}
			models.push({ id, name: id });
		}
		return models;
	}
}

export { DEFAULT_BASE_URL };