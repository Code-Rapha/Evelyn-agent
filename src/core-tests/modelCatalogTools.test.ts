/** Testes das ferramentas com que a Evelyn consulta o catálogo de modelos. */

import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	MODEL_DETAILS,
	MODEL_LIST,
	MODEL_RECOMMEND,
	MODEL_REFRESH,
	MODEL_RESEARCH,
	MODEL_RESEARCH_SAVE,
	MODEL_CATALOG_TOOL_SPECS,
	createModelCatalogTools,
	type ModelSelectionPort,
	type ModelResearchPort,
} from '../core/agent/modelCatalogTools';
import type {
	DiscoveryRefreshResult,
	ModelDirectory,
	ModelRecord,
} from '../core/agent/modelCatalogPort';
import { classifyTask } from '../desktop/taskDiscovery';
import { selectModels, isPaidBlocked } from '../desktop/modelSelector';
import type { ModelCatalogEntry } from '../core/storage/types/modelCatalog';
import { confirmedResearch } from '../core/agent/modelResearch';

/**
 * A porta de pesquisa para os testes que não testam a pesquisa.
 *
 * Nenhum destes testes toca a rede: a pesquisa devolve `undefined`, que é o
 * "não há como pesquisar" do produto.
 */
const RESEARCH: ModelResearchPort = {
	research: async () => undefined,
	apply: async () => undefined,
};

/**
 * A porta de seleção, como o desktop a fornece.
 *
 * No produto isto mora em `chatSession.ts`; aqui é reconstruído com as mesmas
 * duas funções (`classifyTask`, `selectModels`) para provar que a ferramenta
 * não tem pontuação própria — se tivesse, o teste passaria com outra conta.
 */
const SELECTION: ModelSelectionPort = {
	classify: (text, overrides) => {
		const base = classifyTask(text);
		return {
			domain: overrides.domain ?? base.domain,
			complexity: overrides.complexity ?? base.complexity,
			needsTools: overrides.needsTools ?? base.needsTools,
			requiredCapabilities: overrides.requiredCapabilities ?? base.requiredCapabilities,
		};
	},
	recommend: ({ task, models, guidance, allowPaid, maxCandidates }) => {
		const catalog: ModelCatalogEntry[] = models.map((entry) => ({
			providerId: entry.providerName,
			modelId: entry.modelId,
			capabilities: [
				...(entry.capabilities?.toolCalling === true ? ['tools'] : []),
				...(entry.capabilities?.reasoning === true ? ['reasoning'] : []),
			],
			access: entry.access ?? 'unknown',
			...(entry.limits !== undefined ? { limits: entry.limits } : {}),
			observations: [],
			createdAt: '',
			updatedAt: '',
		}));
		const selection = selectModels({
			task: task as Parameters<typeof selectModels>[0]['task'],
			availableModels: models.map((entry) => ({
				providerId: entry.providerName,
				providerName: entry.providerName,
				model: entry.modelId,
			})),
			catalog,
			maxCandidates: maxCandidates + 1,
			allowPaid,
			...(guidance.length > 0 ? { guidance } : {}),
		});
		const blocked = new Set(
			catalog
				.filter((entry) =>
					isPaidBlocked(
						{
							providerId: entry.providerId,
							modelId: entry.modelId,
							providerName: entry.providerId,
							catalog: entry,
							available: true as const,
						},
						allowPaid,
					),
				)
				.map((entry) => `${entry.providerId}:${entry.modelId}`),
		);
		const withConstraints = (reason: (typeof selection.reasons)[number]) =>
			blocked.has(`${reason.providerId}:${reason.modelId}`) &&
			!(reason.constraints ?? []).some((constraint) => constraint.id === 'paid_not_allowed')
				? {
						...reason,
						constraints: [
							...(reason.constraints ?? []),
							{
								id: 'paid_not_allowed' as const,
								label: 'paid model, paid access not authorized',
								detail: 'this model is classified as paid and paid access is not authorized in this session',
							},
						],
					}
				: reason;
		const primaryReason = selection.reasons.find((reason) => reason.chosen);
		return {
			...(selection.primary !== undefined && primaryReason !== undefined
				? { primary: { providerName: selection.primary.providerId, modelId: selection.primary.modelId } }
				: {}),
			reasons: selection.reasons.map((reason) => {
				const explained = withConstraints(reason);
				return {
					providerName: explained.providerId,
					modelId: explained.modelId,
					chosen: explained.chosen,
					...(explained.score !== undefined ? { score: explained.score } : {}),
					reason: explained.reason,
					...(explained.components !== undefined
						? {
								components: explained.components.map((component) => ({
									id: component.id,
									points: component.points,
									detail: component.detail,
								})),
							}
						: {}),
					...(explained.constraints !== undefined && explained.constraints.length > 0
						? { excludedBecause: explained.constraints.map((item) => item.detail) }
						: {}),
					...(explained.confidence !== undefined && explained.confidence.length > 0
						? { confidence: explained.confidence.map((item) => item.detail) }
						: {}),
				};
			}),
		};
	},
};

const CONTEXT = { sessionId: 'turn-1' };

/** Um catálogo com os três casos que a tarefa precisa cobrir. */
const CATALOG: readonly ModelRecord[] = [
	{
		providerId: 'river',
		providerName: 'river',
		modelId: 'modelo-completo',
		available: true,
		access: 'paid',
		capabilities: { toolCalling: true, reasoning: true, structuredOutput: true },
		limits: { contextTokens: 200_000, maxOutputTokens: 8_192 },
		pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '1', output: '2', state: 'exact' },
		observations: 3,
		medianTotalMs: 2_000,
	},
	{
		// Só o nome: é o caso que a Evelyn encontrou na instalação real.
		providerId: 'river',
		providerName: 'river',
		modelId: 'modelo-sem-metadados',
		available: true,
	},
	{
		providerId: 'local',
		providerName: 'local',
		modelId: 'modelo-completo',
		available: false,
		access: 'free',
		capabilities: { toolCalling: true },
		policyReason: 'not_free',
	},
];

function directory(overrides: Partial<ModelDirectory> = {}): ModelDirectory & {
	readonly refreshes: (string | undefined)[];
} {
	const refreshes: (string | undefined)[] = [];
	const base: ModelDirectory = {
		list: async (options) =>
			options?.providerId !== undefined
				? CATALOG.filter((entry) => entry.providerName === options.providerId)
				: CATALOG,
		refreshDiscovery: async (providerId): Promise<DiscoveryRefreshResult> => {
			refreshes.push(providerId);
			return {
				providers: [
					{ providerId: 'river', ok: true, models: 2 },
					...(providerId === undefined
						? [{ providerId: 'local', ok: false, message: 'não respondeu' }]
						: []),
				],
			};
		},
		guidance: async () => [],
		allowPaid: async () => true,
	};
	const merged = { ...base, ...overrides };
	return Object.assign(merged, { refreshes });
}

function toolOf(created: ReturnType<typeof createModelCatalogTools>, name: string) {
	const found = created.find((entry) => entry.spec.name === name);
	assert.ok(found !== undefined, `a ferramenta ${name} existe`);
	return found.tool;
}

describe('modelCatalogTools', () => {
	describe('anúncio', () => {
		it('anuncia as ferramentas, com rede e gravação pedindo aprovação', () => {
			const names = MODEL_CATALOG_TOOL_SPECS.map((spec) => spec.name);
			assert.deepStrictEqual(names, [
				MODEL_LIST,
				MODEL_DETAILS,
				MODEL_REFRESH,
				MODEL_RECOMMEND,
				MODEL_RESEARCH,
				MODEL_RESEARCH_SAVE,
			]);
			// Leitura do catálogo não pergunta nada; tocar a rede de um
			// provedor, pesquisar e gravar, sim.
			for (const spec of MODEL_CATALOG_TOOL_SPECS) {
				assert.strictEqual(
					spec.riskLevel,
					spec.name === MODEL_REFRESH ||
						spec.name === MODEL_RESEARCH ||
						spec.name === MODEL_RESEARCH_SAVE
						? 'moderate'
						: 'safe',
					spec.name,
				);
			}
		});

		it('o descritor concorda com a spec', () => {
			for (const entry of createModelCatalogTools(directory(), SELECTION, RESEARCH)) {
				assert.strictEqual(entry.tool.descriptor.name, entry.spec.name);
				assert.strictEqual(entry.tool.descriptor.riskLevel, entry.spec.riskLevel);
			}
		});
	});

	describe('list_models', () => {
		it('lista todos os provedores e diz o que não sabe', async () => {
			const result = await toolOf(createModelCatalogTools(directory(), SELECTION, RESEARCH), MODEL_LIST).execute(
				{},
				CONTEXT,
			);
			assert.strictEqual(result.ok, true);
			const output = result.output as {
				count: number;
				providers: string[];
				models: { model: string; access?: unknown; pricing?: unknown; unknown: string[] }[];
			};
			assert.strictEqual(output.count, 3);
			assert.deepStrictEqual(output.providers.sort(), ['local', 'river']);

			const semMetadados = output.models.find((entry) => entry.model === 'modelo-sem-metadados');
			assert.deepStrictEqual(semMetadados?.unknown, [
				'access',
				'capabilities',
				'limits',
				'pricing',
				'observations',
			]);
			// Nada foi inventado: os campos ausentes não aparecem com valor.
			assert.strictEqual(semMetadados?.access, undefined);
			assert.strictEqual(semMetadados?.pricing, undefined);
		});

		it('filtra por provedor', async () => {
			const result = await toolOf(createModelCatalogTools(directory(), SELECTION, RESEARCH), MODEL_LIST).execute(
				{ providerId: 'local' },
				CONTEXT,
			);
			const output = result.output as { count: number };
			assert.strictEqual(output.count, 1);
		});

		it('distingue o modelo que o provedor não publica mais', async () => {
			const result = await toolOf(createModelCatalogTools(directory(), SELECTION, RESEARCH), MODEL_LIST).execute(
				{ providerId: 'local' },
				CONTEXT,
			);
			const model = (result.output as { models: { available: boolean }[] }).models[0];
			assert.strictEqual(model.available, false);
		});
	});

	describe('model_details', () => {
		it('devolve capacidades, contexto, preço e medidas quando existem', async () => {
			const result = await toolOf(createModelCatalogTools(directory(), SELECTION, RESEARCH), MODEL_DETAILS).execute(
				{ model: 'modelo-completo' },
				CONTEXT,
			);
			const output = result.output as {
				found: boolean;
				count: number;
				models: {
					capabilities: object;
					limits: object;
					pricing: object;
					observations: number;
				}[];
			};
			assert.strictEqual(output.found, true);
			assert.strictEqual(output.count, 2, 'o mesmo id em dois provedores é dito, não escolhido');
			assert.deepStrictEqual(output.models[0].capabilities, {
				toolCalling: true,
				reasoning: true,
				structuredOutput: true,
			});
			assert.deepStrictEqual(output.models[0].limits, {
				contextTokens: 200_000,
				maxOutputTokens: 8_192,
			});
			assert.strictEqual((output.models[0].pricing as { input: string }).input, '1');
			assert.strictEqual(output.models[0].observations, 3);
		});

		it('diz que não encontrou em vez de inventar', async () => {
			const result = await toolOf(createModelCatalogTools(directory(), SELECTION, RESEARCH), MODEL_DETAILS).execute(
				{ model: 'inexistente' },
				CONTEXT,
			);
			const output = result.output as { found: boolean };
			assert.strictEqual(output.found, false);
		});

		it('exige o id', async () => {
			const result = await toolOf(createModelCatalogTools(directory(), SELECTION, RESEARCH), MODEL_DETAILS).execute(
				{},
				CONTEXT,
			);
			assert.strictEqual(result.ok, false);
			assert.match(result.error ?? '', /needs a model id/);
		});
	});

	describe('refresh_models', () => {
		it('atualiza todos e relata quem falhou e por quê', async () => {
			const dir = directory();
			const result = await toolOf(createModelCatalogTools(dir, SELECTION, RESEARCH), MODEL_REFRESH).execute({}, CONTEXT);
			assert.strictEqual(result.ok, true);
			assert.deepStrictEqual(dir.refreshes, [undefined]);
			const providers = (result.output as DiscoveryRefreshResult).providers;
			assert.deepStrictEqual(
				providers.map((provider) => [provider.providerId, provider.ok]),
				[
					['river', true],
					['local', false],
				],
			);
			assert.strictEqual(providers[1].message, 'não respondeu');
		});

		it('atualiza um provedor só, quando pedido', async () => {
			const dir = directory();
			await toolOf(createModelCatalogTools(dir, SELECTION, RESEARCH), MODEL_REFRESH).execute(
				{ providerId: 'river' },
				CONTEXT,
			);
			assert.deepStrictEqual(dir.refreshes, ['river']);
		});
	});

	describe('recommend_model', () => {
		it('usa o seletor do motor e explica a conta', async () => {
			const result = await toolOf(createModelCatalogTools(directory(), SELECTION, RESEARCH), MODEL_RECOMMEND).execute(
				{ task: 'crie um arquivo com uma função de teste em TypeScript' },
				CONTEXT,
			);
			assert.strictEqual(result.ok, true);
			const output = result.output as {
				task: { needsTools: boolean; domain: string };
				recommended?: { model: string; score: number; components: { id: string }[] };
				alternatives: unknown[];
			};
			// A classificação é a do mesmo classificador do turno.
			assert.strictEqual(output.task.needsTools, true);
			assert.strictEqual(output.task.domain, 'coding');
			assert.ok(output.recommended !== undefined);
			assert.strictEqual(output.recommended.model, 'modelo-completo');
			assert.ok(output.recommended.components.some((component) => component.id === 'tools.supported'));
		});

		it('recomenda o gratuito e explica por que o pago ficou de fora', async () => {
			const dir = directory({ allowPaid: async () => false });
			const result = await toolOf(createModelCatalogTools(dir, SELECTION, RESEARCH), MODEL_RECOMMEND).execute(
				{ task: 'leia este arquivo e me diga o que ele faz' },
				CONTEXT,
			);
			const output = result.output as {
				recommended?: { provider: string; model: string };
				note?: string;
				alternatives: { excludedBecause?: string[]; model: string; provider: string }[];
			};
			// O gratuito é elegível e vence; o pago continua listado, com o motivo.
			assert.strictEqual(output.recommended?.provider, 'local');
			assert.strictEqual(output.recommended?.model, 'modelo-completo');
			assert.ok(
				output.alternatives.some(
					(entry) =>
						entry.provider === 'river' &&
						(entry.excludedBecause ?? []).some((reason) => /paid/i.test(reason)),
				),
				'o motivo do bloqueio do pago é dito',
			);
		});

		it('sem nenhum elegível, diz isso e explica cada candidato', async () => {
			// Só o pago existe: nada pode ser escolhido.
			const dir = directory({
				allowPaid: async () => false,
				list: async () => [
					{ providerId: 'river', providerName: 'river', modelId: 'apenas-pago', available: true, access: 'paid', capabilities: { toolCalling: true } },
				],
			});
			const result = await toolOf(createModelCatalogTools(dir, SELECTION, RESEARCH), MODEL_RECOMMEND).execute(
				{ task: 'leia este arquivo e me diga o que ele faz' },
				CONTEXT,
			);
			const output = result.output as {
				recommended?: unknown;
				note?: string;
				alternatives: { excludedBecause?: string[]; model: string }[];
			};
			assert.strictEqual(output.recommended, undefined);
			assert.match(output.note ?? '', /no eligible model/);
			assert.ok(
				output.alternatives.some((entry) =>
					(entry.excludedBecause ?? []).some((reason) => /paid/i.test(reason)),
				),
				'com a lista vazia, o motivo não apareceria',
			);
		});

		it('as preferências da Evelyn entram na conta', async () => {
			const dir = directory({
				list: async () => [
					{ providerId: 'river', providerName: 'river', modelId: 'a', available: true, capabilities: { toolCalling: true } },
					{ providerId: 'river', providerName: 'river', modelId: 'b', available: true, capabilities: { toolCalling: true } },
				],
				guidance: async () => [{ model: 'b', tools: true, value: 1 }],
			});
			const result = await toolOf(createModelCatalogTools(dir, SELECTION, RESEARCH), MODEL_RECOMMEND).execute(
				{ task: 'escreva a implementação de uma função e rode o teste' },
				CONTEXT,
			);
			const output = result.output as { recommended: { model: string; components: { id: string }[] } };
			assert.strictEqual(output.recommended.model, 'b');
			assert.ok(output.recommended.components.some((component) => component.id === 'evelyn.tools'));
		});
	});

	describe('pesquisa e confirmação', () => {
		const PESQUISA = [
			'- context | provider | 128000 | https://docs.river.ai/models | janela de 128k',
			'- tools | provider | sim | https://docs.river.ai/models | function calling',
			'- reasoning | secondary | sim | https://bench.example/alpha | melhor em lógica',
			'- price-input | estimated | 3 | sem-fonte | talvez uns 3 dólares',
		].join('\n');

		function researchPort(calls: string[]) {
			return {
				research: async (input: { providerId: string; modelId: string }) => {
					calls.push(`research:${input.providerId}/${input.modelId}`);
					return { answer: PESQUISA, query: `research ${input.modelId}` };
				},
				apply: async (input: {
					providerId: string;
					modelId: string;
					confirmed: ReturnType<typeof confirmedResearch>;
					sources?: readonly { url?: string }[];
				}) => {
					calls.push(`apply:${input.providerId}/${input.modelId}`);
				},
			};
		}

		it('research_model propõe e não grava', async () => {
			const calls: string[] = [];
			const tools = createModelCatalogTools(directory(), SELECTION, researchPort(calls));
			const result = await toolOf(tools, MODEL_RESEARCH).execute(
				{ model: 'modelo-sem-metadados' },
				CONTEXT,
			);
			assert.strictEqual(result.ok, true);
			const output = result.output as {
				proposals: {
					stored: boolean;
					research: {
						limits?: { contextTokens?: { level: string; value: number } };
						capabilities?: { toolCalling?: { level: string } };
						pricing?: { input?: { level: string } };
						sources: { url?: string }[];
					};
				}[];
			};
			assert.deepStrictEqual(calls, ['research:river/modelo-sem-metadados']);
			assert.strictEqual(output.proposals[0].stored, false);
			assert.strictEqual(output.proposals[0].research.limits?.contextTokens?.value, 128_000);
			assert.strictEqual(output.proposals[0].research.capabilities?.toolCalling?.level, 'provider');
			assert.strictEqual(output.proposals[0].research.pricing?.input?.level, 'estimated');
			assert.ok(output.proposals[0].research.sources.some((source) => source.url?.includes('docs.river.ai')));
		});

		it('research_model diz que não conseguiu, sem inventar', async () => {
			const tools = createModelCatalogTools(directory(), SELECTION, {
				research: async () => undefined,
				apply: async () => undefined,
			});
			const result = await toolOf(tools, MODEL_RESEARCH).execute(
				{ model: 'modelo-sem-metadados' },
				CONTEXT,
			);
			const output = result.output as { proposals: { research: unknown; note?: string }[] };
			assert.strictEqual(output.proposals[0].research, null);
			assert.match(output.proposals[0].note ?? '', /the fields stay unknown/);
		});

		it('save_researched_model grava o confirmado e recusa a estimativa', async () => {
			const calls: string[] = [];
			const applied: unknown[] = [];
			const tools = createModelCatalogTools(directory(), SELECTION, {
				research: async () => ({ answer: PESQUISA, query: 'q' }),
				apply: async (input) => {
					calls.push(`apply:${input.providerId}/${input.modelId}`);
					applied.push(input);
				},
			});
			const result = await toolOf(tools, MODEL_RESEARCH_SAVE).execute(
				{
					providerId: 'river',
					model: 'modelo-sem-metadados',
					answer: PESQUISA,
					fields: ['context', 'tools', 'price-input'],
				},
				CONTEXT,
			);
			assert.strictEqual(result.ok, true);
			const output = result.output as {
				saved: boolean;
				applied: string[];
				skipped: { field: string; reason: string }[];
			};
			assert.strictEqual(output.saved, true);
			assert.deepStrictEqual(calls, ['apply:river/modelo-sem-metadados']);
			assert.ok(output.applied.includes('context'));
			// O preço existia, mas só como estimativa: o que é dito ao usuário é
			// que o preço inteiro ficou de fora, porque não há moeda nem
			// unidade com fonte — e não que cada linha foi recusada.
			assert.ok(
				output.skipped.some(
					(entry) => entry.field === 'pricing' && /moeda e unidade/.test(entry.reason),
				),
			);
			const input = applied[0] as {
				confirmed: { limits?: { contextTokens?: number }; pricing?: unknown };
				sources?: readonly { url?: string }[];
			};
			assert.strictEqual(input.confirmed.limits?.contextTokens, 128_000);
			// Preço só existia como estimativa: não entrou.
			assert.strictEqual(input.confirmed.pricing, undefined);
			assert.ok((input.sources ?? []).some((source) => source.url?.includes('docs.river.ai')));
		});

		it('save_researched_model sem nada com fonte não grava', async () => {
			const calls: string[] = [];
			const tools = createModelCatalogTools(directory(), SELECTION, {
				research: async () => ({ answer: '', query: 'q' }),
				apply: async (input) => {
					calls.push('apply');
				},
			});
			const result = await toolOf(tools, MODEL_RESEARCH_SAVE).execute(
				{ providerId: 'river', model: 'x', answer: '- tools | estimated | sim | sem-fonte | achismo' },
				CONTEXT,
			);
			const output = result.output as { saved: boolean };
			assert.strictEqual(output.saved, false);
			assert.deepStrictEqual(calls, []);
		});
	});

	describe('falhas', () => {
		it('um diretório quebrado vira erro da ferramenta, não do turno', async () => {
			const dir = directory({
				list: async () => {
					throw new Error('catálogo indisponível');
				},
			});
			const result = await toolOf(createModelCatalogTools(dir, SELECTION, RESEARCH), MODEL_LIST).execute({}, CONTEXT);
			assert.strictEqual(result.ok, false);
			assert.strictEqual(result.error, 'catálogo indisponível');
		});
	});
});
