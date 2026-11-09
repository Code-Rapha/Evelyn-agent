/**
 * Latency diagnostics for the providers the user has configured.
 *
 * The rules this module is built around, in the order they matter:
 *
 * 1. **Only configured providers are contacted.** A provider that is not in the
 *    stored configuration appears as `not-configured` and is never given an
 *    endpoint, a key, or a guess at either. The known-provider list below is a
 *    label, not a configuration: nothing is derived from it into a request.
 * 2. **Paid models are not contacted without permission.** The catalog's
 *    `access` is the same source the orchestrator reads, and the check happens
 *    *before* the request rather than after it.
 * 3. **The three timings never stand in for one another.** Headers landing is
 *    not the model answering; a proxy that answers `200` in 40ms and then
 *    thinks for twelve seconds has a 40ms header time and a 12s first token,
 *    and reporting the first as the second is the specific error this module
 *    exists to avoid.
 * 4. **An untrustworthy measurement is absent, with a reason.** Never zero: a
 *    zero would read as instant and be believed.
 * 5. **Nothing secret leaves here.** No key, no authorization header, no
 *    request or response body. The only provider text reused is a
 *    `ProviderError` message, and those are built by our own code and never
 *    interpolate a secret.
 */

import { ProviderError } from '../core/errors';
import type { ChatRequest, ChatStream } from '../core/providers/chat/types';
import type { PersistedProviderConfig } from '../core/providers/config';
import { OpenAICompatibleProvider } from '../core/providers/openaiCompatible';
import type { FetchLike } from '../core/providers/openaiCompatible';
import type { SecretStore } from '../core/providers/secrets';
import type { ModelCatalogEntry } from '../core/storage/types/modelCatalog';

/**
 * How a provider (or one model of it) came out of the check.
 *
 * Several outcomes are decided without a request: `not-configured`, `disabled`,
 * `no-credentials`, `skipped-paid` and `no-models`. Keeping them distinct is
 * the point — a provider we never asked must not be reported with the outcome
 * of one that answered badly.
 */
export type DiagnosticOutcome =
	| 'ok'
	| 'http-error'
	| 'auth-error'
	| 'timeout'
	| 'network-error'
	| 'no-credentials'
	| 'skipped-paid'
	| 'no-models'
	| 'not-configured'
	| 'disabled'
	| 'cancelled';

/** A metric the probe could not measure, and why. */
export interface UnmeasuredMetric {
	readonly metric: 'headers' | 'firstToken' | 'total';
	readonly reason: string;
}

/** One row of the report: a provider, optionally narrowed to one model. */
export interface ProviderDiagnostic {
	readonly providerId: string;
	readonly providerName: string;
	/** Absent on a provider-level row — the ones decided without a probe. */
	readonly modelId?: string;
	readonly outcome: DiagnosticOutcome;
	/**
	 * Human-readable explanation, in the language the window uses.
	 *
	 * Built here rather than copied from the provider, so no response body,
	 * header or endpoint can reach the renderer through it.
	 */
	readonly detail?: string;
	readonly httpStatus?: number;
	/** From sending the request to the HTTP response headers. */
	readonly headersMs?: number;
	/** From sending the request to the first content token. */
	readonly firstTokenMs?: number;
	/** From sending the request to the stream ending. */
	readonly totalMs?: number;
	readonly unmeasured?: readonly UnmeasuredMetric[];
}

/** What one run produced. `cancelled` is true when the caller's signal fired. */
export interface ProviderDiagnosticsReport {
	readonly results: readonly ProviderDiagnostic[];
	readonly cancelled: boolean;
}

/**
 * A provider the product knows how to talk about, so a missing one can be
 * listed as `not-configured` instead of silently absent from the table.
 *
 * Deliberately only `id` and `name`. A `baseUrl` or a `requiresKey` here would
 * be a second source of configuration, and the moment it disagrees with what
 * the user stored, one of them starts contacting the wrong endpoint.
 */
export interface KnownProvider {
	readonly id: string;
	readonly name: string;
}

/**
 * Display names only. Nothing below is ever used to build a request, a key
 * reference or an endpoint.
 */
export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
	{ id: '9router', name: '9Router' },
	{ id: 'ollama', name: 'Ollama' },
	{ id: 'nvidia', name: 'NVIDIA' },
	{ id: 'openrouter', name: 'OpenRouter' },
	{ id: 'cloudflare', name: 'Cloudflare' },
	{ id: 'apinex', name: 'Apinex' },
	{ id: 'river', name: 'River' },
	{ id: 'gemini', name: 'Gemini' },
];

/** The part of a live provider a probe needs. */
export interface DiagnosticTarget {
	listModels(): Promise<readonly { readonly id: string }[]>;
	streamChat(
		request: ChatRequest,
		options?: { readonly signal?: AbortSignal },
	): Promise<ChatStream>;
}

export interface ProviderDiagnosticsInput {
	/** The stored configuration. The only source of providers that get called. */
	readonly providers: readonly PersistedProviderConfig[];
	/**
	 * Transport for the live clients built by the default `connect`.
	 *
	 * Injected rather than reached for, so a test drives the whole path — model
	 * listing, request, stream — without a network. The default is the global
	 * `fetch`.
	 */
	readonly fetch?: FetchLike;
	/**
	 * Overrides how a live client is built.
	 *
	 * Only needed for a provider that is not OpenAI-compatible. The default
	 * builds the same client the chat session uses, from the stored config.
	 */
	readonly connect?: (config: PersistedProviderConfig) => DiagnosticTarget;
	/** Used to report `no-credentials` before asking, and to build the client. */
	readonly secrets?: SecretStore;
	/** Declared access, so a paid model can be skipped. Optional. */
	readonly catalog?: readonly ModelCatalogEntry[];
	/** Defaults to false: a paid model is skipped unless the caller says so. */
	readonly allowPaid?: boolean;
	/**
	 * Budget for one probe, and for one `/models` call.
	 *
	 * Defaults to `DEFAULT_PROBE_TIMEOUT_MS`. `0` disables the bound, which is
	 * only sensible when the caller supplies a signal.
	 */
	readonly timeoutMs?: number;
	/** The built-in provider's own `/models` budget. Defaults to its own 5s. */
	readonly modelsTimeoutMs?: number;
	/** Stops the run between probes; the probe in flight is cancelled. */
	readonly signal?: AbortSignal;
	/** Cap on models probed per provider. Defaults to 3; `0` means no cap. */
	readonly maxModelsPerProvider?: number;
	/** Restricts and orders the probed model ids. Intersected with what is listed. */
	readonly models?: readonly string[];
	/** Defaults to `KNOWN_PROVIDERS`. */
	readonly knownProviders?: readonly KnownProvider[];
	/** Injected for tests; defaults to `Date.now`. */
	readonly now?: () => number;
}

/**
 * A probe is a real request, so its budget is generous enough for a cold local
 * server and short enough that one hung provider cannot stall the whole table.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Each probe costs real tokens, so the default is a sample, not a census. */
const DEFAULT_MAX_MODELS_PER_PROVIDER = 3;

/**
 * The shortest request that can still prove the endpoint answers: one user
 * message, streaming, one token of output, no tools.
 */
const PROBE_MESSAGE = 'ping';

/**
 * Runs the diagnostic over the configured providers, sequentially.
 *
 * Sequential on purpose: these are latency measurements, and firing every
 * provider at once would measure contention on this machine rather than the
 * provider. The same reason `listAvailableModels` is sequential.
 */
export async function diagnoseProviders(
	input: ProviderDiagnosticsInput,
): Promise<ProviderDiagnosticsReport> {
	const now = input.now ?? Date.now;
	const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const known = input.knownProviders ?? KNOWN_PROVIDERS;
	const configured = new Map(input.providers.map((provider) => [provider.id, provider]));

	const results: ProviderDiagnostic[] = [];
	let cancelled = false;
	// A function rather than the inline check: the flag is expected to flip
	// during a probe, and TypeScript narrows a repeated property read to the
	// value it had the first time.
	const aborted = (): boolean => input.signal?.aborted === true;

	for (const provider of input.providers) {
		const base = { providerId: provider.id, providerName: provider.name };
		if (aborted()) {
			cancelled = true;
			// A row rather than a gap: the provider is configured and the table
			// has to say why it has no numbers, not leave it out as though it
			// were unconfigured.
			results.push({
				...base,
				outcome: 'cancelled',
				detail: 'O diagnóstico foi cancelado antes de testar este provedor.',
			});
			continue;
		}
		const rows = await diagnoseOne(provider, { ...input, now, timeoutMs });
		if (rows.length === 0) {
			// Cancelled while listing models: the probe never started, and an
			// empty result would read as "this provider does not exist".
			cancelled = true;
			results.push({
				...base,
				outcome: 'cancelled',
				detail: 'O diagnóstico foi cancelado antes de testar este provedor.',
			});
			continue;
		}
		results.push(...rows);
		if (aborted()) {
			// The probe that was in flight reports `cancelled` on its own; this
			// records the run as a whole, including when the last provider was
			// the one that was interrupted.
			cancelled = true;
		}
	}

	// Everything the product knows about but the user has not configured. One
	// row each, no request, so the table answers "where is OpenRouter?" instead
	// of leaving a gap that reads as a bug.
	for (const entry of known) {
		if (configured.has(entry.id)) {
			continue;
		}
		results.push({
			providerId: entry.id,
			providerName: entry.name,
			outcome: 'not-configured',
			detail: 'Este provedor não está configurado.',
		});
	}

	return { results, cancelled };
}

/** The input once the defaults have been resolved. */
type RunContext = Omit<ProviderDiagnosticsInput, 'now' | 'timeoutMs'> & {
	readonly now: () => number;
	readonly timeoutMs: number;
};

/**
 * Builds the live client, by default the same OpenAI-compatible one the chat
 * session uses.
 *
 * The construction lives here rather than in the caller so the service is
 * usable as-is: a caller with a `fetch` and a secret store has everything a
 * diagnostic needs, and does not have to know which provider class to build.
 */
function connect(
	config: PersistedProviderConfig,
	input: RunContext,
): DiagnosticTarget {
	if (input.connect !== undefined) {
		return input.connect(config);
	}
	return new OpenAICompatibleProvider({
		id: config.id,
		name: config.name,
		baseUrl: config.baseUrl,
		...(config.apiKeyRef !== undefined ? { apiKeyRef: config.apiKeyRef } : {}),
		// Passed through so a disabled provider refuses even if the check above
		// were ever removed, exactly as in `ChatSession`.
		enabled: config.enabled,
		...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
		...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
		...(input.modelsTimeoutMs !== undefined ? { modelsTimeoutMs: input.modelsTimeoutMs } : {}),
	});
}

/** Every provider-level decision that precedes a request, then the probes. */
async function diagnoseOne(
	config: PersistedProviderConfig,
	input: RunContext,
): Promise<readonly ProviderDiagnostic[]> {
	const base = { providerId: config.id, providerName: config.name };

	if (!config.enabled) {
		return [
			{
				...base,
				outcome: 'disabled',
				detail: 'Este provedor está desativado nas configurações.',
			},
		];
	}

	const credentials = await credentialsPresent(config, input.secrets);
	if (credentials === false) {
		return [
			{
				...base,
				outcome: 'no-credentials',
				detail: 'A chave deste provedor não está no armazenamento seguro.',
			},
		];
	}

	let target: DiagnosticTarget;
	try {
		target = connect(config, input);
	} catch (error) {
		return [{ ...base, ...classify(error) }];
	}

	const listed = await listModelsWithin(target, input.timeoutMs);
	if (listed.timedOut === true) {
		return [
			{
				...base,
				outcome: 'timeout',
				detail: `O provedor não respondeu em ${input.timeoutMs}ms.`,
				unmeasured: [
					{
						metric: 'headers',
						reason: 'A listagem de modelos não terminou dentro do limite.',
					},
				],
			},
		];
	}
	if (listed.error !== undefined) {
		return [{ ...base, ...classify(listed.error) }];
	}

	const offered = listed.models ?? [];
	const wanted = selectModels(offered, input.models, input.maxModelsPerProvider);
	if (wanted.length === 0) {
		return [
			{
				...base,
				outcome: 'no-models',
				detail:
					offered.length === 0
						? 'O provedor respondeu, mas não listou nenhum modelo.'
						: 'Nenhum dos modelos pedidos está na lista deste provedor.',
			},
		];
	}

	const rows: ProviderDiagnostic[] = [];
	for (const modelId of wanted) {
		if (input.signal?.aborted === true) {
			break;
		}
		const skipped = paidSkipReason(config.id, modelId, input.catalog, input.allowPaid === true);
		if (skipped !== undefined) {
			rows.push({ ...base, modelId, outcome: 'skipped-paid', detail: skipped });
			continue;
		}
		rows.push(
			await probeModel(target, { ...base, modelId }, {
				now: input.now,
				timeoutMs: input.timeoutMs,
				...(input.signal !== undefined ? { signal: input.signal } : {}),
			}),
		);
	}
	return rows;
}

/**
 * The orchestrator's rule, applied before the request: a model the catalog
 * declares paid is not used unless the caller allows it.
 *
 * Only an explicit `paid` skips. `unknown` is not a reason to refuse — refusing
 * would make every unclassified local model unreachable, and the point of the
 * catalog is that unknown stays unknown rather than being guessed either way.
 */
function paidSkipReason(
	providerId: string,
	modelId: string,
	catalog: readonly ModelCatalogEntry[] | undefined,
	allowPaid: boolean,
): string | undefined {
	if (allowPaid || catalog === undefined) {
		return undefined;
	}
	const entry = catalog.find(
		(candidate) => candidate.providerId === providerId && candidate.modelId === modelId,
	);
	if (entry?.access !== 'paid') {
		return undefined;
	}
	return 'Modelo pago: não é testado sem autorização explícita.';
}

/**
 * `false` only when the reference is known to be empty.
 *
 * A store that fails to answer is `undefined`, never `false`: a storage hiccup
 * reported as a missing key would tell the user to re-enter a key they already
 * have.
 */
async function credentialsPresent(
	config: PersistedProviderConfig,
	secrets: SecretStore | undefined,
): Promise<boolean | undefined> {
	if (config.apiKeyRef === undefined) {
		return true;
	}
	if (secrets === undefined) {
		return undefined;
	}
	try {
		return await secrets.has(config.apiKeyRef);
	} catch {
		return undefined;
	}
}

/** Applies the caller's filter and the per-provider cap, preserving the filter's order. */
function selectModels(
	offered: readonly string[],
	wanted: readonly string[] | undefined,
	max: number | undefined,
): readonly string[] {
	const available = new Set(offered);
	const filtered =
		wanted === undefined ? offered : wanted.filter((modelId) => available.has(modelId));
	const cap = max ?? DEFAULT_MAX_MODELS_PER_PROVIDER;
	return cap > 0 ? filtered.slice(0, cap) : filtered;
}

async function listModelsWithin(
	target: DiagnosticTarget,
	timeoutMs: number,
): Promise<{
	readonly models?: readonly string[];
	readonly timedOut?: boolean;
	readonly error?: unknown;
}> {
	const request = target.listModels().then((models) => ({
		models: models.map((model) => model.id),
	}));
	if (timeoutMs <= 0) {
		try {
			return await request;
		} catch (error) {
			return { error };
		}
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<{ readonly timedOut: true }>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
	});
	try {
		return await Promise.race([request, deadline]);
	} catch (error) {
		return { error };
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

interface ProbeContext {
	readonly now: () => number;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

/**
 * One minimal streamed request, measured in three phases.
 *
 * The request is consumed to the end rather than closed at the first token: the
 * total is one of the three numbers asked for, and stopping early would make it
 * equal to the first token and call that a total.
 */
async function probeModel(
	target: DiagnosticTarget,
	base: Pick<ProviderDiagnostic, 'providerId' | 'providerName'> & { readonly modelId: string },
	context: ProbeContext,
): Promise<ProviderDiagnostic> {
	const budget = bounded(context.timeoutMs, context.signal);
	const requestedAt = context.now();

	try {
		let stream: ChatStream;
		try {
			stream = await target.streamChat(
				{
					model: base.modelId,
					messages: [{ role: 'user', content: PROBE_MESSAGE }],
					stream: true,
					maxTokens: 1,
				},
				{ signal: budget.signal },
			);
		} catch (error) {
			if (budget.timedOut()) {
				return {
					...base,
					outcome: 'timeout',
					detail: `A requisição não recebeu resposta em ${context.timeoutMs}ms.`,
					unmeasured: [
						{ metric: 'headers', reason: 'Nenhum cabeçalho chegou antes do limite.' },
						{ metric: 'firstToken', reason: 'Nenhum token chegou antes do limite.' },
						{ metric: 'total', reason: 'A requisição foi abandonada antes de terminar.' },
					],
				};
			}
			if (budget.cancelled()) {
				return { ...base, outcome: 'cancelled', detail: 'O diagnóstico foi cancelado.' };
			}
			return { ...base, ...classify(error) };
		}

		let failure: Error | undefined;
		for await (const event of stream) {
			if (event.type === 'Error') {
				failure = event.error;
			}
		}
		// The stream is the authority on its own phases: it started its clock
		// when the request was sent, before this function could observe it.
		const timing = stream.timing;
		const measured = {
			...reportedPhases(timing),
			// A clean stream always reports its own total. This covers a stream
			// that ended without one: measured from just before the request to
			// just after the stream closed, which is the same span.
			totalMs: elapsed(timing.totalMs ?? context.now() - requestedAt),
		};
		const abandoned = abandonedPhases(timing);

		if (budget.timedOut()) {
			return {
				...base,
				outcome: 'timeout',
				detail: `A resposta não terminou em ${context.timeoutMs}ms.`,
				// `totalMs` is deliberately dropped: on a timeout it measures how
				// long we waited, not how long the request took. Reporting it
				// would put the budget in a latency table as if it were an
				// observation.
				...reportedPhases(timing),
				unmeasured: abandoned,
			};
		}
		if (budget.cancelled()) {
			return {
				...base,
				outcome: 'cancelled',
				detail: 'O diagnóstico foi cancelado.',
				...reportedPhases(timing),
				unmeasured: abandoned,
			};
		}
		if (failure !== undefined) {
			return { ...base, ...classify(failure), ...measured };
		}
		if (stream.closedReason === 'failed') {
			return {
				...base,
				outcome: 'network-error',
				detail: 'O stream terminou em falha antes de uma resposta completa.',
				...measured,
			};
		}
		if (stream.closedReason === 'aborted') {
			return {
				...base,
				outcome: 'cancelled',
				detail: 'A requisição foi interrompida antes de terminar.',
				...reportedPhases(timing),
				unmeasured: abandoned,
			};
		}

		// A clean stream that carried no token is reachable and authenticated,
		// but it did not answer. Saying `ok` would hide that; saying `timeout`
		// would be false.
		return {
			...base,
			outcome: 'ok',
			detail:
				timing.firstTokenMs !== undefined
					? 'Resposta recebida.'
					: 'O provedor respondeu, mas o stream não trouxe nenhum token.',
			...measured,
			...(timing.firstTokenMs === undefined
				? { unmeasured: missingFirstToken() }
				: {}),
		};
	} finally {
		budget.dispose();
	}
}

/** The phases the stream reported, rounded and never negative. */
function reportedPhases(timing: ChatStream['timing']): Pick<
	ProviderDiagnostic,
	'headersMs' | 'firstTokenMs'
> {
	return {
		...(timing.headersMs !== undefined ? { headersMs: elapsed(timing.headersMs) } : {}),
		...(timing.firstTokenMs !== undefined ? { firstTokenMs: elapsed(timing.firstTokenMs) } : {}),
	};
}

/**
 * What an abandoned request could not measure.
 *
 * `total` is always listed: the stream's own total on an abort is the time
 * until *we* gave up, and putting the budget in a latency table as an
 * observation would make every timeout look like a request that took exactly
 * `timeoutMs` to answer.
 */
function abandonedPhases(timing: ChatStream['timing']): readonly UnmeasuredMetric[] {
	const missing: UnmeasuredMetric[] = [];
	if (timing.headersMs === undefined) {
		missing.push({ metric: 'headers', reason: 'Nenhum cabeçalho chegou antes do limite.' });
	}
	if (timing.firstTokenMs === undefined) {
		missing.push({ metric: 'firstToken', reason: 'Nenhum token chegou antes do limite.' });
	}
	missing.push({ metric: 'total', reason: 'A requisição foi abandonada antes de terminar.' });
	return missing;
}

function missingFirstToken(): readonly UnmeasuredMetric[] {
	return [{ metric: 'firstToken', reason: 'O stream terminou sem nenhum token de conteúdo.' }];
}

/** Rounds to whole milliseconds and never reports a negative duration. */
function elapsed(value: number): number {
	return Math.max(0, Math.round(value));
}

interface Budget {
	readonly signal: AbortSignal;
	/** True only when this module's own timer fired. */
	readonly timedOut: () => boolean;
	/** True only when the caller's signal fired, so an abort is attributed to them. */
	readonly cancelled: () => boolean;
	readonly dispose: () => void;
}

/**
 * One attempt's cancellation, with its cause kept.
 *
 * The provider reports every abort as the same `AbortedChatStream`, so the
 * only place that knows *why* is here. Same distinction the turn's own timers
 * make: a budget that ran out is a timeout, and a user who pressed stop is not.
 */
function bounded(timeoutMs: number, outer?: AbortSignal): Budget {
	const controller = new AbortController();
	let timedOut = false;

	const timer =
		timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, timeoutMs)
			: undefined;

	const onOuterAbort = (): void => controller.abort();
	if (outer !== undefined) {
		if (outer.aborted) {
			controller.abort();
		} else {
			outer.addEventListener('abort', onOuterAbort, { once: true });
		}
	}

	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		cancelled: () => outer?.aborted === true && !timedOut,
		dispose: () => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			outer?.removeEventListener('abort', onOuterAbort);
		},
	};
}

/**
 * Maps a failure onto an outcome without letting its text through.
 *
 * `ProviderError` messages are written by this codebase and never interpolate a
 * key, but they are still not user-facing prose, and an error from `fetch` can
 * carry the URL or a header. So the row says what happened, not what was said.
 */
function classify(error: unknown): Pick<ProviderDiagnostic, 'outcome' | 'detail' | 'httpStatus'> {
	if (error instanceof ProviderError) {
		// The `/models` budget running out is a timeout even though the message
		// describes an unreachable endpoint.
		if (error.details?.['abandoned'] === true) {
			return { outcome: 'timeout', detail: 'O provedor não respondeu dentro do limite.' };
		}
		const status = error.details?.['status'];
		if (typeof status === 'number') {
			if (status === 401 || status === 403) {
				return {
					outcome: 'auth-error',
					httpStatus: status,
					detail: `O provedor recusou a credencial (HTTP ${status}).`,
				};
			}
			return {
				outcome: 'http-error',
				httpStatus: status,
				detail: `O provedor respondeu HTTP ${status}.`,
			};
		}
		if (/disabled/i.test(error.message)) {
			return { outcome: 'disabled', detail: 'Este provedor está desativado nas configurações.' };
		}
		return { outcome: 'network-error', detail: 'Não foi possível alcançar o provedor.' };
	}
	return { outcome: 'network-error', detail: 'A requisição falhou antes de o provedor responder.' };
}
