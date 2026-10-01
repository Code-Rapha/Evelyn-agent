/**
 * Persistent configuration for providers.
 *
 * What is persisted: the non-secret shape of a provider connection —
 * `{ baseUrl, apiKeyRef, enabled }`.
 *
 * What is never persisted here: the API key itself. `apiKeyRef` is only a
 * pointer into the `SecretStore`; the value it points to stays in the OS
 * keychain via `SecretStorage`. Deleting this configuration therefore leaves an
 * orphaned key behind — that is deliberate, because losing a key the user paid
 * for is worse than leaving one unreachable, and `removeProvider` is the place
 * that cleans up both.
 *
 * The VS Code `Memento` is reached only through the `StateStore` port, so the
 * whole service is unit-testable with a fake and no extension host.
 */
import type * as vscode from 'vscode';
import { ValidationError } from '../../core/errors';
import { providerApiKeyRef, type SecretStore } from '../secrets';
import { OpenAICompatibleProvider, type FetchLike } from '../openaiCompatible';
import type { Provider } from '../types';

/** Key used inside the extension's `globalState`. */
export const PROVIDER_CONFIG_KEY = 'modelhub.providers.config';

/**
 * The `globalState` port. Mirrors the slice of `vscode.Memento` we need, so a
 * fake is a plain object.
 */
export interface StateStore {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Promise<void>;
}

/**
 * The persisted record. `id` is part of the stored value so a restored list can
 * be rebuilt without depending on the ordering inside the map.
 */
export interface PersistedProviderConfig {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	/** Reference into the `SecretStore`. Absent for keyless local servers. */
	readonly apiKeyRef?: string;
	readonly enabled: boolean;
	readonly capabilities?: readonly string[];
}

/** `StateStore` over VS Code's `ExtensionContext.globalState`. */
export class VsCodeStateStore implements StateStore {
	constructor(private readonly memento: vscode.Memento) {}

	get<T>(key: string, defaultValue: T): T {
		return this.memento.get<T>(key, defaultValue);
	}

	async update(key: string, value: unknown): Promise<void> {
		await this.memento.update(key, value);
	}
}

/**
 * Reads and writes provider configuration.
 *
 * Every method tolerates absent state: a fresh install, a cleared key, or a
 * `globalState` written by a different version all read as an empty list
 * rather than an error.
 */
export class ProviderConfigService {
	readonly id = 'provider-config';

	constructor(
		private readonly state: StateStore,
		private readonly fetchImpl?: FetchLike,
	) {}

	/** Every stored provider. Returns `[]` when nothing is stored. */
	list(): readonly PersistedProviderConfig[] {
		const raw = this.state.get<unknown>(PROVIDER_CONFIG_KEY, []);
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw
			.filter((entry): entry is PersistedProviderConfig => isPersistedConfig(entry))
			.map((entry) => ({ ...entry }));
	}

	get(providerId: string): PersistedProviderConfig | undefined {
		return this.list().find((entry) => entry.id === providerId);
	}

	/**
	 * Creates or replaces one provider's configuration.
	 *
	 * The API key is not a parameter, by design: callers must have already put
	 * it in the `SecretStore` and pass only the reference.
	 */
	async save(config: PersistedProviderConfig): Promise<void> {
		const validated = validateConfig(config);
		const next = this.list().filter((entry) => entry.id !== validated.id);
		next.push(validated);
		await this.state.update(PROVIDER_CONFIG_KEY, next);
	}

	/** Removes one provider's configuration. Absent ids are a no-op. */
	async remove(providerId: string): Promise<boolean> {
		const current = this.list();
		const next = current.filter((entry) => entry.id !== providerId);
		if (next.length === current.length) {
			return false;
		}
		await this.state.update(PROVIDER_CONFIG_KEY, next);
		return true;
	}

	async removeAll(): Promise<void> {
		await this.state.update(PROVIDER_CONFIG_KEY, []);
	}

	/**
	 * Rebuilds live providers from persisted configuration.
	 *
	 * Returns an empty list — never throws — when there is nothing stored or
	 * when the stored value is unusable. Individual malformed entries are
	 * skipped rather than failing the whole restore, so one bad record cannot
	 * take down the extension on activate.
	 */
	restoreAll(
		secrets: SecretStore,
		register: (provider: Provider) => () => void,
	): readonly Provider[] {
		const restored: Provider[] = [];
		for (const config of this.list()) {
			try {
				const provider = new OpenAICompatibleProvider({
					id: config.id,
					name: config.name,
					baseUrl: config.baseUrl,
					...(config.apiKeyRef !== undefined ? { apiKeyRef: config.apiKeyRef } : {}),
					enabled: config.enabled,
					...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {}),
					secrets,
				});
				register(provider);
				restored.push(provider);
			} catch {
				// A record that cannot produce a provider is skipped; the rest of
				// the configuration still loads.
				continue;
			}
		}
		return restored;
	}
}

/**
 * Builds the config for a provider that uses an API key, deriving the secret
 * reference so callers never write it by hand.
 */
export function buildProviderConfig(input: {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly enabled?: boolean;
	readonly capabilities?: readonly string[];
}): PersistedProviderConfig {
	const config: PersistedProviderConfig = {
		id: input.id,
		name: input.name,
		baseUrl: input.baseUrl,
		// A keyless provider omits the field entirely rather than storing an
		// explicit `undefined`, so the persisted record carries no dangling ref.
		...(input.apiKey !== undefined ? { apiKeyRef: providerApiKeyRef(input.id) } : {}),
		enabled: input.enabled ?? true,
		...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
	};
	return config;
}

/** Narrows an unknown value read back from storage. */
function isPersistedConfig(value: unknown): value is PersistedProviderConfig {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return typeof candidate.id === 'string' && typeof candidate.baseUrl === 'string';
}

/** Rejects a config that could never produce a working provider. */
function validateConfig(config: PersistedProviderConfig): PersistedProviderConfig {
	if (typeof config.id !== 'string' || config.id.trim().length === 0) {
		throw new ValidationError('A provider configuration requires a non-empty id');
	}
	if (typeof config.baseUrl !== 'string' || config.baseUrl.trim().length === 0) {
		throw new ValidationError(
			`Provider "${config.id}" requires a non-empty baseUrl`,
			{ details: { providerId: config.id } },
		);
	}
	const name = typeof config.name === 'string' && config.name.length > 0 ? config.name : config.id;
	return {
		id: config.id.trim(),
		name,
		baseUrl: config.baseUrl.trim(),
		...(config.apiKeyRef !== undefined ? { apiKeyRef: config.apiKeyRef } : {}),
		enabled: config.enabled ?? true,
		...(config.capabilities !== undefined ? { capabilities: config.capabilities } : {}),
	};
}