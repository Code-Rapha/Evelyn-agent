/**
 * Local filesystem adapter for the `SecretStore` port.
 *
 * This is the default implementation for a local-first installation: it keeps
 * credentials in a single JSON file under the user's data directory with
 * owner-only permissions, so the Core runs with no host at all.
 *
 * It is deliberately not in the VS Code host. The Core only knows the
 * `SecretStore` port; this file is one implementation of it among others.
 *
 * Threat model, stated plainly: on a single-user machine this keeps keys out
 * of `settings.json`, out of logs and out of git. It is not a substitute for
 * the OS keychain — that is what `VsCodeSecretStore` is for. Whoever hardens
 * this later should prefer the platform keyring over this file.
 *
 * Writes are queued behind one another and swap the file atomically, so a
 * crash mid-write costs a stray temp file, never the credentials file.
 */
import { readFile, rm, chmod } from 'node:fs/promises';
import { StorageError } from '../../core/errors';
import {
	assertValidSecretRef,
	type SecretStore,
} from '../../core/providers/secrets';
import { writeFileAtomic } from './writeFileAtomic';

/** Owner read/write only. On Windows this maps to the user's ACL. */
const OWNER_ONLY = 0o600;

export interface FileSecretStoreOptions {
	/** Absolute path of the JSON file backing the store. */
	readonly filePath: string;
}

export class FileSecretStore implements SecretStore {
	private cache: Record<string, string> | undefined;
	/** Serializes writes so two concurrent stores cannot clobber the file. */
	private pending: Promise<void> = Promise.resolve();

	constructor(private readonly options: FileSecretStoreOptions) {}

	/**
	 * Loads the backing file once and caches it. A missing file is an empty
	 * store, not an error: a first run has nothing saved yet.
	 */
	private async load(): Promise<Record<string, string>> {
		if (this.cache !== undefined) {
			return this.cache;
		}
		let raw: string;
		try {
			raw = await readFile(this.options.filePath, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				this.cache = {};
				return this.cache;
			}
			throw new StorageError(
				`Could not read the secrets file at ${this.options.filePath}`,
				{ cause: error, details: { filePath: this.options.filePath } },
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			throw new StorageError(
				`The secrets file at ${this.options.filePath} is not valid JSON`,
				{ cause, details: { filePath: this.options.filePath } },
			);
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new StorageError(
				`The secrets file at ${this.options.filePath} does not contain an object`,
				{ details: { filePath: this.options.filePath } },
			);
		}

		this.cache = parsed as Record<string, string>;
		return this.cache;
	}

	/** Writes the cache to disk, queued behind any in-flight write. */
	private persist(): Promise<void> {
		const run = async (): Promise<void> => {
			const data = this.cache ?? {};
			await writeFileAtomic(this.options.filePath, `${JSON.stringify(data, null, 2)}\n`, {
				mode: OWNER_ONLY,
			});
			// The mode is set on the temp file the swap brings in; re-assert it
			// anyway in case the platform quietly dropped it.
			await chmod(this.options.filePath, OWNER_ONLY).catch(() => undefined);
		};
		const next = this.pending.then(run, run);
		// The chain must never stay rejected: one failed write would otherwise
		// skip every write after it and brick the store for the rest of the
		// session. Same re-arm the data store's queue uses.
		this.pending = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async get(ref: string): Promise<string | undefined> {
		const store = await this.load();
		return store[assertValidSecretRef(ref)];
	}

	async store(ref: string, value: string): Promise<void> {
		const key = assertValidSecretRef(ref);
		if (typeof value !== 'string') {
			throw new StorageError('Secret value must be a string', {
				details: { received: typeof value },
			});
		}
		const store = await this.load();
		store[key] = value;
		await this.persist();
	}

	async delete(ref: string): Promise<void> {
		const key = assertValidSecretRef(ref);
		const store = await this.load();
		if (!(key in store)) {
			// Deleting an absent reference changes nothing, so skip the write.
			return;
		}
		delete store[key];
		await this.persist();
	}

	async has(ref: string): Promise<boolean> {
		const store = await this.load();
		return assertValidSecretRef(ref) in store;
	}
}

/** Removes the backing file. Used by tests and by a future "reset" action. */
export async function removeSecretFile(filePath: string): Promise<void> {
	try {
		await rm(filePath, { force: true });
	} catch (error) {
		throw new StorageError(`Could not remove the secrets file at ${filePath}`, {
			cause: error,
			details: { filePath },
		});
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { code?: string }).code === 'ENOENT'
	);
}