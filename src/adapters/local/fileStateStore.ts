/**
 * Local filesystem adapter for the `StateStore` port.
 *
 * Backs configuration and app state with a single JSON file. `StateStore.get`
 * is synchronous by contract, so the file is read once at construction and
 * kept in memory; `update` writes through and re-reads nothing.
 *
 * A missing or unreadable file yields an empty store instead of throwing, so a
 * first run and a corrupted state both degrade to "nothing configured".
 *
 * `update` queues its writes behind one another and swaps the file
 * atomically, so a crash mid-write costs at most a stray temp file — never
 * the saved state itself — and two concurrent updates cannot swap the same
 * path at once, which on Windows fails the loser outright.
 */
import { existsSync, readFileSync } from 'node:fs';
import { StorageError } from '../../core/errors';
import type { StateStore } from '../../core/providers/config';
import { writeFileAtomic } from './writeFileAtomic';

export interface FileStateStoreOptions {
	/** Absolute path of the JSON file backing the store. */
	readonly filePath: string;
}

export class FileStateStore implements StateStore {
	private readonly cache: Record<string, unknown>;
	/** Serializes writes so two concurrent updates cannot swap the file at once. */
	private pending: Promise<void> = Promise.resolve();

	constructor(private readonly options: FileStateStoreOptions) {
		this.cache = readInitialState(options.filePath);
	}

	get<T>(key: string, defaultValue: T): T {
		return key in this.cache ? (this.cache[key] as T) : defaultValue;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.cache[key] = value;
		const next = this.pending.then(async () => {
			try {
				// Stringified at write time, so every queued update stores the
				// state as it stands when its turn comes, not a stale snapshot.
				await writeFileAtomic(this.options.filePath, `${JSON.stringify(this.cache, null, 2)}\n`);
			} catch (error) {
				throw new StorageError(
					`Could not write the state file at ${this.options.filePath}`,
					{ cause: error, details: { filePath: this.options.filePath } },
				);
			}
		});
		// The chain must never stay rejected: one failed write would otherwise
		// skip every write after it. Same re-arm the other local stores use.
		this.pending = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
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