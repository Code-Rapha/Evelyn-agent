/**
 * O histórico de execuções e a comparação entre duas delas.
 *
 * O caminho testado é o real: um turno roda, a entrada é gravada no log, o
 * histórico a devolve, e duas execuções podem ser comparadas — a comparação
 * sendo **aceita**, **limitada** ou **recusada**, sempre com o motivo.
 */
import * as assert from 'assert';
import { mkdtemp, readFile } from 'node:fs/promises';
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
import { compareExecutions, type HistoryExecution } from '../desktop/compareExecutions';
import { parseExecutionComparison, parseExecutionHistory } from '../desktop/executionHistoryParsers';
import { describeComparison, describeTaskExplanation } from '../desktop/renderer/describePolicy';
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

const LISTING = {
	data: [
		{ id: 'livre', pricing: { currency: 'USD', input: 0, output: 0 } },
		{ id: 'pouco', pricing: { currency: 'USD', input: 1, output: 2 } },
	],
};

suite('History: the executions are recorded and can be compared', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-history-5g-'));
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

	async function runTurn(chat: ChatSession, message: string): Promise<void> {
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const ack = await chat.sendMessage(
			{
				conversationId: conversation.summary.id,
				providerId: LOCAL_ID,
				model: 'livre',
				messages: [{ role: 'user', content: message }],
				strategy: 'fallback',
			},
			() => undefined,
		);
		await chat.waitForTurn(ack.turnId);
	}

	test('an execution is recorded with its id, date and policy', async () => {
		const chat = await ready();
		await runTurn(chat, 'olá');
		const history = await chat.listExecutionHistory();
		assert.strictEqual(history.length, 1);
		const execution = history[0];
		assert.ok(execution?.executionId.length);
		assert.ok(!Number.isNaN(Date.parse(execution?.timestamp ?? '')));
		assert.strictEqual(execution?.report.policy, 'any');
		assert.strictEqual(execution?.report.executionId, execution?.executionId);
	});

	test('the report carries the score decomposition of the chosen candidate', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'livre',
			capabilities: 'coding, tools',
			access: 'free',
		});
		await runTurn(chat, 'escreva um código');
		const history = await chat.listExecutionHistory();
		const evaluation = history[0]?.report.evaluations.find((entry) => entry.chosen);
		assert.ok(evaluation !== undefined, 'o escolhido foi avaliado');
		assert.ok(evaluation.score !== undefined);
		assert.ok(evaluation.components.length > 0, 'os termos da pontuação estão lá');
		const sum = evaluation.components.reduce((total, component) => total + component.points, 0);
		assert.strictEqual(sum, evaluation.score, 'a soma dos termos é o score');
	});

	test('a candidate that was discarded is evaluated too', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'livre',
			capabilities: 'coding, tools',
			access: 'free',
		});
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'pouco',
			access: 'paid',
		});
		await runTurn(chat, 'escreva um código');
		const history = await chat.listExecutionHistory();
		const discarded = history[0]?.report.evaluations.find((entry) => entry.modelId === 'pouco');
		assert.ok(discarded !== undefined, 'o descartado também foi avaliado');
		assert.strictEqual(discarded.chosen, false);
	});

	test('a candidate removed by the policy is reported, without a score', async () => {
		const chat = await ready();
		await chat.saveAccessPolicy({ policy: 'free_only' });
		await runTurn(chat, 'olá');
		const history = await chat.listExecutionHistory();
		const report = history[0]?.report;
		// `pouco` não tem acesso gratuito confirmado: a política o removeu
		// antes da pontuação.
		const excluded = report?.policyExcluded.find((entry) => entry.modelId === 'pouco');
		assert.ok(excluded !== undefined, 'o candidato removido pela política está no relatório');
		const evaluation = report?.evaluations.find((entry) => entry.modelId === 'pouco');
		assert.strictEqual(evaluation?.score, undefined, 'ele nunca foi pontuado');
		assert.ok(
			evaluation?.constraints.some((constraint) => constraint.id === 'policy_excluded'),
			'a restrição que o removeu está separada do score',
		);
	});

	test('two executions under the same policy are accepted as comparable', async () => {
		const chat = await ready();
		await runTurn(chat, 'primeira');
		await runTurn(chat, 'segunda');
		const history = await chat.listExecutionHistory();
		assert.strictEqual(history.length, 2);
		const comparison = await chat.compareExecutions(
			history[0]?.executionId as string,
			history[1]?.executionId as string,
		);
		assert.strictEqual(comparison.status, 'accepted');
	});

	test('two executions under different policies are limited, and the limit is named', async () => {
		const chat = await ready();
		await runTurn(chat, 'primeira');
		await chat.saveAccessPolicy({ policy: 'free_only' });
		await runTurn(chat, 'segunda');
		const history = await chat.listExecutionHistory();
		const comparison = await chat.compareExecutions(
			history[0]?.executionId as string,
			history[1]?.executionId as string,
		);
		assert.strictEqual(comparison.status, 'limited');
		if (comparison.status === 'limited') {
			assert.ok(
				comparison.context.some((difference) => difference.what === 'política de acesso'),
				'a diferença de política é nomeada',
			);
			assert.ok(comparison.limits.length > 0, 'o limite é escrito');
		}
	});

	test('the comparison is limited when the metadata sources differ', async () => {
		const chat = await ready();
		await runTurn(chat, 'primeira');
		await chat.saveAccessPolicy({ priceSource: 'discovered' });
		await runTurn(chat, 'segunda');
		const history = await chat.listExecutionHistory();
		const comparison = await chat.compareExecutions(
			history[0]?.executionId as string,
			history[1]?.executionId as string,
		);
		assert.strictEqual(comparison.status, 'limited');
		if (comparison.status === 'limited') {
			assert.ok(
				comparison.context.some((difference) => difference.what === 'origem dos metadados'),
			);
		}
	});

	test('comparing an execution that is gone is refused, not a crash', async () => {
		const chat = await ready();
		await runTurn(chat, 'olá');
		const comparison = await chat.compareExecutions('inexistente', 'outro-inexistente');
		assert.strictEqual(comparison.status, 'refused');
		if (comparison.status === 'refused') {
			assert.strictEqual(comparison.reason, 'unknown_execution');
		}
	});

	test('the history holds no secret and no conversation content', async () => {
		const chat = await ready();
		await runTurn(chat, 'uma pergunta muito particular');
		const history = await chat.listExecutionHistory();
		const raw = JSON.stringify(history);
		assert.strictEqual(raw.includes('uma pergunta'), false);
		assert.strictEqual(/sk-[A-Za-z0-9]{8,}/.test(raw), false);
		assert.strictEqual(raw.includes('authorization'), false);
		assert.strictEqual(raw.includes('messages'), false);
	});

	test('the log file on disk holds no secret either', async () => {
		const chat = await ready();
		await runTurn(chat, 'uma pergunta muito particular');
		const raw = await readFile(join(root, 'data', 'orchestrationLog.json'), 'utf8');
		assert.strictEqual(raw.includes('uma pergunta'), false);
		assert.strictEqual(/sk-[A-Za-z0-9]{8,}/.test(raw), false);
		assert.strictEqual(raw.includes('authorization'), false);
	});

	test('the history is bounded', async () => {
		const chat = await ready();
		await runTurn(chat, 'olá');
		const many = await chat.listExecutionHistory(1000);
		assert.ok(many.length <= 500, 'o log é limitado a 500 entradas');
	});

	test('the history works under every access policy', async () => {
		for (const accessPolicy of ['any', 'free_only', 'free_preferred'] as const) {
			const scoped = await mkdtemp(join(tmpdir(), `seshyina-history-${accessPolicy}-`));
			try {
				const chat = new ChatSession({
					config: new ProviderConfigService(
						new FileStateStore({ filePath: join(scoped, 'state.json') }),
					),
					secrets: new FileSecretStore({ filePath: join(scoped, 'secrets.json') }),
					history: new FileDataStore({ rootPath: join(scoped, 'data') }),
					logger: new LoggingService(
						new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
					),
					fetchImpl: async (url) =>
						url.endsWith('/models') ? jsonResponse(LISTING) : jsonResponse({}),
					routing: {
						policy: policy(),
						breaker: new CircuitBreaker(() => policy().breaker, () => Date.now()),
						sleep: async () => true,
					},
				});
				await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
				await chat.listModels(LOCAL_ID);
				await chat.saveAccessPolicy({ policy: accessPolicy });
				const conversation = await chat.createConversation({ providerId: LOCAL_ID });
				const ack = await chat.sendMessage(
					{
						conversationId: conversation.summary.id,
						providerId: LOCAL_ID,
						model: 'livre',
						messages: [{ role: 'user', content: 'olá' }],
						strategy: 'fallback',
					},
					() => undefined,
				);
				await chat.waitForTurn(ack.turnId);
				const history = await chat.listExecutionHistory();
				assert.strictEqual(history.length, 1, `a execução foi registrada sob ${accessPolicy}`);
				assert.strictEqual(history[0]?.report.policy, accessPolicy);
				assert.strictEqual(history[0]?.report.policyApplied, accessPolicy !== 'any');
			} finally {
				await removeFixtureTree(scoped);
			}
		}
	});

	test('the report carries the explanation of the classification', async () => {
		const chat = await ready();
		await runTurn(chat, 'escreva um código em python para corrigir este bug');
		const history = await chat.listExecutionHistory();
		const task = history[0]?.report.task;
		assert.ok(task !== undefined, 'a classificação foi explicada');
		assert.strictEqual(task.domain.detected, 'coding');
		assert.ok(task.domain.hits.length > 0, 'as palavras-chave do domínio estão lá');
		assert.ok(
			task.domain.hits.every((hit) => hit.keyword.length > 0),
			'toda regra tem a palavra-chave que disparou',
		);
		assert.ok(task.complexity.evidence.length > 0, 'a complexidade tem evidência');
		assert.ok(task.confidence.basis.length > 0, 'a confiança diz de onde veio');
	});
});

suite('History: the comparison, as a pure function', () => {
	function execution(overrides: {
		readonly policy?: 'any' | 'free_only' | 'free_preferred';
		readonly providerId?: string;
		readonly modelId?: string;
		readonly score?: number;
		readonly totalMs?: number;
		readonly totalTokens?: number;
		readonly source?: 'user' | 'discovered';
		readonly domain?: string;
		readonly complexity?: string;
		readonly withAttempt?: boolean;
	}): HistoryExecution {
		const providerId = overrides.providerId ?? 'p';
		const modelId = overrides.modelId ?? 'm';
		return {
			executionId: `e-${modelId}`,
			timestamp: '2026-10-20T12:00:00.000Z',
			conversationId: 'c',
			report: {
				turnId: 't',
				conversationId: 'c',
				startedAt: '2026-10-20T12:00:00.000Z',
				strategy: 'fallback',
				policy: overrides.policy ?? 'any',
				policyApplied: (overrides.policy ?? 'any') !== 'any',
				sources: {
					price: (overrides.source ?? 'user') as 'user' | 'discovered',
					limits: 'user' as const,
					capabilities: 'user' as const,
				},
				chosen: { providerId, modelId, reason: 'r', access: 'free' as const },
				alternatives: [],
				evaluations: [
					{
						providerId,
						modelId,
						...(overrides.score !== undefined ? { score: overrides.score } : {}),
						components: [{ id: 'access.free', label: 'Free', points: 10, detail: 'd' }],
						constraints: [],
						confidence: [],
						reason: 'r',
						chosen: true,
					},
				],
				policyExcluded: [],
				budget: [],
				quotas: [],
				attempts:
					overrides.withAttempt === false
						? []
						: [
								{
									sequence: 1,
									providerId,
									modelId,
									outcome: 'success' as const,
									fallback: false,
									retry: false,
									...(overrides.totalMs !== undefined ? { totalMs: overrides.totalMs } : {}),
									...(overrides.totalTokens !== undefined
										? { usage: { totalTokens: overrides.totalTokens } }
										: {}),
								},
							],
				result: 'success' as const,
				finalModel: { providerId, modelId },
				summary: 'ok',
				...(overrides.domain !== undefined
					? {
							task: {
								domain: {
									detected: overrides.domain as 'coding',
									hits: [],
									considered: [],
									reason: 'r',
								},
								complexity: { detected: (overrides.complexity ?? 'simple') as 'simple', evidence: [] },
								capabilities: [],
								tools: { needed: false, hits: [] },
								confidence: { value: 0.5, level: 'medium' as const, basis: 'b' },
								missingInformation: [],
							},
						}
					: {}),
			},
		};
	}

	test('two executions under the same conditions are accepted', () => {
		const comparison = compareExecutions(
			execution({ modelId: 'a', score: 10, totalMs: 100 }),
			execution({ modelId: 'b', score: 20, totalMs: 200 }),
		);
		assert.strictEqual(comparison.status, 'accepted');
		if (comparison.status !== 'accepted') {
			return;
		}
		assert.ok(comparison.differences.some((d) => d.includes('modelo escolhido')));
		assert.ok(comparison.differences.some((d) => d.includes('pontuação')));
		assert.ok(comparison.metrics.length > 0, 'as métricas são listadas uma a uma');
	});

	test('the same model under different policies is limited, and the limit is named', () => {
		const comparison = compareExecutions(
			execution({ modelId: 'a', policy: 'any' }),
			execution({ modelId: 'a', policy: 'free_only' }),
		);
		assert.strictEqual(comparison.status, 'limited');
		if (comparison.status !== 'limited') {
			return;
		}
		assert.ok(comparison.context.some((d) => d.what === 'política de acesso'));
		assert.ok(comparison.limits.length > 0);
	});

	test('different providers limit the latency comparison only', () => {
		const comparison = compareExecutions(
			execution({ providerId: 'p1', totalMs: 100 }),
			execution({ providerId: 'p2', totalMs: 200 }),
		);
		assert.strictEqual(comparison.status, 'limited');
		if (comparison.status !== 'limited') {
			return;
		}
		const latency = comparison.metrics.find((metric) => metric.id === 'latency');
		const result = comparison.metrics.find((metric) => metric.id === 'result');
		assert.strictEqual(latency?.comparable, false, 'latência de servidores diferentes não se compara');
		assert.strictEqual(result?.comparable, true, 'o resultado ainda se compara');
	});

	test('different models on the same provider are accepted', () => {
		const comparison = compareExecutions(
			execution({ modelId: 'a' }),
			execution({ modelId: 'b' }),
		);
		assert.strictEqual(comparison.status, 'accepted');
	});

	test('different tasks limit the score comparison', () => {
		const comparison = compareExecutions(
			execution({ domain: 'coding', complexity: 'simple' }),
			execution({ domain: 'database', complexity: 'complex' }),
		);
		assert.strictEqual(comparison.status, 'limited');
		if (comparison.status !== 'limited') {
			return;
		}
		const score = comparison.metrics.find((metric) => metric.id === 'score');
		assert.strictEqual(score?.comparable, false);
	});

	test('an execution without an attempt has nothing to compare', () => {
		const comparison = compareExecutions(
			execution({ withAttempt: false }),
			execution({ withAttempt: false }),
		);
		assert.strictEqual(comparison.status, 'refused');
		if (comparison.status !== 'refused') {
			return;
		}
		assert.strictEqual(comparison.reason, 'no_data');
	});

	test('a missing execution is refused', () => {
		const comparison = compareExecutions(execution({}), undefined);
		assert.strictEqual(comparison.status, 'refused');
		if (comparison.status !== 'refused') {
			return;
		}
		assert.strictEqual(comparison.reason, 'unknown_execution');
	});

	test('the screen distinguishes a measured latency from an unmeasured one', () => {
		const comparison = compareExecutions(
			execution({ modelId: 'a', totalMs: 100 }),
			execution({ modelId: 'b' }),
		);
		const lines = describeComparison(comparison);
		assert.ok(lines.some((line) => line.includes('100ms')));
		assert.ok(lines.some((line) => line.includes('não medida')));
		assert.strictEqual(
			lines.some((line) => /(^|[^0-9])0ms/.test(line)),
			false,
			'nenhum zero onde não houve medição',
		);
	});

	test('the screen distinguishes published tokens from absent ones', () => {
		const comparison = compareExecutions(
			execution({ modelId: 'a', totalTokens: 120 }),
			execution({ modelId: 'b' }),
		);
		const lines = describeComparison(comparison);
		assert.ok(lines.some((line) => line.includes('120')));
		assert.ok(lines.some((line) => line.includes('não publicados')));
	});

	test('the screen says which metric is not comparable', () => {
		const comparison = compareExecutions(
			execution({ providerId: 'p1', totalMs: 100 }),
			execution({ providerId: 'p2', totalMs: 200 }),
		);
		const lines = describeComparison(comparison);
		assert.ok(lines.some((line) => line.includes('Comparação limitada')));
		assert.ok(lines.some((line) => line.includes('não comparável')));
		assert.ok(lines.some((line) => line.includes('provedor')));
	});
});

suite('History: the bridge', () => {
	test('a history round-trips through the parser', () => {
		const parsed = parseExecutionHistory([
			{
				executionId: 'e1',
				timestamp: '2026-10-20T12:00:00.000Z',
				conversationId: 'c',
				report: {
					turnId: 't',
					conversationId: 'c',
					startedAt: '2026-10-20T12:00:00.000Z',
					strategy: 'fallback',
					policy: 'any',
					policyApplied: false,
					sources: { price: 'user', limits: 'user', capabilities: 'user' },
					alternatives: [],
					evaluations: [],
					policyExcluded: [],
					budget: [],
					quotas: [],
					attempts: [],
					result: 'success',
					summary: 'ok',
				},
			},
		]);
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0]?.executionId, 'e1');
	});

	test('an entry without a report is dropped', () => {
		assert.deepStrictEqual(parseExecutionHistory([{ executionId: 'e1' }]), []);
	});

	test('a refusal survives the parser', () => {
		const parsed = parseExecutionComparison({
			status: 'refused',
			reason: 'no_data',
			detail: 'nenhuma tentativa',
		});
		assert.strictEqual(parsed?.status, 'refused');
	});

	test('an unknown status is dropped', () => {
		assert.strictEqual(parseExecutionComparison({ status: 'whatever' }), undefined);
	});
});

suite('History: the classification explanation on the screen', () => {
	test('the explanation names the rules, not the message', () => {
		const lines = describeTaskExplanation({
			domain: {
				detected: 'coding',
				hits: [{ rule: 'domain.coding', keyword: 'código', detail: 'palavra-chave do domínio' }],
				considered: [{ domain: 'coding', hits: 2 }],
				reason: '2 palavra(s)-chave do domínio "coding" apareceram',
			},
			complexity: {
				detected: 'simple',
				evidence: [{ source: 'message_length', detail: 'a mensagem tem 20 palavra(s)' }],
			},
			capabilities: [
				{
					capability: 'code-generation',
					hits: [],
					reason: 'capacidade assumida pelo padrão do domínio de código, sem palavra-chave',
				},
			],
			tools: { needed: false, hits: [] },
			confidence: { value: 0.5, level: 'medium', basis: 'base 20 palavra(s) e 2 palavra(s)-chave' },
			missingInformation: [{ item: 'linguagem ou framework alvo', rule: 'coding.sem_alvo' }],
		});
		const text = lines.join('\n');
		assert.ok(text.includes('coding'));
		assert.ok(text.includes('código'));
		assert.ok(text.includes('a mensagem tem 20 palavra(s)'));
		assert.ok(text.includes('code-generation'));
		assert.ok(text.includes('medium (0.5)'));
		assert.ok(text.includes('linguagem ou framework alvo'));
	});

	test('an ambiguous classification says it had no evidence', () => {
		const lines = describeTaskExplanation({
			domain: {
				detected: 'general',
				hits: [],
				considered: [],
				reason: 'nenhuma palavra-chave de domínio apareceu; a tarefa ficou como geral',
			},
			complexity: { detected: 'unknown', evidence: [] },
			capabilities: [],
			tools: { needed: false, hits: [] },
			confidence: { value: 0.3, level: 'low', basis: 'base 3 palavra(s) e 0 palavra(s)-chave' },
			missingInformation: [],
		});
		const text = lines.join('\n');
		assert.ok(text.includes('nenhuma palavra-chave'));
		assert.ok(text.includes('low (0.3)'));
	});
});
