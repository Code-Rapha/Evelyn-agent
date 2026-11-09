/**
 * Write-to-temp-then-rename: the durable shape every local store shares.
 *
 * A plain `writeFile` can leave a half-written file behind if the process
 * dies mid-write — which, for `state.json`, is exactly how a user's saved
 * providers disappear. `rename` within a directory is atomic on the platforms
 * this runs on, so a reader sees either the old file or the new one, never
 * the middle of both.
 *
 * A failed `rename` removes the temp and rethrows: the destination still
 * holds the previous content, so the caller's error costs nothing on disk.
 *
 * A sharing violation on the destination — a reader holding it open, common on
 * Windows — is retried once before the error is reported: the destination was
 * never truncated, so the second attempt starts from the same place.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Distinguishes concurrent writers in the same process: two live stores
 * hitting the same path would otherwise share one temp name.
 */
let sequence = 0;

export interface WriteFileAtomicOptions {
	/** Unix mode for the new file. Applied to the temp, which `rename` keeps. */
	readonly mode?: number;
}

export async function writeFileAtomic(
	filePath: string,
	contents: string,
	options: WriteFileAtomicOptions = {},
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const target = filePath;
	const write = async (): Promise<void> => {
		sequence += 1;
		const temp = `${target}.${process.pid}.${sequence}.tmp`;
		await writeFile(temp, contents, {
			encoding: 'utf8',
			...(options.mode !== undefined ? { mode: options.mode } : {}),
		});
		try {
			await rename(temp, target);
		} catch (error) {
			await rm(temp, { force: true }).catch(() => undefined);
			throw error;
		}
	};
	try {
		await write();
	} catch (error) {
		if (!isSharingViolation(error)) {
			throw error;
		}
		// One short wait, then a single retry. A lock that outlives it is a
		// real failure and is reported as such, not hidden behind a loop.
		await new Promise((resolve) => setTimeout(resolve, 15));
		await write();
	}
}

/** `EBUSY`/`EPERM` from `rename` on Windows: another handle has the file open. */
function isSharingViolation(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	const code = (error as { readonly code?: unknown }).code;
	return code === 'EBUSY' || code === 'EPERM';
}
