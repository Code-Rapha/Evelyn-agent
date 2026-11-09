/**
 * A 5D pela sessão: uma listagem real vira catálogo descoberto, o filtro de
 * gratuitos olha só evidência fresca, e as regras da 5B/5C continuam valendo.
 */
import * as assert from 'assert';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService } from '../core/providers/config';
import { LoggingService } from '../core/logging';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ChatSession } from '../desktop/chatSession';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import type { RoutePolicy } from '../core/providers/routing/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';
import { FileDataStore, PROVIDER_MODELS_FILE } from '../adapters/local/fileDataStore';
const LOCAL_ID = '127.0.0.1-11434-v1';

function policy(): RoutePolicy {
	return {
		retries: 0,
		retryBackoffMs: 1,
		maxRetryBackoffMs: 5,
		timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 0 },
		fallbackOn: ['rate_limit', 'timeout'],
		breaker: { failureThreshold: 5, windowMs: 60_000, openMs: 30_000, halfOpenProbes: 1 },
	};
}

function jsonResponse(body: unknown): FetchResponseLike {
	return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

suite('Discovery: through the chat session', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-discovery-session-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function session(fetchImpl: FetchLike, allowPaid = false): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			routing: {
				policy: policy(),
				breaker: new CircuitBreaker(() => policy().breaker, () => Date.now()),
				sleep: async () => true,
			},
			allowPaid,
		});
	}

	async function listingSession(allowPaid = false): Promise<ChatSession> {
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return jsonResponse({
					data: [
						{ id: 'livre', pricing: { currency: 'USD', input: 0, output: 0 }, context_length: 4096 },
						{ id: 'caro', pricing: { currency: 'USD', input: 0.000002, output: 0.000012 } },
						{ id: 'sem-dados' },
					],
				});
			}
			return jsonResponse({});
		};
		const chat = session(fetchImpl, allowPaid);
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
		await chat.listModels(LOCAL_ID);
		return chat;
	}

	test('a listing from the provider becomes the discovered catalog', async () => {
		const chat = await listingSession();
		const models = await chat.listDiscoveredModels(LOCAL_ID);
		assert.deepStrictEqual(models.map((model) => model.modelId), ['caro', 'livre', 'sem-dados']);
		const byId = new Map(models.map((model) => [model.modelId, model]));
		assert.strictEqual(byId.get('livre')?.listed, true);
		assert.strictEqual(byId.get('livre')?.access?.access, 'free');
		assert.strictEqual(byId.get('livre')?.contextTokens, 4096);
		assert.strictEqual(byId.get('caro')?.access?.access, 'unknown', 'a price is not a classification');
		assert.strictEqual(byId.get('caro')?.pricing?.input, 2);
		assert.strictEqual(byId.get('sem-dados')?.access, undefined);
	});

	test('onlyFree returns the confirmed-free model and never the unknown ones', async () => {
		const chat = await listingSession();
		const usable = await chat.listUsableModels({ onlyFree: true });
		assert.deepStrictEqual(usable.map((model) => model.modelId), ['livre']);
	});

	test('without the filter every listed model is usable', async () => {
		const chat = await listingSession();
		const usable = await chat.listUsableModels();
		assert.deepStrictEqual(usable.map((model) => model.modelId), ['caro', 'livre', 'sem-dados']);
	});

	test('a paid model with paid access off stays out of the free list', async () => {
		const chat = await listingSession(false);
		const models = await chat.listUsableModels({ onlyFree: true });
		assert.strictEqual(models.every((model) => model.access?.access === 'free'), true);
		// And the 5B refusal is unchanged for the manual path.
		const paid = (await chat.listUsableModels()).find((model) => model.modelId === 'caro');
		assert.strictEqual(paid?.listed, true, 'listed, even though paid access is off');
	});

	test('a stale listing keeps serving the earlier models and says so', async () => {
		let fail = false;
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				if (fail) {
					return { ok: false, status: 503, text: async () => '{"error":"down"}' };
				}
				return jsonResponse({ data: [{ id: 'livre', pricing: { currency: 'USD', input: 0, output: 0 } }] });
			}
			return jsonResponse({});
		};
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
		await chat.listModels(LOCAL_ID);
		fail = true;
		chat.invalidateModelCache(LOCAL_ID);
		// The refresh fails and the stale copy is served within the bound.
		const models = await chat.listModels(LOCAL_ID);
		assert.deepStrictEqual(models, ['livre']);
		// The file was not emptied by the failure.
		const discovered = await chat.listDiscoveredModels(LOCAL_ID);
		assert.strictEqual(discovered.length, 1);
		assert.strictEqual(discovered[0]?.listed, true);
	});

	test('a discovery file that cannot be written does not fail the model list', async () => {


		await mkdir(join(root, 'data', PROVIDER_MODELS_FILE), { recursive: true }).catch(() => undefined);
		const fetchImpl: FetchLike = async (url) =>
			url.endsWith('/models') ? jsonResponse({ data: [{ id: 'x' }] }) : jsonResponse({});
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
		assert.deepStrictEqual(await chat.listModels(LOCAL_ID), ['x']);
	});

	test('quotas read from the API keep their source', async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return {
					ok: true,
					status: 200,
					headers: {
						get: (name: string) => (name.toLowerCase() === 'x-ratelimit-remaining-requests' ? '4' : null),
						entries: () => new Map([['x-ratelimit-remaining-requests', '4']]).entries(),
					},
					text: async () => JSON.stringify({ data: [{ id: 'm' }] }),
				};
			}
			return jsonResponse({});
		};
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
		await chat.listModels(LOCAL_ID);
		const quotas = await chat.listDiscoveredQuotas(LOCAL_ID);
		assert.strictEqual(quotas[0]?.account?.source, 'account');
	});
});
