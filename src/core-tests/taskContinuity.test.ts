/**
 * DEV — continuidade: a tarefa não morre por uma falha passageira, e a
 * interface consegue distinguir espera de erro de fim.
 *
 * ## O defeito
 *
 * Uma ferramenta que falhava devolvia `ERROR:` ao modelo e o turno seguia com
 * o que isto produzia — quando um recurso ocupado (a trava, a rede, um arquivo
 * aberto) teria passado com uma segunda tentativa. E o teto de rounds
 * (`maxTurns: 8`) era contado por retorno ao provedor, então uma tarefa de
 * várias etapas terminava com `reason: 'maxTurns'` no meio.
 *
 * ## O que estes testes fixam
 *
 * - falha **transitória** é tentada de novo, com evento `ToolRetry` a cada
 *   tentativa (é o que faz a interface dizer "aguardando");
 * - falha **definitiva** não é repetida — repetir não ajuda e gasta o turno;
 * - cancelar durante a espera encerra na hora, e a nova tentativa não acontece;
 * - esgotadas as tentativas, o turno **só então** reporta erro, com o texto
 *   final — nunca uma conclusão com etapas pendentes.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConversationRuntime, isTransientFailure } from '../core/agent/runtime';
import { ToolRegistry, type ToolSpec } from '../core/agent/toolRegistry';
import type { AgentEvent, AgentTool, ToolResult } from '../core/agent/types';
import type { ChatProvider, ChatStream, ChatStreamEvent } from '../core/providers/chat/types';

class ScriptedProvider implements ChatProvider {
	private index = 0;
	constructor(private readonly scripts: readonly ChatStreamEvent[][]) {}
	async streamChat(): Promise<ChatStream> {
		const script = this.scripts[Math.min(this.index, this.scripts.length - 1)];
		this.index += 1;
		return {
			closedReason: 'completed',
			timing: {},
			[Symbol.asyncIterator]: async function* () {
				yield* script;
			},
		};
	}
}

const ALLOW = { ask: async () => ({ decision: 'allow' as const }) };

function spec(name: string): ToolSpec {
	return {
		name,
		description: name,
		parameters: { type: 'object', properties: {} },
		riskLevel: 'safe',
		category: 'other',
	};
}

function tool(name: string, behaviour: (attempt: number) => Promise<ToolResult> | ToolResult): AgentTool {
	let attempt = 0;
	return {
		descriptor: { id: name, name, category: 'other', riskLevel: 'safe', description: name },
		execute: async () => {
			attempt += 1;
			return behaviour(attempt);
		},
	};
}

function callScript(name: string, id = 'c1'): ChatStreamEvent[] {
	return [
		{ type: 'ToolCallDelta', call: { id, name, arguments: '{}' } },
		{ type: 'Done' },
	];
}

const ANSWER: ChatStreamEvent[] = [
	{ type: 'TextDelta', text: 'pronto' },
	{ type: 'Done' },
];

async function collect(runtime: ConversationRuntime, signal?: AbortSignal): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of runtime.run({ messages: [{ role: 'user', content: 'faça' }] }, signal !== undefined ? { signal } : {})) {
		events.push(event);
	}
	return events;
}

test('a classificação de transitório é estreita e nomeada', () => {
	// Passageiros.
	assert.equal(isTransientFailure('o repositório está em uso por outro processo'), true);
	assert.equal(isTransientFailure('ECONNRESET'), true);
	assert.equal(isTransientFailure('the operation timed out'), true);
	// Definitivos: repetir não muda o resultado.
	assert.equal(isTransientFailure('permission to run "dev_write" was denied'), false);
	assert.equal(isTransientFailure('no tool named "x" is registered'), false);
	assert.equal(isTransientFailure('não está dentro do repositório'), false);
});

test('uma falha transitória é tentada de novo e o resultado bom vale', async () => {
	const registry = new ToolRegistry();
	registry.register(
		tool('dev_run', (attempt) =>
			attempt < 3 ? { ok: false, error: 'o repositório está em uso por outro processo' } : { ok: true, output: 'passou' },
		),
		spec('dev_run'),
	);
	const runtime = new ConversationRuntime({
		provider: new ScriptedProvider([callScript('dev_run'), ANSWER]),
		tools: registry,
		permissions: ALLOW,
		toolRetries: 2,
		retryDelayMs: 1,
	});

	const events = await collect(runtime);
	const retries = events.filter((event) => event.type === 'ToolRetry');
	assert.equal(retries.length, 2, 'duas novas tentativas, uma por falha');
	const completed = events.find((event) => event.type === 'ToolCompleted');
	assert.ok(completed !== undefined && completed.type === 'ToolCompleted');
	assert.equal(completed.ok, true, 'o desfecho é o sucesso da terceira tentativa');
	assert.match(completed.output, /passou/);
	// A tarefa continua até a resposta final.
	assert.equal(events.at(-1)?.type, 'TurnCompleted');
	assert.equal((events.at(-1) as { reason: string }).reason, 'answered');
});

test('uma falha definitiva NÃO é repetida', async () => {
	let calls = 0;
	const registry = new ToolRegistry();
	registry.register(
		tool('dev_write', () => {
			calls += 1;
			return { ok: false, error: 'permission to run "dev_write" was denied' };
		}),
		spec('dev_write'),
	);
	const runtime = new ConversationRuntime({
		provider: new ScriptedProvider([callScript('dev_write'), ANSWER]),
		tools: registry,
		permissions: ALLOW,
		toolRetries: 3,
		retryDelayMs: 1,
	});

	const events = await collect(runtime);
	assert.equal(calls, 1, 'uma única execução');
	assert.equal(events.filter((event) => event.type === 'ToolRetry').length, 0);
	const completed = events.find((event) => event.type === 'ToolCompleted');
	assert.ok(completed !== undefined && completed.type === 'ToolCompleted');
	assert.equal(completed.ok, false);
});

test('esgotadas as tentativas, o erro chega ao modelo e a tarefa pode seguir', async () => {
	let calls = 0;
	const registry = new ToolRegistry();
	registry.register(
		tool('dev_run', () => {
			calls += 1;
			return { ok: false, error: 'ECONNRESET' };
		}),
		spec('dev_run'),
	);
	const runtime = new ConversationRuntime({
		provider: new ScriptedProvider([callScript('dev_run'), ANSWER]),
		tools: registry,
		permissions: ALLOW,
		toolRetries: 1,
		retryDelayMs: 1,
	});

	const events = await collect(runtime);
	assert.equal(calls, 2, 'a original e uma nova tentativa');
	const completed = events.find((event) => event.type === 'ToolCompleted');
	assert.ok(completed !== undefined && completed.type === 'ToolCompleted');
	assert.equal(completed.ok, false);
	assert.match(completed.output, /ERROR:/, 'o modelo sabe o que falhou');
	assert.equal((events.at(-1) as { reason: string }).reason, 'answered', 'a tarefa chegou ao fim, em vez de morrer');
});

test('cancelar durante a espera encerra na hora e não tenta de novo', async () => {
	let calls = 0;
	const registry = new ToolRegistry();
	registry.register(
		tool('dev_run', () => {
			calls += 1;
			return { ok: false, error: 'ECONNRESET' };
		}),
		spec('dev_run'),
	);
	const controller = new AbortController();
	const runtime = new ConversationRuntime({
		provider: new ScriptedProvider([callScript('dev_run'), ANSWER]),
		tools: registry,
		permissions: ALLOW,
		toolRetries: 5,
		// Espera longa de propósito: a parada tem de interrompê-la.
		retryDelayMs: 5_000,
	});

	const started = Date.now();
	const draining = collect(runtime, controller.signal);
	// A primeira falha acontece, e a espera começa.
	await new Promise((resolve) => setTimeout(resolve, 40));
	controller.abort();
	const events = await draining;

	assert.ok(Date.now() - started < 2_000, 'a parada encerra a espera, não a aguarda');
	assert.deepEqual([...new Set(events.map((event) => event.type))].filter((type) => type === 'ToolRetry').length, 1);
	assert.equal(calls, 1, 'não houve segunda execução');
	assert.equal((events.at(-1) as { reason: string }).reason, 'aborted');
});

test('sem novas tentativas configuradas, o comportamento antigo vale', async () => {
	let calls = 0;
	const registry = new ToolRegistry();
	registry.register(
		tool('dev_run', () => {
			calls += 1;
			return { ok: false, error: 'ECONNRESET' };
		}),
		spec('dev_run'),
	);
	const runtime = new ConversationRuntime({
		provider: new ScriptedProvider([callScript('dev_run'), ANSWER]),
		tools: registry,
		permissions: ALLOW,
		toolRetries: 0,
	});

	await collect(runtime);
	assert.equal(calls, 1);
});

test('o teto de rounds explícito é respeitado: nunca "conclui" com etapas pendentes', async () => {
	// O modelo pede a mesma ferramenta sempre: o teto tem de encerrar com
	// `maxTurns` — e a interface distingue isso de "answered".
	const registry = new ToolRegistry();
	registry.register(tool('dev_read', () => ({ ok: true, output: 'ok' })), spec('dev_read'));
	const runtime = new ConversationRuntime({
		provider: new ScriptedProvider([callScript('dev_read')]),
		tools: registry,
		permissions: ALLOW,
		maxTurns: 12,
	});

	const events = await collect(runtime);
	const calls = events.filter((event) => event.type === 'ToolCallRequested').length;
	assert.equal(calls, 12, 'o teto é o número de rounds, não menos');
	const last = events.at(-1) as { type: string; reason?: string };
	assert.equal(last.type, 'TurnCompleted');
	assert.equal(last.reason, 'maxTurns', 'e não é reportado como resposta');
});
