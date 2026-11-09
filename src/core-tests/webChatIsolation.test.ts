/**
 * R4C: isolamento de turnos concorrentes e ciclo de permissões.
 *
 * ## Por que este arquivo existe separado
 *
 * `webChatService.test.ts` prova o turno e a continuidade. Aqui o backend é
 * **lento de propósito**: cada resposta espera o teste liberar. É a única
 * forma de dois turnos estarem de fato em curso ao mesmo tempo — e de provar
 * que os eventos não se misturam quando chegam intercalados, e que cancelar
 * um não toca o outro.
 *
 * ## O que continua real
 *
 * O motor (`ChatSession.runTurn`), o roteamento, o laço de ferramentas, o
 * broker de permissões e o transporte SSE. O backend do modelo é local e
 * determinístico, pelo `fetchImpl` que o `assembleCore` aceita.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { startWebServer, CHAT_TOKEN_HEADER } from '../web/server';
import { EventQueue, WebChatEndpoint } from '../web/chatEndpoint';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12222/v1';
const CHAT_TOKEN = 'c'.repeat(64);

/** Um pedido em curso no backend falso. */
interface Pending {
	readonly messages: readonly { readonly role: string; readonly content: string }[];
	release(text: string): void;
}

/**
 * Um backend que apara cada pedido até o teste liberar.
 *
 * `pending` acumula os pedidos na ordem em que chegaram; o teste libera o que
 * quiser, o que permite a resposta de um turno chegar **depois** do outro —
 * exatamente a intercalação que precisa ser provada.
 */
function gateBackend(): { readonly fetchImpl: FetchLike; readonly pending: Pending[] } {
	const pending: Pending[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		if (url.endsWith('/models')) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }] }),
			};
		}
		const body = JSON.parse(String(init?.body ?? '{}')) as {
			readonly messages: readonly { readonly role: string; readonly content: string }[];
		};
		let release: ((chunks: readonly string[]) => void) | undefined;
		const chunks = new Promise<readonly string[]>((resolve) => {
			release = resolve;
		});
		const streamed = (text: string): readonly string[] => [
			`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
			'data: [DONE]\n\n',
		];
		pending.push({
			messages: body.messages ?? [],
			release: (text) => release?.(streamed(text)),
		});
		const response: FetchResponseLike = {
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					yield* await chunks;
				},
			},
			text: async () => (await chunks).join(''),
		};
		return response;
	};
	return { fetchImpl, pending };
}

interface Harness {
	readonly core: AssembledCore;
	readonly endpoint: WebChatEndpoint;
	readonly backend: ReturnType<typeof gateBackend>;
	readonly base: string;
	close(): Promise<void>;
}

async function start(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4c-iso-'));
	const backend = gateBackend();
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl: backend.fetchImpl,
	});
	await core.chat.saveProvider({ id: 'local', name: 'Local', baseUrl: BASE_URL });
	await core.chat.listModels('local').catch(() => undefined);
	const endpoint = new WebChatEndpoint({ session: core.chat });
	const server = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		chatToken: CHAT_TOKEN,
		chat: endpoint,
		port: 0,
	});
	return {
		core,
		endpoint,
		backend,
		base: `http://127.0.0.1:${server.port}`,
		async close() {
			await server.close();
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		},
	};
}

async function conversation(harness: Harness): Promise<string> {
	const created = await harness.core.chat.createConversation({ providerId: 'local', title: 'iso' });
	return created.summary.id;
}

/** Espera uma condição, com limite — sem dormir um tempo "que costuma bastar". */
async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`tempo esgotado esperando: ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Coleta os eventos de um turno à medida que chegam. */
async function consume(
	endpoint: WebChatEndpoint,
	input: { readonly conversationId: string; readonly text: string },
): Promise<{ readonly turnId: string; readonly events: Record<string, unknown>[] }> {
	const started = await endpoint.start({
		conversationId: input.conversationId,
		providerId: 'local',
		model: 'local/modelo-a',
		text: input.text,
	});
	if (started.kind !== 'started') {
		throw new Error(`turno recusado: ${started.message}`);
	}
	const events: Record<string, unknown>[] = [];
	void (async () => {
		for await (const event of started.events) {
			events.push(event);
		}
	})();
	return { turnId: started.turnId, events };
}

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4C: turnos concorrentes', () => {
	test('dois turnos em curso ao mesmo tempo: eventos intercalados, sem mistura', async () => {
		const harness = await start();
		try {
			const one = await conversation(harness);
			const two = await conversation(harness);

			const first = await consume(harness.endpoint, { conversationId: one, text: 'turno-um' });
			const second = await consume(harness.endpoint, { conversationId: two, text: 'turno-dois' });

			// Os dois chegaram ao backend antes de qualquer resposta: estão em
			// curso simultaneamente.
			await until(() => harness.backend.pending.length === 2, 'dois pedidos em curso');
			assert.notEqual(first.turnId, second.turnId);

			// Libera o **segundo** primeiro: a resposta de dois chega antes da
			// de um, que é a ordem inversa da criação.
			harness.backend.pending[1]?.release('resposta-dois');
			await until(
				() => second.events.some((event) => event['type'] === 'done'),
				'o turno dois terminar',
			);
			harness.backend.pending[0]?.release('resposta-um');
			await until(
				() => first.events.some((event) => event['type'] === 'done'),
				'o turno um terminar',
			);

			const textOf = (events: readonly Record<string, unknown>[]): string =>
				events
					.filter((event) => event['type'] === 'delta')
					.map((event) => event['text'])
					.join('');

			assert.equal(textOf(first.events), 'resposta-um');
			assert.equal(textOf(second.events), 'resposta-dois');
			// Nenhum evento de um turno aparece no outro.
			assert.ok(first.events.every((event) => event['turnId'] === first.turnId));
			assert.ok(second.events.every((event) => event['turnId'] === second.turnId));
		} finally {
			await harness.close();
		}
	});

	test('cancelar um turno em curso não toca o outro', async () => {
		const harness = await start();
		try {
			const one = await conversation(harness);
			const two = await conversation(harness);
			const doomed = await consume(harness.endpoint, { conversationId: one, text: 'vai cancelar' });
			const survivor = await consume(harness.endpoint, { conversationId: two, text: 'vai terminar' });
			await until(() => harness.backend.pending.length === 2, 'dois pedidos em curso');

			assert.equal(harness.endpoint.cancel(doomed.turnId), true);
			await until(
				() => doomed.events.some((event) => event['type'] === 'done' || event['type'] === 'error'),
				'o turno cancelado terminar',
			);

			// O outro segue em curso e termina normalmente.
			assert.equal(harness.endpoint.activeCount, 1);
			harness.backend.pending[1]?.release('sobreviveu');
			await until(
				() => survivor.events.some((event) => event['type'] === 'done'),
				'o outro terminar',
			);
			const text = survivor.events
				.filter((event) => event['type'] === 'delta')
				.map((event) => event['text'])
				.join('');
			assert.equal(text, 'sobreviveu');
		} finally {
			await harness.close();
		}
	});

	test('cancelar um turno que já terminou devolve "nada a cancelar"', async () => {
		const harness = await start();
		try {
			const id = await conversation(harness);
			const running = await consume(harness.endpoint, { conversationId: id, text: 'rápido' });
			await until(() => harness.backend.pending.length === 1, 'o pedido chegar');
			harness.backend.pending[0]?.release('pronto');
			await until(
				() => running.events.some((event) => event['type'] === 'done'),
				'o turno terminar',
			);

			assert.equal(harness.endpoint.cancel(running.turnId), false);
		} finally {
			await harness.close();
		}
	});
});

suite('R4C: permissões de ferramenta', () => {
	test('a pergunta de permissão chega no evento do turno certo, e a resposta é aceita', async () => {
		const harness = await start();
		try {
			const id = await conversation(harness);
			const running = await consume(harness.endpoint, { conversationId: id, text: 'use uma ferramenta' });
			await until(() => harness.backend.pending.length === 1, 'o pedido chegar');

			// Uma ferramenta `moderate` abre pergunta pelo gateway do turno.
			// O broker é o do turno: a resposta só vale para ele.
			const answered = harness.endpoint.answer(running.turnId, { id: 'perm-inexistente', decision: 'allow' });
			assert.equal(answered, false, 'não há pergunta aberta com esse id');

			harness.backend.pending[0]?.release('sem ferramentas nesta rodada');
			await until(
				() => running.events.some((event) => event['type'] === 'done'),
				'o turno terminar',
			);

			// Depois do fim, um turno inexistente não aceita resposta.
			assert.equal(harness.endpoint.answer(running.turnId, { id: 'perm-1', decision: 'allow' }), false);
		} finally {
			await harness.close();
		}
	});

	test('uma permissão dirigida a um turno não é respondida pelo outro', async () => {
		const harness = await start();
		try {
			const one = await conversation(harness);
			const two = await conversation(harness);
			const first = await consume(harness.endpoint, { conversationId: one, text: 'a' });
			const second = await consume(harness.endpoint, { conversationId: two, text: 'b' });
			await until(() => harness.backend.pending.length === 2, 'dois pedidos');

			// A resposta vai com o id do **turno**; o outro não a recebe.
			assert.equal(harness.endpoint.answer(first.turnId, { id: 'perm-1', decision: 'deny' }), false);
			assert.equal(harness.endpoint.answer('svc-turn-inexistente', { id: 'perm-1', decision: 'allow' }), false);

			harness.backend.pending[0]?.release('a');
			harness.backend.pending[1]?.release('b');
			await until(
				() =>
					first.events.some((event) => event['type'] === 'done') &&
					second.events.some((event) => event['type'] === 'done'),
				'os dois terminarem',
			);
		} finally {
			await harness.close();
		}
	});
});

suite('R4C: a fila de eventos de cada turno', () => {
	test('duas filas nunca compartilham itens', async () => {
		const one = new EventQueue<number>();
		const two = new EventQueue<number>();

		const readOne: number[] = [];
		const readTwo: number[] = [];
		const consumeOne = (async () => {
			for await (const item of one.iterate()) {
				readOne.push(item);
			}
		})();
		const consumeTwo = (async () => {
			for await (const item of two.iterate()) {
				readTwo.push(item);
			}
		})();

		one.push(1);
		two.push(10);
		one.push(2);
		two.push(20);
		one.close();
		two.close();
		await Promise.all([consumeOne, consumeTwo]);

		assert.deepEqual(readOne, [1, 2]);
		assert.deepEqual(readTwo, [10, 20]);
	});

	test('um consumidor que fecha não recebe o que vier depois', async () => {
		const queue = new EventQueue<string>();
		queue.push('antes');
		queue.close();
		queue.push('depois');

		const seen: string[] = [];
		for await (const item of queue.iterate()) {
			seen.push(item);
		}

		assert.deepEqual(seen, ['antes']);
	});
});
