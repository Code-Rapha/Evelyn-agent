/**
 * The Core/Electron boundary.
 *
 * `core/` is host-free: it must not import `electron`, and it must not import
 * anything from `desktop/` either. The dependency is allowed to point one way —
 * the desktop host reaches into the Core, never the reverse — and this suite is
 * what keeps that true as both sides grow.
 *
 * A source scan rather than an import attempt, because an import that resolves
 * proves nothing about files nobody imported yet. Every `.ts` under `core/` is
 * read, so the check covers new files the moment they are added.
 *
 * Runs under plain mocha via `npm run test:core`, outside any host.
 */
import * as assert from 'assert';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Directories that must never reach for a host. */
const HOST_FREE_ROOTS = ['core'];

/** Host modules a Core file has no business naming. */
const FORBIDDEN_IMPORTS = ['electron'];

async function collectTypeScriptFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) {
			found.push(...(await collectTypeScriptFiles(full)));
		} else if (entry.name.endsWith('.ts')) {
			found.push(full);
		}
	}
	return found;
}

suite('Boundary: the Core stays free of the desktop host', () => {
	/**
	 * The sources under `src/`.
	 *
	 * Resolved from `__dirname`, which is `out/core-tests/` after compilation,
	 * so the parent is `out/` — the sibling of the `src/` tree being scanned.
	 */
	const srcRoot = join(__dirname, '..', '..', 'src');

	test('no file under core/ imports electron or the desktop folder', async () => {
		const offenders: string[] = [];

		for (const directory of HOST_FREE_ROOTS) {
			const files = await collectTypeScriptFiles(join(srcRoot, directory));
			assert.ok(files.length > 0, `expected to find sources under ${directory}`);

			for (const file of files) {
				const source = await readFile(file, 'utf8');
				for (const forbidden of FORBIDDEN_IMPORTS) {
					// Matches `from 'electron'`, `require('electron')` and
					// `import('electron')` — any way of naming it counts.
					const pattern = new RegExp(`['"]${forbidden}['"]`);
					if (pattern.test(source)) {
						offenders.push(`${relative(srcRoot, file)} references "${forbidden}"`);
					}
				}
				// A relative climb into ../desktop is the same violation by
				// another route.
				if (/from\s+['"][^'"]*\/desktop\//.test(source)) {
					offenders.push(`${relative(srcRoot, file)} imports from ../desktop/`);
				}
			}
		}

		assert.deepStrictEqual(offenders, [], `the Core must not know about Electron:\n${offenders.join('\n')}`);
	});

	test('the desktop host does import the Core, so the dependency points one way', async () => {
		const main = await readFile(join(srcRoot, 'desktop', 'main.ts'), 'utf8');

		// The point of the rule above: the host is allowed to reach in, and it
		// does. If this stops being true the Core has been bypassed, not freed.
		assert.match(main, /from '\.\.\/core\//);
	});
});