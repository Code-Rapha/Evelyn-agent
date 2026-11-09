import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AssembledCore } from '../app/assemble';
import { API_CAPABILITIES, WebApi } from '../web/api';

/**
 * A interface web: a navegação, o carregamento, os estados vazios e os erros.
 *
 * ## Por que se testa o *conteúdo* e não o navegador
 *
 * A página é `index.js` sem build: um documento que chama `fetch` e escreve
 * HTML. Rodá-la num navegador num teste de unidade seria testar o
 * navegador, não a página. O que importa aqui — a lista de áreas é a mesma
 * dos links, cada área tem o seu endpoint, uma área pendente diz que é
 * pendente, e o erro da API vira uma mensagem — é texto, e é comparável.
 *
 * O que só o navegador prova (o clique, o hash, a renderização) foi
 * verificado no navegador real, e não se finge aqui.
 */
const ASSETS = join(__dirname, '..', '..', 'src', 'web', 'assets');
const SCRIPT = readFileSync(join(ASSETS, 'index.js'), 'utf8');
const MARKUP = readFileSync(join(ASSETS, 'index.html'), 'utf8');

/** Extrai o bloco entre `const NOME = [` e o `];` seguinte. */
function arrayBlock(name: string): string {
	const start = SCRIPT.indexOf(`const ${name} = [`);
	if (start < 0) {
		throw new Error(`bloco ${name} não encontrado`);
	}
	const end = SCRIPT.indexOf('];', start);
	return SCRIPT.slice(start, end);
}

/** As áreas, na ordem do script. */
function areas(): string[] {
	return [...arrayBlock('AREAS').matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
}

/**
 * Uma fachada mínima, com o que cada leitura da interface toca.
 *
 * O `WebApi` só conhece a parte da `ChatSession` que lê; isto é o suficiente
 * para exercitá-lo sem montar o Core. Os campos ausentes ficam ausentes,
 * como no Core: nada aqui é preenchido por conveniência do teste.
 */
function fakeCore(options: {
	readonly providers?: readonly unknown[];
	readonly models?: readonly unknown[];
}): AssembledCore {
	const providers = options.providers ?? [];
	const models = options.models ?? [];
	const chat = {
		listProviders: () => providers,
		readRouterConfig: async () => ({ mode: 'native', enabled: true, configured: true }),
		listMergedCatalog: async () => ({
			policy: {
				policy: 'any',
				priceSource: 'user',
				limitsSource: 'user',
				capabilitiesSource: 'user',
			},
			models,
		}),
		listDiscoveredQuotas: async () => [],
		listModelCatalog: async () => [],
		listAvailableModels: async () => [],
		listSpendingLimits: async () => [],
		readBudget: async () => ({
			total: { usage: { executions: 0, attempts: 0 }, cost: { status: 'unknown', reasons: [] } },
		}),
		listBudgetAlerts: async () => [],
		loadAccessPolicy: async () => ({
			policy: 'any',
			priceSource: 'user',
			limitsSource: 'user',
			capabilitiesSource: 'user',
		}),
		listProjects: async () => [],
	};
	return { chat } as unknown as AssembledCore;
}

suite('Web: a navegação', () => {
	test('as áreas da interface são as exigidas, nesta ordem', () => {
		assert.deepStrictEqual(areas(), [
			'overview',
			'providers',
			'models',
			'chat',
			'combos',
			'routing',
			'usage',
			// R4J: o diagnóstico de turnos, antes dos ajustes.
			'turns',
			'settings',
		]);
	});

	test('cada link do menu corresponde a uma área', () => {
		const links = [...MARKUP.matchAll(/data-area="([a-z-]+)"/g)].map((match) => match[1]);
		assert.deepStrictEqual(links, areas(), 'o menu e a lista de áreas não podem divergir');
	});

	test('a área destacada é a do hash, e o padrão é a visão geral', () => {
		assert.ok(SCRIPT.includes("window.location.hash.replace(/^#/, '')"));
		assert.ok(SCRIPT.includes("return AREAS.includes(area) ? area : 'overview'"));
	});

	test('o hash muda a área: há um listener de hashchange', () => {
		assert.ok(SCRIPT.includes("window.addEventListener('hashchange'"));
	});
});

suite('Web: os endpoints de cada área', () => {
	test('toda área com renderizador tem endpoint, exceto Combos', () => {
		const start = SCRIPT.indexOf('const ENDPOINTS = {');
		assert.ok(start >= 0, 'o mapa de endpoints existe');
		const endpoints = SCRIPT.slice(start, SCRIPT.indexOf('};', start));
		for (const area of ['overview', 'providers', 'models', 'routing', 'usage', 'settings']) {
			assert.ok(endpoints.includes(`${area}: '/api/`), `${area} precisa de um endpoint`);
		}
		assert.ok(!endpoints.includes('combos:'), 'Combos não tem endpoint nesta fase');
	});

	test('Combos é declarada pendente, com uma explicação', () => {
		assert.ok(SCRIPT.includes('combos: {'));
		assert.ok(SCRIPT.includes('Combos ainda não têm endpoint'));
		assert.ok(SCRIPT.includes("if (area === 'combos')"));
	});

	test('as capacidades dizem o que está pendente, e nada disso é escrita', () => {
		assert.ok(API_CAPABILITIES.pending.includes('combos'));
		assert.ok(API_CAPABILITIES.pending.includes('chat'));
		assert.ok(API_CAPABILITIES.ready.includes('providers'));
		assert.ok(API_CAPABILITIES.ready.includes('models'));
	});

	test('a API lista as escrituras que existem, e só elas', () => {
		const reply = new WebApi(undefined).capabilities();
		assert.strictEqual(reply.status, 200);
		const writes = (reply.body as { writes: readonly string[] }).writes;
		assert.deepStrictEqual([...writes], ['providers', 'model-discovery']);
		// Combos e chat continuam sem endpoint, e a página diz isso.
		const pending = (reply.body as { pending: readonly string[] }).pending;
		assert.ok(pending.includes('combos'));
		assert.ok(pending.includes('chat'));
	});
});

suite('Web: carregamento, vazio e erro', () => {
	test('a área mostra carregando antes de pedir os dados', () => {
		const body = SCRIPT.slice(SCRIPT.indexOf('async function show(area)'));
		const loadingAt = body.indexOf('main.innerHTML = loading();');
		const fetchAt = body.indexOf('await getJson(endpoint)');
		assert.ok(loadingAt >= 0 && fetchAt > loadingAt, 'carregar tem de aparecer antes da resposta');
	});

	test('lista vazia é dita, não desenhada como zero', () => {
		assert.ok(SCRIPT.includes('Nenhuma integração disponível nesta instalação.'));
		assert.ok(SCRIPT.includes('Nenhum modelo conhecido ainda.'));
		assert.ok(SCRIPT.includes('Nenhum limite de gasto configurado.'));
		assert.ok(SCRIPT.includes('Nenhum projeto configurado.'));
	});

	test('um erro da API vira a mensagem do servidor e o status', () => {
		assert.ok(SCRIPT.includes("if (typeof body.error === 'string')"));
		assert.ok(SCRIPT.includes('function errorBox(message, status)'));
		assert.ok(SCRIPT.includes('(HTTP '));
	});

	test('401 é tratado como sessão expirada, com instrução', () => {
		assert.ok(SCRIPT.includes('if (response.status === 401)'));
		assert.ok(SCRIPT.includes('A sessão expirou'));
	});

	test('o erro de uma área não quebra o menu', () => {
		const body = SCRIPT.slice(SCRIPT.indexOf('async function show(area)'));
		const markAt = body.indexOf('markActive(area);');
		const fetchAt = body.indexOf('await getJson(endpoint)');
		assert.ok(markAt >= 0 && fetchAt > markAt);
	});
});

suite('Web: a origem de cada valor', () => {
	test('um modelo sem preço não ganha um', async () => {
		const core = fakeCore({ models: [{ providerId: 'p', modelId: 'm', listed: true }] });
		const reply = await new WebApi(core).models();
		const model = (reply.body as { models: Array<{ price?: unknown }> }).models[0];
		assert.strictEqual(model.price, undefined);
	});

	test('preço declarado é marcado como nosso, e o do provedor como dele', async () => {
		const core = fakeCore({
			models: [
				{
					providerId: 'p',
					modelId: 'declarado',
					listed: true,
					price: {
						user: { currency: 'USD', unit: 'per_1m_tokens', input: 1 },
						comparable: false,
						fellBack: false,
					},
				},
			],
		});
		const reply = await new WebApi(core).models();
		const model = (reply.body as { models: Array<{ price: { user: { input: number } } }> }).models[0];
		assert.strictEqual(model.price.user.input, 1);
		// A página marca o lado de origem: nosso, do provedor, ou desconhecido.
		assert.ok(SCRIPT.includes("price.effective.side === 'user' ? 'ours' : 'theirs'"));
		assert.ok(SCRIPT.includes("'nosso' : origin === 'theirs' ? 'do provedor' : 'desconhecido'"));
	});

	test('a chave nunca aparece nas visões de provider', async () => {
		const core = fakeCore({
			providers: [
				{
					id: 'p',
					name: 'P',
					baseUrl: 'http://127.0.0.1:1/v1',
					status: 'configured',
					hasApiKeyRef: true,
					models: [],
				},
			],
		});
		const reply = await new WebApi(core).providers();
		const serialized = JSON.stringify(reply.body);
		assert.ok(!serialized.includes('apiKeyRef'), 'a referência da chave não sai do Core');
		const provider = (reply.body as { providers: Array<{ hasApiKeyRef: boolean }> }).providers[0];
		assert.strictEqual(provider.hasApiKeyRef, true, 'só o fato de existir');
	});
});

suite('Web: sem Core montado', () => {
	test('as áreas respondem "não montado", sem inventar dados', async () => {
		const api = new WebApi(undefined);
		const readers = ['overview', 'providers', 'models', 'routing', 'usage', 'settings'] as const;
		for (const area of readers) {
			const reply = await api[area]();
			assert.strictEqual(reply.status, 404, `${area} deveria recusar sem Core`);
			assert.ok(String((reply.body as { error: string }).error).includes('não está montado'));
		}
	});
});

suite('Web: o registro de turnos corrompido (R4K)', () => {
	/** O trecho de `renderTurnsCorrupt`. */
	function corruptArea(): string {
		const start = SCRIPT.indexOf('function renderTurnsCorrupt(');
		assert.ok(start >= 0, 'a área do registro corrompido existe');
		return SCRIPT.slice(start, SCRIPT.indexOf('\n}', start));
	}

	test('o 503 com `turns_corrupt` mostra a área de recuperação, não o erro genérico', () => {
		assert.ok(
			SCRIPT.includes("error?.status === 503 && error?.code === 'turns_corrupt'"),
			'o carregamento distingue corrupção de um erro qualquer',
		);
		assert.ok(SCRIPT.includes('main.innerHTML = renderTurnsCorrupt(error.reason)'));
	});

	test('a área diz que o diagnóstico está indisponível e que as conversas continuam', () => {
		const area = corruptArea();
		assert.ok(area.includes('diagnóstico dos turnos está indisponível'));
		assert.ok(area.includes('corrompido'));
		assert.ok(area.includes('não foi alterado'));
		assert.ok(area.includes('As conversas continuam abrindo'));
		// O motivo vem da rota, escapado: nunca interpolado cru.
		assert.ok(area.includes('escapeHtml(reason)'));
	});

	test('a área oferece copiar e reiniciar, e avisa do risco', () => {
		const area = corruptArea();
		assert.ok(area.includes('id="turns-backup"'));
		assert.ok(area.includes('id="turns-reset"'));
		assert.ok(area.includes('podem ter se perdido'));
		assert.ok(area.includes('não sobrescreve cópias anteriores'));
	});

	test('o clique dos dois botões está ligado, fora das ações de provider', () => {
		assert.ok(SCRIPT.includes("button.id === 'turns-backup'"));
		assert.ok(SCRIPT.includes("button.id === 'turns-reset'"));
		assert.ok(SCRIPT.includes('void backupTurns()'));
		assert.ok(SCRIPT.includes('void resetTurns()'));
	});

	test('reiniciar pede confirmação explícita', () => {
		const start = SCRIPT.indexOf('async function resetTurns(');
		assert.ok(start >= 0);
		const body = SCRIPT.slice(start, SCRIPT.indexOf('\n}', start));
		assert.ok(body.indexOf('window.confirm(') >= 0, 'sem confirmação a ação não acontece');
		assert.ok(body.includes('/api/turns/recover/reset'));
	});

	test('a cópia chama a rota de cópia e mostra o nome do arquivo', () => {
		const start = SCRIPT.indexOf('async function backupTurns(');
		assert.ok(start >= 0);
		const body = SCRIPT.slice(start, SCRIPT.indexOf('\n}', start));
		assert.ok(body.includes('/api/turns/recover/backup'));
		assert.ok(body.includes('data.backup'));
	});

	test('a lista vazia e a indisponível não se confundem', () => {
		const empties = SCRIPT.slice(
			SCRIPT.indexOf('function renderTurns('),
			SCRIPT.indexOf('function renderTurnsCorrupt('),
		);
		assert.ok(empties.includes('Nenhum turno registrado ainda.'));
		// A área de corrupção não afirma ausência de turnos.
		assert.ok(!corruptArea().includes('Nenhum turno registrado'));
	});
});
