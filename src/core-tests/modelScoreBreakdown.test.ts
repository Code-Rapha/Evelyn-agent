/**
 * A explicação da pontuação, e a prova de que ela não mudou o roteador.
 *
 * ## A prova de não-mudança
 *
 * `referenceScore` é a **fórmula antiga**, copiada termo a termo. O teste
 * compara as duas numa bateria de combinações: a decomposição nova tem de
 * somar exatamente o mesmo número. Se alguém mexer na aritmética, este teste
 * falha — e a falha é o aviso.
 */
import * as assert from 'assert';

import {
	selectModels,
	type SelectableModel,
} from '../desktop/modelSelector';
import type { ModelCatalogEntry } from '../core/storage/types/modelCatalog';
import type { TaskClassification } from '../desktop/taskDiscovery';

const T0 = '2026-10-20T12:00:00.000Z';

/**
 * A fórmula que existia antes da decomposição.
 *
 * Copiada do seletor antigo, sem alterações. É a referência contra a qual a
 * nova é medida.
 */
function referenceScore(
	model: SelectableModel,
	task: TaskClassification,
	allowPaid: boolean,
): number {
	let score = 0;
	if (model.catalog === undefined) {
		return 1;
	}
	const cat = model.catalog;
	if (cat.access === 'paid' && !allowPaid) {
		score -= 100;
	} else if (cat.access === 'free') {
		score += 10;
	}
	if (cat.capabilities !== undefined) {
		for (const req of task.requiredCapabilities) {
			if (cat.capabilities.includes(req)) {
				score += 20;
			}
		}
		if (cat.capabilities.includes(task.domain)) {
			score += 15;
		}
	}
	if (task.needsTools) {
		const supportsTools = cat.capabilities?.includes('tools') ?? false;
		if (supportsTools) score += 15;
		else score -= 10;
	}
	if (task.requiredCapabilities.includes('long-context')) {
		if (cat.limits?.contextTokens !== undefined) {
			if (cat.limits.contextTokens >= 100_000) score += 20;
			else if (cat.limits.contextTokens >= 32_000) score += 10;
			else score -= 5;
		} else {
			score -= 5;
		}
	}
	if (cat.observations.length > 0) {
		score += Math.min(cat.observations.length * 2, 20);
		const medianTotal = cat.observations
			.map((o) => o.totalMs)
			.filter((v): v is number => v !== undefined)
			.sort((a, b) => a - b);
		if (medianTotal.length > 0) {
			const mid = medianTotal[Math.floor(medianTotal.length / 2)];
			if (mid < 5000) score += 10;
			else if (mid < 15000) score += 5;
			else if (mid > 60000) score -= 10;
		}
	}
	if (task.complexity === 'complex' && cat.capabilities?.includes('reasoning')) {
		score += 10;
	}
	return score;
}

function entry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
	return {
		providerId: 'p',
		modelId: 'm',
		access: 'unknown',
		observations: [],
		createdAt: T0,
		updatedAt: T0,
		...overrides,
	};
}

function model(catalog: ModelCatalogEntry | undefined): SelectableModel {
	return {
		providerId: 'p',
		modelId: 'm',
		providerName: 'P',
		catalog,
		available: true,
	};
}

function task(overrides: Partial<TaskClassification> = {}): TaskClassification {
	return {
		primaryGoal: 'fazer alguma coisa',
		domain: 'coding',
		complexity: 'simple',
		needsTools: false,
		requiredCapabilities: [],
		missingInformation: [],
		confidence: 0.5,
		rationale: 'teste',
		...overrides,
	};
}

/** Uma bateria de combinações, para a comparação com a fórmula antiga. */
const CASES: readonly {
	readonly name: string;
	readonly catalog: ModelCatalogEntry | undefined;
	readonly task: TaskClassification;
	readonly allowPaid: boolean;
}[] = [
	{ name: 'unknown model', catalog: undefined, task: task(), allowPaid: false },
	{ name: 'free model', catalog: entry({ access: 'free' }), task: task(), allowPaid: false },
	{
		name: 'paid model, not authorized',
		catalog: entry({ access: 'paid' }),
		task: task(),
		allowPaid: false,
	},
	{
		name: 'paid model, authorized',
		catalog: entry({ access: 'paid' }),
		task: task(),
		allowPaid: true,
	},
	{
		name: 'capabilities match',
		catalog: entry({ capabilities: ['coding', 'tools'] }),
		task: task({ requiredCapabilities: ['coding'] }),
		allowPaid: false,
	},
	{
		name: 'tool support present',
		catalog: entry({ capabilities: ['tools'] }),
		task: task({ needsTools: true }),
		allowPaid: false,
	},
	{
		name: 'tool support missing',
		catalog: entry({ capabilities: ['coding'] }),
		task: task({ needsTools: true }),
		allowPaid: false,
	},
	{
		name: 'tool support unknown',
		catalog: entry({ capabilities: ['coding'] }),
		task: task({ needsTools: true, requiredCapabilities: [] }),
		allowPaid: false,
	},
	{
		name: 'large context',
		catalog: entry({ limits: { contextTokens: 200000 } }),
		task: task({ requiredCapabilities: ['long-context'] }),
		allowPaid: false,
	},
	{
		name: 'medium context',
		catalog: entry({ limits: { contextTokens: 50000 } }),
		task: task({ requiredCapabilities: ['long-context'] }),
		allowPaid: false,
	},
	{
		name: 'small context',
		catalog: entry({ limits: { contextTokens: 8000 } }),
		task: task({ requiredCapabilities: ['long-context'] }),
		allowPaid: false,
	},
	{
		name: 'unknown context',
		catalog: entry(),
		task: task({ requiredCapabilities: ['long-context'] }),
		allowPaid: false,
	},
	{
		name: 'fast observations',
		catalog: entry({
			observations: [
				{ at: T0, totalMs: 1000 },
				{ at: T0, totalMs: 2000 },
			],
		}),
		task: task(),
		allowPaid: false,
	},
	{
		name: 'acceptable observations',
		catalog: entry({ observations: [{ at: T0, totalMs: 10000 }] }),
		task: task(),
		allowPaid: false,
	},
	{
		name: 'slow observations',
		catalog: entry({ observations: [{ at: T0, totalMs: 90000 }] }),
		task: task(),
		allowPaid: false,
	},
	{
		name: 'many observations',
		catalog: entry({
			observations: Array.from({ length: 30 }, () => ({ at: T0, totalMs: 1000 })),
		}),
		task: task(),
		allowPaid: false,
	},
	{
		name: 'complex task with reasoning',
		catalog: entry({ capabilities: ['reasoning'] }),
		task: task({ complexity: 'complex' }),
		allowPaid: false,
	},
	{
		name: 'complex task without reasoning',
		catalog: entry(),
		task: task({ complexity: 'complex' }),
		allowPaid: false,
	},
];

suite('Score: the decomposition does not change the arithmetic', () => {
	for (const testCase of CASES) {
		test(`the score is unchanged: ${testCase.name}`, () => {
			const selected = selectModels({
				task: testCase.task,
				availableModels: [
					{ providerId: 'p', providerName: 'P', model: 'm' },
				],
				catalog: testCase.catalog === undefined ? [] : [testCase.catalog],
				allowPaid: testCase.allowPaid,
			});
			const reason = selected.reasons[0];
			assert.ok(reason !== undefined);
			assert.strictEqual(
				reason.score,
				referenceScore(model(testCase.catalog), testCase.task, testCase.allowPaid),
				'the score is the same as before the decomposition',
			);
		});
	}

	test('the components add up to the score', () => {
		const selected = selectModels({
			task: task({ needsTools: true, requiredCapabilities: ['long-context'] }),
			availableModels: [{ providerId: 'p', providerName: 'P', model: 'm' }],
			catalog: [
				entry({
					access: 'free',
					capabilities: ['coding', 'tools'],
					limits: { contextTokens: 200000 },
					observations: [{ at: T0, totalMs: 1000 }],
				}),
			],
			allowPaid: false,
		});
		const reason = selected.reasons[0];
		assert.ok(reason !== undefined && reason.components !== undefined);
		const sum = reason.components.reduce((total, component) => total + component.points, 0);
		assert.strictEqual(sum, reason.score, 'a soma dos termos é o score');
	});

	test('the chosen model is still the one with the highest score', () => {
		const selected = selectModels({
			task: task(),
			availableModels: [
				{ providerId: 'p', providerName: 'P', model: 'melhor' },
				{ providerId: 'p', providerName: 'P', model: 'pior' },
			],
			catalog: [
				entry({ modelId: 'melhor', access: 'free' }),
				entry({ modelId: 'pior', access: 'paid' }),
			],
			allowPaid: false,
		});
		assert.strictEqual(selected.primary?.modelId, 'melhor');
	});});

suite('Score: what the decomposition says', () => {
	test('a free model gets the free component', () => {
		const selected = selectModels({
			task: task(),
			availableModels: [{ providerId: 'p', providerName: 'P', model: 'm' }],
			catalog: [entry({ access: 'free' })],
		});
		const component = selected.reasons[0]?.components?.find((c) => c.id === 'access.free');
		assert.strictEqual(component?.points, 10);
		assert.ok(component?.detail.length > 0);
	});

	test('a paid model without authorization carries the negative term', () => {
		const selected = selectModels({
			task: task(),
			availableModels: [{ providerId: 'p', providerName: 'P', model: 'm' }],
			catalog: [entry({ access: 'paid' })],
			allowPaid: false,
		});
		const component = selected.reasons[0]?.components?.find(
			(c) => c.id === 'access.paid_not_allowed',
		);
		assert.strictEqual(component?.points, -100);
	});

	test('a criterion that did not participate does not appear', () => {
		const selected = selectModels({
			task: task(),
			availableModels: [{ providerId: 'p', providerName: 'P', model: 'm' }],
			catalog: [entry({ access: 'free' })],
		});
		const ids = (selected.reasons[0]?.components ?? []).map((component) => component.id);
		assert.strictEqual(ids.includes('context.large'), false, 'a janela não participou');
		assert.strictEqual(ids.includes('tools.supported'), false, 'ferramentas não participaram');
		assert.strictEqual(ids.includes('latency.fast'), false, 'a latência não participou');
	});

	test('the constraint that removed a paid model is separate from the score', () => {
		const selected = selectModels({
			task: task(),
			availableModels: [{ providerId: 'p', providerName: 'P', model: 'm' }],
			catalog: [entry({ access: 'paid' })],
			allowPaid: false,
		});
		const reason = selected.reasons[0];
		assert.strictEqual(reason?.constraints?.[0]?.id, 'paid_not_allowed');
		// E o score continua sendo o score: a restrição não é um termo.
		assert.strictEqual(
			reason?.components?.some((component) => component.id === 'paid_not_allowed'),
			false,
		);
	});

	test('a candidate removed by a negative score says so', () => {
		const selected = selectModels({
			task: task({ needsTools: true }),
			availableModels: [
				{ providerId: 'p', providerName: 'P', model: 'sem-ferramentas' },
				{ providerId: 'p', providerName: 'P', model: 'com-ferramentas' },
			],
			catalog: [
				entry({ modelId: 'sem-ferramentas', capabilities: ['outro'] }),
				entry({ modelId: 'com-ferramentas', capabilities: ['coding', 'tools'] }),
			],
			allowPaid: false,
		});
		const removed = selected.reasons.find((reason) => reason.modelId === 'sem-ferramentas');
		assert.strictEqual(removed?.score, -10, 'a ausência de ferramentas custou dez pontos');
		assert.ok(
			removed?.constraints?.some((constraint) => constraint.id === 'negative_score'),
			'o candidato com score negativo foi eliminado pela restrição',
		);
	});
});

suite('Score: what was missing, and what it cost', () => {
	test('a model with no catalog entry is scored minimally and says so', () => {
		const selected = selectModels({
			task: task(),
			availableModels: [{ providerId: 'p', providerName: 'P', model: 'm' }],
			catalog: [],
		});
		const reason = selected.reasons[0];
		assert.strictEqual(reason?.score, 1);
		assert.ok(reason?.confidence?.some((item) => item.id === 'no_catalog_entry'));
	});

	test('a model with no task categories says the match could not be scored', () => {
		const selected = selectModels({
			task: task(),
			availableModels: [{ providerId: 'p', providerName: 'P', model: 'm' }],
			catalog: [entry({ access: 'free' })],
		});
		assert.ok(
			selected.reasons[0]?.confidence?.some((item) => item.id === 'capabilities_unknown'),
		);
	});

	test('a long-context task with no window says the window is unknown', () => {
		const selected = selectModels({
			task: task({ requiredCapabilities: ['long-context'] }),
			availableModels: [{ providerId: 'p', providerName: 'P', model: 'm' }],
			catalog: [entry({ access: 'free' })],
		});
		assert.ok(
			selected.reasons[0]?.confidence?.some((item) => item.id === 'context_unknown'),
		);
	});

	test('a model with no measured run says the latency term is absent', () => {
		const selected = selectModels({
			task: task(),
			availableModels: [{ providerId: 'p', providerName: 'P', model: 'm' }],
			catalog: [entry({ access: 'free' })],
		});
		assert.ok(
			selected.reasons[0]?.confidence?.some((item) => item.id === 'no_observations'),
		);
	});

	test('metadata that expired is reported as less informed', () => {
		const selected = selectModels({
			task: task(),
			availableModels: [{ providerId: 'p', providerName: 'P', model: 'm' }],
			catalog: [
				entry({
					access: 'free',
					metadata: { source: 'provider', stale: true, expiresAt: '2026-10-19T12:00:00.000Z' },
				}),
			],
		});
		const item = selected.reasons[0]?.confidence?.find((c) => c.id === 'metadata_stale');
		assert.ok(item !== undefined);
		assert.ok(item.detail.includes('2026-10-19'));
	});
});
