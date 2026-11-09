/**
 * `node dist/web/main.js` — a entrada do processo do servidor local.
 *
 * So le a linha de comando, sobe o host e imprime onde a interface esta.
 * A logica esta em `src/host/web/index.ts`, que responde a chamada, nao a
 * linha de comando, e pode ser usada por um teste.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { startWebHost } from '../host/web/index';
import { serviceStatus, stopService, waitForStop } from '../app/serviceLifecycle';
import { defaultDataStoreRoot } from '../adapters/local/fileDataStore';

const args = process.argv.slice(2);

function option(name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

const rootOption = option('--root');
const portText = option('--port');
const parsedPort = portText === undefined ? undefined : Number(portText);
const port = parsedPort !== undefined && Number.isInteger(parsedPort) ? parsedPort : undefined;

/**
 * A versao que o health reporta, lida do manifesto ao lado do bundle.
 *
 * Um valor fixo no codigo envelheceria calado; o health existe justamente
 * para dizer o que esta rodando.
 */
async function readVersion(): Promise<string> {
	try {
		const raw = await readFile(join(__dirname, 'package.json'), 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
			return String((parsed as { readonly version: unknown }).version);
		}
		return '0.0.0';
	} catch {
		return '0.0.0';
	}
}

async function main(): Promise<void> {
	const rootPath = rootOption ?? defaultDataStoreRoot();
	// `--status` e `--stop` falam com o serviço **já em execução**; não montam
	// nada. São a única forma de encerrar o serviço sem depender do Electron.
	//
	// A saída é pelo `exitCode` e pelo retorno, nunca por `process.exit()`
	// imediato: no Windows, encerrar o processo com sockets/handles ainda em
	// fechamento aborta o libuv (`UV_HANDLE_CLOSING`), e o código de saída vira
	// uma falha de processo em vez do valor pedido.
	if (args.includes('--status')) {
		const status = await serviceStatus({ root: rootPath });
		process.stdout.write(`${status.line}\n`);
		process.exitCode = status.probe.kind === 'active' ? 0 : 1;
		return;
	}
	if (args.includes('--stop')) {
		const result = await stopService({ root: rootPath });
		if (result.kind === 'stopped') {
			await waitForStop({ root: rootPath });
			process.stdout.write(`serviço encerrado (processo ${result.pid})\n`);
			return;
		}
		process.stdout.write(
			result.kind === 'not-running'
				? `nada a encerrar: ${result.reason}\n`
				: `recusado: ${result.reason}\n`,
		);
		process.exitCode = result.kind === 'not-running' ? 0 : 1;
		return;
	}

	const version = await readVersion();
	let closing = false;
	/**
	 * Encerra o host e devolve o processo.
	 *
	 * Usado por Ctrl+C, por `SIGTERM` (onde houver) e pelo pedido HTTP do
	 * `--stop`. O `close` do host libera o lock e os recursos; o processo sai
	 * sozinho quando o último handle fecha.
	 */
	const close = async (): Promise<void> => {
		if (closing) {
			return;
		}
		closing = true;
		await host.close();
		process.exitCode = 0;
	};

	const host = await startWebHost({
		...(rootPath !== undefined ? { rootPath } : {}),
		...(port !== undefined ? { port } : {}),
		assetsDir: option('--app') ?? join(__dirname, 'assets'),
		version,
		// O encerramento pedido por API (o que `--stop` usa) passa pelo mesmo
		// caminho do Ctrl+C.
		requestShutdown: () => void close(),
	});

	console.log('');
	console.log('  Evelyn - servidor local');
	console.log(`  raiz dos dados: ${host.rootPath}`);
	console.log(`  abra no navegador: ${host.server.entryUrl}`);
	console.log('');
	if (host.storageNote !== undefined) {
		// A raiz não é deste host: o servidor está no ar, mas sem o Core.
		// Dizer isso aqui é o que impede o operador de achar que os dados
		// estão sendo usados.
		console.log(`  ATENCAO: ${host.storageNote}`);
		console.log('  O servidor responde ao health, mas sem montar o Core.');
		console.log('');
	}
	console.log('  Ctrl+C encerra e libera a raiz.');
	console.log('');

	process.on('SIGINT', () => void close());
	process.on('SIGTERM', () => void close());
	// Último recurso: se o processo estiver saindo por um caminho que não
	// chamou `close`, ele ainda tenta liberar o que puder antes de morrer.
	process.on('beforeExit', () => void close());
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
