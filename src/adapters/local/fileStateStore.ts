/**
 * Local filesystem adapter for the `StateStore` port.
 *
 * Backs configuration and app state with a single JSON file. `StateStore.get`
 * is synchronous by contract, so the file is read once at construction and
 * kept in memory; `update` writes through and re-reads nothing.
 *
 * A missing or unreadable file yields an empty store instead of throwing, so a
 * first run and a corrupted state both degrade to "nothing configured".
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { StorageError } from '../../core/errors';
import type { StateStore } from '../../core/providers/config';

export interface FileStateStoreOptions {
	/** Absolute path of the JSON file backing the store. */
	readonly filePath: string;
}

export class FileStateStore implements StateStore {
	private readonly cache: Record<string, unknown>;

	constructor(private readonly options: FileStateStoreOptions) {
		this.cache = readInitialState(options.filePath);
	}

	get<T>(key: string, defaultValue: T): T {
		return key in this.cache ? (this.cache[key] as T) : defaultValue;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.cache[key] = value;
		try {
			await mkdir(dirname(this.options.filePath), { recursive: true });
			await writeFile(
				this.options.filePath,
				`${JSON.stringify(this.cache, null, 2)}\n`,
				{ encoding: 'utf8' },
			);
		} catch (error) {
			throw new StorageError(
				`Could not write the state file at ${this.options.filePath}`,
				{ cause: error, details: { filePath: this.options.filePath } },
			);
		}
	}
}

/**
 * Reads the state file synchronously, because the port's `get` is sync.
 * Anything unreadable or malformed is treated as an empty store.
 */
function readInitialState(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return {};
		}
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}