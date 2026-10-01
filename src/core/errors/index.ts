/**
 * Central error model for ModelHub.
 *
 * Every module must throw one of these (or `ModelHubError` subclasses) so that
 * error handling is consistent and categories are distinguishable at runtime.
 */

export type ModelHubErrorCategory =
	| 'configuration'
	| 'provider'
	| 'agent'
	| 'permission'
	| 'storage'
	| 'backend'
	| 'validation';

export interface ModelHubErrorOptions {
	readonly cause?: unknown;
	readonly details?: Readonly<Record<string, unknown>>;
}

export class ModelHubError extends Error {
	readonly category: ModelHubErrorCategory;
	readonly details?: Readonly<Record<string, unknown>>;

	constructor(category: ModelHubErrorCategory, message: string, options: ModelHubErrorOptions = {}) {
		super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'ModelHubError';
		this.category = category;
		if (options.details !== undefined) {
			this.details = options.details;
		}
	}
}

export class ConfigurationError extends ModelHubError {
	constructor(message: string, options: ModelHubErrorOptions = {}) {
		super('configuration', message, options);
		this.name = 'ConfigurationError';
	}
}

export class ProviderError extends ModelHubError {
	constructor(message: string, options: ModelHubErrorOptions = {}) {
		super('provider', message, options);
		this.name = 'ProviderError';
	}
}

export class AgentError extends ModelHubError {
	constructor(message: string, options: ModelHubErrorOptions = {}) {
		super('agent', message, options);
		this.name = 'AgentError';
	}
}

export class PermissionError extends ModelHubError {
	constructor(message: string, options: ModelHubErrorOptions = {}) {
		super('permission', message, options);
		this.name = 'PermissionError';
	}
}

export class StorageError extends ModelHubError {
	constructor(message: string, options: ModelHubErrorOptions = {}) {
		super('storage', message, options);
		this.name = 'StorageError';
	}
}

export class BackendError extends ModelHubError {
	constructor(message: string, options: ModelHubErrorOptions = {}) {
		super('backend', message, options);
		this.name = 'BackendError';
	}
}

export class ValidationError extends ModelHubError {
	constructor(message: string, options: ModelHubErrorOptions = {}) {
		super('validation', message, options);
		this.name = 'ValidationError';
	}
}

export function isModelHubError(error: unknown): error is ModelHubError {
	return error instanceof ModelHubError;
}
