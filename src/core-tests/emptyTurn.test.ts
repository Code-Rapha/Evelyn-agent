/**
 * DEV-10 — um turno que não disse nada não é uma resposta.
 *
 * Medido com o modelo real: `Qwen/Qwen3.8-27B-FP8`, com as ferramentas
 * declaradas, gastou 2 333 caracteres de raciocínio e não emitiu texto nem
 * chamada de ferramenta. O turno foi reportado `done`/`success`, nada foi
 * gravado, e a pessoa ficou com um chat que nunca respondeu — e repetiu a
 * mensagem, achando que a primeira tinha sido ignorada.
 *
 * O mesmo pedido sem ferramentas respondeu: o modelo não estava quebrado, o
 * turno é que estava vazio e dizia outra coisa.
 */
import * as assert from 'node:assert/strict';

import { runAgentTurn, type AgentEventSink, type AgentTurnHooks, type AgentUiEvent } from '../desktop/agentTurn';
import type { ConversationRuntime } from '../core/agent/runtime';

/** Um runtime que emite só o que o teste mandar. */
function runtimeEmitting(eventos: readonly Record<string, unknown>[]): ConversationRuntime {
	return {
		async *run() {
			for (const evento of eventos) {
				yield evento as never;
			}
		},
		completion: 'answered',
		// O turno lê estes dois campos; o resto não participa deste caminho.
	} as unknown as ConversationRuntime;
}

function registro(): Parameters<typeof runAgentTurn>[1] {
	return {
		id: 'conv-teste',
		title: 'teste',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		messages: [
			{
				id: 'm1',
				seq: 1,
				role: 'user',
				content: 'pergunta',
				createdAt: new Date().toISOString(),
			},
		],
	} as unknown as Parameters<typeof runAgentTurn>[1];
}

function hooks(runtime: ConversationRuntime): AgentTurnHooks {
	return {
		runtime,
		model: 'um-modelo',
		tools: {
			all: () => [],
			get: () => undefined,
			specs: () => [],
		} as unknown as AgentTurnHooks['tools'],
		permissions: {
			ask: async () => ({ granted: true }),
		} as unknown as AgentTurnHooks['permissions'],
		recorders: new Map(),
		release: () => undefined,
		persistToolResult: async () => undefined,
		persistAssistant: async () => undefined,
	} as unknown as AgentTurnHooks;
}

async function correr(runtime: ConversationRuntime): Promise<AgentUiEvent[]> {
	const eventos: AgentUiEvent[] = [];
	const sink: AgentEventSink = (evento) => eventos.push(evento);
	await runAgentTurn(hooks(runtime), registro(), 'turn-1', sink);
	return eventos;
}

suite('DEV-10: uma conversa com prompt próprio não vira duas mensagens system', () => {
	// Medido com o River e o Qwen/Qwen3.8-27B-FP8: duas mensagens `system`
	// recebem `invalid_request`; uma só passa. O app enviava a identidade + o
	// prompt da conversa, então toda conversa com `systemPrompt` — o diálogo de
	// preferências — era recusada.
	test('a identidade e o prompt da conversa viram uma só mensagem', async () => {
		// O prompt da conversa, como o disco o guarda.
		const base = registro();
		const record = {
			...base,
			messages: [
				{
					id: 'sys-1',
					seq: 0,
					role: 'system',
					content: 'Você registra as preferências de modelo.',
					createdAt: new Date().toISOString(),
				},
				...base.messages,
			],
		} as unknown as Parameters<typeof runAgentTurn>[1];

		let enviadas: { readonly role: string; readonly content: string }[] = [];
		const runtime = {
			async *run(input: { readonly messages: readonly { role: string; content: string }[] }) {
				enviadas = [...input.messages];
				yield { type: 'TextDelta', text: 'ok' } as never;
				yield { type: 'TurnCompleted' } as never;
			},
			completion: 'answered',
		} as unknown as Parameters<typeof runAgentTurn>[0]['runtime'];

		await runAgentTurn(hooks(runtime), record, 'turn-1', () => undefined);

		const sistemas = enviadas.filter((m) => m.role === 'system');
		assert.equal(sistemas.length, 1, 'o provedor recusa duas; tem de sobrar uma');
		// Nenhuma das duas instruções se perdeu.
		assert.match(sistemas[0]?.content ?? '', /Evelyn/);
		assert.match(sistemas[0]?.content ?? '', /preferências de modelo/);
	});

	test('as instruções de skill entram na mesma system, não numa segunda', async () => {
		// Medido: o River recusa com `invalid_request` qualquer requisição com
		// mais de uma mensagem `system`. A injeção de skill criava a segunda
		// sempre que alguma skill era carregada — e a conversa que respondia
		// parava de responder assim que a descoberta passava a achar uma.
		const base = registro();
		const record = {
			...base,
			messages: [
				{
					id: 'sys-1',
					seq: 0,
					role: 'system',
					content: 'Você registra as preferências de modelo.',
					createdAt: new Date().toISOString(),
				},
				...base.messages,
			],
		} as unknown as Parameters<typeof runAgentTurn>[1];

		let enviadas: { readonly role: string; readonly content: string }[] = [];
		const runtime = {
			async *run(input: { readonly messages: readonly { role: string; content: string }[] }) {
				enviadas = [...input.messages];
				yield { type: 'TextDelta', text: 'ok' } as never;
				yield { type: 'TurnCompleted' } as never;
			},
			completion: 'answered',
		} as unknown as Parameters<typeof runAgentTurn>[0]['runtime'];

		const baseHooks = hooks(runtime);
		const hooksComSkill = {
			...baseHooks,
			tools: { ...baseHooks.tools, names: () => [] },
			skillDiscovery: {
				formatAsSystemMessage: () => '<skill-instructions>uma skill</skill-instructions>',
				discover: async () => ({ ok: true, skills: [{ id: 'sk-1', name: 'Uma skill' }], missing: [] }),
				loadInstructions: async () => ({
					skills: [{ id: 'sk-1', name: 'Uma skill' }],
					text: '<skill-instructions>uma skill</skill-instructions>',
				}),
			},
		} as unknown as Parameters<typeof runAgentTurn>[0];

		await runAgentTurn(hooksComSkill, record, 'turn-1', () => undefined);

		const sistemas = enviadas.filter((m) => m.role === 'system');
		assert.equal(sistemas.length, 1, 'uma só system, mesmo com skill carregada');
		assert.match(sistemas[0]?.content ?? '', /skill-instructions/);
		assert.match(sistemas[0]?.content ?? '', /preferências de modelo/);
	});

	test('uma conversa sem prompt próprio continua com uma system', async () => {
		let enviadas: { readonly role: string }[] = [];
		const runtime = {
			async *run(input: { readonly messages: readonly { role: string }[] }) {
				enviadas = [...input.messages];
				yield { type: 'TextDelta', text: 'ok' } as never;
				yield { type: 'TurnCompleted' } as never;
			},
			completion: 'answered',
		} as unknown as Parameters<typeof runAgentTurn>[0]['runtime'];

		await runAgentTurn(hooks(runtime), registro(), 'turn-1', () => undefined);

		assert.equal(enviadas.filter((m) => m.role === 'system').length, 1);
	});
});

suite('DEV-10: um turno vazio não é reportado como resposta', () => {
	test('só raciocínio, sem texto e sem ferramenta: erro que diz o que houve', async () => {
		const eventos = await correr(
			runtimeEmitting([
				{ type: 'ReasoningDelta', text: 'pensando muito, sem concluir nada' },
				{ type: 'TurnCompleted' },
			]),
		);

		const terminal = eventos.find((e) => e.type === 'done' || e.type === 'error');
		assert.equal(terminal?.type, 'error', 'um turno sem conteúdo não é "done"');
		const mensagem = terminal?.type === 'error' ? terminal.message : '';
		assert.match(mensagem, /sem responder/);
		assert.match(mensagem, /outro modelo/);
	});

	test('texto de verdade continua sendo um turno concluído', async () => {
		const eventos = await correr(
			runtimeEmitting([
				{ type: 'ReasoningDelta', text: 'pensando' },
				{ type: 'TextDelta', text: 'a resposta' },
				{ type: 'TurnCompleted' },
			]),
		);

		const terminal = eventos.find((e) => e.type === 'done' || e.type === 'error');
		assert.equal(terminal?.type, 'done');
		assert.equal(terminal?.type === 'done' ? terminal.content : '', 'a resposta');
	});

	test('só ferramenta, sem texto, continua concluído', async () => {
		// O caso comum: o modelo chama uma ferramenta sem dizer nada antes.
		const eventos = await correr(
			runtimeEmitting([
				{
					type: 'ToolCallRequested',
					call: { id: 'c1', name: 'list_files', rawArguments: '{}', malformed: false },
				},
				{
					type: 'ToolCompleted',
					callId: 'c1',
					output: 'ok',
					ok: true,
					toolName: 'list_files',
					attempt: 1,
				},
				{ type: 'TurnCompleted' },
			]),
		);

		const terminal = eventos.find((e) => e.type === 'done' || e.type === 'error');
		assert.notEqual(terminal?.type, 'error', 'um turno com ferramenta não é "vazio"');
	});
});

suite('aprendizado automático: o gancho roda no valor que o runtime produz', () => {
	// O gancho nasceu comparando `completion === 'completed'`, que o runtime
	// nunca produz. O teste antigo usava o mesmo valor inventado, então o
	// caminho parecia coberto — e o E2E mostrou o painel funcionando enquanto
	// nenhuma skill era criada. Este teste usa o valor real.
	test("um turno 'answered' chama o gancho e emite o selo antes do done", async () => {
		let chamadas = 0;
		const runtime = runtimeEmitting([
			{ type: 'TextDelta', text: 'ok' },
			{ type: 'TurnCompleted' },
		]);
		const eventos: AgentUiEvent[] = [];
		await runAgentTurn(
			{
				...hooks(runtime),
				learnSkills: async () => {
					chamadas += 1;
					return [{ id: 'read-skill', title: 'Read Skill', confidence: 0.6, proposalId: 'p1' }];
				},
			},
			registro(),
			'turn-1',
			(evento) => eventos.push(evento),
		);

		assert.equal(chamadas, 1, 'o gancho tem de rodar no turno bem-sucedido');
		const selo = eventos.find((e) => e.type === 'skillLearned');
		assert.ok(selo, 'o selo do turno tem de sair');
		assert.equal(
			selo.type === 'skillLearned' ? selo.skills[0]?.id : undefined,
			'read-skill',
		);
		const iSelo = eventos.findIndex((e) => e.type === 'skillLearned');
		const iDone = eventos.findIndex((e) => e.type === 'done');
		assert.ok(iSelo >= 0 && iDone > iSelo, 'o selo vem antes do desfecho');
	});

	test('um turno abortado não ensina: meio procedimento não é prova', async () => {
		let chamadas = 0;
		const runtime = {
			...runtimeEmitting([{ type: 'TextDelta', text: 'ok' }]),
			completion: 'aborted',
		} as unknown as ConversationRuntime;
		await runAgentTurn(
			{
				...hooks(runtime),
				learnSkills: async () => {
					chamadas += 1;
					return [];
				},
			},
			registro(),
			'turn-1',
			() => undefined,
		);
		assert.equal(chamadas, 0);
	});
});
