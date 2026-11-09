/**
 * DEV-9.1 (item 3) — o que o modo tarefa muda no turno, medido de verdade.
 *
 * Sobe o motor (`ConversationRuntime`) com um provedor que sempre pede a mesma
 * ferramenta, e conta quantos rounds o turno aguenta antes de encerrar:
 *
 * - sem `maxTurns` explícito, para no padrão (8) — o que cortava a tarefa;
 * - com o teto de tarefa, vai além.
 *
 * É a diferença observável que o botão "Tarefa" produz. O prazo por
 * inatividade não é medido aqui: exigiria dez minutos de espera; ele é fixado
 * pelas constantes em `devTaskModeConstantes.test.ts`.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConversationRuntime } from '../core/agent/runtime';
import { ToolRegistry, type ToolSpec } from '../core/agent/toolRegistry';
import type { AgentEvent, AgentTool } from '../core/agent/types';
import type { ChatProvider, ChatStream, ChatStreamEvent } from '../core/providers/chat/types';
import { TASK_MAX_TURNS } from '../desktop/chatSession';

class AlwaysCallsProvider implements ChatProvider {
	private calls = 0;
	async streamChat(): Promise<ChatStream> {
		this.calls += 1;
		const script: ChatStreamEvent[] = [
			{ type: 'ToolCallDelta', call: { id: `c${this.calls}`, name: 'dev_read', arguments: '{}' } },
			{ type: 'Done' },
		];
		return {
			closedReason: 'completed',
			timing: {},
			[Symbol.asyncIterator]: async function* () {
				yield* script;
			},
		};
	}
	get rounds(): number {
		return this.calls;
	}
}

const ALLOW = { ask: async () => ({ decision: 'allow' as const }) };

function spec(): ToolSpec {
	return {
		name: 'dev_read',
		description: 'leitura',
		parameters: { type: 'object', properties: {} },
		riskLevel: 'safe',
		category: 'other',
	};
}

function tool(): AgentTool {
	return {
		descriptor: { id: 'dev_read', name: 'dev_read', category: 'other', riskLevel: 'safe', description: 'leitura' },
		execute: async () => ({ ok: true, output: 'ok' }),
	};
}

async function roundsUntilStop(maxTurns: number | undefined): Promise<number> {
	const provider = new AlwaysCallsProvider();
	const registry = new ToolRegistry();
	registry.register(tool(), spec());
	const runtime = new ConversationRuntime({
		provider,
		tools: registry,
		permissions: ALLOW,
		...(maxTurns !== undefined ? { maxTurns } : {}),
	});
	const events: AgentEvent[] = [];
	for await (const event of runtime.run({ messages: [{ role: 'user', content: 'faça' }] })) {
		events.push(event);
	}
	const last = events.at(-1) as { type: string; reason?: string };
	assert.equal(last.type, 'TurnCompleted');
	assert.equal(last.reason, 'maxTurns', 'o turno foi cortado pelo teto, não terminou sozinho');
	return provider.rounds;
}

test('uma pergunta para no teto padrão do motor (8 rounds)', async () => {
	assert.equal(await roundsUntilStop(undefined), 8);
});

test('uma tarefa continua muito além do teto de pergunta', async () => {
	const rounds = await roundsUntilStop(TASK_MAX_TURNS);
	assert.equal(rounds, TASK_MAX_TURNS);
	assert.ok(rounds > 8, 'o modo tarefa tem de aguentar mais que uma pergunta');
});
