/**
 * Storage boundary.
 *
 * Two layers live here:
 *
 * 1. `StorageService` — the future structured Markdown memory layer. Phase 1
 *    ships interfaces only; no implementation exists yet. It lives under
 *    `~/.modelhub/`:
 *
 *      ~/.modelhub/
 *      ├── memory/
 *      │   ├── personal/     (local-only by default, never auto-uploaded)
 *      │   └── projects/
 *      ├── rules/
 *      └── skills/
 *
 * 2. `DataStore` (in `./dataStore`) — the local persistence port for projects,
 *    conversation history and non-sensitive configuration, which *is*
 *    implemented, by `adapters/local/fileDataStore`.
 *
 * Future services must depend on these abstractions instead of touching
 * arbitrary filesystem paths or `fs` directly.
 */

export type StorageArea = 'memory/personal' | 'memory/projects' | 'rules' | 'skills';

export const STORAGE_ROOT_NAME = '.modelhub';

/**
 * Paths are relative to the ModelHub storage root. Implementations resolve
 * them safely (no path traversal outside the root).
 */
export interface StorageService {
	read(path: string): Promise<string | undefined>;
	write(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<readonly string[]>;
	createDirectory(path: string): Promise<void>;
	delete(path: string): Promise<void>;
}

export interface StoragePaths {
	readonly rootName: typeof STORAGE_ROOT_NAME;
	resolve(area: StorageArea, relativePath?: string): string;
}
