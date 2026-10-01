/**
 * VS Code secret store adapter.
 *
 * Lives under `host/vscode/` because it depends on `vscode.SecretStorage`;
 * the Core only knows the `SecretStore` port.
 */
import type * as vscode from 'vscode';
import { ValidationError } from '../../../core/errors';
import {
	assertValidSecretRef,
	type SecretStore,
} from '../../../core/providers/secrets';

/**
 * `SecretStore` over VS Code's `SecretStorage`, which is backed by the OS
 * keychain rather than `settings.json`.
 */
export class VsCodeSecretStore implements SecretStore {
	constructor(private readonly secrets: vscode.SecretStorage) {}

	async get(ref: string): Promise<string | undefined> {
		return this.secrets.get(assertValidSecretRef(ref));
	}

	async store(ref: string, value: string): Promise<void> {
		assertValidSecretRef(ref);
		if (typeof value !== 'string') {
			throw new ValidationError('Secret value must be a string', {
				details: { received: typeof value },
			});
		}
		await this.secrets.store(ref, value);
	}

	async delete(ref: string): Promise<void> {
		await this.secrets.delete(assertValidSecretRef(ref));
	}

	async has(ref: string): Promise<boolean> {
		return (await this.secrets.get(assertValidSecretRef(ref))) !== undefined;
	}
}