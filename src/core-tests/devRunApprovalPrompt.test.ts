/**
 * DEV-9.1 — a aprovação do `dev_run` chega à tela e volta.
 *
 * O defeito que estes testes fecham: o host já pedia a aprovação, mas o
 * broker não publicava o cartão de comando e o painel não tinha o tipo — a
 * pergunta ficava dois minutos em silêncio e era lida como recusa.
 *
 * O que se prova aqui, na cadeia real (`OwnerPromptBroker` → resposta):
 *
 * - a pergunta `run-command` é publicada com comando, diretório e escopo;
 * - `approve` é aceito **só** para ela;
 * - `approve` numa pergunta de autorização é recusado (senão seria aprovar
 *   sem credencial);
 * - cancelar encerra como `cancelled` — não como "expirou";
 * - a permissão não atravessa: cada comando abre a sua pergunta.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { OwnerPromptBroker, type OwnerPrompt } from '../desktop/ownerPrompt';
import { parseOwnerPromptAnswer } from '../desktop/devControl';

/** Um broker que registra o que publicou. */
function broker(): { instance: OwnerPromptBroker; published: OwnerPrompt[] } {
	const published: OwnerPrompt[] = [];
	const instance = new OwnerPromptBroker(
		(prompt: OwnerPrompt) => {
			published.push(prompt);
			return true;
		},
		{ ttlMs: 5_000 },
	);
	return { instance, published };
}

const COMMAND_PROMPT = {
	title: 'Aprovar a execução de um comando',
	detail:
		'Comando: npm run check-types\nDiretório: C:\\repo\nEscopo: script "check-types"\nPrazo: 600s',
};

test('a pergunta de comando é publicada com o texto completo', async () => {
	const { instance, published } = broker();
	const waiting = instance.ask('run-command', COMMAND_PROMPT);
	assert.equal(published.length, 1);
	const prompt = published[0] as OwnerPrompt;
	assert.equal(prompt.kind, 'run-command');
	assert.match(prompt.detail, /Comando: npm run check-types/);
	assert.match(prompt.detail, /Diretório: C:\\repo/);
	assert.match(prompt.detail, /Escopo: script "check-types"/);
	instance.answer({ id: prompt.id, kind: 'cancel' });
	await waiting;
});

test('aprovar resolve a pergunta de comando', async () => {
	const { instance, published } = broker();
	const waiting = instance.ask('run-command', COMMAND_PROMPT);
	const prompt = published[0] as OwnerPrompt;
	const accepted = instance.answer({ id: prompt.id, kind: 'approve' });
	assert.equal(accepted.accepted, true);
	assert.deepEqual(await waiting, { kind: 'approved' });
});

test('aprovar NÃO vale para a pergunta de autorização (que exige senha)', async () => {
	const { instance, published } = broker();
	const waiting = instance.ask('authorize', { title: 'Autorizar', detail: 'confirme' });
	const prompt = published[0] as OwnerPrompt;
	const result = instance.answer({ id: prompt.id, kind: 'approve' });
	assert.equal(result.accepted, false);
	assert.match(result.reason ?? '', /não aceita aprovação sem senha/);
	instance.answer({ id: prompt.id, kind: 'cancel' });
	await waiting;
});

test('cancelar encerra como cancelled, não como expirada', async () => {
	const { instance, published } = broker();
	const waiting = instance.ask('run-command', COMMAND_PROMPT);
	const prompt = published[0] as OwnerPrompt;
	instance.answer({ id: prompt.id, kind: 'cancel' });
	assert.deepEqual(await waiting, { kind: 'cancelled' });
});

test('a resposta ao id de uma pergunta anterior é recusada', async () => {
	const { instance, published } = broker();
	const first = instance.ask('run-command', COMMAND_PROMPT);
	const firstPrompt = published[0] as OwnerPrompt;
	instance.answer({ id: firstPrompt.id, kind: 'cancel' });
	await first;

	const second = instance.ask('run-command', COMMAND_PROMPT);
	const secondPrompt = published[1] as OwnerPrompt;
	const stale = instance.answer({ id: firstPrompt.id, kind: 'approve' });
	assert.equal(stale.accepted, false, 'a aprovação da pergunta antiga não vale para a nova');
	instance.answer({ id: secondPrompt.id, kind: 'approve' });
	assert.deepEqual(await second, { kind: 'approved' });
});

test('o parser aceita approve e recusa o que não tem forma de resposta', () => {
	// O id real tem 18 caracteres hexadecimais depois de `auth-`.
	const id = 'auth-0123456789abcdef01';
	const parsed = parseOwnerPromptAnswer({ id, kind: 'approve' });
	assert.deepEqual(parsed, { id, kind: 'approve' });

	// Campo a mais não invalida: o parser lê os campos que conhece.
	assert.deepEqual(parseOwnerPromptAnswer({ id, kind: 'approve', extra: 1 }), { id, kind: 'approve' });

	assert.throws(() => parseOwnerPromptAnswer({ kind: 'approve' }), /identificador/);
	assert.throws(() => parseOwnerPromptAnswer({ id: 'nao-e-um-id', kind: 'approve' }), /identificador/);
	// Um tipo desconhecido é recusado — hoje como "senha inválida", porque a
	// validação de senha vem antes da de tipo. O que importa é que não passa.
	assert.throws(() => parseOwnerPromptAnswer({ id, kind: 'outra-coisa' }), /senha inválida|tipo de resposta/);
});
