/**
 * DEV-8.11: a configuração do roteador compartilhada entre desktop e serviço.
 *
 * ## O que se prova
 *
 * 1. A **fonte autoritativa** é o Core do serviço: `ServiceClient.routing()`
 *    lê `GET /api/routing` com o token de **leitura** do registro (o mesmo
 *    mecanismo de autenticação local já existente);
 * 2. A decisão lida é a que o seletor do desktop usa — e a mesma que executa
 *    o turno, porque o serviço executa com o próprio Core (DEV-8.10);
 * 3. `targets` (nomes/URLs de destino) não atravessa; nenhuma chave existe no
 *    corpo lido nem é produzida;
 * 4. Serviço ausente ou leitura falha → `source: 'unavailable'` com motivo,
 *    nunca um estado que pareça configurado;
 * 5. Configuração antiga (sem `source`) continua válida para os modos.
 *
 * ## O que é simulado
 *
 * A descoberta (`probe`) e o transporte HTTP (`fetch`): nenhum socket é
 * aberto e nenhuma chave real existe. O `ServiceClient` e o parser são os de
 * produção.
 */
import * as assert from 'assert';

import { ServiceClient } from '../desktop/serviceClient';
import type { ServiceProbe } from '../app/discoverService';
import { effectiveTurnMode, turnRoutingPayload } from '../desktop/turnMode';
import { parseRouterConfigView } from '../desktop/routerConfigParsers';
import type { RouterConfigView } from '../desktop/contract';

const ROOT = 'C:\\raiz-descartavel';
const READER = 'leitor-de-teste-nao-e-segredo-real';
const PANEL = 'painel-de-teste-nao-e-segredo-real';
const CHAT = 'conversa-de-teste-nao-e-segredo-real';
const API_KEY = 'chave-de-api-que-nao-pode-aparecer';

function activeProbe(): ServiceProbe {
	return {
		kind: 'active',
		record: {
			version: 1,
			protocol: 3,
			pid: 4242,
			port: 7817,
			startedAt: '2026-10-29T10:00:00.000Z',
			appVersion: '0.0.1',
			token: PANEL,
			readerToken: READER,
			chatToken: CHAT,
			address: '127.0.0.1',
		},
		health: { ok: true, pid: 4242, protocol: 3 },
	} as unknown as ServiceProbe;
}

/** O corpo real de `GET /api/routing`, sem nenhum segredo. */
function routingBody(overrides: Record<string, unknown> = {}): unknown {
	return {
		config: {
			mode: 'external',
			enabled: true,
			externalRouterProviderId: 'roteador-9',
			updatedAt: '2026-10-29T12:00:00.000Z',
			configured: true,
			...overrides,
		},
		targets: [
			{
				id: 'roteador-9',
				name: 'Roteador 9',
				baseUrl: 'http://127.0.0.1:20128/v1',
				role: 'router',
				usable: true,
			},
		],
		status: 'normal',
	};
}

/** Um `fetch` que registra a requisição e responde um corpo fixo. */
function recordingFetch(
	answer: { status: number; body: unknown },
	calls: { url: string; headers: Record<string, string> }[],
): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ url, headers });
		return {
			ok: answer.status >= 200 && answer.status < 300,
			status: answer.status,
			json: async () => answer.body,
			text: async () => JSON.stringify(answer.body),
		} as unknown as Response;
	}) as typeof fetch;
}

function client(
	answer: { status: number; body: unknown },
	calls: { url: string; headers: Record<string, string> }[],
	probe: ServiceProbe = activeProbe(),
): ServiceClient {
	return new ServiceClient({
		root: ROOT,
		fetch: recordingFetch(answer, calls),
		probe: async () => probe,
	});
}

suite('DEV-8.11: configuração do roteador compartilhada', () => {
	test('lê a decisão do serviço com o token de leitura, e só a decisão', async () => {
		const calls: { url: string; headers: Record<string, string> }[] = [];
		const queried = await client({ status: 200, body: routingBody() }, calls).routing();

		assert.strictEqual(queried.ok, true);
		if (!queried.ok) {
			return;
		}
		assert.deepStrictEqual(
			{
				mode: queried.value.mode,
				enabled: queried.value.enabled,
				externalRouterProviderId: queried.value.externalRouterProviderId,
				configured: queried.value.configured,
			},
			{
				mode: 'external',
				enabled: true,
				externalRouterProviderId: 'roteador-9',
				configured: true,
			},
		);
		assert.strictEqual(calls.length, 1);
		assert.ok(calls[0]?.url.endsWith('/api/routing'), `URL: ${String(calls[0]?.url)}`);
		assert.strictEqual(
			calls[0]?.headers['x-seshyina-reader'],
			READER,
			'a leitura usa a credencial de leitura do registro',
		);
		// `targets` é descartado: o seletor do chat não precisa do catálogo de
		// destinos, e nada além da decisão atravessa.
		assert.deepStrictEqual(
			Object.keys(queried.value).sort(),
			['configured', 'enabled', 'externalRouterProviderId', 'mode', 'updatedAt'],
		);
	});

	test('a decisão compartilhada governa o modo efetivo do desktop', async () => {
		const calls: { url: string; headers: Record<string, string> }[] = [];
		const queried = await client({ status: 200, body: routingBody() }, calls).routing();
		assert.strictEqual(queried.ok, true);
		if (!queried.ok) {
			return;
		}
		const view: RouterConfigView = {
			mode: queried.value.mode,
			enabled: queried.value.enabled,
			updatedAt: queried.value.updatedAt,
			configured: queried.value.configured,
			source: 'service',
			...(queried.value.externalRouterProviderId !== undefined
				? { externalRouterProviderId: queried.value.externalRouterProviderId }
				: {}),
		};
		// O serviço está em `external`: o "automático" do chat não pode se
		// apresentar como uma seleção local.
		assert.strictEqual(effectiveTurnMode('auto', view), 'external');
		// Trocar a decisão no serviço muda o que o desktop exibe, sem reiniciar.
		const again = await client(
			{ status: 200, body: routingBody({ mode: 'native', externalRouterProviderId: undefined }) },
			[],
		).routing();
		assert.strictEqual(again.ok, true);
		if (again.ok) {
			assert.strictEqual(
				effectiveTurnMode('auto', {
					mode: again.value.mode,
					enabled: again.value.enabled,
					updatedAt: again.value.updatedAt,
					configured: again.value.configured,
					source: 'service',
				}),
				'auto',
			);
		}
	});

	test('serviço ausente: indisponível com motivo, nunca configurado', async () => {
		const queried = await client({ status: 200, body: routingBody() }, [], { kind: 'absent' }).routing();
		assert.strictEqual(queried.ok, false);
		if (queried.ok) {
			return;
		}
		assert.strictEqual(queried.code, 'inactive');
		assert.ok(queried.message.length > 0);
	});

	test('leitura recusada pelo serviço: indisponível, com a mensagem do cliente', async () => {
		const queried = await client({ status: 401, body: { error: 'credencial' } }, []).routing();
		assert.strictEqual(queried.ok, false);
		if (queried.ok) {
			return;
		}
		assert.ok(queried.message.length > 0);
		// A mensagem de falha não carrega token nem caminho da raiz.
		assert.strictEqual(queried.message.includes(READER), false);
		assert.strictEqual(queried.message.includes(PANEL), false);
		assert.strictEqual(queried.message.includes(ROOT), false);
	});

	test('corpo sem a decisão é recusado em vez de virar "nativo" inventado', async () => {
		const queried = await client({ status: 200, body: { config: { mode: 'inventado' } } }, []).routing();
		assert.strictEqual(queried.ok, false);
	});

	test('nenhuma credencial do registro aparece na resposta lida', async () => {
		const calls: { url: string; headers: Record<string, string> }[] = [];
		const queried = await client(
			{
				status: 200,
				body: routingBody({ apiKey: API_KEY, token: PANEL }),
			},
			calls,
		).routing();
		assert.strictEqual(queried.ok, true);
		const serialized = JSON.stringify(queried);
		assert.strictEqual(serialized.includes(API_KEY), false, 'a chave não atravessa');
		assert.strictEqual(serialized.includes(PANEL), false, 'o token de painel não atravessa');
		assert.strictEqual(serialized.includes(READER), false, 'o token de leitura não volta');
		assert.strictEqual(serialized.includes('targets'), false, 'destinos ficam no serviço');
	});

	test('configuração antiga (sem source) continua valendo', () => {
		const legacy: RouterConfigView = {
			mode: 'native',
			enabled: true,
			updatedAt: new Date(0).toISOString(),
			configured: true,
		};
		assert.strictEqual(effectiveTurnMode('auto', legacy), 'auto');
		assert.strictEqual(effectiveTurnMode('direct', legacy), 'direct');
	});

	test('fonte indisponível não decide o modo do chat', () => {
		const unavailable: RouterConfigView = {
			mode: 'native',
			enabled: true,
			updatedAt: new Date(0).toISOString(),
			configured: false,
			source: 'unavailable',
			reason: 'sem serviço',
		};
		// Sem uma configuração real, o modo escolhido é preservado — não se
		// "corrige" o automático com base num padrão que ninguém leu.
		assert.strictEqual(effectiveTurnMode('auto', unavailable), 'auto');
		assert.strictEqual(effectiveTurnMode('external', unavailable), 'external');
	});

	test('DEV-8.14: o parser da ponte preserva source, reason e unreadable', () => {
		// O defeito medido no executável: sem `source` a janela perdia a
		// procedência e bloqueava a edição; sem `unreadable` o painel mostrava
		// "padrão (Nativo)" e "Roteador ligado" para um arquivo ilegível.
		const parsed = parseRouterConfigView({
			mode: 'external',
			enabled: true,
			updatedAt: '2026-10-29T00:00:00.000Z',
			configured: false,
			source: 'unavailable',
			reason: 'o serviço local não respondeu',
			unreadable: 'o arquivo do roteador existe, mas não pôde ser lido',
		});
		assert.deepStrictEqual(
			{ source: parsed?.source, reason: parsed?.reason, unreadable: parsed?.unreadable },
			{
				source: 'unavailable',
				reason: 'o serviço local não respondeu',
				unreadable: 'o arquivo do roteador existe, mas não pôde ser lido',
			},
		);

		// Um `source` inventado não atravessa.
		const inventado = parseRouterConfigView({ mode: 'native', enabled: true, source: 'remoto' });
		assert.strictEqual(inventado?.source, undefined);
	});

	test('DEV-8.14: modo efetivo externo exige modelo do destino', () => {
		const externo: RouterConfigView = {
			mode: 'external',
			enabled: true,
			updatedAt: new Date(0).toISOString(),
			configured: true,
			source: 'service',
			externalRouterProviderId: 'roteador',
		};
		// O chat em `auto` executa o externo configurado — e o externo precisa
		// de um modelo pedido (o do destino).
		assert.strictEqual(effectiveTurnMode('auto', externo), 'external');
		assert.deepStrictEqual(turnRoutingPayload('auto', { providerId: 'p', model: 'alfa' }), {
			routing: 'auto',
		});
		assert.deepStrictEqual(turnRoutingPayload('external', { providerId: 'p', model: 'alfa' }), {
			routing: 'external',
			model: 'alfa',
		});
	});

	test('DEV-8.14: a gravação recusa quando o serviço está ausente', async () => {		const queried = await client(
			{ status: 200, body: routingBody() },
			[],
			{ kind: 'absent' },
		).saveRouting({ mode: 'native' });
		assert.strictEqual(queried.ok, false);
		if (queried.ok) {
			return;
		}
		assert.strictEqual(queried.code, 'inactive');
		assert.strictEqual(queried.message.includes(READER), false);
	});

	test('DEV-8.12: a gravação usa a credencial de painel, não a de leitura', async () => {
		const calls: { url: string; headers: Record<string, string> }[] = [];
		const saved = await client(
			{ status: 200, body: routingBody({ mode: 'native', externalRouterProviderId: undefined }) },
			calls,
		).saveRouting({ mode: 'native' });
		assert.strictEqual(saved.ok, true);
		assert.strictEqual(calls.length, 1);
		assert.ok(calls[0]?.url.endsWith('/api/routing/save'), String(calls[0]?.url));
		assert.strictEqual(calls[0]?.headers['x-seshyina-token'], PANEL, 'usa o token de painel');
		assert.strictEqual(
			calls[0]?.headers['x-seshyina-reader'],
			undefined,
			'a escrita não apresenta a credencial de leitura',
		);
	});

	test('DEV-8.12: recusa sem corpo (401/403) vira "unauthorized", não "JSON inválido"', async () => {
		const calls: { url: string; headers: Record<string, string> }[] = [];
		const refusing = new ServiceClient({
			root: ROOT,
			probe: async () => activeProbe(),
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
				return {
					ok: false,
					status: 403,
					// A recusa real vem com corpo vazio, `text/plain`.
					json: async () => {
						throw new SyntaxError('corpo vazio');
					},
				} as unknown as Response;
			}) as typeof fetch,
		});
		const saved = await refusing.saveRouting({ mode: 'native' });
		assert.strictEqual(saved.ok, false);
		if (saved.ok) {
			return;
		}
		assert.strictEqual(saved.code, 'unauthorized');
		assert.strictEqual(saved.message.includes(PANEL), false);
	});

	test('DEV-8.12: a mensagem de recusa do serviço é repassada sem chave', async () => {
		const calls: { url: string; headers: Record<string, string> }[] = [];
		const saved = await client(
			{
				status: 400,
				body: { error: 'O modo "external" precisa de um provedor: escolha um endpoint antes de salvar.' },
			},
			calls,
		).saveRouting({ mode: 'external' });
		assert.strictEqual(saved.ok, false);
		if (saved.ok) {
			return;
		}
		assert.match(saved.message, /precisa de um provedor/);
		assert.strictEqual(saved.message.includes(API_KEY), false);
	});
});
