/**
 * Builds the local web server.
 *
 * Separado do `esbuild.desktop.js` pelo mesmo motivo que aquele é separado do
 * `esbuild.js` da extensão: são hosts diferentes, e misturar as flags de um
 * no outro é como um bundle passa a carregar Electron sem ninguém notar.
 *
 * Two outputs:
 *
 *   dist/web/main.js      node + CommonJS — the process entry point
 *   dist/web/assets/*     the page, served by the server as-is
 *
 * Electron is neither `external` nor bundled: the server must not import it,
 * and the build fails if someone tries, which is the point.
 */
const esbuild = require('esbuild');
const { cp, mkdir } = require('node:fs/promises');
const { join } = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const root = __dirname;
const outDir = join(root, 'dist', 'web');

async function copyAssets() {
	const from = join(root, 'src', 'web', 'assets');
	const to = join(outDir, 'assets');
	await mkdir(to, { recursive: true });
	for (const name of ['index.html', 'index.css', 'index.js']) {
		await cp(join(from, name), join(to, name));
	}
	// O manifesto que o servidor le para dizer a versao no health.
	await cp(join(root, 'package.json'), join(outDir, 'package.json'));
}

async function main() {
	await copyAssets();
	const options = {
		bundle: true,
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'info',
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		entryPoints: [join(root, 'src', 'web', 'main.ts')],
		outfile: join(outDir, 'main.js'),
	};

	const context = await esbuild.context(options);
	if (watch) {
		await context.watch();
		console.log('[watch] web build watching');
		return;
	}
	await context.rebuild();
	await context.dispose();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
