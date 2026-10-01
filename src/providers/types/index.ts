/**
 * Provider abstraction boundary (Phase 1: types only — no network calls).
 *
 * The architecture is provider-independent: OpenRouter, OpenCode, Z.AI, GLM,
 * Together, Groq, Ollama, LM Studio and custom OpenAI-compatible servers are
 * all representable through these types. Automatic model discovery is a
 * future capability and is NOT implemented in this phase.
 */

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
