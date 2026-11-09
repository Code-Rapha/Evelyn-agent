/**
 * R4A: o cliente HTTP do desktop para o serviço local.
 *
 * ## O que estes testes fixam
 *
 * Cada teste é uma falha que a interface precisa saber explicar — e nenhuma
 * delas pode vazar a credencial:
 *
 * - serviço ausente → `inactive`, e o chamador segue com o Core próprio;
 * - serviço que recusa a credencial → `unauthorized` (provavelmente reiniciou);
 * - serviço que não responde → `timeout`, sem esperar para sempre;
 * - conexão que cai → `unreachable`;
 * - corpo fora do contrato → `invalid-response`, em vez de dados inventados;
 * - erro do servidor → `server-error`.
 *
 * A descoberta (`probeService`) é injetada: o que se testa aqui é o
 * **cliente**, e a descoberta tem suíte própria. A integração com o serviço
 * de verdade está em `serviceClient.integration.test.ts`.
 */
import * as assert from 'assert';

import {
	DEFAULT_QUERY_TIMEOUT_MS,
	READER_HEADER,
	ServiceClient,
	type ServiceClientOptions,
} from '../desktop/serviceClient';
import type { ServiceProbe } from '../app/discoverService';
import type { ServiceRecord } from '../app/serviceRecord';

const RECORD: ServiceRecord = {
	version: 1,
	protocol: 2,
	pid: 4321,
	port: 7817,
	startedAt: '2026-01-01T00:00:00.000Z',
	appVersion: '0.0.1',
	token: 'a'.repeat(64),
	readerToken: 'r'.repeat(64),
	chatToken: 'c'.repeat(64),
	address: '127.0.0.1',
};

const ACTIVE: ServiceProbe = {
	kind: 'active',
	record: RECORD,
	health: {
		status: 'ok',
		app: 'Evelyn',
		version: '0.0.1',
		listening: '127.0.0.1:7817',
		coreMounted: true,
		storageHost: 'web',
		pid: 4321,
	},
};

const OVERVIEW = {
	providers: { total: 2, enabled: 1, routers: 0 },
	models: { total: 3 },
	router: { mode: 'native', enabled: true, configured: true },
};

const POLICY = {
	policy: 'any',
	priceSource: 'user',
	limitsSource: 'user',
	capabilitiesSource: 'user',
	updatedAt: '2026-01-01T00:00:00.000Z',
	changedBy: 'user',
	hint: 'Evelyn, use somente os modelos gratuitos',
};

const MODELS = {
	policy: POLICY,
	models: [
		{ providerId: 'local', modelId: 'modelo-a', listed: true },
		{ providerId: 'local', modelId: 'modelo-b' },
	],
};

interface Call {
	readonly url: string;
	readonly method: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
}

/** Um `fetch` que responde pelo caminho, e registra as chamadas. */
function fetchBy(
	map: Record<string, () => Response | Promise<Response>>,
	calls: Call[] = [],
): typeof fetch {
	return (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({
			url,
			method: init?.method,
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		const path = new URL(url).pathname;
		const handler = map[path];
		if (handler === undefined) {
			return new Response('não encontrado', { status: 404 });
		}
		return await handler();
	}) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function client(options: {
	readonly probe?: ServiceProbe;
	readonly fetch: typeof fetch;
	readonly timeoutMs?: number;
	readonly probeThrows?: boolean;
}): ServiceClient {
	const config: ServiceClientOptions = {
		root: 'C:\\dados',
		fetch: options.fetch,
		...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		probe: async () => {
			if (options.probeThrows === true) {
				throw new Error('a leitura do registro falhou');
			}
			return options.probe ?? ACTIVE;
		},
	};
	return new ServiceClient(config);
}

suite('R4A: cliente do serviço — estado', () => {
	test('serviço ausente é "inactive", não um erro', async () => {
		const service = client({ probe: { kind: 'absent' }, fetch: fetchBy({}) });

		const status = await service.status();

		assert.equal(status.state, 'inactive');
		assert.equal(status.reason, 'inactive');
		assert.match(status.detail, /não está ativo/);
		// Nada de credencial nem de caminho na mensagem para a interface.
		assert.equal(status.detail.includes(RECORD.readerToken), false);
		assert.equal(status.detail.includes(RECORD.token), false);
	});

	test('serviço com protocolo incompatível é dito assim', async () => {
		const service = client({ probe: { kind: 'incompatible', protocol: 99 }, fetch: fetchBy({}) });

		const status = await service.status();

		assert.equal(status.state, 'inactive');
		assert.match(status.detail, /protocolo diferente \(99\)/);
	});

	test('serviço ativo: conecta e devolve estado', async () => {
		const calls: Call[] = [];
		const service = client({
			fetch: fetchBy({ '/api/overview': () => json(OVERVIEW) }, calls),
		});

		const status = await service.status();

		assert.equal(status.state, 'active');
		assert.equal(status.port, 7817);
		assert.equal(status.pid, 4321);
		assert.equal(status.version, '0.0.1');
		// Uma chamada de leitura, no caminho existente.
		assert.deepEqual(
			calls.map((call) => call.url),
			['http://127.0.0.1:7817/api/overview'],
		);
		assert.equal(calls[0]?.method, 'GET');
	});

	test('a credencial de leitura vai no header próprio, e a do painel não', async () => {
		const calls: Call[] = [];
		const service = client({
			fetch: fetchBy({ '/api/overview': () => json(OVERVIEW) }, calls),
		});

		await service.status();

		const headers = calls[0]?.headers ?? {};
		assert.equal(headers[READER_HEADER], RECORD.readerToken);
		// O token do painel — que escreve e encerra — nunca é enviado.
		assert.equal(Object.values(headers).includes(RECORD.token), false);
		assert.equal('authorization' in headers, false);
		// E nunca na URL.
		assert.equal(calls[0]?.url.includes(RECORD.readerToken), false);
		assert.equal(calls[0]?.url.includes('token'), false);
	});
});

suite('R4A: cliente do serviço — catálogo', () => {
	test('o catálogo vem do endpoint existente, com a política', async () => {
		const calls: Call[] = [];
		const service = client({
			fetch: fetchBy({ '/api/models': () => json(MODELS) }, calls),
		});

		const result = await service.catalog();

		assert.equal(result.ok, true);
		if (!result.ok) {
			return;
		}
		assert.deepEqual(
			result.value.models.map((model) => `${model.providerId}/${model.modelId}`),
			['local/modelo-a', 'local/modelo-b'],
		);
		assert.equal(result.value.policy.policy, 'any');
		assert.equal(calls[0]?.url, 'http://127.0.0.1:7817/api/models');
	});

	test('sem serviço, o catálogo diz "inactive" em vez de uma lista vazia', async () => {
		const service = client({ probe: { kind: 'absent' }, fetch: fetchBy({}) });

		const result = await service.catalog();

		assert.equal(result.ok, false);
		if (result.ok) {
			return;
		}
		assert.equal(result.code, 'inactive');
	});

	test('um modelo sem identidade invalida o corpo inteiro', async () => {
		// Entregar à interface metade de uma lista faria metade dos modelos
		// "não funcionar" sem explicação.
		const service = client({
			fetch: fetchBy({
				'/api/models': () => json({ policy: POLICY, models: [{ providerId: 'local' }] }),
			}),
		});

		const result = await service.catalog();

		assert.equal(result.ok, false);
		if (result.ok) {
			return;
		}
		assert.equal(result.code, 'invalid-response');
	});

	test('um corpo que não é o contrato é recusado', async () => {
		const service = client({
			fetch: fetchBy({ '/api/models': () => json({ models: 'nada' }) }),
		});

		const result = await service.catalog();

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, 'invalid-response');
		}
	});

	test('o resultado bem-sucedido não carrega nenhuma credencial', async () => {
		// O resultado vai para logs, para a interface e para o IPC. Devolver o
		// registro do serviço junto "por conveniência" serializaria as duas
		// credenciais em todo lugar — foi um vazamento real encontrado nesta
		// fase, e este teste existe para ele não voltar.
		const service = client({
			fetch: fetchBy({
				'/api/models': () => json(MODELS),
				'/api/overview': () => json(OVERVIEW),
			}),
		});

		const catalog = await service.catalog();
		const connected = await service.connect();

		assert.equal(catalog.ok, true);
		const serializedCatalog = JSON.stringify(catalog);
		assert.equal(serializedCatalog.includes(RECORD.readerToken), false, 'credencial de leitura no catálogo');
		assert.equal(serializedCatalog.includes(RECORD.token), false, 'token do painel no catálogo');

		assert.equal(connected.ok, true);
		if (connected.ok) {
			const serializedConnection = JSON.stringify(connected);
			assert.equal(serializedConnection.includes(RECORD.readerToken), false);
			assert.equal(serializedConnection.includes(RECORD.token), false);
		}
	});
});

suite('R4A: cliente do serviço — falhas', () => {
	test('uma credencial recusada é dita como tal, sem expor a credencial', async () => {
		const service = client({
			fetch: fetchBy({ '/api/overview': () => new Response('', { status: 401 }) }),
		});

		const result = await service.connect();

		assert.equal(result.ok, false);
		if (result.ok) {
			return;
		}
		assert.equal(result.code, 'unauthorized');
		assert.match(result.message, /credencial de leitura/);
		assert.equal(result.message.includes(RECORD.readerToken), false);
	});

	test('um `403` também é credencial recusada', async () => {
		const service = client({
			fetch: fetchBy({ '/api/overview': () => new Response('', { status: 403 }) }),
		});

		const result = await service.status();

		assert.equal(result.reason, 'unauthorized');
	});

	test('um erro do servidor vira "server-error" com o status', async () => {
		const service = client({
			fetch: fetchBy({ '/api/overview': () => new Response('', { status: 503 }) }),
		});

		const result = await service.connect();

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, 'server-error');
			assert.match(result.message, /503/);
		}
	});

	test('um 404 é "invalid-response", não "serviço inexistente"', async () => {
		const service = client({ fetch: fetchBy({}) });

		const result = await service.connect();

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, 'invalid-response');
		}
	});

	test('uma resposta que não é JSON é recusada', async () => {
		const service = client({
			fetch: fetchBy({ '/api/overview': () => new Response('<html>oi</html>', { status: 200 }) }),
		});

		const result = await service.connect();

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, 'invalid-response');
			assert.match(result.message, /não é JSON/);
		}
	});

	test('uma conexão que cai é "unreachable"', async () => {
		const service = client({
			fetch: (async () => {
				throw Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' });
			}) as typeof fetch,
		});

		const result = await service.connect();

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, 'unreachable');
			assert.match(result.message, /não foi possível conectar/);
		}
	});

	test('um serviço que não responde é "timeout", e o prazo é respeitado', async () => {
		const service = client({
			timeoutMs: 20,
			fetch: ((_input: string | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
					});
				})) as typeof fetch,
		});

		const started = Date.now();
		const result = await service.connect();
		const elapsed = Date.now() - started;

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, 'timeout');
			assert.match(result.message, /não respondeu a tempo/);
		}
		assert.ok(elapsed < 2_000, `o prazo deve ser curto (${elapsed}ms)`);
		assert.equal(DEFAULT_QUERY_TIMEOUT_MS, 5_000);
	});

	test('as mensagens de erro não carregam o caminho da raiz', async () => {
		const service = client({
			fetch: fetchBy({ '/api/overview': () => new Response('', { status: 500 }) }),
		});

		const result = await service.connect();

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.message.includes('C:\\dados'), false);
		}
	});
});
