/**
 * O registro de consumo no disco.
 *
 * Cada teste roda num diretório temporário próprio e lê o arquivo com uma
 * instância **nova** do armazenamento quando quer provar que o histórico
 * sobreviveu à reabertura, e nunca confia no cache de quem escreveu.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationError } from '../core/errors';
import { CONSUMPTION_FILE, FileDataStore } from '../adapters/local/fileDataStore';
import type { RecordAttemptInput, RecordExecutionInput } from '../core/storage/types/consumption';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

suite('Storage: consumption ledger', () => {
	let root: string;
	let store: FileDataStore;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-consumption-'));
		store = new FileDataStore({ rootPath: root });
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function execution(overrides: Partial<RecordExecutionInput> = {}): RecordExecutionInput {
		return {
			executionId: 'turn-1',
			kind: 'routing',
			turnId: 'turn-1',
			status: 'success',
			startedAt: '2026-01-01T10:00:00.000Z',
			finishedAt: '2026-01-01T10:00:02.000Z',
			...overrides,
		};
	}

	function attempt(overrides: Partial<RecordAttemptInput> = {}): RecordAttemptInput {
		return {
			executionId: 'turn-1',
			sequence: 1,
			providerId: 'atria',
			modelId: 'modelo-a',
			retry: false,
			fallback: false,
			status: 'success',
			startedAt: '2026-01-01T10:00:01.000Z',
			...overrides,
		};
	}

	const USD_PER_MILLION = {
		currency: 'USD',
		unit: 'per_1m_tokens' as const,
		input: 3,
		output: 15,
	};

	// Reopening ...............................................................

	test('an execution and its attempts survive the store being reopened', async () => {
		await store.recordExecution(execution());
		await store.recordAttempt(
			attempt({ reportedTokens: { input: 1_000, output: 500 }, pricing: USD_PER_MILLION }),
		);

		const reopened = new FileDataStore({ rootPath: root });
		const loaded = await reopened.getExecution('turn-1');

		assert.ok(loaded !== undefined);
		assert.strictEqual(loaded.execution.executionId, 'turn-1');
		assert.strictEqual(loaded.execution.kind, 'routing');
		assert.strictEqual(loaded.execution.turnId, 'turn-1');
		assert.strictEqual(loaded.execution.status, 'success');
		assert.strictEqual(loaded.attempts.length, 1);
		assert.deepStrictEqual(loaded.attempts[0].reportedTokens, { input: 1_000, output: 500 });
		assert.strictEqual(loaded.attempts[0].tokenSource, 'provider');
		assert.deepStrictEqual(loaded.attempts[0].pricing, USD_PER_MILLION);
		assert.strictEqual(loaded.totals.cost.status, 'estimated');
		if (loaded.totals.cost.status === 'estimated') {
			assert.strictEqual(loaded.totals.cost.total, 0.0105);
		}
	});

	test('a missing ledger is an empty history, and creates no file on read', async () => {
		assert.deepStrictEqual(await store.listConsumption(), []);
		assert.strictEqual(existsSync(join(root, CONSUMPTION_FILE)), false);
	});

	// Identity and ordering ...................................................

	test('the same id under two providers stays two attempts', async () => {
		await store.recordExecution(execution());
		await store.recordAttempt(attempt({ sequence: 1, providerId: 'atria', modelId: 'gpt-x' }));
		await store.recordAttempt(attempt({ sequence: 2, providerId: 'opencode', modelId: 'gpt-x', fallback: true }));
		await store.recordAttempt(attempt({ sequence: 3, providerId: 'atria', modelId: 'gpt-x', retry: true }));

		const attempts = await store.listAttempts('turn-1');
		assert.deepStrictEqual(
			attempts.map((record) => `${record.providerId}/${record.modelId}/${record.sequence}`),
			['atria/gpt-x/1', 'opencode/gpt-x/2', 'atria/gpt-x/3'],
		);
		assert.strictEqual(attempts[1].fallback, true);
		assert.strictEqual(attempts[2].retry, true);
	});

	test('executions are listed most recent first and filtered by provider', async () => {
		await store.recordExecution(
			execution({ executionId: 'a', providerId: 'atria', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z' }),
		);
		await store.recordExecution(
			execution({ executionId: 'b', providerId: 'opencode', startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-01-02T00:00:01.000Z' }),
		);
		await store.recordExecution(
			execution({ executionId: 'c', providerId: 'atria', startedAt: '2026-01-03T00:00:00.000Z', finishedAt: '2026-01-03T00:00:01.000Z' }),
		);

		assert.deepStrictEqual(
			(await store.listConsumption()).map((record) => record.executionId),
			['c', 'b', 'a'],
		);
		assert.deepStrictEqual(
			(await store.listConsumption({ providerId: 'atria' })).map((record) => record.executionId),
			['c', 'a'],
		);
		assert.deepStrictEqual(
			(await store.listConsumption({ limit: 1 })).map((record) => record.executionId),
			['c'],
		);
		assert.deepStrictEqual(
			(
				await store.listConsumption({
					since: '2026-01-02T00:00:00.000Z',
					until: '2026-01-03T00:00:00.000Z',
				})
			).map((record) => record.executionId),
			['b'],
		);
	});

	// Idempotency .............................................................

	test('recording the same execution twice keeps one record', async () => {
		await store.recordExecution(execution());
		await store.recordExecution(execution({ status: 'failure' }));

		const all = await store.listConsumption();
		assert.strictEqual(all.length, 1);
		assert.strictEqual(all[0].status, 'failure', 'the replay wins, without duplicating');
	});

	test('recording the same attempt twice keeps one attempt and does not double its tokens', async () => {
		await store.recordExecution(execution());
		const input = attempt({
			reportedTokens: { input: 1_000, output: 500 },
			pricing: USD_PER_MILLION,
		});
		await store.recordAttempt(input);
		// A replay after a crash: the caller does not know whether the first
		// write landed, so it sends the same event again.
		await store.recordAttempt(input);

		const loaded = await store.getExecution('turn-1');
		assert.strictEqual(loaded?.attempts.length, 1);
		assert.deepStrictEqual(loaded?.totals.tokens, { input: 1_000, output: 500 });
		assert.strictEqual(loaded?.totals.attempts, 1);
		assert.deepStrictEqual(loaded?.execution.attemptIds, ['turn-1#1']);
	});

	test('a replay after reopening is still the same attempt', async () => {
		await store.recordExecution(execution());
		await store.recordAttempt(attempt({ reportedTokens: { input: 10, output: 5 } }));

		const reopened = new FileDataStore({ rootPath: root });
		await reopened.recordAttempt(
			attempt({ reportedTokens: { input: 10, output: 5 } }),
		);
		assert.strictEqual((await reopened.listAttempts('turn-1')).length, 1);
	});

	test('an attempt cannot be recorded for an execution that does not exist', async () => {
		await assert.rejects(() => store.recordAttempt(attempt()), ValidationError);
		assert.deepStrictEqual(await store.listConsumption(), []);
	});

	// Write validation ........................................................

	test('a fractional or negative token count is refused', async () => {
		await store.recordExecution(execution());
		for (const reportedTokens of [{ input: 1.5 }, { output: -1 }, { input: 10, cachedInput: 20 }]) {
			await assert.rejects(
				() => store.recordAttempt(attempt({ reportedTokens })),
				ValidationError,
			);
		}
	});

	test('an empty token object is refused rather than stored as a reading of nothing', async () => {
		await store.recordExecution(execution());
		await assert.rejects(
			() => store.recordAttempt(attempt({ reportedTokens: {} })),
			ValidationError,
		);
	});

	test('an unknown status is refused', async () => {
		await assert.rejects(
			() => store.recordExecution(execution({ status: 'ok' as never })),
			ValidationError,
		);
	});

	test('a finish before the start is refused', async () => {
		await assert.rejects(
			() =>
				store.recordExecution(
					execution({ startedAt: '2026-01-01T10:00:02.000Z', finishedAt: '2026-01-01T10:00:00.000Z' }),
				),
			ValidationError,
		);
	});

	test('a malformed price is refused', async () => {
		await store.recordExecution(execution());
		await assert.rejects(
			() =>
				store.recordAttempt(
					attempt({ reportedTokens: { input: 1, output: 1 }, pricing: { currency: '', unit: 'per_1k_tokens' } }),
				),
			ValidationError,
		);
	});

	test('a sequence below one is refused', async () => {
		await store.recordExecution(execution());
		await assert.rejects(() => store.recordAttempt(attempt({ sequence: 0 })), ValidationError);
	});

	// Secrets and content .....................................................

	test('a secret-shaped field is refused and nothing is written', async () => {
		await assert.rejects(
			() =>
				store.recordExecution({
					...execution(),
					apiKey: 'sk-live-should-never-land',
				} as never),
			ValidationError,
		);
		assert.strictEqual(existsSync(join(root, CONSUMPTION_FILE)), false);
	});

	test('an attempt carrying a secret-shaped field is refused', async () => {
		await store.recordExecution(execution());
		await assert.rejects(
			() =>
				store.recordAttempt(
					attempt({ apiKey: 'sk-live-should-never-land' } as never),
				),
			ValidationError,
		);
		assert.strictEqual((await store.listAttempts('turn-1')).length, 0);
	});

	test('unknown fields are dropped: a prompt sent along never reaches the file', async () => {
		await store.recordExecution(execution());
		await store.recordAttempt({
			...attempt({ reportedTokens: { input: 3, output: 4 } }),
			prompt: 'minha senha é 1234',
			response: 'a resposta privada',
		} as never);

		const raw = await readFile(join(root, CONSUMPTION_FILE), 'utf8');
		assert.strictEqual(raw.includes('minha senha'), false);
		assert.strictEqual(raw.includes('a resposta privada'), false);
		assert.strictEqual(raw.includes('sk-live'), false);
	});

	test('the ledger file holds identity, numbers and timestamps only', async () => {
		await store.recordExecution(execution());
		await store.recordAttempt(
			attempt({ reportedTokens: { input: 10, output: 5, cachedInput: 4 }, pricing: { ...USD_PER_MILLION, cachedInput: 0.3 } }),
		);

		const parsed = JSON.parse(await readFile(join(root, CONSUMPTION_FILE), 'utf8')) as {
			executions: Record<string, unknown>[];
			attempts: Record<string, unknown>[];
		};
		const allowedExecution = new Set([
			'executionId', 'kind', 'turnId', 'routeId', 'providerId', 'modelId', 'status',
			'startedAt', 'finishedAt', 'attemptIds', 'totals',
		]);
		const allowedAttempt = new Set([
			'attemptId', 'executionId', 'providerId', 'modelId', 'sequence', 'retry', 'fallback',
			'status', 'startedAt', 'recordedAt', 'reportedTokens', 'estimatedTokens', 'tokenSource',
			'pricing', 'cost', 'errorClass', 'abortCause', 'httpStatus',
		]);
		for (const key of Object.keys(parsed.executions[0])) {
			assert.ok(allowedExecution.has(key), `unexpected field ${key}`);
		}
		for (const key of Object.keys(parsed.attempts[0])) {
			assert.ok(allowedAttempt.has(key), `unexpected field ${key}`);
		}
	});

	// Old and damaged files ...................................................

	test('a damaged file reads as an empty history rather than failing to start', async () => {
		await writeFile(join(root, CONSUMPTION_FILE), 'not json at all', 'utf8');
		assert.deepStrictEqual(await new FileDataStore({ rootPath: root }).listConsumption(), []);
	});

	test('a ledger written before a field existed still reads', async () => {
		// The oldest shape: an execution with no attempts, and an attempt with
		// no token source, no price and no cost block.
		await writeFile(
			join(root, CONSUMPTION_FILE),
			JSON.stringify({
				version: 1,
				executions: [
					{
						executionId: 'old',
						kind: 'turn',
						status: 'success',
						startedAt: '2025-01-01T00:00:00.000Z',
						finishedAt: '2025-01-01T00:00:01.000Z',
						attemptIds: ['old#1'],
					},
				],
				attempts: [
					{
						attemptId: 'old#1',
						executionId: 'old',
						providerId: 'p',
						modelId: 'm',
						sequence: 1,
						status: 'success',
						startedAt: '2025-01-01T00:00:00.000Z',
						recordedAt: '2025-01-01T00:00:01.000Z',
						reportedTokens: { input: 7, output: 3 },
					},
				],
			}),
			'utf8',
		);

		const loaded = await new FileDataStore({ rootPath: root }).getExecution('old');
		assert.ok(loaded !== undefined);
		assert.strictEqual(loaded.attempts[0].tokenSource, 'provider', 'inferred from the reading, not from the id');
		assert.strictEqual(loaded.attempts[0].cost.status, 'unknown', 'no price was ever recorded');
		assert.deepStrictEqual(loaded.totals.tokens, { input: 7, output: 3 });
	});

	test('a record with an invalid optional field loses the field, not the record', async () => {
		await writeFile(
			join(root, CONSUMPTION_FILE),
			JSON.stringify({
				version: 1,
				executions: [
					{
						executionId: 'e',
						kind: 'turn',
						status: 'success',
						startedAt: '2026-01-01T00:00:00.000Z',
						finishedAt: '2026-01-01T00:00:01.000Z',
						attemptIds: ['e#1'],
					},
				],
				attempts: [
					{
						attemptId: 'e#1',
						executionId: 'e',
						providerId: 'p',
						modelId: 'm',
						sequence: 1,
						status: 'success',
						startedAt: '2026-01-01T00:00:00.000Z',
						recordedAt: '2026-01-01T00:00:01.000Z',
						reportedTokens: { input: 5, output: 2, cachedInput: 'muito' },
						httpStatus: 'ok',
					},
				],
			}),
			'utf8',
		);

		const attempt = (await new FileDataStore({ rootPath: root }).listAttempts('e'))[0];
		assert.deepStrictEqual(attempt.reportedTokens, { input: 5, output: 2 });
		assert.strictEqual(attempt.httpStatus, undefined);
	});

	test('a record without an id is dropped and the valid ones survive', async () => {
		await writeFile(
			join(root, CONSUMPTION_FILE),
			JSON.stringify({
				version: 1,
				executions: [
					{ kind: 'turn', status: 'success', startedAt: 'a', finishedAt: 'a' },
					{
						executionId: 'good',
						kind: 'turn',
						status: 'success',
						startedAt: '2026-01-01T00:00:00.000Z',
						finishedAt: '2026-01-01T00:00:01.000Z',
						attemptIds: [],
					},
				],
				attempts: [
					{ providerId: 'p', modelId: 'm', sequence: 1 },
				],
			}),
			'utf8',
		);

		assert.deepStrictEqual(
			(await new FileDataStore({ rootPath: root }).listConsumption()).map((record) => record.executionId),
			['good'],
		);
	});

	test('a stored total that disagrees with its attempts is recomputed from them', async () => {
		// A hand-edited total is what a budget would later read. The attempts
		// are the facts; the total is a cache.
		await writeFile(
			join(root, CONSUMPTION_FILE),
			JSON.stringify({
				version: 1,
				executions: [
					{
						executionId: 'e',
						kind: 'turn',
						status: 'success',
						startedAt: '2026-01-01T00:00:00.000Z',
						finishedAt: '2026-01-01T00:00:01.000Z',
						attemptIds: ['e#1'],
						totals: { attempts: 1, tokens: { input: 999_999, output: 0 }, cost: { status: 'unknown', parts: [], reasons: ['x'] } },
					},
				],
				attempts: [
					{
						attemptId: 'e#1',
						executionId: 'e',
						providerId: 'p',
						modelId: 'm',
						sequence: 1,
						status: 'success',
						startedAt: '2026-01-01T00:00:00.000Z',
						recordedAt: '2026-01-01T00:00:01.000Z',
						reportedTokens: { input: 10, output: 2 },
						tokenSource: 'provider',
						cost: {
							status: 'estimated',
							currency: 'USD',
							unit: 'per_1m_tokens',
							parts: [{ currency: 'USD', unit: 'per_1m_tokens', amount: 0.00003 }],
							total: 0.00003,
						},
					},
				],
			}),
			'utf8',
		);

		const loaded = await new FileDataStore({ rootPath: root }).getExecution('e');
		assert.deepStrictEqual(loaded?.totals.tokens, { input: 10, output: 2 });
	});

	test('an attempt list pointing at another execution does not move its tokens', async () => {
		await store.recordExecution(execution({ executionId: 'owner' }));
		await store.recordAttempt(attempt({ executionId: 'owner', reportedTokens: { input: 100, output: 100 } }));
		await store.recordExecution(execution({ executionId: 'thief' }));

		// Hand-edited: `thief` claims the owner's attempt.
		const raw = JSON.parse(await readFile(join(root, CONSUMPTION_FILE), 'utf8')) as {
			executions: { executionId: string; attemptIds: string[] }[];
		};
		raw.executions.find((entry) => entry.executionId === 'thief')!.attemptIds = ['owner#1'];
		await writeFile(join(root, CONSUMPTION_FILE), JSON.stringify(raw), 'utf8');

		const thief = await new FileDataStore({ rootPath: root }).getExecution('thief');
		assert.strictEqual(thief?.totals.tokens, undefined);
		assert.strictEqual(thief?.totals.attempts, 0);
	});

	// Independence ............................................................

	test('writing the ledger leaves the model catalog and the catalog untouched by it', async () => {
		await store.saveModelCatalogEntry({ providerId: 'atria', modelId: 'modelo-a', access: 'paid' });
		await store.recordExecution(execution());
		await store.recordAttempt(attempt({ reportedTokens: { input: 1, output: 1 } }));

		const reopened = new FileDataStore({ rootPath: root });
		const entry = await reopened.getModelCatalogEntry({ providerId: 'atria', modelId: 'modelo-a' });
		assert.strictEqual(entry?.access, 'paid');
		assert.deepStrictEqual(entry?.observations, []);
	});
});
