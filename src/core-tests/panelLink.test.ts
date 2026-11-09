/**
 * R4R: o endereço do painel que o botão "Abrir no navegador" usa.
 *
 * O que se fixa aqui é a fronteira de segurança: o app só abre o painel do
 * serviço desta instalação, na porta registrada e com a credencial do
 * registro. Um registro ausente ou danificado recusa — nunca abre uma URL
 * arbitrária no navegador do usuário.
 */
import * as assert from 'node:assert/strict';

import { panelUrlFor } from '../desktop/panelLink';

suite('R4R: o endereço do painel', () => {
	test('monta a entrada do painel a partir do registro', () => {
		const plan = panelUrlFor({ port: 43210, token: 'a'.repeat(64) });

		assert.equal(plan.ok, true);
		if (plan.ok) {
			assert.equal(plan.url, `http://127.0.0.1:43210/?t=${'a'.repeat(64)}`);
			// Só loopback: o painel nunca é aberto fora da máquina.
			assert.ok(plan.url.startsWith('http://127.0.0.1:'));
		}
	});

	test('sem registro, recusa e diz que precisa do serviço', () => {
		const plan = panelUrlFor(undefined);

		assert.equal(plan.ok, false);
		if (!plan.ok) {
			assert.equal(plan.code, 'inactive');
			assert.match(plan.message, /serviço local não está ativo/);
		}
	});

	test('porta fora de faixa é recusada', () => {
		for (const port of [0, -1, 70_000, 3.5]) {
			const plan = panelUrlFor({ port, token: 'x' });
			assert.equal(plan.ok, false, `porta ${port}`);
			if (!plan.ok) {
				assert.equal(plan.code, 'invalid');
			}
		}
	});

	test('registro sem credencial é recusado', () => {
		const plan = panelUrlFor({ port: 1234, token: '' });

		assert.equal(plan.ok, false);
		if (!plan.ok) {
			assert.equal(plan.code, 'invalid');
		}
	});

	test('o token é codificado na URL', () => {
		const plan = panelUrlFor({ port: 1, token: 'a b&c' });

		assert.equal(plan.ok, true);
		if (plan.ok) {
			assert.equal(plan.url, 'http://127.0.0.1:1/?t=a%20b%26c');
		}
	});
});
