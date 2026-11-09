/**
 * R4S: o par (provedor, modelo) no modo conectado.
 *
 * ## O defeito
 *
 * O renderer reconstruía o provedor recortando o **nome** do modelo em
 * `indexOf('/')`, supondo o formato `providerId/modelId`. A lista do serviço
 * traz os dois campos separados, e nomes reais têm barra:
 *
 * ```
 * providerId = "api.river.ai-v1"      model = "deepseek-ai/DeepSeek-V4.1-Flash"
 * ```
 *
 * O recorte dava `deepseek-ai` como provedor, e o serviço recusava criar a
 * conversa e iniciar o turno. Estes testes fixam a regra: o par vem da
 * escolha, nunca do texto do modelo.
 */
import * as assert from 'node:assert/strict';

import { chooseProviderFor } from '../desktop/panelSelection';

const MODELS = [
	{ providerId: 'api.river.ai-v1', providerName: 'River', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
	{ providerId: 'api.river.ai-v1', providerName: 'River', model: 'Qwen/Qwen3.8-27B-FP8' },
	{ providerId: 'outro', providerName: 'Outro', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
] as const;

suite('R4S: o par provedor/modelo', () => {
	test('um nome com barra não vira provedor', () => {
		const choice = chooseProviderFor(MODELS, '', 'deepseek-ai/DeepSeek-V4.1-Flash');

		assert.deepEqual(choice, {
			providerId: 'api.river.ai-v1',
			model: 'deepseek-ai/DeepSeek-V4.1-Flash',
		});
		assert.notEqual(choice?.providerId, 'deepseek-ai');
	});

	test('o provedor escolhido desempata dois modelos de mesmo nome', () => {
		const choice = chooseProviderFor(MODELS, 'outro', 'deepseek-ai/DeepSeek-V4.1-Flash');

		assert.equal(choice?.providerId, 'outro');
	});

	test('sem modelo escolhido, não há par', () => {
		assert.equal(chooseProviderFor(MODELS, 'api.river.ai-v1', ''), undefined);
	});

	test('um modelo que não está na lista não vira par inventado', () => {
		assert.equal(chooseProviderFor(MODELS, 'api.river.ai-v1', 'sumiu/modelo'), undefined);
	});

	test('o par carrega o id exato do provedor, como o serviço o conhece', () => {
		const choice = chooseProviderFor(MODELS, '', 'Qwen/Qwen3.8-27B-FP8');

		assert.equal(choice?.providerId, 'api.river.ai-v1');
		assert.equal(choice?.model, 'Qwen/Qwen3.8-27B-FP8');
	});
});
