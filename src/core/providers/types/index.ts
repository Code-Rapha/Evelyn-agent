/**
 * Provider abstraction boundary (Phase 1: types only — no network calls).
 *
 * The architecture is provider-independent: OpenRouter, OpenCode, Z.AI, GLM,
 * Together, Groq, Ollama, LM Studio and custom OpenAI-compatible servers are
 * all representable through these types. Automatic model discovery is a
 * future capability and is NOT implemented in this phase.
 */

import type { ModelCapabilities } from '../../storage/types/modelCatalog';

export type ProviderType = 'predefined' | 'custom-openai-compatible';

export type ProviderStatus =
	| 'unconfigured'
	| 'configured'
	| 'available'
	| 'error'
	| 'disabled';

export type ProviderCapability =
	| 'chat'
	| 'completion'
	| 'embeddings'
	| 'streaming'
	| 'tools'
	| 'vision';

export interface ModelInfo {
	readonly id: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly capabilities?: readonly ProviderCapability[];
	/**
	 * What the endpoint published about this model in the same listing.
	 *
	 * Absent on a server that only publishes ids, which is the common case.
	 * Nothing here is derived: a price the server did not state stays absent.
	 */
	readonly pricing?: {
		readonly currency: string;
		readonly unit: 'per_1k_tokens' | 'per_1m_tokens';
		readonly input?: number;
		readonly output?: number;
	};
	/** When the provider's catalog picked this model up, ISO-8601, when published. */
	readonly created?: string;
	/** The response budget the provider published, when it publishes one. */
	readonly maxOutputTokens?: number;
	/**
	 * The capabilities the provider published, when it publishes a list.
	 *
	 * Absent means the provider said nothing about them - not that the model
	 * lacks them. A field inside is `false` only when the provider's own
	 * enumeration says so.
	 */
	readonly modelCapabilities?: ModelCapabilities;
}

/**
 * Provider configuration. `apiKeyRef` is a *reference* to a key inside VS
 * Code's SecretStorage — the secret itself must never be part of this object,
 * of settings, or of logs.
 */
export interface ProviderConfiguration {
	readonly baseUrl?: string;
	readonly apiKeyRef?: string;
	readonly enabled?: boolean;
}

export interface ProviderDescriptor {
	readonly id: string;
	readonly name: string;
	readonly type: ProviderType;
	readonly status: ProviderStatus;
	readonly configuration: ProviderConfiguration;
	readonly capabilities: readonly ProviderCapability[];
	readonly models: readonly ModelInfo[];
}

export interface Provider {
	readonly descriptor: ProviderDescriptor;
	/**
	 * Lists available models. In future phases this will back automatic model
	 * discovery; for now it may return the static descriptor models.
	 */
	listModels(): Promise<readonly ModelInfo[]>;
}
