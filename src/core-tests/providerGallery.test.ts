/**
 * A galeria de provedores.
 *
 * ## O que se prova
 *
 * 1. **Categorias**: oficiais, gratuitas via ferramentas externas e
 *    experimentais — as três que a página mostra;
 * 2. **Metadado não é conexão**: uma integração só é `connected` quando há um
 *    provedor real com o mesmo endereço;
 * 3. **A honestidade dos métodos**: só `api-key` é suportado pelo app; tudo o
 *    que depende de CLI ou OAuth aparece como não suportado, com o motivo;
 * 4. **Nada inventado**: nenhuma integração sem método suportado declara
 *    endereço, e nenhuma promete fluxo OAuth;
 * 5. **A galeria não mistura** com o catálogo de modelos.
 */
import * as assert from 'assert';

import type { ProviderSummary } from '../desktop/contract';
import {
	INTEGRATIONS,
	buildGallery,
	categoryLabel,
	integrationState,
	type Integration,
} from '../web/integrations';

/** Um provedor real, para o estado "conectado". */
function provider(baseUrl: string, id = 'p'): ProviderSummary {
	return { id, name: 'P', baseUrl, status: 'configured', hasApiKeyRef: true, models: [] };
}

suite('Providers: a galeria', () => {
	test('as três categorias existem, com nome legível', () => {
		assert.strictEqual(categoryLabel('official'), 'Oficiais');
		assert.strictEqual(categoryLabel('free-via-tools'), 'Gratuitas via ferramentas externas');
		assert.strictEqual(categoryLabel('experimental'), 'Experimentais e personalizados');
	});

	test('o catálogo tem integrações nas três categorias', () => {
		const categories = new Set(INTEGRATIONS.map((entry) => entry.category));
		assert.ok(categories.has('official'));
		assert.ok(categories.has('free-via-tools'));
		assert.ok(categories.has('experimental'));
	});

	test('só chave de API é um método que o app executa', () => {
		for (const entry of INTEGRATIONS) {
			if (entry.support === 'supported') {
				assert.strictEqual(entry.connection, 'api-key', `${entry.id}: o app só executa chave de API`);
			}
			if (entry.connection !== 'api-key') {
				assert.notStrictEqual(entry.support, 'supported', `${entry.id}: login externo não vira suportado`);
			}
		}
	});

	test('nada depende de OAuth fictício: CLI/OAuth é dito como não suportado, com motivo', () => {
		const external = INTEGRATIONS.filter((entry) => entry.connection === 'cli-or-oauth' && entry.managedServer !== true);
		assert.ok(external.length > 0, 'há integrações desse tipo, e elas são ditas');
		for (const entry of external) {
			assert.strictEqual(entry.support, 'unavailable');
			assert.ok((entry.limitation ?? '').length > 0, `${entry.id}: a limitação é dita`);
			assert.ok((entry.instructions ?? '').length > 0, `${entry.id}: o que fazer é dito`);
		}
	});

	/**
	 * O OpenCode saiu de "não suportado" na Fase 4C, mas não por OAuth: o app
	 * tem um gerenciador de servidor próprio, com metal e sem token do
	 * usuário. A galeria precisa dizer as duas coisas: o método continua fora
	 * do formulário de chave, e o estado é o do health — não do catálogo.
	 */
	test('a integração com servidor próprio é declarada como tal, e não finge conexão', () => {
		const managed = INTEGRATIONS.filter((entry) => entry.managedServer === true);
		assert.deepStrictEqual(managed.map((entry) => entry.id), ['opencode']);
		for (const entry of managed) {
			assert.strictEqual(entry.connection, 'cli-or-oauth', `${entry.id}: o login é do CLI`);
			assert.notStrictEqual(entry.support, 'supported', `${entry.id}: não é o formulário de chave`);
			assert.strictEqual(entry.baseUrl, undefined, `${entry.id}: o endereço é do runtime, não inventado`);
			assert.ok((entry.limitation ?? '').length > 0, `${entry.id}: a limitação da fase é dita`);
		}
		const gallery = buildGallery([]);
		const opencode = gallery.find((entry) => entry.integration.id === 'opencode');
		assert.strictEqual(opencode?.state, 'experimental', 'a galeria sozinha nunca diz "conectado"');
	});

	test('uma integração não suportada não declara endereço', () => {
		for (const entry of INTEGRATIONS) {
			if (entry.support !== 'supported') {
				assert.strictEqual(entry.baseUrl, undefined, `${entry.id}: sem endereço inventado`);
			}
		}
	});

	test('o endereço declarado é um endereço http(s)', () => {
		for (const entry of INTEGRATIONS) {
			if (entry.baseUrl !== undefined) {
				assert.match(entry.baseUrl, /^https?:\/\//, `${entry.id}: o endereço é uma URL`);
			}
		}
	});

	test('nenhuma conexão: disponível, não "conectado"', () => {
		const gallery = buildGallery([]);
		for (const entry of gallery) {
			assert.notStrictEqual(entry.state, 'connected', `${entry.integration.id}: sem provedor real`);
		}
	});

	test('metadado não é conexão: um provedor real com o mesmo endereço torna conectado', () => {
		const openai = INTEGRATIONS.find((entry) => entry.id === 'openai');
		assert.ok(openai !== undefined);
		const state = integrationState(openai, [provider(`${openai.baseUrl}/`, 'x')]);
		assert.strictEqual(state.state, 'connected');
		assert.strictEqual(state.provider?.id, 'x');
	});

	test('um endereço parecido não é o mesmo endereço', () => {
		const openai = INTEGRATIONS.find((entry) => entry.id === 'openai');
		assert.ok(openai !== undefined);
		const state = integrationState(openai, [provider('https://api.openai.com/v2')]);
		assert.strictEqual(state.state, 'available');
	});

	test('CLI/OAuth aparece como autenticação necessária; experimental como experimental', () => {
		const kiro = INTEGRATIONS.find((entry) => entry.id === 'kiro') as Integration;
		assert.strictEqual(integrationState(kiro, []).state, 'needs-auth');

		const local = INTEGRATIONS.find((entry) => entry.id === 'local-openai-compatible') as Integration;
		assert.strictEqual(integrationState(local, []).state, 'experimental');
	});

	test('a galeria é do provedor, não do catálogo de modelos', () => {
		// A galeria não expõe nenhum modelo — ela diz o que é e como conectar.
		const entries = buildGallery([]);
		for (const entry of entries) {
			assert.strictEqual('models' in entry.integration, false);
		}
	});
});
