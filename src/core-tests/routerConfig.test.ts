/**
 * A configuração persistente do roteador.
 *
 * ## O que se prova
 *
 * 1. **Padrão** — o padrão reproduz exatamente o comportamento de antes:
 *    o roteador ligado, no modo nativo;
 * 2. **Persistência** — a configuração sobrevive a fechar e reabrir;
 * 3. **Validação** — um estado que o app não pode obedecer não é gravado;
 * 4. **Robustez** — arquivo ausente ou inválido não impede o app de abrir;
 * 5. **Compatibilidade** — um provedor gravado antes do papel existir continua
 *    funcionando, como provedor;
 * 6. **Sigilo** — nem a configuração do roteador nem o registro do provedor
 *    carregam chave de API.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	DEFAULT_ROUTER_CONFIG,
	isProviderRole,
	isRouterConfigUsable,
	isRouterMode,
	providerIdForMode,
	providerRoleOf,
	validateRouterConfig,
	type RouterConfig,
} from '../core/providers/routing/config';
import {
	parseRouterConfig,
	serializeRouterConfig,
} from '../core/storage/routerConfigLedger';
import {
	ACCESS_POLICY_FILE,
	FileDataStore,
	PROVIDER_MODELS_FILE,
	ROUTER_CONFIG_FILE,
} from '../adapters/local/fileDataStore';
import { ProviderConfigService } from '../core/providers/config';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ValidationError } from '../core/errors';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const T0 = '2026-10-20T12:00:00.000Z';

suite('Router config: the defaults', () => {
	test('the default is the behaviour the app already had', () => {
		assert.strictEqual(DEFAULT_ROUTER_CONFIG.enabled, true, 'o roteador nasce ligado');
		assert.strictEqual(DEFAULT_ROUTER_CONFIG.mode, 'native', 'e no modo nativo');
		assert.strictEqual(DEFAULT_ROUTER_CONFIG.externalRouterProviderId, undefined);
		assert.strictEqual(DEFAULT_ROUTER_CONFIG.directProviderId, undefined);
	});

	test('the three modes are the three named ones', () => {
		assert.strictEqual(isRouterMode('native'), true);
		assert.strictEqual(isRouterMode('external'), true);
		assert.strictEqual(isRouterMode('direct'), true);
		assert.strictEqual(isRouterMode('something'), false);
		assert.strictEqual(isRouterMode(undefined), false);
	});

	test('the native mode points at no provider', () => {
		assert.strictEqual(
			providerIdForMode({ ...DEFAULT_ROUTER_CONFIG, mode: 'native' }),
			undefined,
		);
		assert.strictEqual(
			providerIdForMode({ ...DEFAULT_ROUTER_CONFIG, mode: 'external', externalRouterProviderId: 'r' }),
			'r',
		);
		assert.strictEqual(
			providerIdForMode({ ...DEFAULT_ROUTER_CONFIG, mode: 'direct', directProviderId: 'd' }),
			'd',
		);
	});

	test('a configuration that names no provider in its mode is not usable', () => {
		assert.strictEqual(isRouterConfigUsable(DEFAULT_ROUTER_CONFIG), true);
		assert.strictEqual(
			isRouterConfigUsable({ ...DEFAULT_ROUTER_CONFIG, mode: 'external' }),
			false,
		);
		assert.strictEqual(
			isRouterConfigUsable({ ...DEFAULT_ROUTER_CONFIG, mode: 'direct' }),
			false,
		);
	});
});

suite('Router config: validation', () => {
	test('a valid configuration passes through, with the id trimmed', () => {
		const validated = validateRouterConfig({
			enabled: false,
			mode: 'external',
			externalRouterProviderId: '  9router  ',
			updatedAt: T0,
		});
		assert.strictEqual(validated.enabled, false);
		assert.strictEqual(validated.mode, 'external');
		assert.strictEqual(validated.externalRouterProviderId, '9router');
		assert.strictEqual(validated.updatedAt, T0);
	});

	test('the external mode requires a router provider', () => {
		assert.throws(
			() =>
				validateRouterConfig({
					enabled: true,
					mode: 'external',
					updatedAt: T0,
				}),
			ValidationError,
		);
	});

	test('the direct mode requires a provider', () => {
		assert.throws(
			() =>
				validateRouterConfig({
					enabled: true,
					mode: 'direct',
					updatedAt: T0,
				}),
			ValidationError,
		);
	});

	test('an unknown mode is refused', () => {
		assert.throws(
			() =>
				validateRouterConfig({
					enabled: true,
					mode: 'magic' as RouterConfig['mode'],
					updatedAt: T0,
				}),
			ValidationError,
		);
	});

	test('a non-boolean switch is refused', () => {
		assert.throws(
			() =>
				validateRouterConfig({
					enabled: 'yes' as unknown as boolean,
					mode: 'native',
					updatedAt: T0,
				}),
			ValidationError,
		);
	});

	test('the id of the mode that is not in force is dropped', () => {
		const validated = validateRouterConfig({
			enabled: true,
			mode: 'native',
			externalRouterProviderId: 'orfao',
			updatedAt: T0,
		});
		assert.strictEqual(validated.externalRouterProviderId, undefined);
	});
});

suite('Router config: the file format', () => {
	test('a record round-trips', () => {
		const record: RouterConfig = {
			enabled: true,
			mode: 'external',
			externalRouterProviderId: '9router',
			updatedAt: T0,
		};
		assert.deepStrictEqual(parseRouterConfig(serializeRouterConfig(record)), record);
	});

	test('a missing file is "never configured", not the default', () => {
		assert.strictEqual(parseRouterConfig(undefined), undefined);
		assert.strictEqual(parseRouterConfig(''), undefined);
		assert.strictEqual(parseRouterConfig('   '), undefined);
	});

	test('a corrupt file is not a choice', () => {
		assert.strictEqual(parseRouterConfig('{ not json'), undefined);
		assert.strictEqual(parseRouterConfig('[]'), undefined);
		assert.strictEqual(parseRouterConfig('"nada"'), undefined);
	});

	test('an invalid field falls back on its own, not on the others', () => {
		const parsed = parseRouterConfig(
			JSON.stringify({ enabled: 'sim', mode: 'native', updatedAt: T0 }),
		);
		assert.strictEqual(parsed?.enabled, true, 'o interruptor cai no padrão');
		assert.strictEqual(parsed?.mode, 'native', 'o modo válido permanece');
	});

	test('a mode that names no provider is repaired back to native', () => {
		const parsed = parseRouterConfig(
			JSON.stringify({ enabled: true, mode: 'external', updatedAt: T0 }),
		);
		assert.strictEqual(parsed?.mode, 'native', 'o modo impossível não sobrevive');
		assert.strictEqual(parsed?.enabled, true, 'e o interruptor permanece');
	});

	test('the file holds no credential', () => {
		const raw = serializeRouterConfig({
			enabled: true,
			mode: 'direct',
			directProviderId: 'meu-provedor',
			updatedAt: T0,
		});
		assert.strictEqual(/api[_-]?key|authorization|bearer|secret|sk-/i.test(raw), false);
	});
});

suite('Router config: on disk', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-router-config-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function store(): FileDataStore {
		return new FileDataStore({ rootPath: root });
	}

	test('reading a fresh install finds no configuration', async () => {
		assert.strictEqual(await store().readRouterConfig(), undefined);
		let exists = true;
		try {
			await readFile(join(root, ROUTER_CONFIG_FILE));
		} catch {
			exists = false;
		}
		assert.strictEqual(exists, false, 'ler não cria o arquivo');
	});

	test('a configuration survives a reopen', async () => {
		await store().saveRouterConfig({
			enabled: false,
			mode: 'direct',
			directProviderId: 'meu-provedor',
			updatedAt: T0,
		});
		const reopened = await store().readRouterConfig();
		assert.strictEqual(reopened?.enabled, false);
		assert.strictEqual(reopened?.mode, 'direct');
		assert.strictEqual(reopened?.directProviderId, 'meu-provedor');
	});

	test('the configuration lives in its own file', async () => {
		const data = store();
		await data.saveRouterConfig({
			enabled: true,
			mode: 'native',
			updatedAt: T0,
		});
		const raw = await readFile(join(root, ROUTER_CONFIG_FILE), 'utf8');
		assert.ok(raw.includes('"mode"'));
		// E ele não se mistura com a política de acesso nem com os modelos.
		const policyRaw = await readFile(join(root, ACCESS_POLICY_FILE), 'utf8').catch(() => '');
		assert.strictEqual(policyRaw.includes('"mode"'), false);
		const modelsRaw = await readFile(join(root, PROVIDER_MODELS_FILE), 'utf8').catch(() => '');
		assert.strictEqual(modelsRaw.includes('externalRouterProviderId'), false);
	});

	test('a configuration that could never be obeyed is refused', async () => {
		await assert.rejects(
			() =>
				store().saveRouterConfig({
					enabled: true,
					mode: 'external',
					updatedAt: T0,
				}),
			ValidationError,
		);
	});

	test('a corrupt file without a backup is reported, not read as "never configured"', async () => {
		// Antes, um arquivo corrompido era lido como ausência — e a próxima
		// gravação o sobrescrevia como se nunca tivesse havido escolha. Agora
		// o estrago é um erro com motivo: quem lê decide, e a página diz.
		await writeFile(join(root, ROUTER_CONFIG_FILE), '{ quebrado', 'utf8');
		await assert.rejects(
			() => store().readRouterConfig(),
			(error: Error) => error.name === 'StorageError' && error.message.includes('unreadable'),
		);
	});

	test('a corrupt file is recovered from a valid backup', async () => {
		// Grava uma configuração válida (o que cria a cópia), e depois
		// corrompe o destino: a leitura volta pela cópia.
		await store().saveRouterConfig({
			enabled: true,
			mode: 'direct',
			directProviderId: 'provedor',
			updatedAt: '2026-01-01T00:00:00.000Z',
		});
		await writeFile(join(root, ROUTER_CONFIG_FILE), '{ quebrado', 'utf8');

		const recovered = await store().readRouterConfig();
		assert.strictEqual(recovered?.mode, 'direct');
		assert.strictEqual(recovered?.directProviderId, 'provedor');
	});

	test('an invalid backup is never used in place of a valid configuration', async () => {
		await store().saveRouterConfig({
			enabled: true,
			mode: 'native',
			updatedAt: '2026-01-01T00:00:00.000Z',
		});
		// A cópia também quebrada: não há o que recuperar, e o destino válido
		// continua sendo o que vale.
		await writeFile(`${join(root, ROUTER_CONFIG_FILE)}.backup`, 'nao e json', 'utf8');

		const read = await store().readRouterConfig();
		assert.strictEqual(read?.mode, 'native', 'o destino válido manda');
	});
});

suite('Provider role: the persisted provider', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-provider-role-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function service(): ProviderConfigService {
		return new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') }));
	}

	test('a provider with no role is a provider', () => {
		assert.strictEqual(providerRoleOf(undefined), 'provider');
		assert.strictEqual(providerRoleOf('provider'), 'provider');
		assert.strictEqual(providerRoleOf('router'), 'router');
	});

	test('a role outside the vocabulary is not a role', () => {
		assert.strictEqual(isProviderRole('router'), true);
		assert.strictEqual(isProviderRole('provider'), true);
		assert.strictEqual(isProviderRole('gateway'), false);
	});

	test('a record written before the role existed still works', async () => {
		// O formato antigo: sem `role`. É o que o app gravava antes desta etapa.
		await writeFile(
			join(root, 'state.json'),
			JSON.stringify({
				'modelhub.providers.config': [
					{ id: 'antigo', name: 'Antigo', baseUrl: 'http://localhost:1234/v1', enabled: true },
				],
			}),
			'utf8',
		);
		const providers = service().list();
		assert.strictEqual(providers.length, 1);
		assert.strictEqual(providers[0]?.id, 'antigo');
		assert.strictEqual(providers[0]?.role, undefined, 'o papel ausente é o padrão');
		assert.strictEqual(providerRoleOf(providers[0]?.role), 'provider');
	});

	test('a provider saved as a router keeps the role', async () => {
		const config = service();
		await config.save({
			id: '9router',
			name: '9Router',
			baseUrl: 'http://localhost:20128/v1',
			enabled: true,
			role: 'router',
		});
		const providers = config.list();
		assert.strictEqual(providers[0]?.role, 'router');
		assert.strictEqual(providerRoleOf(providers[0]?.role), 'router');
	});

	test('a hand-edited role outside the vocabulary is dropped, not guessed', async () => {
		await writeFile(
			join(root, 'state.json'),
			JSON.stringify({
				'modelhub.providers.config': [
					{
						id: 'estranho',
						name: 'Estranho',
						baseUrl: 'http://localhost:1234/v1',
						enabled: true,
						role: 'gateway',
					},
				],
			}),
			'utf8',
		);
		const providers = service().list();
		assert.strictEqual(providers.length, 1, 'o provedor continua lá');
		assert.strictEqual(providers[0]?.role, undefined, 'o papel inválido foi descartado');
		assert.strictEqual(providerRoleOf(providers[0]?.role), 'provider');
	});

	test('the persisted provider never carries the key itself', async () => {
		const config = service();
		await config.save({
			id: 'com-chave',
			name: 'Com chave',
			baseUrl: 'http://localhost:1234/v1',
			apiKeyRef: 'provider.com-chave.apiKey',
			enabled: true,
			role: 'router',
		});
		const raw = await readFile(join(root, 'state.json'), 'utf8');
		assert.strictEqual(raw.includes('apiKeyRef'), true, 'a referência é o que se guarda');
		assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(raw), 'e a chave não');
	});
});
