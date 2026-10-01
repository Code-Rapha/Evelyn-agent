/**
 * Provider add/remove flow, expressed as pure logic over ports.
 *
 * `commands.ts` wires these ports to the real VS Code dialogs; the tests wire
 * them to fakes. No `vscode` import lives here, so the flow that actually
 * matters — what gets stored, what gets registered, what happens on a
 * duplicate — is unit-testable without an extension host.
 *
 * Invariants this module owns:
 *
 * - The API key is written to the `SecretStore` only. The persisted config
 *   receives the derived `apiKeyRef`, never the key.
 * - Adding a provider that already exists fails with a clear message and
 *   changes nothing: no secret written, no config overwritten, no registry
 *   entry.
 * - Removing a provider deletes the key, the persisted config and the
 *   registry entry, so an empty registry is genuinely empty again.
 */
import { ProviderError } from '../../../core/errors';
import type { SecretStore } from '../../../core/providers/secrets';
import { providerApiKeyRef } from '../../../core/providers/secrets';
import type { ProviderRegistry } from '../../../core/providers/registry';
import type {
	ProviderConfigService,
	PersistedProviderConfig,
} from '../../../core/providers/config';
import { buildProviderConfig } from '../../../core/providers/config';
import { OpenAICompatibleProvider, type FetchLike } from '../../../core/providers/openaiCompatible';
import type { Provider } from '../../../core/providers/types';

/** Result of asking the user for the base URL. */
export type BaseUrlPromptResult =
	| { readonly kind: 'accepted'; readonly value: string }
	| { readonly kind: 'cancelled' };

/** Result of asking the user for the API key. */
export type ApiKeyPromptResult =
	| { readonly kind: 'accepted'; readonly value: string }
	| { readonly kind: 'skipped' };

/** Asks the user for input. Backed by QuickInput/InputBox in production. */
export interface ProviderPromptPort {
	askBaseUrl(defaultValue: string): Promise<BaseUrlPromptResult>;
	/**
	 * Returns `skipped` when the user leaves the field empty or dismisses it —
	 * an optional key must be reachable without typing anything.
	 */
	askApiKey(providerName: string): Promise<ApiKeyPromptResult>;
}

/** Shows messages to the user. */
export interface ProviderNotifierPort {
	info(message: string): void;
	error(message: string): void;
}

/** Everything the flow needs, injected. */
export interface ProviderFlowDependencies {
	readonly prompt: ProviderPromptPort;
	readonly notifier: ProviderNotifierPort;
	readonly secrets: SecretStore;
	readonly config: ProviderConfigService;
	readonly registry: ProviderRegistry;
	/** Optional, for tests. Production uses the real `fetch`. */
	readonly fetch?: FetchLike;
}

/** Default base URL offered in the prompt. */
export const DEFAULT_PROVIDER_BASE_URL = 'https://api.openai.com/v1';

export interface AddProviderOutcome {
	readonly ok: boolean;
	readonly providerId?: string;
	/**
	 * Disposes the registry entry. The caller owns it so the provider can be
	 * removed when the extension stops; the flow itself does not own lifetime.
	 */
	readonly unregister?: () => void;
}

export class ProviderFlow {
	constructor(private readonly deps: ProviderFlowDependencies) {}

	/**
	 * Prompts for a base URL and an optional API key, then registers and
	 * persists the provider.
	 *
	 * Cancelling either prompt leaves the board untouched and reports
	 * `ok: false` without an error message — cancelling is not a failure.
	 */
	async addProvider(): Promise<AddProviderOutcome> {
		const baseUrlPrompt = await this.deps.prompt.askBaseUrl(DEFAULT_PROVIDER_BASE_URL);
		if (baseUrlPrompt.kind === 'cancelled') {
			return { ok: false };
		}
		const baseUrl = baseUrlPrompt.value.trim();
		if (baseUrl.length === 0) {
			this.deps.notifier.error('A base URL is required.');
			return { ok: false };
		}

		const apiKeyPrompt = await this.deps.prompt.askApiKey(baseUrl);
		const apiKey = apiKeyPrompt.kind === 'accepted' ? apiKeyPrompt.value : undefined;

		const providerId = this.deriveProviderId(baseUrl);

		// Refuse before writing anything: a duplicate must leave the existing
		// provider, its secret and its config exactly as they were.
		if (this.deps.registry.get(providerId) !== undefined) {
			this.deps.notifier.error(
				`A provider for "${this.deriveName(baseUrl)}" already exists. Remove it first to add it again.`,
			);
			return { ok: false };
		}

		const apiKeyRef = providerApiKeyRef(providerId);
		if (apiKey !== undefined && apiKey.length > 0) {
			try {
				await this.deps.secrets.store(apiKeyRef, apiKey);
			} catch (error) {
				this.deps.notifier.error(
					`Could not store the API key for "${this.deriveName(baseUrl)}".`,
				);
				return { ok: false, providerId };
			}
		}

		const provider = new OpenAICompatibleProvider({
			id: providerId,
			name: this.deriveName(baseUrl),
			baseUrl,
			// A keyless provider registers without any reference, so it sends no
			// authorization header.
			...(apiKey !== undefined && apiKey.length > 0 ? { apiKeyRef } : {}),
			secrets: this.deps.secrets,
			...(this.deps.fetch !== undefined ? { fetch: this.deps.fetch } : {}),
		});

		let unregister: () => void;
		try {
			unregister = this.deps.registry.register(provider);
		} catch (error) {
			this.deps.notifier.error(
				`Could not register "${this.deriveName(baseUrl)}": ${
					error instanceof ProviderError ? error.message : String(error)
				}`,
			);
			return { ok: false, providerId };
		}

		const persisted: PersistedProviderConfig = {
			...buildProviderConfig({
				id: providerId,
				name: this.deriveName(baseUrl),
				baseUrl,
				...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
			}),
			enabled: true,
		};
		await this.deps.config.save(persisted);

		this.deps.notifier.info(`Added provider "${persisted.name}".`);
		return { ok: true, providerId, unregister };
	}

	/**
	 * Removes a provider: registry entry, persisted config and stored key.
	 *
	 * Reports whether anything was removed, so the caller can stay quiet when
	 * the id is unknown.
	 */
	async removeProvider(providerId: string): Promise<boolean> {
		const provider: Provider | undefined = this.deps.registry.get(providerId);
		const stored = this.deps.config.get(providerId);
		const known = provider !== undefined || stored !== undefined;
		if (!known) {
			return false;
		}

		this.deps.registry.unregister(providerId);

		// The key reference is derived, not read from config, so a provider
		// whose config was hand-edited still gets its key cleaned up.
		await this.deps.secrets.delete(providerApiKeyRef(providerId));

		const removedConfig = await this.deps.config.remove(providerId);
		return known || removedConfig;
	}

	/** Rebuilds providers from persisted configuration. Used on activate. */
	restorePersistedProviders(): readonly Provider[] {
		return this.deps.config.restoreAll(this.deps.secrets, (provider) =>
			this.deps.registry.register(provider),
		);
	}

	/**
	 * Stable id from the base URL: scheme and host only, so
	 * `https://host/v1` and `https://host/v2` are the same provider rather
	 * than two entries pointing at one server.
	 */
	deriveProviderId(baseUrl: string): string {
		try {
			const url = new URL(baseUrl.trim());
			return `local-${url.hostname}${url.port ? `-${url.port}` : ''}`.toLowerCase();
		} catch {
			return `local-${baseUrl.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
		}
	}

	/** Display name derived from the base URL's host. */
	deriveName(baseUrl: string): string {
		try {
			return new URL(baseUrl.trim()).hostname;
		} catch {
			return baseUrl.trim();
		}
	}
}