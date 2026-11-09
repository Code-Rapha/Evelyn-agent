/** Tests for orchestration log. */

import * as assert from 'assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { createOrchestrationLog, buildLogEntry, type OrchestrationLogEntry } from '../desktop/orchestrationLog';
import type { TaskClassification } from '../desktop/taskDiscovery';
import type { OrchestrationAttempt, OrchestrationStrategy } from '../desktop/orchestrator';
import type { SelectableModel } from '../desktop/modelSelector';

const testDir = join(tmpdir(), `modelhub-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const sampleTask: TaskClassification = {
	primaryGoal: 'Test task',
	domain: 'coding',
	complexity: 'simple',
	needsTools: true,
	requiredCapabilities: ['code-generation'],
	missingInformation: [],
	confidence: 0.8,
	rationale: 'test',
};

const sampleModel: SelectableModel = {
	providerId: 'provider-1',
	modelId: 'model-a',
	providerName: 'Provider One',
	catalog: undefined,
	available: true,
};

const sampleAttempts: readonly OrchestrationAttempt[] = [
	{ attempt: 1, model: sampleModel, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
	{ attempt: 2, model: sampleModel, recoverable: false, timestamp: '2024-01-01T00:00:01.000Z' },
];

describe('orchestrationLog', () => {
	let store: FileDataStore;
	let log: ReturnType<typeof createOrchestrationLog>;

	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		store = new FileDataStore({ rootPath: testDir });
		log = createOrchestrationLog(store);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it('appends and retrieves log entries', async () => {
		const entry = await log.append(
			buildLogEntry('conv-1', sampleTask, 'fallback', sampleModel, sampleAttempts, sampleModel, 'success'),
		);
		assert.ok(entry.id !== undefined);
		assert.strictEqual(entry.conversationId, 'conv-1');
		assert.strictEqual(entry.strategy, 'fallback');
		assert.strictEqual(entry.result, 'success');

		const entries = await log.list({ conversationId: 'conv-1' });
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].id, entry.id);
	});

	it('filters by conversationId', async () => {
		await log.append(buildLogEntry('conv-1', sampleTask, 'manual', sampleModel, sampleAttempts, sampleModel, 'success'));
		await log.append(buildLogEntry('conv-2', sampleTask, 'fallback', sampleModel, sampleAttempts, sampleModel, 'failed'));
		await log.append(buildLogEntry('conv-1', sampleTask, 'fallback', sampleModel, sampleAttempts, sampleModel, 'success'));

		const conv1 = await log.list({ conversationId: 'conv-1' });
		assert.strictEqual(conv1.length, 2);

		const conv2 = await log.list({ conversationId: 'conv-2' });
		assert.strictEqual(conv2.length, 1);
	});

	it('limits results', async () => {
		for (let i = 0; i < 10; i++) {
			await log.append(buildLogEntry(`conv-${i}`, sampleTask, 'manual', sampleModel, sampleAttempts, sampleModel, 'success'));
		}
		const limited = await log.list({ limit: 3 });
		assert.strictEqual(limited.length, 3);
	});

	it('clears all entries', async () => {
		await log.append(buildLogEntry('conv-1', sampleTask, 'manual', sampleModel, sampleAttempts, sampleModel, 'success'));
		await log.clear();
		const entries = await log.list();
		assert.strictEqual(entries.length, 0);
	});

	it('persists across instances', async () => {
		await log.append(buildLogEntry('conv-1', sampleTask, 'manual', sampleModel, sampleAttempts, sampleModel, 'success'));

		const log2 = createOrchestrationLog(store);
		const entries = await log2.list({ conversationId: 'conv-1' });
		assert.strictEqual(entries.length, 1);
	});

	it('buildLogEntry creates correct summary', () => {
		const entry = buildLogEntry(
			'conv-1',
			sampleTask,
			'fallback',
			sampleModel,
			sampleAttempts,
			sampleModel,
			'success',
		);
		assert.ok(entry.summary.includes('strategy=fallback'));
		assert.ok(entry.summary.includes('task=coding:simple'));
		assert.ok(entry.summary.includes('primary=provider-1:model-a'));
		assert.ok(entry.summary.includes('attempts=2'));
		assert.ok(entry.summary.includes('result=success'));
		assert.ok(entry.summary.includes('final=provider-1:model-a'));
	});

	it('handles missing primary/final models', () => {
		const entry = buildLogEntry(
			'conv-1',
			sampleTask,
			'manual',
			undefined,
			[],
			undefined,
			'failed',
		);
		assert.strictEqual(entry.primaryModel, undefined);
		assert.strictEqual(entry.finalModel, undefined);
		assert.ok(entry.summary.includes('primary=auto'));
		assert.ok(entry.summary.includes('final=none'));
	});

	it('bounds entries to MAX_ENTRIES', async () => {
		for (let i = 0; i < 10; i++) {
			await log.append(buildLogEntry(`conv-${i}`, sampleTask, 'manual', sampleModel, sampleAttempts, sampleModel, 'success'));
		}
		const entries = await log.list();
		assert.strictEqual(entries.length, 10);
	});
});