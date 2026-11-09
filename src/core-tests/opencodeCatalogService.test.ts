/**
 * A descoberta do catálogo: a ordem, as recusas e o que sobrevive a uma falha.
 *
 * ## O que se prova
 *
 * 1. **Só com conexão**: sem conexão viva do gerenciador, nada é perguntado;
 * 2. **Só após o health**: um health que recusa a senha encerra antes de
 *    qualquer leitura do catálogo;
 * 3. **`401`/`403`**, **timeout** e **falha de rede** viram estados com
 *    motivo, e não apagam o catálogo anterior — que fica **desatualizado**;
 * 4. **Formato inesperado e campo sensível** são dizeres explícitos;
 * 5. **A rota insegura nunca é pedida**: o teste falha se a URL não for uma
 *    das duas que o serviço conhece;
 * 6. **Isolamento**: o catálogo do OpenCode não entra no catálogo do Core.
 *
 * A rede é substituída por um transporte injetado: nenhum socket é aberto.
 */
import * as assert from 'assert';

import {
	OpencodeCatalogService,
	type CatalogTransport,
	type OpencodeCatalogOptions,
} from '../app/opencodeCatalogService';
import type { OpencodeManager } from '../app/opencodeManager';
import type { OpencodeCatalog } from '../app/opencodeCatalog';

/** Uma conexão mínima, só com o que a descoberta usa. */
function fakeManager(connection: { baseUrl: string; password: string } | undefined): OpencodeManager {
	return {
		connection: () => (connection === undefined ? undefined : { ...connection, mode: 'managed' }),
	} as unknown as OpencodeManager;
}

/** O que o transporte simulado responde a cada caminho. */
type Answer = { readonly status: number; readonly body: string } | 'timeout' | 'network';

interface Script {
	health: Answer;
	catalog: Answer;
}

/** Um transporte que registra tudo o que foi pedido. */
interface FakeTransport {
	readonly transport: CatalogTransport;
	readonly urls: string[];
	script: Script;
}

function fakeTransport(script: Script): FakeTransport {
	const urls: string[] = [];
	const holder: FakeTransport = {
		urls,
		script,
		transport: {
			get: async (input: { readonly url: string }) => {
				urls.push(input.url);
				const answer = input.url.endsWith('/global/health') ? holder.script.health : holder.script.catalog;
				if (answer === 'timeout') {
					throw new Error('o servidor não respondeu a tempo');
				}
				if (answer === 'network') {
					throw new Error('connect ECONNREFUSED 127.0.0.1:1');
				}
				return { status: answer.status, body: answer.body };
			},
		},
	};
	return holder;
}

/** Um corpo válido com dois provedores. */
const VALID = JSON.stringify({
	data: [
		{ id: 'modelo-a', providerID: 'openrouter', status: 'active', name: 'Modelo A' },
		{ id: 'modelo-b', providerID: 'opencode', status: 'deprecated' },
	],
});

const HEALTH_OK: Answer = { status: 200, body: '{"healthy":true,"version":"1.18.34"}' };

/** Um registro em disco, em memória. */
function memoryStore(): {
	readonly store: NonNullable<OpencodeCatalogOptions['store']>;
	readonly written: OpencodeCatalog[];
} {
	const written: OpencodeCatalog[] = [];
	return {
		written,
		store: {
			read: async () => ({ kind: 'absent' as const }),
			write: async (catalog: OpencodeCatalog) => {
				written.push(catalog);
				return { kind: 'written' as const };
			},
		},
	};
}

interface Built {
	readonly service: OpencodeCatalogService;
	readonly urls: string[];
	readonly written: OpencodeCatalog[];
	readonly fake: FakeTransport;
}

function service(
	script: Partial<Script>,
	options: {
		readonly connection?: { baseUrl: string; password: string } | undefined;
		readonly credentials?: 'openrouter' | 'unavailable';
	} = {},
): Built {
	const connection =
		'connection' in options ? options.connection : { baseUrl: 'http://127.0.0.1:4096', password: 'senha-teste' };
	const fake = fakeTransport({ health: script.health ?? HEALTH_OK, catalog: script.catalog ?? { status: 200, body: VALID } });
	const memory = memoryStore();
	const credentials = options.credentials ?? 'unavailable';
	const catalogService = new OpencodeCatalogService({
		manager: fakeManager(connection),
		transport: fake.transport,
		store: memory.store,
		readCredentials: async () =>
			credentials === 'unavailable'
				? undefined
				: { connected: new Set(['openrouter']), names: new Map([['openrouter', 'OpenRouter']]) },
		now: () => new Date('2026-10-23T12:00:00.000Z'),
	});
	return { service: catalogService, urls: fake.urls, written: memory.written, fake };
}

suite('OpenCode: a descoberta do catálogo', () => {
	test('sem conexão, nada é perguntado e o estado é "não conectado"', async () => {
		const built = service({}, { connection: undefined });

		const result = await built.service.refresh();

		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'failed');
		if (result.state.state === 'failed') {
			assert.strictEqual(result.state.code, 'not-connected');
		}
		assert.deepStrictEqual(built.urls, [], 'sem conexão, nenhuma requisição');
	});

	test('um catálogo válido é lido depois do health e gravado', async () => {
		const built = service({});

		const result = await built.service.refresh();

		assert.strictEqual(result.done, true);
		assert.strictEqual(result.state.state, 'ok');
		if (result.state.state === 'ok') {
			assert.strictEqual(result.state.catalog.models.length, 2);
			assert.strictEqual(result.state.catalog.providers.length, 2);
			assert.strictEqual(result.state.catalog.discoveredAt, '2026-10-23T12:00:00.000Z');
			assert.strictEqual(result.state.connectionsUnknown, true, 'o CLI não respondeu: não se afirma conexão');
		}
		// A ordem: health **antes** do catálogo.
		assert.deepStrictEqual(built.urls, [
			'http://127.0.0.1:4096/global/health',
			'http://127.0.0.1:4096/api/model',
		]);
		assert.strictEqual(built.written.length, 1);
		const saved = built.written[0];
		assert.deepStrictEqual(Object.keys(saved.models[0]).sort(), ['modelId', 'name', 'providerId', 'status']);
	});

	test('provedores conectados e desconectados vêm da consulta de credencial', async () => {
		const built = service({}, { credentials: 'openrouter' });

		const result = await built.service.refresh();

		assert.strictEqual(result.done, true);
		if (result.state.state !== 'ok') {
			return;
		}
		assert.strictEqual(result.state.connectionsUnknown, false);
		const byId = new Map(result.state.catalog.providers.map((provider) => [provider.id, provider]));
		assert.strictEqual(byId.get('openrouter')?.connected, true);
		assert.strictEqual(byId.get('openrouter')?.name, 'OpenRouter');
		assert.strictEqual(byId.get('opencode')?.connected, false);
	});

	test('nenhuma rota insegura é consultada — nem em erro', async () => {
		const allowed = new Set(['http://127.0.0.1:4096/global/health', 'http://127.0.0.1:4096/api/model']);
		const scenarios: ReadonlyArray<Partial<Script>> = [
			{},
			{ catalog: { status: 401, body: '' } },
			{ catalog: { status: 403, body: '' } },
			{ catalog: { status: 500, body: '' } },
			{ catalog: 'timeout' },
			{ catalog: 'network' },
			{ health: { status: 401, body: '' } },
			{ health: 'timeout' },
			{ catalog: { status: 200, body: '{"data":[{"id":"x","providerID":"a","apiKey":"v"}]}' } },
			{ catalog: { status: 200, body: '{"providers":[]}' } },
		];
		for (const script of scenarios) {
			const built = service(script);
			await built.service.refresh();
			for (const url of built.urls) {
				assert.ok(allowed.has(url), `rota inesperada pedida: ${url}`);
			}
			for (const forbidden of ['/provider', '/config/providers', '/api/provider']) {
				assert.ok(!built.urls.some((url) => url.endsWith(forbidden)), `a rota ${forbidden} não pode ser pedida`);
			}
		}
	});

	test('401 no health encerra antes de ler o catálogo', async () => {
		const built = service({ health: { status: 401, body: '' } });

		const result = await built.service.refresh();

		assert.strictEqual(result.state.state, 'failed');
		if (result.state.state === 'failed') {
			assert.strictEqual(result.state.code, 'auth-invalid');
		}
		assert.deepStrictEqual(built.urls, ['http://127.0.0.1:4096/global/health']);
	});

	test('403 no catálogo é "autenticação inválida"', async () => {
		const built = service({ catalog: { status: 403, body: '' } });
		const result = await built.service.refresh();
		assert.strictEqual(result.state.state, 'failed');
		if (result.state.state === 'failed') {
			assert.strictEqual(result.state.code, 'auth-invalid');
		}
	});

	test('timeout no health e no catálogo têm o seu código', async () => {
		const healthTimeout = await service({ health: 'timeout' }).service.refresh();
		assert.strictEqual(healthTimeout.state.state, 'failed');
		if (healthTimeout.state.state === 'failed') {
			assert.strictEqual(healthTimeout.state.code, 'timeout');
		}
		const catalogTimeout = await service({ catalog: 'timeout' }).service.refresh();
		assert.strictEqual(catalogTimeout.state.state, 'failed');
		if (catalogTimeout.state.state === 'failed') {
			assert.strictEqual(catalogTimeout.state.code, 'timeout');
		}
	});

	test('falha de rede é "servidor indisponível"', async () => {
		const built = service({ catalog: 'network' });
		const result = await built.service.refresh();
		assert.strictEqual(result.state.state, 'failed');
		if (result.state.state === 'failed') {
			assert.strictEqual(result.state.code, 'unavailable');
		}
	});

	test('formato inesperado e campo sensível são recusados com o motivo', async () => {
		const unexpected = await service({ catalog: { status: 200, body: '{"providers":[]}' } }).service.refresh();
		assert.strictEqual(unexpected.state.state, 'failed');
		if (unexpected.state.state === 'failed') {
			assert.strictEqual(unexpected.state.code, 'unexpected-format');
			assert.ok(!unexpected.state.reason.includes('{"providers"'), 'o corpo cru não vai para a tela');
		}
		const sensitive = await service({
			catalog: {
				status: 200,
				body: '{"data":[{"id":"x","providerID":"a","request":{"headers":{"x-api-key":"valor"}}}]}',
			},
		}).service.refresh();
		assert.strictEqual(sensitive.state.state, 'failed');
		if (sensitive.state.state === 'failed') {
			assert.strictEqual(sensitive.state.code, 'sensitive-field');
			assert.ok(!sensitive.state.reason.includes('valor'));
		}
	});

	test('uma atualização que falha mantém o último catálogo, marcado como desatualizado', async () => {
		const built = service({});
		const first = await built.service.refresh();
		assert.strictEqual(first.state.state, 'ok');

		// A segunda falha: o catálogo anterior continua, desatualizado.
		built.fake.script = { health: HEALTH_OK, catalog: { status: 500, body: '' } };
		const second = await built.service.refresh();

		assert.strictEqual(second.done, false);
		assert.strictEqual(second.state.state, 'stale');
		if (second.state.state === 'stale') {
			assert.strictEqual(second.state.catalog.models.length, 2, 'o catálogo anterior continua aqui');
			assert.strictEqual(second.state.catalog.discoveredAt, '2026-10-23T12:00:00.000Z');
			assert.strictEqual(second.state.stale, true);
			assert.ok(second.state.reason.length > 0);
		}
		// E só a primeira gravação aconteceu.
		assert.strictEqual(built.written.length, 1);
	});

	test('perder a conexão depois de um catálogo válido deixa-o desatualizado, não o apaga', async () => {
		// O gerenciador é um objeto cuja conexão pode sumir: é o que acontece
		// quando o processo morre por fora, entre duas atualizações.
		let connection: { baseUrl: string; password: string } | undefined = {
			baseUrl: 'http://127.0.0.1:4096',
			password: 'p',
		};
		const fake = fakeTransport({ health: HEALTH_OK, catalog: { status: 200, body: VALID } });
		const memory = memoryStore();
		const catalog = new OpencodeCatalogService({
			manager: { connection: () => (connection === undefined ? undefined : { ...connection, mode: 'managed' }) } as unknown as OpencodeManager,
			transport: fake.transport,
			store: memory.store,
			now: () => new Date('2026-10-23T12:00:00.000Z'),
		});

		const first = await catalog.refresh();
		assert.strictEqual(first.state.state, 'ok');
		const firstAt = first.state.state === 'ok' ? first.state.catalog.discoveredAt : '';

		connection = undefined;
		const second = await catalog.refresh();

		assert.strictEqual(second.done, false);
		assert.strictEqual(second.state.state, 'stale');
		if (second.state.state === 'stale') {
			assert.strictEqual(second.state.catalog.discoveredAt, firstAt, 'o catálogo anterior continua');
			assert.strictEqual(second.state.catalog.models.length, 2);
			assert.strictEqual(second.state.code, 'not-connected');
			assert.strictEqual(second.state.stale, true);
		}
	});

	test('o catálogo do OpenCode não se confunde com o do Core', async () => {
		const built = service({}, { credentials: 'openrouter' });
		await built.service.refresh();
		const state = await built.service.state();
		assert.strictEqual(state.state, 'ok');
		if (state.state !== 'ok') {
			return;
		}
		const text = JSON.stringify(state.catalog);
		for (const coreField of ['"baseUrl"', '"hasApiKeyRef"', '"role"', '"disabled"']) {
			assert.ok(!text.includes(coreField), `o catálogo do OpenCode não pode ter ${coreField}`);
		}
	});

	test('duas atualizações simultâneas compartilham uma tentativa', async () => {
		const built = service({});
		const [a, b] = await Promise.all([built.service.refresh(), built.service.refresh()]);
		assert.strictEqual(a.state.state, 'ok');
		assert.strictEqual(b.state.state, 'ok');
		assert.strictEqual(built.urls.filter((url) => url.endsWith('/api/model')).length, 1);
	});

	test('a senha da conexão vai no cabeçalho, e ele não aparece em lugar nenhum', async () => {
		const authorizations: string[] = [];
		const fake = fakeTransport({ health: HEALTH_OK, catalog: { status: 200, body: VALID } });
		const inner = fake.transport.get;
		const serviceInstance = new OpencodeCatalogService({
			manager: fakeManager({ baseUrl: 'http://127.0.0.1:4096', password: 'senha-secreta-123' }),
			transport: {
				get: async (input) => {
					authorizations.push(input.authorization);
					return await inner(input);
				},
			},
		});
		void serviceInstance;
		const result = await serviceInstance.refresh();
		assert.strictEqual(result.state.state, 'ok');
		for (const value of authorizations) {
			assert.ok(value.startsWith('Basic '));
			assert.strictEqual(Buffer.from(value.slice(6), 'base64').toString('utf8'), 'opencode:senha-secreta-123');
			assert.ok(!JSON.stringify(result).includes(value), 'o cabeçalho nunca volta na resposta');
			assert.ok(!JSON.stringify(result).includes('senha-secreta-123'));
		}
	});
});
