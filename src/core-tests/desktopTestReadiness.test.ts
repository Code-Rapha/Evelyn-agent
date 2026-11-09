/**
 * R4L: o sinal de prontidão dos testes de integração.
 *
 * ## O que estes testes fixam
 *
 * - desligado por padrão: sem `SESHYINA_TEST_READY=1` nada é produzido;
 * - o formato é o que o teste de integração lê, e `parseReady` o devolve;
 * - o sinal não carrega token nem caminho — só modo e pids;
 * - a leitura de uma saída partida em pedaços ainda encontra a linha;
 * - a falta do sinal gera uma mensagem diagnóstica.
 *
 * Unitário: a função pura, sem Electron e sem processo.
 */
import * as assert from 'node:assert/strict';

import {
	missingReadyHint,
	parseReady,
	READY_ENV,
	READY_LINE_PATTERN,
	readyEnabled,
	readyLine,
} from '../desktop/testReadiness';

suite('R4L: o sinal de prontidão', () => {
	test('desligado por padrão: ambiente vazio ou com outro valor não produz nada', () => {
		assert.equal(readyEnabled({}), false);
		assert.equal(readyEnabled({ [READY_ENV]: '0' }), false);
		assert.equal(readyEnabled({ [READY_ENV]: 'true' }), false, 'só "1" liga');
		assert.equal(readyEnabled({ [READY_ENV]: '1' }), true);
		assert.equal(readyLine({ mode: 'connected', pid: 1 }, { env: {} }), undefined);
	});

	test('o modo conectado carrega o pid do serviço', () => {
		const line = readyLine({ mode: 'connected', pid: 4242, service: 99 }, { enabled: true });

		assert.equal(line, '[evelyn-test] ready mode=connected pid=4242 service=99');
		const parsed = parseReady(`${line ?? ''}\n`);
		assert.deepEqual(parsed, { mode: 'connected', pid: 4242, service: 99 });
	});

	test('o modo local não carrega serviço', () => {
		const line = readyLine({ mode: 'local', pid: 7 }, { enabled: true }) ?? '';

		assert.equal(line, '[evelyn-test] ready mode=local pid=7');
		assert.deepEqual(parseReady(line), { mode: 'local', pid: 7 });
	});

	test('a leitura encontra o sinal no meio de outra saída', () => {
		const output = [
			'[evelyn] INFO [seshyina.web] qualquer coisa',
			'outra linha qualquer',
			'[evelyn-test] ready mode=connected pid=5 service=6',
			'mais saída depois',
		].join('\r\n');

		assert.deepEqual(parseReady(output), { mode: 'connected', pid: 5, service: 6 });
	});

	test('nenhum modo inventado é aceito', () => {
		assert.equal(parseReady('[evelyn-test] ready mode=magic pid=1'), undefined);
		assert.equal(READY_LINE_PATTERN.test('[evelyn-test] ready mode=connected pid=x'), false);
	});

	test('o sinal não carrega token nem caminho', () => {
		const token = 'a'.repeat(64);
		const path = 'C:\\Users\\alguem\\dados';
		const line = readyLine({ mode: 'connected', pid: 1, service: 2 }, { enabled: true }) ?? '';

		assert.equal(line.includes(token), false);
		assert.equal(line.includes(path), false);
		assert.equal(line.includes('token'), false);
		assert.equal(line.includes('root'), false);
	});

	test('a falta do sinal explica como e mostra a saída', () => {
		const message = missingReadyHint('connected', '   \n  ');
		assert.match(message, /não emitiu o sinal de prontidão/);
		assert.match(message, /SESHYINA_TEST_READY=1/);
		assert.match(message, /<vazia>/);
	});

	test('a saída longa é truncada na mensagem, sem engolir o teste', () => {
		const message = missingReadyHint('local', 'x'.repeat(5_000));
		assert.ok(message.length < 1_200, `mensagem curta (${message.length})`);
		assert.equal(message.includes('x'.repeat(700)), false);
	});
});
