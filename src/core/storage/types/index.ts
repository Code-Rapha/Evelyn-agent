/**
 * Storage boundary (Phase 1: interfaces only — the local-first storage layer
 * is NOT implemented yet).
 *
 * Future structured Markdown memory lives under `~/.modelhub/`:
 *
 *   ~/.modelhub/
 *   ├── memory/
 *   │   ├── personal/     (local-only by default, never auto-uploaded)
 *   │   └── projects/
 *   ├── rules/
 *   └── skills/
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
