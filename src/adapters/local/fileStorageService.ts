/**
 * Local filesystem implementation of `StorageService` and `StoragePaths`.
 *
 * ## Where it writes
 *
 * The same root the rest of Evelyn uses — `~/.modelhub/seshyina` — and only
 * four directories inside it:
 *
 *   seshyina/
 *     memory/personal/     local-only, never uploaded
 *     memory/projects/     per project
 *     rules/
 *     skills/
 *     projects.json        ← not addressable
 *     models.json          ← not addressable
 *     state.json           ← not addressable
 *     secrets.json         ← not addressable
 *     conversations/       ← not addressable
 *
 * That last list is the security argument, and it is structural rather than
 * inspected. Every path this service accepts must begin with one of the four
 * area prefixes, so `secrets.json` is not "rejected by a rule" — it is not a
 * path this service can express. A caller cannot reach a credential, a provider
 * configuration, a transcript or the model catalog through it even by accident,
 * and a bug in a future memory rule cannot delete a conversation.
 *
 * What it cannot do is inspect content. This is an opaque string store: a key
 * pasted into a memory file is indistinguishable from any other text, and no
 * filename check would find it. Keys belong in the `SecretStore` because that is
 * where the architecture puts them, not because something scans for them here.
 *
 * ## Path safety
 *
 * Four layers, because each closes a route the previous one leaves open:
 *
 * 1. **Decoding first.** `%2e%2e%2f` is decoded before anything looks at it, so
 *    an encoded traversal is validated as the traversal it spells. A literal `%`
 *    that is not valid encoding survives as itself.
 * 2. **Segment checking.** No segment may be `..`, `.` or empty, and `\`, `/`
 *    and `:` are all separators, so a Windows path cannot smuggle a level past a
 *    POSIX-only check.
 * 3. **Area confinement.** The leading segments must form a known area, and
 *    nothing outside one is addressable at all.
 * 4. **Real path containment.** `realpath` on the target — or on its nearest
 *    existing ancestor when the target does not exist yet — must land inside the
 *    real path of the root. This is the only layer that catches a symlink
 *    planted inside an area pointing somewhere else, and the three above cannot:
 *    `skills/outside` is a perfectly ordinary path until it is a link.
 *
 * ## Consistency
 *
 * Writes go through `writeFileAtomic`, so a process that dies mid-write leaves
 * the previous content rather than half of the new. Reads are total: a missing
 * file is `undefined` and a missing directory lists as empty, because a first run
 * must not fail. Everything else raises, and says which path and why.
 *
 * ## What it is not
 *
 * A memory system, a rule engine, a skill runner or a learning store. It moves
 * bytes between a path and a string, and knows nothing about what they mean.
 */
import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { StorageError, ValidationError } from '../../core/errors';
import {
	STORAGE_ROOT_NAME,
	type StorageArea,
	type StoragePaths,
	type StorageService,
} from '../../core/storage/types';
import { defaultDataStoreRoot } from './fileDataStore';
import { writeFileAtomic } from './writeFileAtomic';

/**
 * The areas, longest prefix first.
 *
 * Order matters: `memory/personal` has to be tested before `memory`, or a
 * two-segment area would be read as a one-segment one and the second segment
 * would end up as a subdirectory of it. `memory` is not an area, so the test is
 * for the full two segments rather than for the shared prefix.
 */
const AREAS: readonly StorageArea[] = [
	'memory/personal',
	'memory/projects',
	'rules',
	'skills',
];

/**
 * Names Windows treats as devices rather than files.
 *
 * `skills/NUL` does not create a file — it addresses the null device, so the
 * write succeeds and nothing is there. That is a silent data loss, which is
 * worse than a refusal.
 */
const RESERVED_NAMES = new Set([
	'con', 'prn', 'aux', 'nul',
	'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
	'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Longest a single path segment may be. Longer than any filesystem allows. */
const MAX_SEGMENT_LENGTH = 255;

export interface FileStorageServiceOptions {
	/**
	 * Root directory. Defaults to `~/.modelhub/seshyina`, the same root the
	 * provider config, the transcript and the model catalog use.
	 *
	 * Absolute, and derived from `os.homedir()` rather than an env var, so a
	 * hostile `HOME` cannot redirect it. Tests pass an explicit temp path.
	 */
	readonly rootPath?: string;
}

/**
 * One resolved path: where it lives, and which area it belongs to.
 *
 * The area travels with the path because a caller that resolves one file still
 * has to be able to name the area it came from, and re-deriving it by matching
 * a prefix again would be a second place for the two to disagree.
 */
export interface ResolvedStoragePath {
	readonly area: StorageArea;
	/** Relative to the storage root, with `/` separators. */
	readonly relativePath: string;
	/** Absolute, lexically normalized. Not yet checked against symlinks. */
	readonly absolutePath: string;
}

export class FileStorageService implements StorageService, StoragePaths {
	/**
	 * The container key. Present so this satisfies `ServiceLike` and can be
	 * registered with a `ServiceContainer` without an adapter object.
	 */
	readonly id = 'storage';

	readonly rootName = STORAGE_ROOT_NAME;

	private readonly root: string;
	/** The root's real path, resolved once. See `assertContained`. */
	private realRoot: string | undefined;

	constructor(options: FileStorageServiceOptions = {}) {
		this.root = options.rootPath ?? defaultDataStoreRoot();
	}

	/**
	 * Creates the four areas.
	 *
	 * Idempotent, and cheap: it makes the structure inspectable with a file
	 * browser rather than appearing only once something has been written, which
	 * is the difference between a layout the user can find and one they cannot.
	 */
	async initialize(): Promise<void> {
		for (const area of AREAS) {
			await this.createDirectory(area);
		}
	}

	// ── StorageService ──────────────────────────────────────────────────────

	async read(path: string): Promise<string | undefined> {
		const target = await this.resolveContained(path);

		let content: string;
		try {
			content = await readFile(target.absolutePath, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				// A file that is not there yet is an ordinary state, not a failure.
				return undefined;
			}
			if (isADirectory(error)) {
				// Saying "it is a directory" is the difference between a caller
				// fixing its path and a caller retrying the same call forever.
				throw new StorageError(
					`Cannot read ${target.relativePath} as a file: it is a directory`,
					{ cause: error, details: { path: target.relativePath } },
				);
			}
			throw new StorageError(`Could not read ${target.relativePath}`, {
				cause: error,
				details: { path: target.relativePath },
			});
		}
		return content;
	}

	async write(path: string, content: string): Promise<void> {
		if (typeof content !== 'string') {
			throw new ValidationError('Storage content must be a string', {
				details: { received: typeof content },
			});
		}
		const target = await this.resolveContained(path);
		if (target.relativePath === target.area) {
			throw new ValidationError('A path must name a file inside an area, not the area itself', {
				details: { path: target.relativePath },
			});
		}
		// The temp file is a sibling of the target, so it is inside the same
		// directory — and the containment check above already covered that path
		// with the same `realpath` walk.
		await writeFileAtomic(target.absolutePath, content);
	}

	async exists(path: string): Promise<boolean> {
		const target = await this.resolveContained(path);
		try {
			await stat(target.absolutePath);
			return true;
		} catch (error) {
			if (isNotFound(error)) {
				return false;
			}
			throw new StorageError(`Could not check whether ${target.relativePath} exists`, {
				cause: error,
				details: { path: target.relativePath },
			});
		}
	}

	async list(path: string): Promise<readonly string[]> {
		const target = await this.resolveContained(path);

		let entries: string[];
		try {
			entries = await readdir(target.absolutePath);
		} catch (error) {
			if (isNotFound(error)) {
				// Same reason as `read`: a directory that does not exist yet is a
				// first run, not a fault.
				return [];
			}
			if (notADirectory(error)) {
				throw new StorageError(`Cannot list ${target.relativePath}: it is a file`, {
					cause: error,
					details: { path: target.relativePath },
				});
			}
			throw new StorageError(`Could not list ${target.relativePath}`, {
				cause: error,
				details: { path: target.relativePath },
			});
		}
		// Names, not paths, and sorted: the contract returns strings and a
		// directory listing whose order depends on the filesystem is one a
		// caller cannot predict or diff.
		return [...entries].sort((a, b) => a.localeCompare(b));
	}

	async createDirectory(path: string): Promise<void> {
		const target = await this.resolveContained(path);
		try {
			await mkdir(target.absolutePath, { recursive: true });
		} catch (error) {
			throw new StorageError(`Could not create the directory ${target.relativePath}`, {
				cause: error,
				details: { path: target.relativePath },
			});
		}
	}

	/**
	 * Removes a file, or an empty directory.
	 *
	 * A non-empty directory is refused rather than removed recursively. This is
	 * a memory store, and the caller deleting "one thing" should not be able to
	 * take a subtree with it; emptying a directory explicitly is a decision
	 * somebody can see they made.
	 */
	async delete(path: string): Promise<void> {
		const target = await this.resolveContained(path);
		if (target.relativePath === target.area) {
			throw new ValidationError('An area itself cannot be deleted', {
				details: { path: target.relativePath },
			});
		}

		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(target.absolutePath);
		} catch (error) {
			if (isNotFound(error)) {
				// Already gone. Idempotent, so a cleanup pass can run twice.
				return;
			}
			throw new StorageError(`Could not inspect ${target.relativePath} before deleting it`, {
				cause: error,
				details: { path: target.relativePath },
			});
		}

		if (info.isDirectory()) {
			const remaining = await this.list(target.relativePath);
			if (remaining.length > 0) {
				throw new StorageError(
					`${target.relativePath} is not empty, so it was not deleted`,
					{ details: { path: target.relativePath, entries: remaining.length } },
				);
			}
		}

		try {
			await rm(target.absolutePath, { recursive: true, force: true });
		} catch (error) {
			throw new StorageError(`Could not delete ${target.relativePath}`, {
				cause: error,
				details: { path: target.relativePath },
			});
		}
	}

	// ── StoragePaths ────────────────────────────────────────────────────────

	/**
	 * The absolute path for an area and a name inside it.
	 *
	 * Lexical only, because it is synchronous: it cannot ask the filesystem what
	 * a link points at. The containment check that does belongs to the I/O
	 * methods, and every one of them runs it. This is for naming a path to show
	 * the user, not for building one to write to.
	 */
	resolve(area: StorageArea, relativePath = ''): string {
		// Joined with a separator rather than `path.join`, which would resolve a
		// `..` away before the checks ever saw it and turn a clear refusal into a
		// confusing "not an area" one.
		return this.locate(relativePath.length === 0 ? area : `${area}/${relativePath}`).absolutePath;
	}

	// ── resolution and containment ──────────────────────────────────────────

	/**
	 * Validates a root-relative path and proves it lands inside the root.
	 *
	 * The async half of `resolve`: everything lexical happens first, and only
	 * then is the real path checked, so a traversal attempt is refused for the
	 * reason the caller can act on rather than for being "outside".
	 */
	private async resolveContained(path: string): Promise<ResolvedStoragePath> {
		const target = this.locate(path);
		await this.assertContained(target);
		return target;
	}

	/**
	 * Validates one root-relative path and works out where it lands.
	 *
	 * The one place a path is understood. `resolve` and every I/O method come
	 * through here, so there is a single definition of what a legal path is and
	 * no way for the synchronous and asynchronous halves to drift apart.
	 *
	 * Separators are normalized to `/` first, so a Windows caller writing
	 * `rules\style.md` and a POSIX one writing `rules/style.md` name the same
	 * file rather than one becoming a filename with a backslash in it.
	 */
	private locate(path: string): ResolvedStoragePath {
		const { area, rest, decoded } = splitArea(path);

		const segments = rest.length === 0 ? [] : rest.split('/');
		assertSafeSegments(segments, decoded);
		if (segments.length > 0) {
			assertNotReserved(segments[segments.length - 1], decoded);
		}

		return {
			area,
			relativePath: [area, ...segments].join('/'),
			absolutePath: join(this.root, area, ...segments),
		};
	}

	/**
	 * Proves the real path is inside the real root.
	 *
	 * The only layer that sees a symlink, and the reason the other three exist:
	 * `skills/elsewhere` passes every lexical check and is only dangerous if it
	 * turns out to point out of the root.
	 *
	 * A target that does not exist yet cannot be resolved, so the walk goes up
	 * to the nearest ancestor that does and checks that instead. The remaining
	 * segments were already checked lexically, and a segment that will be
	 * created cannot yet be a link — which is exactly why the *parent* is the
	 * one that has to be checked.
	 */
	private async assertContained(target: ResolvedStoragePath): Promise<void> {
		const rootReal = await this.realRootPath();
		let current = target.absolutePath;
		for (;;) {
			try {
				const real = await realpath(current);
				if (real !== rootReal && !real.startsWith(rootReal + sep)) {
					throw new ValidationError(
						`A storage path may not leave the storage root: ${target.relativePath}`,
						{ details: { path: target.relativePath } },
					);
				}
				return;
			} catch (error) {
				if (error instanceof ValidationError) {
					throw error;
				}
				if (!isNotFound(error)) {
					throw new StorageError(
						`Could not resolve ${target.relativePath} to check where it points`,
						{ cause: error, details: { path: target.relativePath } },
					);
				}
			}
			const parent = dirname(current);
			if (parent === current) {
				// Reached the filesystem root without finding anything that exists,
				// which means the root itself is not there. Report it as what it
				// is rather than as a containment failure.
				throw new StorageError(
					`The storage root does not exist, so ${target.relativePath} cannot be resolved`,
					{ details: { path: target.relativePath, root: this.root } },
				);
			}
			current = parent;
		}
	}

	/**
	 * The root's real path, created on first use.
	 *
	 * Created rather than assumed, because `realpath` on a missing directory
	 * fails and the first write of a fresh install would then be refused for
	 * the wrong reason.
	 */
	private async realRootPath(): Promise<string> {
		if (this.realRoot !== undefined) {
			return this.realRoot;
		}
		await mkdir(this.root, { recursive: true });
		// Cached only after it resolves, so a concurrent first call does not
		// leave the field holding a promise-shaped value.
		this.realRoot = await realpath(this.root);
		return this.realRoot;
	}
}

// ── path helpers ───────────────────────────────────────────────────────────

/** Decodes a percent-encoded path once, leaving undecodable input as it was. */
function decodeOnce(path: string): string {
	if (!path.includes('%')) {
		return path;
	}
	try {
		return decodeURIComponent(path);
	} catch {
		// A bare `%` is a legal filename character, so a path that is not valid
		// percent-encoding is a real path and not an attack.
		return path;
	}
}

/** Splits a root-relative path into the area it belongs to and the rest. */
function splitArea(path: string): {
	readonly area: StorageArea;
	readonly rest: string;
	/** The path after decoding, which is what every later check looks at. */
	readonly decoded: string;
} {
	if (typeof path !== 'string' || path.trim().length === 0) {
		throw new ValidationError('A storage path must be a non-empty string', {
			details: { received: typeof path },
		});
	}
	if (path.includes('\0')) {
		throw new ValidationError('A storage path cannot contain a null byte', { details: { path } });
	}

	// Decoded before anything looks at it, never after. `%2e%2e%2f` is checked as
	// the `../` it spells, which is the only order in which it can be caught.
	const decoded = decodeOnce(path);

	// Check for empty segments caused by `//`, `\\`, or mixed `/\` *before* collapsing.
	// This catches `memory/personal//file.md` which would otherwise be normalized away.
	if (/\/[\\/]|[\\/]\/|[\\/]{2,}/.test(decoded)) {
		throw new ValidationError(`A storage path may not contain "." or an empty segment: "${decoded}"`, {
			details: { path: decoded },
		});
	}

	// `\` counts as a separator, so a Windows-style path cannot smuggle a level
	// past a check that only looked at `/`.
	const segments = decoded.split(/[\\/]+/);

	// `C:notes.md` is drive-*relative*: it passes a plain segment check and is
	// then joined onto the root as a segment name, so it is caught by name.
	if (segments.length > 0 && /^[a-zA-Z]:$/.test(segments[0] ?? '')) {
		throw new ValidationError(`A storage path cannot name a drive: "${decoded}"`, {
			details: { path: decoded },
		});
	}
	// An empty first segment is what an absolute path looks like once `/` and
	// `\` are both separators. Checked here rather than with `path.isAbsolute`,
	// whose answer depends on the platform doing the checking — and a path that
	// is absolute on one and relative on the other is a path that passes a check
	// on the machine of whoever wrote it.
	if ((segments[0] ?? 'x').length === 0) {
		throw new ValidationError(`A storage path must be relative to the storage root: "${decoded}"`, {
			details: { path: decoded },
		});
	}

	for (const area of AREAS) {
		const parts = area.split('/');
		if (parts.every((part, index) => segments[index] === part)) {
			return { area, rest: segments.slice(parts.length).join('/'), decoded };
		}
	}
	// Refused rather than guessed. Defaulting an unrecognised path to the first
	// area would let anything land under an area that happened to match, and
	// would let `secrets.json` be written somewhere writable.
	throw new ValidationError(
		`A storage path must begin with one of: ${AREAS.join(', ')} — received "${decoded}"`,
		{ details: { path: decoded, areas: [...AREAS] } },
	);
}

/**
 * Rejects the segments that walk somewhere.
 *
 * `.` and empty segments are refused alongside `..` even though neither can
 * escape on its own: a path with an empty segment is a path built by joining
 * something that was not a plain name, and accepting it means the join is no
 * longer the last word on where the file goes.
 */
function assertSafeSegments(segments: readonly string[], original: string): void {
	for (const segment of segments) {
		if (segment === '..') {
			throw new ValidationError(`A storage path may not contain "..": "${original}"`, {
				details: { path: original },
			});
		}
		if (segment === '.' || segment.length === 0) {
			throw new ValidationError(`A storage path may not contain "." or an empty segment: "${original}"`, {
				details: { path: original },
			});
		}
		if (segment.length > MAX_SEGMENT_LENGTH) {
			throw new ValidationError(
				`A path segment cannot be longer than ${MAX_SEGMENT_LENGTH} characters`,
				{ details: { path: original } },
			);
		}
		if (segment.endsWith(' ') || segment.endsWith('.')) {
			// Windows silently strips these, so `notes.md ` and `notes.md` are one
			// file and a caller comparing names would be comparing two things.
			throw new ValidationError(
				`A path segment cannot end with a space or a dot: "${segment}"`,
				{ details: { path: original } },
			);
		}
	}
}

function assertNotReserved(segment: string, original: string): void {
	const stem = (segment.split('.')[0] ?? '').toLowerCase();
	if (RESERVED_NAMES.has(stem)) {
		throw new ValidationError(
			`"${segment}" is a reserved device name on Windows and cannot be a file`,
			{ details: { path: original, segment } },
		);
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
	);
}

/** Reading a directory as a file. Node reports `EISDIR` on both platforms. */
function isADirectory(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { code?: string }).code === 'EISDIR'
	);
}

function notADirectory(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { code?: string }).code === 'ENOTDIR'
	);
}

/** Removes a whole storage tree. Used by tests, and by a future "reset". */
export async function removeStorageRoot(rootPath: string): Promise<void> {
	try {
		await rm(rootPath, { recursive: true, force: true });
	} catch (error) {
		throw new StorageError(`Could not remove the storage directory at ${rootPath}`, {
			cause: error,
			details: { path: rootPath },
		});
	}
}

// `AREAS` is exported so a caller can offer the four areas as choices rather
// than hard-coding the same list in a menu, which is how a fifth would be added
// in one place and forgotten in the other.
export { AREAS as STORAGE_AREAS };
