/**
 * Secret storage boundary for provider credentials.
 *
 * A provider descriptor only ever carries an `apiKeyRef` — a *reference* into
 * this store. The secret itself must never reach a descriptor, a settings
 * value, a log line, or an error message. This module is the only place where
 * the raw secret is allowed to exist in memory, and it hands it straight to
 * the caller that asked for it by reference.
 *
 * One implementation ships here; every host supplies its own adapter.
  *
  * - `InMemorySecretStore` — dependency-free, used by tests and as the base
  *   for host adapters.
  *
  * Host-specific adapters (the VS Code `SecretStorage` one lives under
  * `host/vscode/`) implement this same port.
  */
import { ValidationError } from '../../errors';

/**
 * Read/write access to secrets by opaque reference.
 *
 * Implementations must not log, cache or return secrets anywhere except to the
 * caller of `get`.
 */
export interface SecretStore {
	/** Returns the secret, or `undefined` when the reference has no value. */
	get(ref: string): Promise<string | undefined>;
	/** Creates or replaces the value behind a reference. */
	store(ref: string, value: string): Promise<void>;
	/** Removes the value behind a reference. Deleting an absent ref is a no-op. */
	delete(ref: string): Promise<void>;
	/** Reports whether a reference currently has a value. */
	has(ref: string): Promise<boolean>;
}

/**
 * Validates a secret reference. A reference is an identifier we control, not
 * user input, so anything blank or padded is a programming error rather than a
 * runtime condition to recover from.
 */
export function assertValidSecretRef(ref: string): string {
	if (typeof ref !== 'string' || ref.trim().length === 0) {
		throw new ValidationError('Secret reference must be a non-empty string', {
			details: { received: typeof ref },
		});
	}
	if (ref !== ref.trim()) {
		throw new ValidationError('Secret reference must not have leading or trailing whitespace');
	}
	return ref;
}

/**
 * In-memory `SecretStore`. Values live only for the lifetime of the process.
 *
 * This is the implementation used by unit tests, and the base of the VS Code
 * adapter so that reference validation is identical in both.
 */
export class InMemorySecretStore implements SecretStore {
	private readonly values = new Map<string, string>();

	async get(ref: string): Promise<string | undefined> {
		return this.values.get(assertValidSecretRef(ref));
	}

	async store(ref: string, value: string): Promise<void> {
		assertValidSecretRef(ref);
		if (typeof value !== 'string') {
			throw new ValidationError('Secret value must be a string', {
				details: { received: typeof value },
			});
		}
		this.values.set(ref, value);
	}

	async delete(ref: string): Promise<void> {
		this.values.delete(assertValidSecretRef(ref));
	}

	async has(ref: string): Promise<boolean> {
		return this.values.has(assertValidSecretRef(ref));
	}

	/** Test/debug affordance: how many references currently hold a value. */
	get size(): number {
		return this.values.size;
	}
}

/**
 * Builds the namespaced secret reference for a provider's API key.
 *
 * Keeping the naming here means provider code never concatenates secret keys
 * by hand, and the two credential kinds (provider key, anything added later)
 * can never collide.
 */
export function providerApiKeyRef(providerId: string): string {
	return `modelhub.provider.${providerId}.apiKey`;
}