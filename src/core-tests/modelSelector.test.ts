/** Tests for model selection based on task and catalog. */

import * as assert from 'assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { selectModels, isRecoverableError, type ModelSelectorInput } from '../desktop/modelSelector';
import type { AvailableModel } from '../desktop/contract';
import type { ModelCatalogEntry } from '../core/storage/types/modelCatalog';

const sampleAvailable: readonly AvailableModel[] = [
	{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-a' },
	{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-b' },
	{ providerId: 'provider-2', providerName: 'Provider Two', model: 'model-c' },
];

const sampleCatalog: readonly ModelCatalogEntry[] = [
	{
		providerId: 'provider-1',
		modelId: 'model-a',
		capabilities: ['coding', 'tools', 'reasoning'],
		access: 'free',
		limits: { contextTokens: 128000, maxOutputTokens: 4096 },
		pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
		observations: [{ totalMs: 2000, at: '2024-01-01T00:00:00.000Z' }],
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
	},
	{
		providerId: 'provider-1',
		modelId: 'model-b',
		capabilities: ['coding', 'long-context'],
		access: 'free',
		limits: { contextTokens: 200000, maxOutputTokens: 8192 },
		pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
		observations: [],
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
	},
];

const codingTask = {
	primaryGoal: 'Create a function',
	domain: 'coding' as const,
	complexity: 'simple' as const,
	needsTools: true,
	requiredCapabilities: ['code-generation'],
	missingInformation: [],
	confidence: 0.8,
	rationale: 'test',
};

/**
 * A task a well-described paid model would score positively against.
 *
 * Every declared capability matches and the observation history is long enough
 * to clear the paid penalty, which is what makes it a real test of the paid
 * policy rather than of a low score.
 */
const paidBaitTask = {
	primaryGoal: 'Refactor a module',
	domain: 'coding' as const,
	complexity: 'complex' as const,
	needsTools: true,
	requiredCapabilities: ['code-generation', 'reasoning'],
	missingInformation: [],
	confidence: 0.8,
	rationale: 'test',
};

const paidBaitCatalog: readonly ModelCatalogEntry[] = [
	{
		providerId: 'provider-2',
		modelId: 'model-paid',
		capabilities: ['coding', 'code-generation', 'reasoning', 'tools'],
		access: 'paid',
		limits: { contextTokens: 200000, maxOutputTokens: 8192 },
		pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 10, output: 30 },
		observations: Array.from({ length: 10 }, (_, index) => ({
			totalMs: 1_000,
			at: `2024-01-${String((index % 9) + 1).padStart(2, '0')}T00:00:00.000Z`,
		})),
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
	},
];

describe('modelSelector', () => {
	describe('as preferências que a Evelyn registrou', () => {
		// model-c não tem catálogo: sem a opinião dela fica com a pontuação
		// mínima (1) e perde de model-a. Com a opinião dela, sobe bem acima.
		it('soma pontos onde o catálogo é mudo', () => {
			const semPreferencia = selectModels({
				task: codingTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				allowPaid: false,
			});
			assert.strictEqual(semPreferencia.primary?.modelId, 'model-a');
			const semCatalogo = semPreferencia.reasons.find((reason) => reason.modelId === 'model-c');
			assert.strictEqual(semCatalogo?.score, 1);

			const comPreferencia = selectModels({
				task: codingTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				allowPaid: false,
				guidance: [{ model: 'model-c', tools: true, value: 1 }],
			});
			const comCatalogo = comPreferencia.reasons.find((reason) => reason.modelId === 'model-c');
			assert.strictEqual(
				comCatalogo?.score,
				1 + 20 + 20,
				'ferramentas + custo-benefício (x4 num modelo sem catálogo)',
			);
			const ids = (comCatalogo?.components ?? []).map((component) => component.id);
			assert.ok(ids.includes('evelyn.tools'), 'o peso de ferramentas vem dela');
			assert.ok(ids.includes('evelyn.value'), 'o custo-benefício vem dela');
		});

		it('não decide por um modelo que ela desaconselhou para a tarefa', () => {
			// Tarefa que pede raciocínio: model-a declara a capacidade e vence.
			// A ressalva dela em raciocínio vale só em tarefa complexa, então a
			// tarefa é complexa; sem a ressalva, model-a continua na frente.
			const complexTask = {
				primaryGoal: codingTask.primaryGoal,
				domain: codingTask.domain,
				needsTools: codingTask.needsTools,
				missingInformation: [],
				confidence: codingTask.confidence,
				rationale: codingTask.rationale,
				complexity: 'complex' as const,
				requiredCapabilities: ['code-generation', 'reasoning'],
			};
			const semPreferencia = selectModels({
				task: complexTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				allowPaid: false,
			});
			assert.strictEqual(semPreferencia.primary?.modelId, 'model-a');

			const comPreferencia = selectModels({
				task: complexTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				allowPaid: false,
				guidance: [{ model: 'model-a', reasoning: false }],
			});
			const withGuidance = comPreferencia.reasons.find((reason) => reason.modelId === 'model-a');
			const without = semPreferencia.reasons.find((reason) => reason.modelId === 'model-a');
			// `complexity.reasoning` (10) existe nos dois; a ressalva da Evelyn
			// troca a ausência de termo por -10 em `evelyn.reasoning`, então
			// a pontuação com a ressalva é a de antes menos dez.
			assert.strictEqual(
				(withGuidance?.score ?? 0),
				(without?.score ?? 0) - 10,
				'a ressalva dela pesa contra a declaração do catálogo',
			);
			const ids = (withGuidance?.components ?? []).map((component) => component.id);
			assert.ok(ids.includes('evelyn.reasoning'));
		});

		it('um campo que ela não declarou não vira termo', () => {
			const result = selectModels({
				task: codingTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				allowPaid: false,
				guidance: [{ model: 'model-a', useFor: 'leitura de arquivos' }],
			});
			const chosen = result.reasons.find((reason) => reason.chosen);
			const ids = (chosen?.components ?? []).map((component) => component.id);
			assert.ok(!ids.some((id) => id.startsWith('evelyn.')), 'nada declarado, nada somado');
		});

		it('não contorna o bloqueio de modelo pago', () => {
			const result = selectModels({
				task: paidBaitTask,
				availableModels: [
					{ providerId: 'provider-2', providerName: 'Provider Two', model: 'model-paid' },
				],
				catalog: paidBaitCatalog,
				allowPaid: false,
				guidance: [{ model: 'model-paid', tools: true, value: 1 }],
			});
			assert.strictEqual(result.primary, undefined);
			assert.ok(
				(result.reasons[0].constraints ?? []).some((item) => item.id === 'paid_not_allowed'),
			);
		});
	});

	describe('selectModels', () => {
		it('respects manual choice when available', () => {
			const input: ModelSelectorInput = {
				task: codingTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				manualChoice: 'provider-1:model-a',
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.ok(result.primary !== undefined);
			assert.strictEqual(result.primary?.providerId, 'provider-1');
			assert.strictEqual(result.primary?.modelId, 'model-a');
			assert.strictEqual(result.fallbacks.length, 0);
			assert.ok(result.reasons[0].chosen);
		});

		it('falls back to automatic selection when manual choice unavailable', () => {
			const input: ModelSelectorInput = {
				task: codingTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				manualChoice: 'provider-99:model-x',
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.ok(result.primary !== undefined);
			assert.strictEqual(result.primary?.modelId, 'model-a');
		});

		it('selects best match for coding task with tools', () => {
			const input: ModelSelectorInput = {
				task: codingTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.ok(result.primary !== undefined);
			assert.strictEqual(result.primary?.modelId, 'model-a');
		});

		it('excludes paid models when allowPaid is false', () => {
			const input: ModelSelectorInput = {
				task: codingTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.strictEqual(result.primary?.modelId, 'model-a');
		});

		it('includes paid models when allowPaid is true and they score higher', () => {
			// Long-context task without tool needs, where model-b's huge context window wins
			// Give model-a a smaller context window so it scores lower on long-context
			const catalogNoObs: readonly ModelCatalogEntry[] = [
				{
					providerId: 'provider-1',
					modelId: 'model-a',
					capabilities: ['coding', 'tools', 'reasoning'],
					access: 'free',
					limits: { contextTokens: 32000, maxOutputTokens: 4096 },
					pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				},
				{
					providerId: 'provider-1',
					modelId: 'model-b',
					capabilities: ['coding', 'long-context'],
					access: 'paid',
					limits: { contextTokens: 200000, maxOutputTokens: 8192 },
					pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 10, output: 30 },
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				},
			];
			const longContextTask = {
				...codingTask,
				requiredCapabilities: ['long-context'],
				complexity: 'complex' as const,
				needsTools: false,
				domain: 'general' as const,
			};
			const input: ModelSelectorInput = {
				task: longContextTask,
				availableModels: sampleAvailable,
				catalog: catalogNoObs,
				maxCandidates: 3,
				allowPaid: true,
			};
			const result = selectModels(input);
			assert.strictEqual(result.primary?.modelId, 'model-b');
		});

		it('handles unknown models (no catalog entry)', () => {
			const input: ModelSelectorInput = {
				task: codingTask,
				availableModels: [
					{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-a' },
					{ providerId: 'provider-2', providerName: 'Provider Two', model: 'model-unknown' },
				],
				catalog: sampleCatalog,
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.ok(result.primary !== undefined);
			assert.strictEqual(result.primary?.modelId, 'model-a');
		});

		it('returns fallbacks ordered by score', () => {
			const input: ModelSelectorInput = {
				task: codingTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.ok(result.primary !== undefined);
			// With allowPaid=false, model-c (paid) is excluded, so fallback is model-b
			assert.strictEqual(result.fallbacks[0].modelId, 'model-b');
		});

		it('limits number of fallback candidates', () => {
			const input: ModelSelectorInput = {
				task: codingTask,
				availableModels: sampleAvailable,
				catalog: sampleCatalog,
				maxCandidates: 2, // primary + 1 fallback
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.strictEqual(result.fallbacks.length, 1);
		});

		it('keeps a high-scoring paid model out when paid access is not authorized', () => {
			// The defect this pins: the paid penalty was a score, and a paid
			// model with enough declared capabilities cleared zero on its own,
			// so it was still chosen as the primary. The exclusion is now
			// structural, so the unknown model wins despite scoring lower.
			const input: ModelSelectorInput = {
				task: paidBaitTask,
				availableModels: [
					{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-unknown' },
					{ providerId: 'provider-2', providerName: 'Provider Two', model: 'model-paid' },
				],
				catalog: paidBaitCatalog,
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.strictEqual(result.primary?.modelId, 'model-unknown');
			assert.strictEqual(
				result.reasons.some((reason) => reason.modelId === 'model-paid' && reason.chosen),
				false,
			);
		});

		it('never offers a paid model as a fallback', () => {
			const input: ModelSelectorInput = {
				task: paidBaitTask,
				availableModels: [
					{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-free' },
					{ providerId: 'provider-2', providerName: 'Provider Two', model: 'model-paid' },
				],
				catalog: [
					{
						providerId: 'provider-1',
						modelId: 'model-free',
						capabilities: ['coding'],
						access: 'free',
						observations: [],
						createdAt: '2024-01-01T00:00:00.000Z',
						updatedAt: '2024-01-01T00:00:00.000Z',
					},
					...paidBaitCatalog,
				],
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.strictEqual(result.primary?.modelId, 'model-free');
			assert.deepStrictEqual(
				result.fallbacks.map((fallback) => fallback.modelId),
				[],
				'a paid candidate cannot be reached through the fallback list',
			);
		});

		it('includes the same paid model once paid access is authorized', () => {
			const input: ModelSelectorInput = {
				task: paidBaitTask,
				availableModels: [
					{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-unknown' },
					{ providerId: 'provider-2', providerName: 'Provider Two', model: 'model-paid' },
				],
				catalog: paidBaitCatalog,
				maxCandidates: 3,
				allowPaid: true,
			};
			const result = selectModels(input);
			assert.strictEqual(result.primary?.modelId, 'model-paid');
		});

		it('refuses a manual paid model while paid access is unauthorized', () => {
			// Naming a paid model states a preference for it, not a budget. The
			// defect this pins: a manual pick used to bypass the paid policy
			// entirely, so clicking a paid model was silently an authorization to
			// spend. It is now refused, and refused rather than swapped.
			const input: ModelSelectorInput = {
				task: paidBaitTask,
				availableModels: [
					{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-unknown' },
					{ providerId: 'provider-2', providerName: 'Provider Two', model: 'model-paid' },
				],
				catalog: paidBaitCatalog,
				manualChoice: 'provider-2:model-paid',
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.strictEqual(result.primary, undefined, 'the paid pick is not authorized');
			assert.deepStrictEqual(
				result.fallbacks,
				[],
				'another model is not silently substituted for the one asked for',
			);
			assert.strictEqual(result.reasons.length, 1);
			assert.strictEqual(result.reasons[0].modelId, 'model-paid');
			assert.strictEqual(result.reasons[0].chosen, false);
			assert.ok(
				result.reasons[0].reason.includes('paid'),
				'the reason names the paid policy, not a capability mismatch',
			);
		});

		it('honors a manual paid model once paid access is authorized', () => {
			const input: ModelSelectorInput = {
				task: paidBaitTask,
				availableModels: [
					{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-unknown' },
					{ providerId: 'provider-2', providerName: 'Provider Two', model: 'model-paid' },
				],
				catalog: paidBaitCatalog,
				manualChoice: 'provider-2:model-paid',
				maxCandidates: 3,
				allowPaid: true,
			};
			const result = selectModels(input);
			assert.strictEqual(result.primary?.modelId, 'model-paid');
			assert.strictEqual(result.fallbacks.length, 0);
		});

		it('honors a manual choice of an unclassified model without an authorization', () => {
			// `unknown` is not evidence of a charge, so the preference stands and
			// no authorization is asked for. Blocking it would make every model
			// the user has not described unusable.
			const input: ModelSelectorInput = {
				task: paidBaitTask,
				availableModels: [
					{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-unknown' },
					{ providerId: 'provider-2', providerName: 'Provider Two', model: 'model-paid' },
				],
				catalog: paidBaitCatalog,
				manualChoice: 'provider-1:model-unknown',
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.strictEqual(result.primary?.modelId, 'model-unknown');
		});

		it('does not credit an unknown access as free', () => {
			// "Not known" must not become "free": an unknown entry is eligible
			// but carries no bonus, so the identical free model outranks it.
			const capabilities = ['coding'];
			const entries: readonly ModelCatalogEntry[] = [
				{
					providerId: 'provider-1',
					modelId: 'model-unknown-access',
					capabilities,
					access: 'unknown',
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				},
				{
					providerId: 'provider-1',
					modelId: 'model-free',
					capabilities,
					access: 'free',
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				},
			];
			const result = selectModels({
				task: { ...paidBaitTask, needsTools: false },
				availableModels: [
					{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-unknown-access' },
					{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-free' },
				],
				catalog: entries,
				maxCandidates: 3,
				allowPaid: false,
			});
			assert.strictEqual(result.primary?.modelId, 'model-free');
		});

		it('returns no primary when no viable models', () => {
			const paidOnlyCatalog: readonly ModelCatalogEntry[] = [
				{
					providerId: 'provider-1',
					modelId: 'model-a',
					capabilities: ['coding'],
					access: 'paid',
					limits: {},
					pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 10, output: 30 },
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				},
			];
			const input: ModelSelectorInput = {
				task: codingTask,
				availableModels: [{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-a' }],
				catalog: paidOnlyCatalog,
				maxCandidates: 3,
				allowPaid: false,
			};
			const result = selectModels(input);
			assert.ok(result.primary === undefined);
		});
	});

	// Metadata never authorises spending.
	//
	// A price is evidence, and evidence is exactly what a reader might mistake
	// for permission. These cases fix the boundary: whatever the metadata says,
	// `access: 'paid'` is refused while `allowPaid` is false, and a cheap or
	// free-looking price does not stand in for the missing authorisation.

	describe('metadata versus the paid rule', () => {
		const freePrice = {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: 0,
			output: 0,
			source: 'provider',
		} as const;

		function only(model: ModelCatalogEntry): readonly ModelCatalogEntry[] {
			return [model];
		}

		it('a paid model with a zero price is still refused', () => {
			const result = selectModels({
				task: codingTask,
				availableModels: [{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-a' }],
				catalog: only({
					providerId: 'provider-1',
					modelId: 'model-a',
					capabilities: ['coding'],
					access: 'paid',
					pricing: freePrice,
					limits: { contextTokens: 200_000 },
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				}),
				maxCandidates: 3,
				allowPaid: false,
			});
			assert.strictEqual(result.primary, undefined);
		});

		it('a paid model with no price at all is still refused', () => {
			const result = selectModels({
				task: codingTask,
				availableModels: [{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-a' }],
				catalog: only({
					providerId: 'provider-1',
					modelId: 'model-a',
					capabilities: ['coding'],
					access: 'paid',
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				}),
				maxCandidates: 3,
				allowPaid: false,
			});
			assert.strictEqual(result.primary, undefined);
		});

		it('a free price does not classify an unknown-access model as free', () => {
			// The price is evidence about cost, not a statement about access.
			// This case pins the safer behaviour: `unknown` is not blocked, but
			// the metadata cannot be used to claim it *was* classified.
			const result = selectModels({
				task: codingTask,
				availableModels: [{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-a' }],
				catalog: only({
					providerId: 'provider-1',
					modelId: 'model-a',
					capabilities: ['coding'],
					access: 'unknown',
					pricing: freePrice,
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				}),
				maxCandidates: 3,
				allowPaid: false,
			});
			// Unchanged from before this step: unknown access is not a block.
			assert.strictEqual(result.primary?.modelId, 'model-a');
		});

		it('a metadata bundle cannot flip access, so the paid block survives it', async () => {
			// The store is the only writer, and `applyModelMetadata` never touches
			// `access`. If that ever changes, a provider listing could unlock a
			// paid model without the user saying so.
			const root = await mkdtemp(join(tmpdir(), 'seshyina-paid-'));
			try {
				const store = new FileDataStore({ rootPath: root });
				await store.saveModelCatalogEntry({
					providerId: 'provider-1',
					modelId: 'model-a',
					access: 'paid',
					pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 10, output: 30, source: 'manual' },
				});
				await store.applyModelMetadata(
					{ providerId: 'provider-1', modelId: 'model-a' },
					{ source: 'provider', pricing: freePrice, model: { toolCalling: true } },
				);

				const [entry] = await store.listModelCatalog({ providerId: 'provider-1' });
				assert.strictEqual(entry.access, 'paid', 'metadata never rewrites the access classification');

				const result = selectModels({
					task: codingTask,
					availableModels: [{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-a' }],
					catalog: [entry],
					maxCandidates: 3,
					allowPaid: false,
				});
				assert.strictEqual(result.primary, undefined);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it('a manual choice of a paid model is still refused while allowPaid is false', () => {
			const result = selectModels({
				task: codingTask,
				availableModels: [{ providerId: 'provider-1', providerName: 'Provider One', model: 'model-a' }],
				catalog: only({
					providerId: 'provider-1',
					modelId: 'model-a',
					access: 'paid',
					pricing: freePrice,
					limits: { contextTokens: 200_000 },
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				}),
				manualChoice: 'provider-1:model-a',
				maxCandidates: 3,
				allowPaid: false,
			});
			assert.strictEqual(result.primary, undefined);
		});
	});

	describe('isRecoverableError', () => {
		it('returns true for overloaded errors', () => {
			assert.ok(isRecoverableError(new Error('Service overloaded')));
			assert.ok(isRecoverableError(new Error('Model overloaded')));
		});

		it('returns true for rate limit errors', () => {
			assert.ok(isRecoverableError(new Error('Rate limit exceeded')));
		});

		it('returns true for timeout errors', () => {
			assert.ok(isRecoverableError(new Error('Request timeout')));
			assert.ok(isRecoverableError(new Error('Gateway timeout')));
		});

		it('returns true for temporary unavailable', () => {
			assert.ok(isRecoverableError(new Error('Service temporarily unavailable')));
			assert.ok(isRecoverableError(new Error('503 Service Unavailable')));
		});

		it('returns true for 502/504', () => {
			assert.ok(isRecoverableError(new Error('502 Bad Gateway')));
			assert.ok(isRecoverableError(new Error('504 Gateway Timeout')));
		});

		it('returns false for auth errors', () => {
			assert.ok(!isRecoverableError(new Error('401 Unauthorized')));
			assert.ok(!isRecoverableError(new Error('Invalid API key')));
		});

		it('returns false for 403/400/404', () => {
			assert.ok(!isRecoverableError(new Error('403 Forbidden')));
			assert.ok(!isRecoverableError(new Error('400 Bad Request')));
			assert.ok(!isRecoverableError(new Error('404 Not Found')));
		});

		it('returns false for context length errors', () => {
			assert.ok(!isRecoverableError(new Error('Context length exceeded')));
			assert.ok(!isRecoverableError(new Error('Max tokens exceeded')));
		});

		it('returns false for cancellation', () => {
			assert.ok(!isRecoverableError(new Error('Aborted')));
			assert.ok(!isRecoverableError(new Error('Cancelled')));
		});

		it('returns false for non-Error values', () => {
			assert.ok(!isRecoverableError('string error'));
			assert.ok(!isRecoverableError(null));
			assert.ok(!isRecoverableError(undefined));
			assert.ok(!isRecoverableError({}));
		});
	});
});