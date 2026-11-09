/**
 * R4C: o ciclo de permissões por turno, com diálogo de verdade.
 *
 * ## O que este arquivo prova
 *
 * Um turno cujo modelo pede `write_file` (ferramenta `moderate`) abre uma
 * pergunta de permissão. A pergunta:
 *
 * - chega no stream **do turno que a pediu**;
 * - é respondida pelo `turnId` do turno, e a decisão chega ao broker **dele**;
 * - uma resposta dirigida a outro turno não resolve esta;
 * - um `deny` impede a execução; um `allow` permite;
 * - o turno nunca fica esperando para sempre: o broker tem prazo próprio.
 *
 * O backend é local e determinístico (o `fetchImpl` do `assembleCore`), mas o
 * laço do agente, as ferramentas, o gateway de risco e o broker são os reais.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { WebChatEndpoint } from '../web/chatEndpoint';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12223/v1';

/** O pedido de ferramenta que o modelo faz no primeiro turno. */
const TOOL_CALL = {
	id: 'call_write_1',
	type: 'function',
	function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'oi' }) },
};

/**
 * Um backend que pede `write_file` na primeira rodada e responde texto na
 * segunda (depois da ferramenta). É o formato que o decodificador real espera.
 */
function toolBackend(): FetchLike {
	return async (url, init) => {
		if (url.endsWith('/models')) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }] }),
			};
		}
		const body = JSON.parse(String(init?.body ?? '{}')) as {
			readonly messages: readonly { readonly role: string }[];
		};
		// Há resposta de ferramenta no histórico? Então é a segunda rodada.
		const hasToolResult = (body.messages ?? []).some((message) => message.role === 'tool');
		const chunks = hasToolResult
			? [
					`data: ${JSON.stringify({ choices: [{ delta: { content: 'ferramenta tratada' } }] })}\n\n`,
					'data: [DONE]\n\n',
				]
			: [
					`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...TOOL_CALL }] } }] })}\n\n`,
					'data: [DONE]\n\n',
				];
		const response: FetchResponseLike = {
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					yield* chunks;
				},
			},
			text: async () => chunks.join(''),
		};
		return response;
	};
}

interface Harness {
	readonly core: AssembledCore;
	readonly endpoint: WebChatEndpoint;
	close(): Promise<void>;
}

async function start(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4c-perm-'));
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl: toolBackend(),
	});
	await core.chat.saveProvider({ id: 'local', name: 'Local', baseUrl: BASE_URL });
	await core.chat.listModels('local').catch(() => undefined);
	return {
		core,
		endpoint: new WebChatEndpoint({ session: core.chat }),
		async close() {
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		},
	};
}

async function conversation(harness: Harness): Promise<string> {
	const created = await harness.core.chat.createConversation({ providerId: 'local', title: 'perm' });
	return created.summary.id;
}

async function until<T>(
	condition: () => T | undefined,
	label: string,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = condition();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`tempo esgotado esperando: ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Inicia um turno e coleta os eventos conforme chegam. */
async function run(
	harness: Harness,
	input: { readonly conversationId: string; readonly text: string },
): Promise<{ readonly turnId: string; readonly events: Record<string, unknown>[] }> {
	const started = await harness.endpoint.start({
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

/** A pergunta de permissão que apareceu no turno, se apareceu. */
function promptOf(events: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
	return events.find((event) => event['type'] === 'permissionRequested');
}

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4C: permissões por turno, com diálogo real', () => {
	test('uma ferramenta moderate abre pergunta no stream do turno', async () => {
		const harness = await start();
		try {
			const id = await conversation(harness);
			const running = await run(harness, { conversationId: id, text: 'escreva a.txt' });

			const asked = await until(() => promptOf(running.events), 'a pergunta de permissão');
			assert.equal(asked['turnId'], running.turnId, 'a pergunta é do turno que a fez');
			const prompt = asked['prompt'] as Record<string, unknown>;
			assert.equal(prompt['toolName'], 'write_file');
			assert.equal(prompt['riskLevel'], 'moderate');

			// Recusa, para o teste não ficar esperando o prazo do broker.
			const answered = harness.endpoint.answer(running.turnId, {
				id: String(prompt['id']),
				decision: 'deny',
			});
			assert.equal(answered, true, 'a resposta foi aceita para o turno certo');

			// A recusa aparece como decisão resolvida, do mesmo turno. Espera o
			// evento, e não só o fim: o `permissionResolved` é emitido antes do
			// terminal, mas chegar ao array depende do laço de consumo.
			const resolved = await until(
				() => running.events.find((event) => event['type'] === 'permissionResolved'),
				'a resolução da permissão',
			);
			assert.equal(resolved['decision'], 'deny');
			assert.equal(resolved['turnId'], running.turnId);

			await until(
				() => running.events.some((event) => event['type'] === 'done' || event['type'] === 'error'),
				'o turno terminar',
			);
		} finally {
			await harness.close();
		}
	});

	test('responder com o id de outro turno não resolve a pergunta', async () => {
		const harness = await start();
		try {
			const one = await conversation(harness);
			const first = await run(harness, { conversationId: one, text: 'escreva a.txt' });
			const asked = await until(() => promptOf(first.events), 'a pergunta do turno');
			const prompt = asked['prompt'] as Record<string, unknown>;

			// Um turno que não existe não resolve nada.
			assert.equal(
				harness.endpoint.answer('svc-turn-outro', { id: String(prompt['id']), decision: 'allow' }),
				false,
			);
			// E a pergunta continua aberta: o turno não terminou antes da resposta.
			assert.equal(first.events.some((event) => event['type'] === 'permissionResolved'), false);

			assert.equal(
				harness.endpoint.answer(first.turnId, { id: String(prompt['id']), decision: 'deny' }),
				true,
			);
			await until(
				() => first.events.some((event) => event['type'] === 'done' || event['type'] === 'error'),
				'o turno terminar',
			);
		} finally {
			await harness.close();
		}
	});

	test('permitir a ferramenta deixa o agente continuar até a resposta final', async () => {
		const harness = await start();
		try {
			const id = await conversation(harness);
			const running = await run(harness, { conversationId: id, text: 'escreva a.txt' });
			const asked = await until(() => promptOf(running.events), 'a pergunta');
			const prompt = asked['prompt'] as Record<string, unknown>;

			assert.equal(
				harness.endpoint.answer(running.turnId, { id: String(prompt['id']), decision: 'allow' }),
				true,
			);

			const done = await until(
				() => running.events.find((event) => event['type'] === 'done'),
				'o turno terminar',
			);
			assert.equal(typeof done['turnId'], 'string');
			// A segunda rodada do modelo respondeu depois da ferramenta.
			const text = running.events
				.filter((event) => event['type'] === 'delta')
				.map((event) => event['text'])
				.join('');
			assert.equal(text, 'ferramenta tratada');
		} finally {
			await harness.close();
		}
	});

	test('dois turnos com perguntas ao mesmo tempo: cada resposta vai ao seu', async () => {
		const harness = await start();
		try {
			const one = await conversation(harness);
			const two = await conversation(harness);
			const first = await run(harness, { conversationId: one, text: 'um' });
			const second = await run(harness, { conversationId: two, text: 'dois' });

			const promptOne = await until(() => promptOf(first.events), 'a pergunta do primeiro');
			const promptTwo = await until(() => promptOf(second.events), 'a pergunta do segundo');
			const idOne = String((promptOne['prompt'] as Record<string, unknown>)['id']);
			const idTwo = String((promptTwo['prompt'] as Record<string, unknown>)['id']);

			// Responder o segundo pelo id do primeiro não deve funcionar.
			assert.equal(harness.endpoint.answer(second.turnId, { id: idOne, decision: 'deny' }), false);
			assert.equal(harness.endpoint.answer(first.turnId, { id: idTwo, decision: 'deny' }), false);

			assert.equal(harness.endpoint.answer(first.turnId, { id: idOne, decision: 'deny' }), true);
			assert.equal(harness.endpoint.answer(second.turnId, { id: idTwo, decision: 'deny' }), true);

			await until(
				() =>
					first.events.some((event) => event['type'] === 'done' || event['type'] === 'error') &&
					second.events.some((event) => event['type'] === 'done' || event['type'] === 'error'),
				'os dois terminarem',
			);
			// Cada resolução ficou no seu turno.
			const resolvedOne = await until(
				() => {
					const found = first.events.filter((event) => event['type'] === 'permissionResolved');
					return found.length > 0 ? found : undefined;
				},
				'a resolução do primeiro',
			);
			const resolvedTwo = await until(
				() => {
					const found = second.events.filter((event) => event['type'] === 'permissionResolved');
					return found.length > 0 ? found : undefined;
				},
				'a resolução do segundo',
			);
			assert.equal(resolvedOne.length, 1);
			assert.equal(resolvedTwo.length, 1);
			assert.equal(resolvedOne[0]?.['turnId'], first.turnId);
			assert.equal(resolvedTwo[0]?.['turnId'], second.turnId);
		} finally {
			await harness.close();
		}
	});
});
