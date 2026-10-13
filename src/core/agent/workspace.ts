/**
 * Workspace containment for file tools.
 *
 * Every path a model supplies is untrusted: it may contain `../`, an absolute
 * path from a different project, or a symlink pointing outside. This module is
 * the single place that decides whether a path is allowed, so `read_file`,
 * `write_file` and `list_files` cannot disagree about what "inside" means.
 *
 * The check is: resolve the real path, resolve the real workspace root, and
 * require the first to be the second or below it. Comparing resolved paths
 * rather than the string is what catches symlinks and `..` alike.
 */
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { StorageError } from '../errors';

/** Raised when a path resolves outside the workspace. */
export class WorkspaceEscapeError extends StorageError {
	constructor(path: string, workspace: string) {
		super(`The path "${path}" resolves outside the workspace`, {
			details: { path, workspace },
		});
		this.name = 'WorkspaceEscapeError';
	}
}

/**
 * The workspace a set of tools is bound to.
 *
 * Created once per project and injected into every tool, so the boundary cannot
 * be moved by a tool call.
 */
export class Workspace {
	/** The path as given, for error messages. */
	readonly root: string;

	private realRootPromise: Promise<string> | undefined;

	constructor(root: string) {
		if (typeof root !== 'string' || root.trim().length === 0) {
			throw new StorageError('A workspace needs a root directory');
		}
		this.root = resolve(root);
	}

	/**
	 * The workspace root with symlinks resolved.
	 *
	 * Cached: the root does not move while a turn runs, and `realpath` is a
	 * syscall. A root that does not exist yet falls back to the resolved path,
	 * so a project directory created moments ago still works.
	 */
	private realRoot(): Promise<string> {
		this.realRootPromise =
			this.realRootPromise ?? realpath(this.root).catch(() => this.root);
		return this.realRootPromise;
	}

	/**
	 * Resolves a workspace-relative path and proves it stays inside.
	 *
	 * Absolute inputs are allowed only when they point inside the workspace —
	 * a model that echoes back an absolute path it was given should not fail.
	 */
	async resolveInside(path: string): Promise<string> {
		if (typeof path !== 'string' || path.trim().length === 0) {
			throw new StorageError('A path is required');
		}

		const root = await this.realRoot();
		const candidate = resolve(root, path);

		// Reject before touching the filesystem when the lexical form already
		// escapes; this is the cheap check and catches the obvious cases.
		if (!isInside(candidate, root)) {
			throw new WorkspaceEscapeError(path, root);
		}

		// Then re-check with symlinks resolved, because `root/link/../outside`
		// and a symlinked file both pass the lexical test.
		const real = await realpath(candidate).catch(() => candidate);
		if (!isInside(real, root)) {
			throw new WorkspaceEscapeError(path, root);
		}
		return real;
	}

	/**
	 * Like `resolveInside`, but tolerates a path that does not exist yet.
	 * `write_file` creating a new file needs this.
	 */
	async resolveInsideForCreate(path: string): Promise<string> {
		if (typeof path !== 'string' || path.trim().length === 0) {
			throw new StorageError('A path is required');
		}
		const root = await this.realRoot();
		const candidate = resolve(root, path);
		if (!isInside(candidate, root)) {
			throw new WorkspaceEscapeError(path, root);
		}
		// The file itself may not exist, so resolve the deepest existing parent
		// and check that instead: `dir/../../outside/new.txt` still escapes, but
		// `dir/new.txt` is fine.
		//
		// What is checked is the *resolved* parent, not the lexical one. The
		// lexical form of `link/new.txt` sits inside the workspace whether or not
		// `link` is a symlink to somewhere else, and the write would follow it —
		// so a check on the unresolved string would bless an escape.
		const existing = await nearestExisting(candidate);
		if (existing === undefined || !isInside(existing, root)) {
			throw new WorkspaceEscapeError(path, root);
		}
		return candidate;
	}

	/**
	 * The workspace root with symlinks resolved, for handing to a child
	 * process as its cwd. A process cannot be containment-checked, so it is
	 * only ever started at a root this class already vouched for.
	 */
	async realRootForExecution(): Promise<string> {
		return this.realRoot();
	}

	/** True when `candidate` is `root` or below it. */
	async contains(candidate: string): Promise<boolean> {
		const root = await this.realRoot();
		const real = await realpath(candidate).catch(() => resolve(candidate));
		return isInside(real, root);
	}
}

/**
 * Path containment by string comparison on already-resolved paths.
 *
 * The separator is appended so `/work/app2` is not accepted as inside
 * `/work/app`.
 */
function isInside(candidate: string, root: string): boolean {
	if (candidate === root) {
		return true;
	}
	const withSep = root.endsWith(sep) ? root : `${root}${sep}`;
	return candidate.startsWith(withSep);
}

/**
 * The deepest existing ancestor of `path`, with its own symlinks resolved.
 *
 * Returning the *resolved* path is the whole point. `realpath` was already
 * being called here and its result thrown away, which left the containment
 * check comparing a string the filesystem had never seen: `root/link/new.txt`
 * reads as inside the workspace whether `root/link` is a real directory or a
 * symlink pointing out of it, and the write would follow it either way.
 *
 * The walk stops at the first ancestor that exists, and everything below it
 * does not exist yet — which is exactly why no further symlinks can hide in
 * that tail. Resolving that one ancestor therefore settles the whole path.
 *
 * Returns `undefined` when nothing up to the filesystem root exists.
 */
async function nearestExisting(path: string): Promise<string | undefined> {
	let current = path;
	// Stop at the filesystem root, where resolve() stops changing anything.
	for (let depth = 0; depth < 64; depth += 1) {
		try {
			return await realpath(current);
		} catch {
			const parent = resolve(current, '..');
			if (parent === current) {
				return undefined;
			}
			current = parent;
		}
	}
	return undefined;
}