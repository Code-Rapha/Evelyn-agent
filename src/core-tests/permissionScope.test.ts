/**
 * DEV — autorização por escopo, e o que ela **não** autoriza.
 *
 * ## O defeito
 *
 * O broker abria um diálogo para todo pedido `!== safe`. No DEV isso é uma
 * pergunta por leitura, por escrita e por comando — e uma tarefa de dez etapas
 * virava dez interrupções. A pessoa relatou exatamente isso.
 *
 * ## A regra testada aqui
 *
 * - leitura e pesquisa: automáticas;
 * - escrita dentro do escopo DEV: uma pergunta por tarefa, valendo para o
 *   resto dela enquanto o escopo não mudar;
 * - perigoso (aplicar, restaurar, credencial, `run_command` genérico):
 *   **sempre** pergunta, mesmo com concessão aberta;
 * - fora do escopo concedido: pergunta de novo;
 * - desligado o recurso, o comportamento antigo volta por inteiro.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { PermissionBroker, type DecisionReport } from '../desktop/permissionBroker';
import { classifyRequest, grantCovers, scopeKey } from '../desktop/permissionScope';
import type { PermissionRequest } from '../core/permissions/gateway';
import type { PermissionPrompt } from '../desktop/contract';

const ROOT = 'G:\\repo';

function request(overrides: Partial<PermissionRequest> & { toolName: string }): PermissionRequest {
	return {
		toolId: overrides.toolName,
		action: overrides.toolName,
		description: `run ${overrides.toolName}`,
		riskLevel: 'moderate',
		arguments: {},
		sessionId: 'turn-1',
		...overrides,
	} as PermissionRequest;
}

/** Um broker que registra o que anunciou, com escopo ligado. */
function broker(options: { readonly scoped?: boolean; readonly devRoot?: string } = {}) {
	const prompts: PermissionPrompt[] = [];
	const reports: DecisionReport[] = [];
	const instance = new PermissionBroker({
		emit: (kind, payload) => {
			if (kind === 'requested') {
				prompts.push(payload as PermissionPrompt);
			} else {
				reports.push(payload as DecisionReport);
			}
		},
		brokerId: 'task-1',
		timeoutMs: 5_000,
		...(options.scoped !== false ? { scopedGrants: true } : {}),
		...(options.devRoot !== undefined ? { devRoot: options.devRoot } : {}),
	});
	return { broker: instance, prompts, reports };
}

/**
 * Espera um prompt ser anunciado, como a interface esperaria o cartão aparecer.
 *
 * Sem isto o teste responde antes de existir a pergunta, e o broker — correto —
 * recusa uma resposta para id desconhecido.
 */
async function nextPrompt(prompts: PermissionPrompt[], from = 0): Promise<PermissionPrompt> {
	const deadline = Date.now() + 2_000;
	while (prompts.length <= from) {
		if (Date.now() > deadline) {
			throw new Error(`nenhum prompt anunciado (já havia ${prompts.length})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return prompts[from];
}

// ── classificação pura ──────────────────────────────────────────────────

test('leitura e pesquisa são automáticas, inclusive fora do DEV', () => {
	for (const name of ['dev_read', 'dev_search', 'web_search', 'web_fetch', 'model_catalog_list']) {
		assert.equal(classifyRequest(request({ toolName: name, riskLevel: 'moderate' })).kind, 'automatic', name);
	}
});

test('escrita do DEV no escopo é reutilizável; a chave é a PASTA do arquivo', () => {
	const verdict = classifyRequest(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/a.ts', content: 'x' } }),
		{ root: ROOT },
	);
	assert.equal(verdict.kind, 'scoped');
	if (verdict.kind === 'scoped') {
		assert.equal(verdict.key, scopeKey('G:\\repo\\src'), 'a pasta, não o arquivo');
	}
});

test('dev_run NÃO reutiliza aprovação: cada comando é aprovado sozinho (DEV-9.1)', () => {
	const verdict = classifyRequest(request({ toolName: 'dev_run', riskLevel: 'dangerous' }), { root: ROOT });
	// A auditoria pediu explicitamente para fechar o "aprovar npm test,
	// executar outra coisa". `dev_run` pergunta a cada chamada.
	assert.equal(verdict.kind, 'explicit');
	if (verdict.kind === 'explicit') {
		assert.match(verdict.reason, /aprovado sozinho|cada comando/i);
	}
});

test('o que é perigoso de verdade nunca é reutilizável', () => {
	for (const name of ['dev_apply', 'dev_configure', 'dev_recover', 'run_command', 'system_write']) {
		assert.equal(
			classifyRequest(request({ toolName: name, riskLevel: 'dangerous' }), { root: ROOT }).kind,
			'explicit',
			name,
		);
	}
});

test('uma ferramenta que ninguém classificou pergunta, em vez de presumir', () => {
	assert.equal(classifyRequest(request({ toolName: 'algo_novo' }), { root: ROOT }).kind, 'explicit');
});

test('sem raiz DEV, nenhuma escrita é "escopo"', () => {
	assert.equal(
		classifyRequest(request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'a.ts' } })).kind,
		'explicit',
	);
});

test('a concessão cobre a própria pasta e as filhas, nunca o irmão homônimo', () => {
	const keys = new Set([scopeKey('G:\\repo\\src')]);
	assert.equal(grantCovers(keys, scopeKey('G:\\repo\\src')), true);
	assert.equal(grantCovers(keys, scopeKey('G:\\repo\\src\\a\\b.ts')), true);
	assert.equal(grantCovers(keys, scopeKey('G:\\repo\\src2\\a.ts')), false);
	assert.equal(grantCovers(keys, scopeKey('G:\\repo\\config.json')), false);
});

// ── comportamento do broker ─────────────────────────────────────────────

test('leitura passa sem abrir diálogo, e a linha do tempo diz por quê', async () => {
	const { broker: b, prompts, reports } = broker({ devRoot: ROOT });
	const decision = await b.gateway.ask(request({ toolName: 'dev_read' }));
	assert.equal(decision.decision, 'allow');
	assert.equal(prompts.length, 0, 'nenhum diálogo');
	assert.equal(reports.at(-1)?.source, 'automatic');
});

test('a primeira escrita pede; a resposta autoriza o ESCOPO e as próximas não perguntam', async () => {
	const { broker: b, prompts } = broker({ devRoot: ROOT });

	// 1ª escrita: pergunta.
	const first = b.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/a.ts', content: 'x' } }),
	);
	const prompt = await nextPrompt(prompts);
	assert.equal(prompts.length, 1, 'a primeira pede autorização');
	b.answer({ id: prompt.id, decision: 'allow' });
	assert.equal((await first).decision, 'allow');

	// 2ª escrita na mesma pasta: não pergunta.
	const second = await b.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/b.ts', content: 'y' } }),
	);
	assert.equal(second.decision, 'allow');
	assert.equal(prompts.length, 1, 'a segunda não abriu diálogo');

	// Outra **pasta** é escopo novo: a concessão de `src` não cobre `config`.
	void b.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'config/x.json' } }),
	);
	await nextPrompt(prompts, 1);
	assert.equal(prompts.length, 2, 'outra pasta pergunta de novo');

	// `dev_run` pergunta **sempre** (DEV-9.1): a aprovação de uma escrita em
	// `src` não autoriza execução, e a aprovação de um comando não autoriza
	// o próximo.
	const run = b.gateway.ask(request({ toolName: 'dev_run', riskLevel: 'dangerous' }));
	const runPrompt = await nextPrompt(prompts, 2);
	assert.equal(runPrompt.toolName, 'dev_run', 'dev_run pergunta mesmo com src concedido');
	b.answer({ id: runPrompt.id, decision: 'allow' });
	assert.equal((await run).decision, 'allow');

	const runAgain = b.gateway.ask(request({ toolName: 'dev_run', riskLevel: 'dangerous' }));
	await nextPrompt(prompts, 3);
	assert.equal(prompts.length, 4, 'a próxima execução pergunta de novo');
});

test('fora do escopo concedido, pergunta de novo', async () => {
	const { broker: b, prompts } = broker({ devRoot: ROOT });

	const first = b.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/a.ts' } }),
	);
	b.answer({ id: (await nextPrompt(prompts)).id, decision: 'allow' });
	await first;

	// Outra pasta: a concessão de `src` não cobre `config`.
	void b.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'config/x.json' } }),
	);
	await nextPrompt(prompts, 1);
	assert.equal(prompts.length, 2, 'a escrita fora do escopo pergunta');
});

test('recusar não concede nada: a próxima escrita pergunta de novo', async () => {
	const { broker: b, prompts } = broker({ devRoot: ROOT });
	const first = b.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/a.ts' } }),
	);
	b.answer({ id: (await nextPrompt(prompts)).id, decision: 'deny' });
	assert.equal((await first).decision, 'deny');

	void b.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/b.ts' } }),
	);
	await nextPrompt(prompts, 1);
	assert.equal(prompts.length, 2, 'a recusa não estende escopo');
});

test('com a concessão aberta, o perigoso AINDA pergunta', async () => {
	const { broker: b, prompts } = broker({ devRoot: ROOT });
	const first = b.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/a.ts' } }),
	);
	b.answer({ id: (await nextPrompt(prompts)).id, decision: 'allow' });
	await first;
	assert.equal(prompts.length, 1);

	// Duas perguntas a mais, uma por ferramenta — e cada uma sozinha.
	let next = 1;
	for (const name of ['dev_apply', 'run_command']) {
		const pending = b.gateway.ask(request({ toolName: name, riskLevel: 'dangerous' }));
		const prompt = await nextPrompt(prompts, next);
		assert.equal(prompt.toolName, name, `${name} pergunta mesmo com escrita autorizada`);
		next += 1;
		b.answer({ id: prompt.id, decision: 'deny' });
		assert.equal((await pending).decision, 'deny');
	}
	assert.equal(prompts.length, 3);
});

test('o desbloqueio por escopo não atravessa tarefas: um broker novo não herda nada', async () => {
	const first = broker({ devRoot: ROOT });
	const pending = first.broker.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/a.ts' } }),
	);
	first.broker.answer({ id: (await nextPrompt(first.prompts)).id, decision: 'allow' });
	await pending;

	const second = broker({ devRoot: ROOT });
	void second.broker.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/a.ts' } }),
	);
	await nextPrompt(second.prompts);
	assert.equal(second.prompts.length, 1, 'a tarefa nova pergunta do zero');
});

test('desligado, o comportamento antigo volta: tudo além de `safe` pergunta', async () => {
	const { broker: b, prompts } = broker({ scoped: false, devRoot: ROOT });
	void b.gateway.ask(request({ toolName: 'dev_read' }));
	await nextPrompt(prompts);
	assert.equal(prompts.length, 1, 'sem o recurso, até a leitura pergunta');
});

test('sem raiz DEV, a escrita pergunta mesmo com o recurso ligado', async () => {
	const { broker: b, prompts } = broker({});
	void b.gateway.ask(request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'a.ts' } }));
	await nextPrompt(prompts);
	assert.equal(prompts.length, 1);
});

test('uma negação por parada não concede escopo', async () => {
	const { broker: b, prompts } = broker({ devRoot: ROOT });
	const controller = new AbortController();
	void b.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/a.ts' } }),
		{ signal: controller.signal },
	);
	await nextPrompt(prompts);
	controller.abort();
	await new Promise((resolve) => setTimeout(resolve, 10));

	void b.gateway.ask(
		request({ toolName: 'dev_write', riskLevel: 'dangerous', arguments: { path: 'src/b.ts' } }),
	);
	await nextPrompt(prompts, 1);
	assert.equal(prompts.length, 2);
});
