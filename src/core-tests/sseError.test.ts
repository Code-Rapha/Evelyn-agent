/**
 * DEV-10 — um erro dentro do stream não pode parecer um keepalive.
 *
 * Medido com o River: HTTP **200**, e o primeiro evento do corpo era
 *
 *     {"error":{"message":"Invalid inference request. Check the model's
 *      supported parameters and input limits.","type":"invalid_request_error"}}
 *
 * O corpo não tem `choices`, então o parser devolvia `undefined` — o mesmo que
 * um keepalive. O stream terminava sem texto e sem erro, o runtime concluía
 * `answered`, e a pessoa via um "ola" sem resposta com o turno marcado como
 * sucesso. O erro estava lá desde o primeiro byte e nunca chegava a ninguém.
 */
import * as assert from 'node:assert/strict';

import { parseChatChunk } from '../core/providers/chat/sse';

suite('DEV-10: o erro que chega dentro do stream', () => {
	test('um corpo de erro sobe como exceção, não como chunk vazio', () => {
		const corpo = JSON.stringify({
			error: {
				message: 'Invalid inference request. Check the model\'s supported parameters and input limits.',
				type: 'invalid_request_error',
				code: 'invalid_request',
			},
		});

		assert.throws(
			() => parseChatChunk(corpo),
			/Invalid inference request/,
			'a mensagem do provedor precisa chegar a quem lê',
		);
	});

	test('a exceção nomeia o tipo e o código, para o log ter contexto', () => {
		const corpo = JSON.stringify({
			error: { message: 'rate limited', type: 'rate_limit_error', code: 'account_rate' },
		});

		assert.throws(() => parseChatChunk(corpo), /rate_limit_error/);
		assert.throws(() => parseChatChunk(corpo), /account_rate/);
	});

	test('um erro sem mensagem ainda falha, em vez de virar silêncio', () => {
		assert.throws(() => parseChatChunk(JSON.stringify({ error: {} })), /recusou a requisição/);
	});

	// O que **não** pode mudar: um keepalive continua sendo nada a reportar.
	test('um keepalive de verdade continua sendo ignorado', () => {
		assert.equal(parseChatChunk(JSON.stringify({ choices: [] })), undefined);
	});

	test('um chunk só de usage continua sendo um chunk', () => {
		const chunk = parseChatChunk(
			JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
		);
		assert.notEqual(chunk, undefined);
		assert.equal(chunk?.text, '');
	});

	test('um chunk normal continua sendo lido', () => {
		const chunk = parseChatChunk(
			JSON.stringify({ choices: [{ delta: { content: 'oi' } }] }),
		);
		assert.equal(chunk?.text, 'oi');
	});
});
