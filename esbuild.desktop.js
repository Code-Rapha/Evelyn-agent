/**
 * Builds the desktop app.
 *
 * A separate script from `esbuild.js` on purpose: the extension bundles to a
 * single `dist/extension.js` for `vsce`, and folding Electron into it would
 * mean either shipping Electron in the .vsix or duplicating every build flag.
 * Two hosts, two bundles, no shared state.
 *
 * Three outputs, because the three processes do not run the same way:
 *
 *   dist/desktop/main.js       node  + CommonJS, external: electron
 *   dist/desktop/preload.js    node  + CommonJS, external: electron
 *   dist/desktop/renderer/*    browser + IIFE, with index.html and index.css
 *   dist/desktop/package.json  the packaged app's manifest (see below)
 *
 * Electron is `external` in main and preload: it is provided by the runtime, and
 * bundling a copy would break its native bindings. The renderer gets no
 * `external` list at all, so any accidental import of Node or Electron in it
 * fails the build instead of shipping.
 *
 * `__APP_VERSION__` comes from the root package.json. Reading it at runtime
 * would mean shipping package.json next to the bundle and resolving a path that
 * changes between `electron .` and a packaged app; substituting it at build time
 * is one less moving part.
 */
const esbuild = require('esbuild');
const { readFileSync } = require('node:fs');
const { cp, mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const root = __dirname;
const outDir = join(root, 'dist', 'desktop');

/**
 * Reads the version from the root package.json.
 *
 * Synchronous on purpose: it feeds `define`, which is evaluated while the
 * option object is being built. An async read would put a pending Promise into
 * the substitution, and `JSON.stringify` would quietly turn that into `{}`.
 */
function readVersion(from) {
	return JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).version;
}

/** @type {import('esbuild').BuildOptions} */
const common = {
	bundle: true,
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	logLevel: 'info',
	define: {
		__APP_VERSION__: JSON.stringify(readVersion(root)),
	},
};

/** Copies the static renderer assets next to the bundled script. */
async function copyRendererAssets() {
	const from = join(root, 'src', 'desktop', 'renderer');
	const to = join(outDir, 'renderer');
	await mkdir(to, { recursive: true });
	await Promise.all([
		cp(join(from, 'index.html'), join(to, 'index.html')),
		cp(join(from, 'index.css'), join(to, 'index.css')),
	]);
}

/**
 * Writes the manifest of the *packaged* app.
 *
 * `dist/desktop` has to be a self-contained Electron app directory: the root
 * `package.json` belongs to the VS Code extension and points `main` at
 * `./dist/extension.js`, which is not a desktop entry point. Packing the root
 * would ship the extension, its `contributes` block and every devDependency.
 *
 * Written by the build rather than checked in, so the version cannot drift from
 * the root `package.json` — the same reasoning as `__APP_VERSION__` above.
 */
async function writeAppManifest() {
	const version = readVersion(root);
	await writeFile(
		join(outDir, 'package.json'),
		`${JSON.stringify(
			{
				name: 'seshyina',
				productName: 'Seshyina',
				version,
				private: true,
				description: 'Seshyina desktop chat',
				main: 'main.js',
			},
			null,
			2,
		)}\n`,
	);
}

async function main() {
	await copyRendererAssets();
	await writeAppManifest();

	const builds = [
		{
			...common,
			entryPoints: [join(root, 'src', 'desktop', 'main.ts')],
			platform: 'node',
			format: 'cjs',
			target: 'node20',
			outfile: join(outDir, 'main.js'),
			external: ['electron'],
		},
		{
			...common,
			entryPoints: [join(root, 'src', 'desktop', 'preload.ts')],
			platform: 'node',
			format: 'cjs',
			target: 'node20',
			outfile: join(outDir, 'preload.js'),
			external: ['electron'],
		},
		{
			...common,
			entryPoints: [join(root, 'src', 'desktop', 'renderer', 'index.ts')],
			platform: 'browser',
			format: 'iife',
			target: 'es2022',
			outfile: join(outDir, 'renderer', 'index.js'),
		},
	];

	const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
	if (watch) {
		await Promise.all(contexts.map((context) => context.watch()));
		console.log('[watch] desktop build watching');
		return;
	}
	await Promise.all(contexts.map((context) => context.rebuild()));
	await Promise.all(contexts.map((context) => context.dispose()));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});