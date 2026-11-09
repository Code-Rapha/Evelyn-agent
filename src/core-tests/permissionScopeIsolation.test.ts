/**
 * DEV-AUDIT-01: uma autorização não atravessa escopos.
 *
 * A auditoria mediu dois defeitos na classificação:
 *
 * 1. Uma regex sobre o **nome** tornava `write_file`, `write_memory`,
 *    `write_skill` e `delete_memory` "escopo DEV".
 * 2. `dev_write` com caminho `C:\fora\do\repo` gerava a chave
 *    `g:/repo/c:/fora/do/repo` — uma chave inventada, que conceder a raiz
 *    (`g:/repo`) cobria.
 *
 * Os casos abaixo fixam o contrário: ferramenta e caminho, cada um no seu
 * escopo.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyRequest, grantCovers, scopeKey } from '../desktop/permissionScope';
import type { PermissionRequest } from '../core/permissions/gateway';

const ROOT = 'G:\\repo';

function request(toolName: string, args: Record<string, unknown> = {}, riskLevel: 'safe' | 'moderate' | 'dangerous' = 'dangerous'): PermissionRequest {
	return {
		toolId: toolName,
		toolName,
		action: toolName,
		description: '',
		riskLevel,
		arguments: args,
		sessionId: 'task-1',
	} as PermissionRequest;
}

test('nenhuma ferramenta fora do repositório é classificada só pelo nome', () => {
	for (const tool of ['write_file', 'create_file', 'write_memory', 'write_skill', 'delete_memory', 'delete_skill']) {
		const verdict = classifyRequest(request(tool, { path: 'src/a.ts', content: 'x' }, 'moderate'), { root: ROOT });
		// `delete_*` e as de memória/skill não têm escopo reutilizável; as de
		// escrita de arquivo têm o escopo do **workspace**, nunca o da raiz DEV.
		if (tool === 'write_file' || tool === 'create_file') {
			assert.equal(verdict.kind, 'scoped', tool);
			if (verdict.kind === 'scoped') {
				assert.notEqual(verdict.key, scopeKey(ROOT), `${tool} não pode ter a raiz DEV como chave`);
			}
			continue;
		}
		assert.equal(verdict.kind, 'explicit', `${tool} não se reutiliza`);
	}
});

test('memória e skill pedem confirmação a cada vez', () => {
	for (const tool of ['write_memory', 'write_skill', 'delete_memory', 'delete_skill']) {
		assert.equal(classifyRequest(request(tool, {}, 'moderate'), { root: ROOT }).kind, 'explicit', tool);
	}
});

test('dev_checkpoint é leitura: automática', () => {
	assert.equal(classifyRequest(request('dev_checkpoint', {}, 'safe'), { root: ROOT }).kind, 'automatic');
});

test('uma concessão na raiz DEV NÃO cobre escrita com caminho absoluto para fora', () => {
	const verdict = classifyRequest(
		request('dev_write', { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', content: 'x' }),
		{ root: ROOT },
	);
	assert.equal(verdict.kind, 'explicit', 'caminho absoluto não gera chave de escopo');
	// E, por não haver chave, nenhuma concessão — nem a da raiz — pode cobri-lo.
	assert.equal(verdict.kind === 'explicit', true);
});

test('`..` que sobe acima da raiz também não gera chave de escopo', () => {
	const verdict = classifyRequest(
		request('dev_write', { path: '../../fora/a.txt', content: 'x' }),
		{ root: ROOT },
	);
	assert.equal(verdict.kind, 'explicit');
});

test('`..` que volta para dentro da raiz é aceito, e a chave é o destino real', () => {
	const verdict = classifyRequest(
		request('dev_write', { path: 'src/../lib/a.ts', content: 'x' }),
		{ root: ROOT },
	);
	assert.equal(verdict.kind, 'scoped');
	if (verdict.kind === 'scoped') {
		assert.equal(verdict.key, scopeKey('G:\\repo\\lib'));
	}
});

test('normalização Windows: barra invertida, caixa e separador final', () => {
	const upper = classifyRequest(request('dev_write', { path: 'SRC\\A.TS', content: 'x' }), { root: ROOT });
	const mixed = classifyRequest(request('dev_write', { path: 'src/a.ts', content: 'x' }), { root: 'g:/repo/' });
	assert.equal(upper.kind, 'scoped');
	assert.equal(mixed.kind, 'scoped');
	if (upper.kind === 'scoped' && mixed.kind === 'scoped') {
		assert.equal(upper.key, mixed.key, 'as duas formas são o mesmo diretório');
		assert.equal(upper.key, 'g:/repo/src');
	}
});

test('grantCovers normaliza as duas pontas antes de comparar', () => {
	const granted = new Set(['G:\\REPO\\SRC']);
	assert.equal(grantCovers(granted, 'g:/repo/src'), true);
	assert.equal(grantCovers(granted, 'G:\\repo\\src\\a\\b.ts'), true);
	assert.equal(grantCovers(granted, 'g:/repo/src2'), false);
	assert.equal(grantCovers(granted, 'g:/repo/outro'), false);
});

test('o escopo de um workspace não alcança o de outro', () => {
	const projectA = classifyRequest(request('write_file', { path: 'C:\\projA\\a.txt', content: 'x' }, 'moderate'), {
		root: ROOT,
	});
	const projectB = classifyRequest(request('write_file', { path: 'C:\\projB\\a.txt', content: 'x' }, 'moderate'), {
		root: ROOT,
	});
	assert.equal(projectA.kind, 'scoped');
	assert.equal(projectB.kind, 'scoped');
	if (projectA.kind === 'scoped' && projectB.kind === 'scoped') {
		assert.equal(grantCovers(new Set([projectA.key]), projectB.key), false);
		assert.equal(grantCovers(new Set([projectA.key]), classifyKey(projectA)), true);
	}
});

test('escrita DENTRO do repositório continua reutilizável, e fora não é', () => {
	const inside = classifyRequest(request('dev_write', { path: 'src/a.ts', content: 'x' }), { root: ROOT });
	assert.equal(inside.kind, 'scoped');
	if (inside.kind === 'scoped') {
		assert.equal(grantCovers(new Set([inside.key]), scopeKey('G:\\repo\\src\\b.ts').replace(/\/[^/]*$/, '')), true);
		assert.equal(grantCovers(new Set([inside.key]), scopeKey('G:\\repo\\config\\x.json')), false);
	}
});

test('destrutivas e sensíveis continuam explícitas', () => {
	for (const tool of ['dev_apply', 'dev_restore', 'dev_configure', 'dev_recover', 'run_command', 'system_write']) {
		assert.equal(classifyRequest(request(tool, {}, 'dangerous'), { root: ROOT }).kind, 'explicit', tool);
	}
});

/** Extrai a chave de um veredito `scoped` (para o teste compilar nos dois ramos). */
function classifyKey(verdict: { readonly kind: string; readonly key?: string }): string {
	return verdict.key ?? '';
}
