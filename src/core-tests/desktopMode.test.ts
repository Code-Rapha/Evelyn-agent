/**
 * R4B: o modo do desktop (local, conectado, sem dados).
 *
 * ## O que estes testes fixam
 *
 * O `CoreStatus.mode` é o que a interface usa para dizer onde os dados estão.
 * Ele precisa ser:
 *
 * - **exaustivo**: um valor fora dos três é recusado pelo contrato, para a
 *   interface não receber um modo que ela não sabe desenhar;
 * - **compatível**: um payload antigo, sem `mode`, lê como `local` — era o
 *   único modo antes desta fase, e um cliente velho não pode quebrar;
 * - **honesto**: os campos que acompanham o modo conectado não carregam
 *   caminho de dados nem credencial.
 */
import * as assert from 'assert';

import { parseCoreStatus, type CoreStatus } from '../desktop/contract';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		appName: 'Evelyn',
		version: '0.0.1',
		electronVersion: '38.0.0',
		platform: 'win32',
		services: [],
		providerCount: 0,
		dataDirectory: '',
		...overrides,
	};
}

suite('R4B: o modo do Core', () => {
	test('local, connected e unavailable são aceitos', () => {
		const modes: CoreStatus['mode'][] = ['local', 'connected', 'unavailable'];
		for (const mode of modes) {
			// O modo local tem caminho; os outros não precisam — e não devem
			// receber um, porque o app não conhece a pasta do serviço.
			const status = parseCoreStatus(
				payload({
					mode,
					dataDirectory: mode === 'local' ? 'C:\\dados' : '',
				}),
			);
			assert.equal(status.mode, mode);
		}
	});

	test('um payload sem `mode` lê como local', () => {
		// Compatibilidade: antes desta fase só existia o modo local, e um
		// payload gravado/gerado por uma versão anterior não diz o modo.
		assert.equal(parseCoreStatus(payload({ dataDirectory: 'C:\\dados' })).mode, 'local');
	});

	test('um modo desconhecido é recusado, em vez de virar local', () => {
		// "local" por engano é perigoso: a interface acharia que há Core aqui
		// e tentaria conversar com um processo que não tem um.
		assert.throws(
			() => parseCoreStatus(payload({ mode: 'remote', dataDirectory: 'C:\\dados' })),
			/mode must be/,
		);
		assert.throws(
			() => parseCoreStatus(payload({ mode: 42, dataDirectory: 'C:\\dados' })),
			/mode must be/,
		);
	});

	test('o status conectado não carrega caminho de dados nem credencial', () => {
		const status = parseCoreStatus(
			payload({
				mode: 'connected',
				dataDirectory: '',
				providerCount: 3,
			}),
		);

		const serialized = JSON.stringify(status);
		assert.equal(status.dataDirectory, '');
		assert.equal(status.providerCount, 3);
		// Nenhum dos formatos de credencial aparece.
		assert.equal(/token/i.test(serialized), false);
		assert.equal(/reader/i.test(serialized), false);
	});
});
