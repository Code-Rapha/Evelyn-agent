/**
 * DEV-AUDIT-03: o contrato e a autenticação do serviço de sandbox.
 *
 * Este código **não está ligado a nada**: nenhum módulo do produto o importa.
 * Ele existe como especificação executável para quando a sandbox de processo
 * for viável (ver `docs/dev-sandbox-limitations.md`) — e estes testes
 * garantem que, se alguém ligá-lo, a autenticação básica já funciona.
 *
 * O que eles provam, e o que **não** provam:
 *
 * - provam: HMAC correto, recusa de assinatura adulterada, janela de tempo e
 *   anti-replay por sequência; validação do pedido e teto de tempo;
 * - **não** provam: isolamento de processo. Não há sandbox implementada, e
 *   nenhum teste aqui afirma que exista.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateSandboxKey, signRequest, verifyEnvelope, SANDBOX_KEY_BYTES } from '../core/dev/sandboxAuth';
import {
	parseSandboxRequest,
	SANDBOX_MAX_TIMEOUT_MS,
	type SandboxRequest,
} from '../core/dev/sandboxProtocol';

const KEY = generateSandboxKey();
const REQUEST: SandboxRequest = {
	op: 'run',
	root: 'C:\\repo',
	command: 'npm run check-types',
	timeoutMs: 30_000,
};

test('a chave tem 32 bytes e é diferente a cada geração', () => {
	assert.equal(Buffer.from(KEY, 'base64').length, SANDBOX_KEY_BYTES);
	assert.notEqual(generateSandboxKey(), generateSandboxKey());
});

test('um envelope assinado é aceito', () => {
	const envelope = signRequest(KEY, 1, REQUEST);
	assert.equal(verifyEnvelope(KEY, envelope, 0).ok, true);
});

test('assinatura adulterada é recusada', () => {
	const envelope = signRequest(KEY, 1, REQUEST);
	const verdict = verifyEnvelope(KEY, { ...envelope, signature: Buffer.alloc(32).toString('base64') }, 0);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false && verdict.reason, 'assinatura-invalida');
});

test('outro pedido com a mesma assinatura é recusado', () => {
	// Trocar o comando invalida o HMAC: é o que impede um intermediário de
	// mudar `npm test` para outra coisa.
	const envelope = signRequest(KEY, 1, REQUEST);
	const tampered = { ...envelope, payload: { ...REQUEST, command: 'npm run outra-coisa' } };
	assert.equal(verifyEnvelope(KEY, tampered, 0).ok, false);
});

test('ordem: a sequência não pode retroceder (replay)', () => {
	const primeiro = signRequest(KEY, 5, REQUEST);
	assert.equal(verifyEnvelope(KEY, primeiro, 4).ok, true);
	assert.equal(verifyEnvelope(KEY, primeiro, 5).ok, false, 'a mesma mensagem não passa de novo');
	const antiga = signRequest(KEY, 3, REQUEST);
	const verdict = verifyEnvelope(KEY, antiga, 5);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false && verdict.reason, 'sequencia-fora-de-ordem');
});

test('fora da janela de tempo é recusado', () => {
	const antigo = signRequest(KEY, 1, REQUEST, new Date(Date.now() - 120_000));
	const verdict = verifyEnvelope(KEY, antigo, 0);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false && verdict.reason, 'fora-da-janela');
});

test('versão de protocolo diferente é recusada', () => {
	const envelope = signRequest(KEY, 1, REQUEST);
	const verdict = verifyEnvelope(KEY, { ...envelope, version: 2 as never }, 0);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false && verdict.reason, 'protocolo-desconhecido');
});

test('o pedido é validado antes de virar sandbox', () => {
	assert.equal(parseSandboxRequest(REQUEST).command, 'npm run check-types');
	assert.throws(() => parseSandboxRequest({ ...REQUEST, op: 'shell' }));
	assert.throws(() => parseSandboxRequest({ ...REQUEST, root: 'repo' }), /raiz/);
	assert.throws(() => parseSandboxRequest({ ...REQUEST, command: '' }), /comando/);
	assert.throws(() => parseSandboxRequest({ ...REQUEST, timeoutMs: -1 }), /prazo/);
});

test('o prazo pedido é limitado ao teto do serviço', () => {
	const parsed = parseSandboxRequest({ ...REQUEST, timeoutMs: 86_400_000 });
	assert.equal(parsed.timeoutMs, SANDBOX_MAX_TIMEOUT_MS, 'um pedido de um dia é cortado');
});
