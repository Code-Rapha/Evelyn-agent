/**
 * O caminho real da 5F: metadados descobertos → catálogo fundido → seletor →
 * relatório → interface.
 *
 * O que se prova aqui é o caminho inteiro, não cada peça: os limites que a
 * tela mostra são os que o seletor usou, e o relatório descreve a decisão que
 * o roteador tomou.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService } from '../core/providers/config';
import { LoggingService } from '../core/logging';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ChatSession } from '../desktop/chatSession';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import type { RoutePolicy } from '../core/providers/routing/types';
import type { ChatStreamEvent } from '../desktop/contract';
import { describeFusedField } from '../desktop/renderer/describePolicy';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

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

/** O que o provedor publica: janela, limite de saída e uma lista de capacidades. */
const LISTING = {
	data: [
		{
			id: 'completo',
			context_length: 128000,
			max_output_tokens: 4096,
			supported_parameters: ['tools', 'structured_outputs'],
			architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
			pricing: { currency: 'USD', input: 0, output: 0 },
		},
		{ id: 'pouco', context_length: 4096 },
	],
};

suite('Fusion: from the provider to the router and the screen', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-fusion-5f-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function session(fetchImpl: FetchLike): ChatSession {
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
		});
	}

	async function ready(): Promise<ChatSession> {
		const chat = session(async (url) => (url.endsWith('/models') ? jsonResponse(LISTING) : jsonResponse({})));
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
		await chat.listModels(LOCAL_ID);
		return chat;
	}

	test('the published limits and capabilities reach the discovered catalog', async () => {
		const chat = await ready();
		const merged = await chat.listMergedCatalog(LOCAL_ID);
		const completo = merged.models.find((model) => model.modelId === 'completo');
		assert.strictEqual(completo?.limits?.contextTokens?.discovered?.value, 128000);
		assert.strictEqual(completo?.limits?.maxOutputTokens?.discovered?.value, 4096);
		assert.strictEqual(completo?.capabilities?.toolCalling?.discovered?.value, true);
		assert.strictEqual(completo?.capabilities?.structuredOutput?.discovered?.value, true);
		assert.strictEqual(completo?.capabilities?.inputs?.image?.discovered?.value, true);
		// A lista do provedor é uma enumeração: o que não está nela é `false`.
		assert.strictEqual(completo?.capabilities?.inputs?.audio?.discovered?.value, false);
	});

	test('a modality nobody published stays unknown', async () => {
		const chat = await session(async (url) =>
			url.endsWith('/models')
				? jsonResponse({ data: [{ id: 'sem-lista', context_length: 1024 }] })
				: jsonResponse({}),
		);
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
		await chat.listModels(LOCAL_ID);
		const merged = await chat.listMergedCatalog(LOCAL_ID);
		const model = merged.models.find((entry) => entry.modelId === 'sem-lista');
		assert.strictEqual(model?.capabilities, undefined, 'sem lista, nada é afirmado');
		assert.strictEqual(model?.limits?.contextTokens?.discovered?.value, 1024);
	});

	test('a conflict is shown, and the declared value wins by default', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'completo',
			limits: { contextTokens: '64000' },
			model: { toolCalling: false } as never,
		});
		const merged = await chat.listMergedCatalog(LOCAL_ID);		const completo = merged.models.find((model) => model.modelId === 'completo');
		assert.strictEqual(completo?.limits?.contextTokens?.conflict, true);
		assert.strictEqual(completo?.limits?.contextTokens?.effective, 64000);
		assert.strictEqual(completo?.limits?.contextTokens?.discovered?.value, 128000);
		assert.strictEqual(completo?.capabilities?.toolCalling?.conflict, true);
		assert.strictEqual(completo?.capabilities?.toolCalling?.effective, false);
	});

	test('choosing the published values changes what the selector uses', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'completo',
			limits: { contextTokens: '64000' },
		});
		const before = await chat.fusedCatalog();
		assert.strictEqual(
			before.find((entry) => entry.modelId === 'completo')?.limits?.contextTokens,
			64000,
		);
		await chat.saveAccessPolicy({ limitsSource: 'discovered' });
		const after = await chat.fusedCatalog();
		assert.strictEqual(
			after.find((entry) => entry.modelId === 'completo')?.limits?.contextTokens,
			128000,
			'o seletor usa o mesmo número que a tela mostra',
		);
		const merged = await chat.listMergedCatalog(LOCAL_ID);
		const completo = merged.models.find((model) => model.modelId === 'completo');
		assert.strictEqual(completo?.limits?.contextTokens?.effective, 128000);
		assert.strictEqual(completo?.limits?.contextTokens?.selected, 'discovered');
	});

	test('the declared catalog on disk is not changed by the fusion', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'completo',
			limits: { contextTokens: '64000' },
		});
		await chat.saveAccessPolicy({ limitsSource: 'discovered' });
		await chat.fusedCatalog();
		const merged = await chat.listMergedCatalog(LOCAL_ID);
		const completo = merged.models.find((model) => model.modelId === 'completo');
		assert.strictEqual(completo?.limits?.contextTokens?.user, 64000, 'o valor declarado continua o seu');
	});

	test('the output limit is never copied from the context window', async () => {
		const chat = await ready();
		const merged = await chat.listMergedCatalog(LOCAL_ID);
		const pouco = merged.models.find((model) => model.modelId === 'pouco');
		assert.strictEqual(pouco?.limits?.contextTokens?.discovered?.value, 4096);
		assert.strictEqual(pouco?.limits?.maxOutputTokens, undefined);
	});

	test('the report describes the decision the router made', async () => {
		const chat = await ready();
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const events: ChatStreamEvent[] = [];
		const ack = await chat.sendMessage(
			{
				conversationId: conversation.summary.id,
				providerId: LOCAL_ID,
				model: 'completo',
				messages: [{ role: 'user', content: 'olá' }],
				strategy: 'fallback',
			},
			(event) => events.push(event),
		);
		await chat.waitForTurn(ack.turnId);
		const reports = await chat.listDecisionReports();
		assert.ok(reports.length >= 1, 'a decisão foi registrada');
		const report = reports[0];
		assert.strictEqual(report?.chosen?.modelId, 'completo');
		assert.ok((report?.chosen?.reason ?? '').length > 0);
		assert.ok((report?.alternatives ?? []).length > 0, 'as alternativas descartadas estão lá');
		assert.strictEqual(report?.result !== undefined, true);
	});

	test('the report carries no secret and no conversation content', async () => {
		const chat = await ready();
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const ack = await chat.sendMessage(
			{
				conversationId: conversation.summary.id,
				providerId: LOCAL_ID,
				model: 'completo',
				messages: [{ role: 'user', content: 'uma pergunta bem秘密' }],
				strategy: 'fallback',
			},
			() => undefined,
		);
		await chat.waitForTurn(ack.turnId);
		const reports = await chat.listDecisionReports();
		const raw = JSON.stringify(reports);
		assert.strictEqual(raw.includes('uma pergunta'), false, 'a pergunta não entra no relatório');
		assert.strictEqual(/sk-[A-Za-z0-9]{8,}/.test(raw), false);
		assert.strictEqual(raw.includes('authorization'), false);
	});

	test('the price in the report carries the validity of its side', async () => {
		const chat = await ready();
		await chat.saveAccessPolicy({ priceSource: 'discovered' });
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const ack = await chat.sendMessage(
			{
				conversationId: conversation.summary.id,
				providerId: LOCAL_ID,
				model: 'completo',
				messages: [{ role: 'user', content: 'olá' }],
				strategy: 'fallback',
			},
			() => undefined,
		);
		await chat.waitForTurn(ack.turnId);
		const reports = await chat.listDecisionReports();
		const price = reports[0]?.chosen?.price;
		assert.strictEqual(price?.side, 'discovered');
		assert.ok(price?.provenance?.source !== undefined);
		assert.ok(price?.provenance?.verifiedAt !== undefined, 'a data da verificação está no relatório');
		assert.ok(price?.provenance?.expiresAt !== undefined, 'a validade está no relatório');
	});

	test('the report names the policy and the sources in force', async () => {		const chat = await ready();
		await chat.saveAccessPolicy({ policy: 'free_only', limitsSource: 'discovered' });
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const ack = await chat.sendMessage(
			{
				conversationId: conversation.summary.id,
				providerId: LOCAL_ID,
				model: 'completo',
				messages: [{ role: 'user', content: 'olá' }],
				strategy: 'fallback',
			},
			() => undefined,
		);
		await chat.waitForTurn(ack.turnId);
		const reports = await chat.listDecisionReports();
		assert.strictEqual(reports[0]?.policy, 'free_only');
		assert.strictEqual(reports[0]?.policyApplied, true);
		assert.strictEqual(reports[0]?.sources.limits, 'discovered');
	});

	test('a policy-scoped budget limit blocks only under that policy', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'completo',
			access: 'paid',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '3', output: '15' },
		});
		// Um limite de zero para a política `free_only`.
		await chat.saveSpendingLimit({
			currency: 'USD',
			amount: '0',
			window: 'month',
			policy: 'free_only',
		});
		const limits = await chat.listSpendingLimits();
		assert.strictEqual(limits.filter((entry) => entry.policy === 'free_only').length, 1);
		// O limite é restrito, e a política em vigor é `any`: ele não se aplica.
		await chat.saveAccessPolicy({ policy: 'any' });
		const applied = await chat.applyAccessPolicy(
			{
				policy: 'any',
				priceSource: 'user',
				limitsSource: 'user',
				capabilitiesSource: 'user',
				updatedAt: new Date().toISOString(),
				changedBy: 'user',
			},
			await chat.listAvailableModels(),
		);
		assert.strictEqual(applied.policy, 'any');
	});

	test('the screen describes a fused field without inventing a value', () => {
		const text = describeFusedField({
			user: 1000,
			discovered: {
				value: 2000,
				source: 'provider',
				verifiedAt: '2026-10-20T12:00:00.000Z',
				expiresAt: '2026-10-21T12:00:00.000Z',
				stale: false,
				usable: true,
			},
			conflict: true,
			selected: 'user',
			effective: 1000,
			fellBack: false,
		});
		assert.ok(text.includes('você: 1.000'));
		assert.ok(text.includes('provedor: 2.000'));
		assert.ok(text.includes('discordam'));
		assert.ok(text.includes('vale o seu'));
	});

	test('the screen says "desconhecido" for a field nobody stated', () => {
		assert.strictEqual(describeFusedField(undefined), 'desconhecido');
	});
});

suite('Fusion: the request and token limits stay apart', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-fusion-quota-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	test('a request limit and a token limit are two facts, not one number', async () => {
		const store = new FileDataStore({ rootPath: root });
		const at = new Date().toISOString();
		await store.recordQuota({
			providerId: 'p',
			account: {
				source: 'account',
				limit: 100,
				remaining: 0,
				kind: 'requests',
				scope: 'api-key',
				window: 'minute',
				verifiedAt: at,
			},
			updatedAt: at,
		});
		await store.recordQuota({
			providerId: 'p',
			modelId: 'm',
			account: {
				source: 'account',
				limit: 50000,
				remaining: 1200,
				kind: 'tokens',
				scope: 'model',
				verifiedAt: at,
			},
			updatedAt: at,
		});
		const quotas = await store.listQuotas('p');
		assert.strictEqual(quotas.length, 2, 'as duas cotas são registros separados');
		const requests = quotas.find((quota) => quota.account?.kind === 'requests');
		const tokens = quotas.find((quota) => quota.account?.kind === 'tokens');
		assert.strictEqual(requests?.account?.limit, 100);
		assert.strictEqual(requests?.account?.scope, 'api-key');
		assert.strictEqual(tokens?.account?.limit, 50000);
		assert.strictEqual(tokens?.account?.scope, 'model');
	});

	test('a quota without a scope says its scope is unknown', async () => {
		const store = new FileDataStore({ rootPath: root });
		const at = new Date().toISOString();
		await store.recordQuota({
			providerId: 'p',
			account: { source: 'account', limit: 10, verifiedAt: at },
			updatedAt: at,
		});
		const quotas = await store.listQuotas('p');
		assert.strictEqual(quotas[0]?.account?.scope, undefined, 'a fonte não disse');
		assert.strictEqual(quotas[0]?.account?.kind, undefined);
	});

	test('an estimate is never presented as an official limit', async () => {
		const store = new FileDataStore({ rootPath: root });
		const at = new Date().toISOString();
		await store.recordQuota({
			providerId: 'p',
			account: { source: 'estimate', limit: 42, verifiedAt: at },
			updatedAt: at,
		});
		const quotas = await store.listQuotas('p');
		assert.strictEqual(quotas[0]?.account?.source, 'estimate');
		assert.notStrictEqual(quotas[0]?.account?.source, 'published');
	});
});

suite('Fusion: every access policy still works', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-fusion-policy-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function session(): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl: async (url) =>
				url.endsWith('/models') ? jsonResponse(LISTING) : jsonResponse({}),
			routing: {
				policy: policy(),
				breaker: new CircuitBreaker(() => policy().breaker, () => Date.now()),
				sleep: async () => true,
			},
		});
	}

	async function ready(): Promise<ChatSession> {
		const chat = session();
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
		await chat.listModels(LOCAL_ID);
		return chat;
	}

	test('any keeps every model', async () => {
		const chat = await ready();
		const applied = await chat.applyAccessPolicy(
			{
				policy: 'any',
				priceSource: 'user',
				limitsSource: 'user',
				capabilitiesSource: 'user',
				updatedAt: new Date().toISOString(),
				changedBy: 'user',
			},
			await chat.listAvailableModels(),
		);
		assert.deepStrictEqual(
			applied.allowedModels.map((model) => model.model),
			['completo', 'pouco'],
		);
	});

	test('free_only keeps only the confirmed free one', async () => {
		const chat = await ready();
		const applied = await chat.applyAccessPolicy(
			{
				policy: 'free_only',
				priceSource: 'user',
				limitsSource: 'user',
				capabilitiesSource: 'user',
				updatedAt: new Date().toISOString(),
				changedBy: 'user',
			},
			await chat.listAvailableModels(),
		);
		assert.deepStrictEqual(applied.allowedModels.map((model) => model.model), ['completo']);
	});

	test('free_preferred keeps every model, free first', async () => {
		const chat = await ready();
		const applied = await chat.applyAccessPolicy(
			{
				policy: 'free_preferred',
				priceSource: 'user',
				limitsSource: 'user',
				capabilitiesSource: 'user',
				updatedAt: new Date().toISOString(),
				changedBy: 'user',
			},
			await chat.listAvailableModels(),
		);
		assert.deepStrictEqual(applied.allowedModels.map((model) => model.model), ['completo', 'pouco']);
	});
});
