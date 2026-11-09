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
 * The host's persistence is reached only through the `StateStore` port, so the
  * whole service is unit-testable with a fake and no extension host.
 */
import { ValidationError } from '../../errors';
import { providerApiKeyRef, type SecretStore } from '../secrets';
import { OpenAICompatibleProvider, type FetchLike } from '../openaiCompatible';
import type { Provider } from '../types';
import { isProviderRole, type ProviderRole } from '../routing/config';

/** Key used inside the extension's `globalState`. */
export const PROVIDER_CONFIG_KEY = 'modelhub.providers.config';

/**
 * The ids the user removed, and that must not come back on their own.
 *
 * A tombstone, not a preference: the app seeds a default provider for a fresh
 * install, and a user who deletes that provider has answered the question the
 * seed asks. Without this, the deletion would last until the next launch —
 * which reads as the app ignoring the user.
 *
 * Saving a provider with the same id takes the tombstone away: the user
 * brought it back on purpose.
 */
export const PROVIDER_REMOVED_KEY = 'modelhub.providers.removed';

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
	/**
	 * What this endpoint is: a **router** (it decides which model answers) or
	 * a plain **provider**.
	 *
	 * Absent = `provider`. That is what every record written before the
	 * distinction existed was, and reading one as a router would change how
	 * the app talks to it.
	 */
	readonly role?: ProviderRole;
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
			.map((entry) => normalizeRole(entry));
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
		// O provedor voltou: a lápide sai, porque a decisão do usuário agora
		// é que ele existe.
		await this.forgetRemoval(validated.id);
	}

	/**
	 * Removes one provider's configuration. Absent ids are a no-op.
	 *
	 * The id is remembered as removed, so that nothing brings it back by
	 * itself — a default provider that reappears on the next launch would
	 * undo the deletion the user just made.
	 */
	async remove(providerId: string): Promise<boolean> {
		const current = this.list();
		const next = current.filter((entry) => entry.id !== providerId);
		if (next.length === current.length) {
			return false;
		}
		await this.state.update(PROVIDER_CONFIG_KEY, next);
		await this.rememberRemoval(providerId);
		return true;
	}

	async removeAll(): Promise<void> {
		await this.state.update(PROVIDER_CONFIG_KEY, []);
	}

	/**
	 * The ids the user removed.
	 *
	 * A missing or malformed value reads as an empty list: nothing was
	 * removed, which is the safe answer.
	 */
	removed(): readonly string[] {
		const raw = this.state.get<unknown>(PROVIDER_REMOVED_KEY, []);
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.filter((entry): entry is string => typeof entry === 'string');
	}

	/** Whether the user removed this provider and it must not come back. */
	isRemoved(providerId: string): boolean {
		return this.removed().includes(providerId);
	}

	/** Records the removal, without repeating it. */
	private async rememberRemoval(providerId: string): Promise<void> {
		const current = this.removed();
		if (current.includes(providerId)) {
			return;
		}
		await this.state.update(PROVIDER_REMOVED_KEY, [...current, providerId]);
	}

	/** Takes the tombstone away: the provider is back, on purpose. */
	private async forgetRemoval(providerId: string): Promise<void> {
		const current = this.removed();
		if (!current.includes(providerId)) {
			return;
		}
		await this.state.update(
			PROVIDER_REMOVED_KEY,
			current.filter((entry) => entry !== providerId),
		);
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
	/** The endpoint's role. Absent means a plain provider. */
	readonly role?: ProviderRole;
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
		// O papel só é gravado quando difere do padrão: um registro que diz
		// "provider" é o mesmo que um registro que não diz nada, e gravar o
		// redundante tornaria cada gravação um diff.
		...(input.role === 'router' || input.role === 'search' ? { role: input.role } : {}),
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

/**
 * Normaliza o papel de um registro lido do disco.
 *
 * O invariante é simples: o papel gravado é `'router'` ou **nada**. Um
 * registro com `'provider'` escrito à mão equivale a um registro sem papel — e
 * um papel fora do vocabulário é descartado, não adivinhado: um valor
 * desconhecido mudaria a forma de falar com o endpoint, e adivinhar é pior
 * do que recusar.
 *
 * Um registro gravado antes do papel existir não tem o campo, e continua
 * funcionando como provedor.
 */
function normalizeRole(entry: PersistedProviderConfig): PersistedProviderConfig {
	const { role, ...rest } = entry;
	return role === 'router' || role === 'search' ? { ...rest, role } : rest;
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
	// O papel é opcional, mas não pode ser um valor fora do vocabulário: um
	// papel desconhecido mudaria a forma de falar com o endpoint, e adivinhar
	// seria pior do que recusar.
	if (config.role !== undefined && !isProviderRole(config.role)) {
		throw new ValidationError(
			`Provider "${config.id}" has an unknown role`,
			{ details: { providerId: config.id, role: config.role } },
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
		...(config.role === 'router' || config.role === 'search' ? { role: config.role } : {}),
	};
}