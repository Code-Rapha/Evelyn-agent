/**
 * A abertura da janela de configurações: o que fazer com ela quando o usuário
 * pede.
 *
 * ## O que se prova
 *
 * 1. Sem janela, a janela é criada;
 * 2. Uma janela destruída também é criada de novo — uma referência velha não
 *    pode ser reutilizada;
 * 3. Uma janela minimizada é **restaurada**: `focus()` sozinho não devolve
 *    uma janela minimizada à tela, e o clique pareceria ignorado;
 * 4. Uma janela escondida é mostrada;
 * 5. Uma janela visível é apenas elevada.
 */
import * as assert from 'assert';

import { settingsWindowAction } from '../desktop/settingsWindowPolicy';

suite('Settings window: what to do when it is asked for', () => {
	test('with no window, one is created', () => {
		assert.strictEqual(
			settingsWindowAction({ exists: false, destroyed: false, minimized: false, visible: false }),
			'create',
		);
	});

	test('a destroyed window is not reused', () => {
		assert.strictEqual(
			settingsWindowAction({ exists: true, destroyed: true, minimized: false, visible: false }),
			'create',
		);
	});

	test('a minimised window is restored, not merely focused', () => {
		assert.strictEqual(
			settingsWindowAction({ exists: true, destroyed: false, minimized: true, visible: false }),
			'restore',
		);
	});

	test('a hidden window is shown', () => {
		assert.strictEqual(
			settingsWindowAction({ exists: true, destroyed: false, minimized: false, visible: false }),
			'show',
		);
	});

	test('a visible window is only raised', () => {
		assert.strictEqual(
			settingsWindowAction({ exists: true, destroyed: false, minimized: false, visible: true }),
			'raise',
		);
	});

	test('a minimised window is restored even when it still counts as visible', () => {
		// The order of the questions matters: a minimised window is out of
		// sight, and restoring it is what brings it back.
		assert.strictEqual(
			settingsWindowAction({ exists: true, destroyed: false, minimized: true, visible: true }),
			'restore',
		);
	});
});
