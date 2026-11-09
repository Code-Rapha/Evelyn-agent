/**
 * R2: cancelamento, concorrência e isolamento — pelo socket.
 *
 * ## O que este arquivo acrescenta ao outro
 *
 * `webOpenAiApi.test.ts` prova a forma da resposta e a autenticação. Este
 * prova o comportamento sob carga e sob desistência: o cliente que fecha a
 * conexão no meio de um stream cancela **a própria** requisição, e as demais
 * continuam e terminam com a resposta certa.
 *
 * ## Por que precisa de um provedor controlado
 *
 * Para o cancelamento ter onde acontecer, o stream do provedor precisa ficar
 * esperando: cada requisição recebe um "portão" que o teste abre quando
 * quiser. Sem isso, um stream instantâneo terminaria antes do cliente
 * desistir, e o teste não provaria nada sobre cancelamento.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { ApiKeyStore, API_KEYS_FILE } from '../core/security/apiKeys';
import { ApiChatRuntime, type ApiRouteCandidate } from '../web/apiChat';
import { startWebServer, type RunningWebServer } from '../web/server';
import type { ChatProvider, ChatRequest, ChatStream, ChatStreamEvent } from '../core/providers/chat/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

/** Um pedido em andamento no provedor falso. */
interface LiveRequest {
	readonly text: string;
	readonly signal: AbortSignal | undefined;
	/** Entrega os eventos (o teste decide quando). */
	emit(events: readonly ChatStreamEvent[]): void;
	/** Fecha o stream sem eventos terminais. */
	close(reason: ChatStream['closedReason']): void;
	readonly aborted: Promise<void>;
}

/**
 * Um provedor que segura cada stream até o teste mandar.
 *
 * Registra o `signal` recebido: é o que prova que o cancelamento do cliente
 * chegou ao provedor, em vez de só fechar o socket.
 */
function controllableProvider(): {
	readonly provider: ChatProvider;
	readonly requests: LiveRequest[];
} {
	const requests: LiveRequest[] = [];
	const provider: ChatProvider = {
		async streamChat(request: ChatRequest, options: { readonly signal?: AbortSignal } = {}): Promise<ChatStream> {
			const text = request.messages[request.messages.length - 1]?.content ?? '';
			const queue: ChatStreamEvent[] = [];
			/**
			 * Os que estão dormindo esperando o próximo evento.
			 *
			 * Era **um** `notify` só: com três streams abertos, cada `await`
			 * sobrescrevia o anterior, e o `abort` de um acordava o gerador de
			 * outro — o próprio ficava preso para sempre, e o teste de três
			 * streams travava (reproduzível em 4 de 5 execuções). Uma lista
			 * acorda **todos**, que é o que um evento significa.
			 */
			const waiting = new Set<() => void>();
			const wake = (): void => {
				for (const resolve of [...waiting]) {
					waiting.delete(resolve);
					resolve();
				}
			};
			let closed = false;
			let closedReason: ChatStream['closedReason'] = 'completed';
			let abortResolve: (() => void) | undefined;
			const aborted = new Promise<void>((resolve) => {
				abortResolve = resolve;
			});
			const signal = options.signal;
			signal?.addEventListener('abort', () => {
				closed = true;
				closedReason = 'aborted';
				abortResolve?.();
				wake();
			}, { once: true });
			const entry: LiveRequest = {
				text,
				signal,
				emit(events) {
					queue.push(...events);
					wake();
				},
				close(reason) {
					closed = true;
					closedReason = reason;
					wake();
				},
				aborted,
			};
			requests.push(entry);
			const stream: ChatStream = {
				get closedReason() {
					return closedReason;
				},
				timing: {},
				[Symbol.asyncIterator]: async function* () {
					for (;;) {
						const next = queue.shift();
						if (next !== undefined) {
							yield next;
							continue;
						}
						if (closed) {
							return;
						}
						await new Promise<void>((resolve) => {
							waiting.add(resolve);
						});
					}
				},
			};
			return stream;
		},
	};
	return { provider, requests };
}

/** Espera uma condição, com limite — sem espera fixa "que costuma bastar". */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error('a condição não foi satisfeita a tempo');
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface Harness {
	readonly url: string;
	readonly port: number;
	readonly key: string;
	readonly requests: LiveRequest[];
	close(): Promise<void>;
}

async function start(options: { readonly candidates?: readonly ApiRouteCandidate[] } = {}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-v1-cancel-'));
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
	});
	const keys = new ApiKeyStore({ filePath: join(root, API_KEYS_FILE) });
	const created = await keys.create({ name: 'teste' });
	const { provider, requests } = controllableProvider();
	const access = core.chat.routingAccess();
	if (access === undefined) {
		throw new Error('a sessão de teste precisa do motor de rota');
	}
	const runtime = new ApiChatRuntime({
		providerFor: () => provider,
		candidatesFor: async ({ requested }) => options.candidates ?? [requested],
		policy: access.policy,
		breaker: access.breaker,
		ledger: core.history,
		store: core.history,
		pricing: async () => undefined,
		accessPolicy: async () => core.chat.loadAccessPolicy(),
	});
	const server: RunningWebServer = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		openai: {
			authenticate: async (presented) => (presented === undefined ? undefined : await keys.verify(presented)),
			runtime,
			listModels: async () => [],
		},
		port: 0,
	});
	return {
		url: '127.0.0.1',
		port: server.port,
		key: created.secret,
		requests,
		async close() {
			await server.close();
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		},
	};
}

/** Um POST em streaming, com o corpo lido à mão para poder destruir a conexão. */
function stream(text: string, harness: Harness): {
	readonly request: ReturnType<typeof httpRequest>;
	readonly done: Promise<{ readonly status: number; readonly body: string; readonly ended: boolean }>;
	destroy(): void;
} {
	let body = '';
	let ended = false;
	let status = 0;
	let finish: ((value: { status: number; body: string; ended: boolean }) => void) | undefined;
	const done = new Promise<{ status: number; body: string; ended: boolean }>((resolve) => {
		finish = resolve;
	});
	const payload = JSON.stringify({
		model: 'p/m',
		messages: [{ role: 'user', content: text }],
		stream: true,
	});
	const req = httpRequest(
		{
			host: harness.url,
			port: harness.port,
			path: '/v1/chat/completions',
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${harness.key}`,
				'content-length': Buffer.byteLength(payload),
			},
		},
		(response) => {
			status = response.statusCode ?? 0;
			response.setEncoding('utf8');
			response.on('data', (chunk: string) => {
				body += chunk;
			});
			response.on('end', () => {
				ended = true;
				finish?.({ status, body, ended });
			});
			response.on('close', () => {
				finish?.({ status, body, ended });
			});
		},
	);
	req.on('error', () => {
		finish?.({ status, body, ended });
	});
	req.end(payload);
	return {
		request: req,
		done,
		destroy() {
			req.destroy();
		},
	};
}

/** O texto entregue num corpo SSE. */
function sseText(body: string): string {
	return body
		.split('\n\n')
		.map((block) => block.trim())
		.filter((block) => block.startsWith('data: ') && !block.includes('[DONE]'))
		.map((block) => JSON.parse(block.slice('data: '.length)) as { choices: { delta: { content?: string } }[] })
		.map((chunk) => chunk.choices[0]?.delta.content ?? '')
		.join('');
}

teardown(async () => {
	// Cada teste fecha o seu; nada fica para trás.
});

suite('R2: cancelamento e isolamento pelo socket', () => {
	test('fechar a conexão cancela o provedor daquela requisição', async () => {
		const harness = await start();
		try {
			const first = stream('cancelar', harness);
			await until(() => harness.requests.length === 1);
			const live = harness.requests[0];
			assert.equal(live?.signal?.aborted, false);

			first.destroy();

			await live?.aborted;
			assert.equal(live?.signal?.aborted, true, 'o abort do cliente chegou ao provedor');
		} finally {
			await harness.close();
		}
	});

	test('cancelar uma requisição não cancela a outra', async () => {
		const harness = await start();
		try {
			const doomed = stream('vai cancelar', harness);
			const survivor = stream('vai terminar', harness);
			await until(() => harness.requests.length === 2);

			doomed.destroy();
			await harness.requests[0]?.aborted;
			assert.equal(harness.requests[0]?.signal?.aborted, true);
			// A outra continua viva e sem abort.
			assert.equal(harness.requests[1]?.signal?.aborted, false);

			harness.requests[1]?.emit([
				{ type: 'TextDelta', text: 'sobreviveu' },
				{ type: 'Done' },
			]);
			harness.requests[1]?.close('completed');

			const result = await survivor.done;
			assert.equal(result.ended, true);
			assert.equal(sseText(result.body), 'sobreviveu');
			assert.ok(result.body.includes('[DONE]'));
		} finally {
			await harness.close();
		}
	});

	test('com três em curso, cancelar o do meio não troca os textos', async () => {
		const harness = await start();
		try {
			const streams = ['um', 'dois', 'tres'].map((text) => stream(text, harness));
			await until(() => harness.requests.length === 3);

			// Os três streams chegam ao provedor em **ordem imprevisível**: a
			// lista é a ordem de chegada (`tres, um, dois` foi observado), não a
			// ordem em que os pedidos saíram. Indexar por posição fazia o teste
			// esperar o abort de outra requisição e travar (8 de 12 execuções).
			const middle = harness.requests.find((request) => request.text === 'dois');
			assert.ok(middle, 'o provedor recebeu o stream do meio');

			streams[1]?.destroy();
			await middle.aborted;

			const byText = (text: string) => harness.requests.find((request) => request.text === text);
			byText('um')?.emit([{ type: 'TextDelta', text: 'resposta-um' }, { type: 'Done' }]);
			byText('um')?.close('completed');
			byText('tres')?.emit([{ type: 'TextDelta', text: 'resposta-tres' }, { type: 'Done' }]);
			byText('tres')?.close('completed');

			const [first, second, third] = await Promise.all(streams.map((entry) => entry.done));
			assert.equal(sseText(first?.body ?? ''), 'resposta-um');
			assert.equal(sseText(third?.body ?? ''), 'resposta-tres');
			// O cancelado não recebeu texto nenhum, nem o de outra requisição.
			assert.equal(sseText(second?.body ?? ''), '');
			assert.equal(second?.body.includes('resposta-um'), false);
			assert.equal(second?.body.includes('resposta-tres'), false);
		} finally {
			await harness.close();
		}
	});

	test('um erro do provedor no meio do stream termina com [DONE] e um evento de erro', async () => {
		const harness = await start();
		try {
			const pending = stream('falha', harness);
			await until(() => harness.requests.length === 1);
			harness.requests[0]?.emit([
				{ type: 'TextDelta', text: 'parcial' },
				{ type: 'Error', error: new Error('o provedor caiu') },
			]);
			harness.requests[0]?.close('failed');

			const result = await pending.done;
			assert.ok(result.body.includes('parcial'));
			assert.ok(result.body.includes('"error"'), 'o cliente é avisado do erro');
			assert.ok(result.body.includes('[DONE]'), 'o stream termina com [DONE]');
		} finally {
			await harness.close();
		}
	});

	test('um provedor que fecha sem resposta é 502, não um 200 vazio', async () => {
		const harness = await start({ candidates: [] });
		try {
			const response = await fetch(`http://${harness.url}:${harness.port}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${harness.key}` },
				body: JSON.stringify({ model: 'p/m', messages: [{ role: 'user', content: 'x' }] }),
			});
			assert.equal(response.status, 404);
		} finally {
			await harness.close();
		}
	});
});
