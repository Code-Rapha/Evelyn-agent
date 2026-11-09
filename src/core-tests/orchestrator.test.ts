/** Tests for orchestration strategies. */

import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	createOrchestrationPlan,
	continueOrchestration,
	summarizeOrchestration,
	type OrchestrationAttempt,
	type OrchestrationResult,
	type OrchestrationStrategy,
} from '../desktop/orchestrator';
import type { TaskClassification } from '../desktop/taskDiscovery';
import type { AvailableModel } from '../desktop/contract';
import type { ModelCatalogEntry } from '../core/storage/types/modelCatalog';
import type { SelectableModel } from '../desktop/modelSelector';

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

const sampleAvailable: readonly AvailableModel[] = [
	{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-a' },
	{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-b' },
	{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-c' },
];

const sampleCatalog: readonly ModelCatalogEntry[] = [
	{
		providerId: 'provider-1',
		modelId: 'model-a',
		capabilities: ['coding', 'tools'],
		access: 'free',
		limits: { contextTokens: 32000 },
		pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
		observations: [],
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
	},
	{
		providerId: 'provider-1',
		modelId: 'model-b',
		capabilities: ['coding'],
		access: 'free',
		limits: { contextTokens: 32000 },
		pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
		observations: [],
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
	},
	{
		providerId: 'provider-1',
		modelId: 'model-c',
		capabilities: ['coding'],
		access: 'paid',
		limits: { contextTokens: 100000 },
		pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 10, output: 30 },
		observations: [],
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
	},
];

const primaryModel: SelectableModel = {
	providerId: 'provider-1',
	modelId: 'model-a',
	providerName: 'Provider One',
	catalog: sampleCatalog[0],
	available: true,
};

const fallbackModel1: SelectableModel = {
	providerId: 'provider-1',
	modelId: 'model-b',
	providerName: 'Provider One',
	catalog: sampleCatalog[1],
	available: true,
};

const fallbackModel2: SelectableModel = {
	providerId: 'provider-1',
	modelId: 'model-c',
	providerName: 'Provider One',
	catalog: sampleCatalog[2],
	available: true,
};

describe('orchestrator', () => {
	describe('createOrchestrationPlan', () => {
		it('creates plan with manual strategy respecting manual choice', () => {
			const plan = createOrchestrationPlan({
				strategy: 'manual',
				task: sampleTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				manualChoice: 'provider-1:model-a',
				maxAttempts: 3,
				allowPaid: false,
			});
			assert.ok(plan.primary !== undefined);
			assert.strictEqual(plan.primary?.modelId, 'model-a');
			assert.strictEqual(plan.candidates.length, 0);
		});

		it('creates plan with fallback strategy and candidates', () => {
			const plan = createOrchestrationPlan({
				strategy: 'fallback',
				task: sampleTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				maxAttempts: 3,
				allowPaid: false,
			});
			assert.ok(plan.primary !== undefined);
			assert.ok(plan.candidates.length > 0);
			assert.ok(plan.candidates.length <= 2);
		});

		it('limits candidates to maxAttempts - 1', () => {
			const plan = createOrchestrationPlan({
				strategy: 'fallback',
				task: sampleTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				maxAttempts: 3, // primary + 2 fallbacks max, but only 1 viable fallback exists (model-c is paid)
				allowPaid: false,
			});
			assert.strictEqual(plan.candidates.length, 1);
		});

		it('excludes paid models when allowPaid is false', () => {
			const plan = createOrchestrationPlan({
				strategy: 'fallback',
				task: sampleTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				maxAttempts: 3,
				allowPaid: false,
			});
			const allModels = [plan.primary, ...plan.candidates].filter((m): m is SelectableModel => m !== undefined);
			for (const m of allModels) {
				assert.ok(m.modelId !== 'model-c');
			}
		});

		it('includes paid models when allowPaid is true', () => {
			// Task where paid model's large context window wins
			// Use catalog where model-a has no observations
			const catalogNoObs: readonly ModelCatalogEntry[] = [
				{
					providerId: 'provider-1',
					modelId: 'model-a',
					capabilities: ['coding', 'tools'],
					access: 'free',
					limits: { contextTokens: 32000 },
					pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				},
				{
					providerId: 'provider-1',
					modelId: 'model-b',
					capabilities: ['coding'],
					access: 'free',
					limits: { contextTokens: 32000 },
					pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				},
				{
					providerId: 'provider-1',
					modelId: 'model-c',
					capabilities: ['coding', 'long-context'],
					access: 'paid',
					limits: { contextTokens: 100000 },
					pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 10, output: 30 },
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				},
			];
			const longContextTask = {
				...sampleTask,
				requiredCapabilities: ['long-context'],
				complexity: 'complex' as const,
				needsTools: false,
				domain: 'general' as const,
			};
			const plan = createOrchestrationPlan({
				strategy: 'fallback',
				task: longContextTask,
				availableModels: sampleAvailable,
				catalog: catalogNoObs,
				maxAttempts: 3,
				allowPaid: true,
			});
			const allModels = [plan.primary, ...plan.candidates].filter((m): m is SelectableModel => m !== undefined);
			const hasPaid = allModels.some((m) => m.modelId === 'model-c');
			assert.ok(hasPaid);
		});
	});

	describe('continueOrchestration', () => {
		const basePlan = {
			primary: primaryModel,
			candidates: [fallbackModel1, fallbackModel2],
		};

		it('stops for manual strategy', () => {
			const attempts: readonly OrchestrationAttempt[] = [
				{ attempt: 1, model: primaryModel, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
			];
			const result = continueOrchestration(basePlan, attempts, new Error('overloaded'), 3, 'manual');
			assert.ok(result.nextModel === undefined);
			assert.ok(!result.recoverable);
			assert.ok(result.reason.includes('Manual strategy'));
		});

		it('continues on recoverable error for fallback strategy', () => {
			const attempts: readonly OrchestrationAttempt[] = [
				{ attempt: 1, model: primaryModel, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
			];
			const result = continueOrchestration(basePlan, attempts, new Error('overloaded'), 3, 'fallback');
			assert.ok(result.nextModel !== undefined);
			assert.strictEqual(result.nextModel?.modelId, 'model-b');
			assert.ok(result.recoverable);
		});

		it('stops on non-recoverable error', () => {
			const attempts: readonly OrchestrationAttempt[] = [
				{ attempt: 1, model: primaryModel, error: new Error('401 Unauthorized'), recoverable: false, timestamp: '2024-01-01T00:00:00.000Z' },
			];
			const result = continueOrchestration(basePlan, attempts, new Error('401 Unauthorized'), 3, 'fallback');
			assert.ok(result.nextModel === undefined);
			assert.ok(!result.recoverable);
			assert.ok(result.reason.includes('Non-recoverable'));
		});

		it('stops when max attempts reached', () => {
			const attempts: readonly OrchestrationAttempt[] = [
				{ attempt: 1, model: primaryModel, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
				{ attempt: 2, model: fallbackModel1, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
			];
			const result = continueOrchestration(basePlan, attempts, new Error('overloaded'), 2, 'fallback');
			assert.ok(result.nextModel === undefined);
			assert.ok(result.reason.includes('Max attempts'));
		});

		it('stops when no more candidates', () => {
			const attempts: readonly OrchestrationAttempt[] = [
				{ attempt: 1, model: primaryModel, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
				{ attempt: 2, model: fallbackModel1, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
				{ attempt: 3, model: fallbackModel2, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
			];
			// Use maxAttempts=4 so we don't hit the max attempts limit first
			const result = continueOrchestration(basePlan, attempts, new Error('overloaded'), 4, 'fallback');
			assert.ok(result.nextModel === undefined);
			assert.ok(result.reason.includes('No more fallback candidates'));
		});

		it('stops when tool calls may have run (side effects)', () => {
			const attempts: readonly OrchestrationAttempt[] = [
				{ attempt: 1, model: primaryModel, error: new Error('overloaded during tool execution'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
			];
			const result = continueOrchestration(basePlan, attempts, new Error('overloaded during tool execution'), 3, 'fallback');
			assert.ok(result.nextModel === undefined);
			assert.ok(result.reason.includes('side effects'));
		});

		it('skips already tried models', () => {
			const attempts: readonly OrchestrationAttempt[] = [
				{ attempt: 1, model: primaryModel, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
				{ attempt: 2, model: fallbackModel1, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
			];
			const result = continueOrchestration(basePlan, attempts, new Error('overloaded'), 3, 'fallback');
			assert.ok(result.nextModel !== undefined);
			assert.strictEqual(result.nextModel?.modelId, 'model-c');
		});
	});

	describe('summarizeOrchestration', () => {
		it('summarizes successful orchestration', () => {
			const result: OrchestrationResult = {
				model: primaryModel,
				attempts: [{ attempt: 1, model: primaryModel, recoverable: false, timestamp: '2024-01-01T00:00:00.000Z' }],
				exhausted: false,
				strategy: 'fallback',
				summary: '',
			};
			const summary = summarizeOrchestration(result);
			assert.ok(summary.includes('strategy=fallback'));
			assert.ok(summary.includes('model=provider-1:model-a'));
			assert.ok(summary.includes('attempts=1'));
			assert.ok(summary.includes('result=success'));
		});

		it('summarizes exhausted orchestration', () => {
			const result: OrchestrationResult = {
				model: undefined,
				attempts: [
					{ attempt: 1, model: primaryModel, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
					{ attempt: 2, model: fallbackModel1, error: new Error('overloaded'), recoverable: true, timestamp: '2024-01-01T00:00:00.000Z' },
				],
				exhausted: true,
				strategy: 'fallback',
				summary: '',
			};
			const summary = summarizeOrchestration(result);
			assert.ok(summary.includes('exhausted'));
			assert.ok(summary.includes('attempts=2'));
		});
	});
});