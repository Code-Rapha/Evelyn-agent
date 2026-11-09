/**
 * Packages the desktop app for Windows.
 *
 * Uses `@electron/packager` — the plain runtime packager, not `electron-builder`
 * — because the deliverable is a runnable app, not an installer with signing,
 * auto-update and a target matrix. Packager takes one already-built directory
 * and wraps a real Electron runtime around it; there is no config file, no
 * YAML, and nothing to keep in sync with the extension's `package.json`.
 *
 * The input is `dist/desktop`, which `esbuild.desktop.js` makes self-contained:
 * main, preload and renderer are bundled, the renderer assets are copied, and a
 * manifest pointing `main` at `./main.js` is written. Nothing under
 * `node_modules` ships — `electron` is `external` in the bundles because the
 * runtime provides it, and every other import is already inlined.
 *
 * `asar` is on: the app's JS is not readable as plain files by whatever else is
 * on the machine, and `__dirname` keeps working inside the archive, which is
 * what `main.ts` relies on to find `preload.js` and `renderer/index.html`.
 *
 * Output: `dist/release/Seshyina-win32-x64/Seshyina.exe` — o nome do pacote;
 * o nome visível é `Evelyn`.
 */
const { packager } = require('@electron/packager');
const { readFileSync } = require('node:fs');
const { readdir, stat, mkdir, cp } = require('node:fs/promises');
const { join } = require('node:path');

const root = __dirname;
const source = join(root, 'dist', 'desktop');
const out = join(root, 'dist', 'release');

/** O ícone do app, como está em `icons/`. */
const ICON_FILE = join('icons', 'evelyn_app_icon.ico');

/**
 * The Electron version to wrap with.
 *
 * Read from the installed `electron` rather than hardcoded: the packaged
 * runtime and the one `npm run desktop:start` uses are then the same build,
 * and bumping the dependency moves both at once.
 */
function electronVersion() {
	return JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))
		.version;
}

/** Copia uma árvore de diretórios, pulando o que casa com `skip`. */
async function copyTree(from, to, skip) {
	const entries = await readdir(from, { withFileTypes: true });
	for (const entry of entries) {
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		if (skip.test(entry.name)) {
			continue;
		}
		if (entry.isDirectory()) {
			await mkdir(target, { recursive: true });
			await copyTree(source, target, skip);
			continue;
		}
		await cp(source, target);
	}
}

/** Total size of a directory, for the summary line. */
async function directorySize(from) {
	let bytes = 0;
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else bytes += (await stat(path)).size;
		}
	};
	await walk(from);
	return bytes;
}

async function main() {
	const [appPath] = await packager({
		dir: source,
		out,
		// O nome do pacote determina a pasta e o `.exe` — e o Electron deriva
		// o diretório de dados (`userData`) dele. Renomeá-lo levaria os dados
		// do usuário junto na próxima execução, sem migração. Fica `Seshyina`
		// no build portátil; o nome visível é o das metadatas abaixo.
		name: 'Seshyina',
		platform: 'win32',
		arch: 'x64',
		electronVersion: electronVersion(),
		appVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
		asar: true,
		overwrite: true,
		// Sourcemaps are dev artifacts; a production build has none, but a stale
		// `dist/desktop` from a `desktop:build` would otherwise ship them.
		ignore: [/\.map$/],
		win32metadata: {
			CompanyName: 'ModelHub',
			FileDescription: 'Evelyn',
			ProductName: 'Evelyn',
		},
		// O ícone do próprio `.exe` (e a entrada na barra de tarefas do
		// pacote). Vem de `icons/`, não de `dist/desktop`: aqui é o executável
		// que recebe o ícone, e o packager o grava nos recursos do binário.
		icon: join(root, ICON_FILE),
	});

	// O serviço vai junto como **dados**: o `main.js` dele não é executado pelo
	// Electron (que não é Node), e sim pelo próprio `Seshyina.exe` com
	// `ELECTRON_RUN_AS_NODE=1`. Esta cópia é a fonte de onde o app extrai o
	// script para `userData` — um arquivo fora do `asar`, porque um script
	// dentro do arquivo empacotado não pode ser passado ao Node.
	const serviceSource = join(root, 'dist', 'web');
	const serviceTarget = join(appPath, 'resources', 'service');
	await mkdir(serviceTarget, { recursive: true });
	await copyTree(serviceSource, serviceTarget, /\.map$/);
	console.log(`[package] serviço incluído em ${serviceTarget}`);

	const size = await directorySize(appPath);
	console.log(`\n[package] ${appPath}`);
	console.log(`[package] ${(size / 1024 / 1024).toFixed(1)} MB — execute: ${join(appPath, 'Seshyina.exe')}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
