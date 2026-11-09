/**
 * As ferramentas com que a Evelyn consulta o catálogo de modelos.
 *
 * ## Por que um módulo, e não um comando
 *
 * A lista de modelos vive fora do repositório — em `models.json`,
 * `provider-models.json` e no que o serviço expõe — e chegar até ela por
 * `run_command` ou `read_file` exigiria um workspace, uma permissão perigosa e
 * um caminho que o usuário teria de conhecer. Aqui a leitura é uma **chamada de
 * ferramenta**: sem terminal, sem trava de repositório e sem caminho.
 *
 * ## O que estas ferramentas não fazem
 *
 * Não montam catálogo próprio. Toda leitura passa pelo `ModelDirectory`, e toda
 * recomendação passa pelo **seletor que o turno usa** — recebido como `port`,
 * e não reimportado: o Core não pode conhecer o host (`desktopBoundary`), e a
 * seleção mora nele. Uma segunda regra de escolha seria uma segunda resposta
 * para a mesma pergunta.
 *
 * ## O que nunca sai daqui
 *
 * Chave, token ou credencial. O adaptador é construído pelo host e só recebe
 * metadados: o `ModelDirectory` não tem acesso a `secrets.json` nem à
 * configuração de provedores, então uma ferramenta não pode vazar o que não
 * alcança.
 */
import type { AgentTool, ToolDescriptor, ToolResult } from './types';
import type { ToolSpec } from './toolRegistry';
import type {
	DiscoveryRefreshResult,
	ModelDirectory,
	ModelRecord,
} from './modelCatalogPort';
import {
	confirmedResearch,
	parseResearch,
	proposeResearch,
	sourcesOf,
	type ResearchSource,
} from './modelResearch';
import { RESEARCH_FORMAT } from './modelResearch';

/**
 * O que só o host sabe: classificar a tarefa e escolher o modelo.
 *
 * Declarado como função, e não como import, porque as duas coisas moram em
 * `src/desktop/` — e o Core não pode depender do host. O host injeta as suas.
 */
export interface ModelSelectionPort {
	/**
	 * Classifica a tarefa exatamente como um turno faria.
	 *
	 * Devolve o `TaskClassification` do host, sem o Core conhecer o tipo: o que
	 * a recomendação relata (`domain`, `complexity`, `needsTools`,
	 * `requiredCapabilities`) é lido daqui.
	 */
	classify(
		text: string,
		overrides: {
			readonly domain?: string;
			readonly complexity?: string;
			readonly needsTools?: boolean;
			readonly requiredCapabilities?: readonly string[];
		},
	): {
		readonly domain: string;
		readonly complexity: string;
		readonly needsTools: boolean;
		readonly requiredCapabilities: readonly string[];
	};
	/**
	 * Escolhe os modelos, com a **mesma** pontuação do roteador.
	 *
	 * Recebe o catálogo já no formato neutro e devolve os motivos; o Core não
	 * reimplementa a conta, só a apresenta.
	 */
	recommend(input: {
		readonly task: unknown;
		readonly models: readonly ModelRecord[];
		readonly guidance: readonly { readonly model: string }[];
		readonly allowPaid: boolean;
		readonly maxCandidates: number;
	}): {
		readonly primary?: {
			readonly providerName: string;
			readonly modelId: string;
		};
		readonly reasons: readonly {
			readonly providerName: string;
			readonly modelId: string;
			readonly chosen: boolean;
			readonly score?: number;
			readonly reason: string;
			readonly components?: readonly {
				readonly id: string;
				readonly points: number;
				readonly detail: string;
			}[];
			readonly excludedBecause?: readonly string[];
			readonly confidence?: readonly string[];
		}[];
	};
}

/**
 * O que uma pesquisa autônoma devolveu, além do texto.
 *
 * O texto é a conclusão; estes campos são o que a ferramenta precisa para dizer
 * ao usuário **o que foi de fato aberto** e se o ciclo parou por teto. Um
 * relatório sem isto seria uma conclusão sem lastro.
 */
export interface ResearchRunReport {
	/** Quantos ciclos (rodadas de ferramenta) o loop usou. */
	readonly cycles: number;
	/** As páginas e buscas realmente executadas, na ordem. */
	readonly visited: readonly {
		readonly tool: 'web_search' | 'open_webpage' | 'browse_web';
		readonly target: string;
		readonly ok: boolean;
	}[];
	/** Por que o ciclo parou. */
	readonly stopped: 'answered' | 'cycle-limit' | 'page-limit' | 'error' | 'aborted';
	/** O que o modelo escreveu no fim. */
	readonly conclusion: string;
}

/**
 * O que só o host sabe: pesquisar na web e gravar no catálogo.
 *
 * A busca de fato depende do provedor configurado e do `fetch` do host — e o
 * Core não pode conhecer o host nem a rede. A ferramenta descreve **o que**
 * perguntar; o host decide **como** perguntar.
 */
export interface ModelResearchPort {
	/**
	 * Pesquisa na web o que se sabe de um modelo e devolve a proposta.
	 *
	 * `undefined` quando não há como pesquisar (nenhum provedor utilizável):
	 * nesse caso a ferramenta diz que não conseguiu, e o campo continua
	 * desconhecido — nunca vira "pesquisado e não tem".
	 */
	research(input: {
		readonly providerId: string;
		readonly modelId: string;
		/**
		 * Um objetivo livre, quando a pesquisa é exploratória.
		 *
		 * É o caso de "encontre modelos gratuitos para programação": o
		 * resultado não é o formulário de um modelo conhecido, é uma conclusão
		 * com alternativas, fontes e como conectar cada provedor.
		 */
		readonly goal?: string;
	}): Promise<{
		/** O texto cru da pesquisa, para o relatório guardar o que se leu. */
		readonly answer: string;
		/** A consulta feita. */
		readonly query: string;
		/** O que o ciclo realmente fez, quando foi autônomo. */
		readonly run?: ResearchRunReport;
	} | undefined>;
	/**
	 * Grava no catálogo o que o usuário confirmou.
	 *
	 * Chamado **depois** da aprovação do cartão de permissão — é a própria
	 * ferramenta que só chega aqui quando o usuário diz sim.
	 */
	apply(input: {
		readonly providerId: string;
		readonly modelId: string;
		readonly confirmed: ReturnType<typeof confirmedResearch>;
		readonly notes?: string;
		/**
		 * As fontes distintas que sustentam os campos gravados.
		 *
		 * Vão para a nota do catálogo: uma capacidade gravada ontem para de ser
		 * "um número qualquer" e passa a ter de onde ser conferida.
		 */
		readonly sources?: readonly ResearchSource[];
	}): Promise<void>;
}

export const MODEL_LIST = 'list_models';
export const MODEL_DETAILS = 'model_details';
export const MODEL_REFRESH = 'refresh_models';
export const MODEL_RECOMMEND = 'recommend_model';
export const MODEL_RESEARCH = 'research_model';
/**
 * A gravação do que foi pesquisado.
 *
 * Ferramenta separada da pesquisa de propósito: pesquisar é ler (e pode ser
 * recusada sem prejuízo), gravar é escrever no catálogo. Separá-las faz o
 * cartão de permissão da gravação aparecer **depois** de o usuário ter visto
 * as fontes — que é exatamente o que a confirmação exige.
 */
export const MODEL_RESEARCH_SAVE = 'save_researched_model';

/** O que a ferramenta não sabia, e disse que não sabia. */
function unknownFields(record: ModelRecord): readonly string[] {
	const missing: string[] = [];
	if (record.access === undefined) {missing.push('access');}
	if (record.capabilities === undefined) {missing.push('capabilities');}
	if (record.limits === undefined) {missing.push('limits');}
	if (record.pricing === undefined) {missing.push('pricing');}
	if (record.observations === undefined) {missing.push('observations');}
	return missing;
}

/** Um resumo curto de cada modelo, para a lista. */
function summarize(record: ModelRecord): Record<string, unknown> {
	return {
		provider: record.providerName,
		model: record.modelId,
		// Ausente e `false` são coisas diferentes: "não publica agora" é uma
		// resposta, "não se sabe" é outra.
		available: record.available,
		access: record.access,
		capabilities: record.capabilities,
		limits: record.limits,
		pricing: record.pricing,
		unknown: unknownFields(record),
		...(record.policyReason !== undefined ? { notEligibleBecause: record.policyReason } : {}),
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function optionalString(input: unknown, key: string): string | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const value = (input as Record<string, unknown>)[key];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

const DOMAINS = [
	'coding',
	'file-analysis',
	'blender',
	'api-design',
	'database',
	'networking',
	'general',
	'unknown',
] as const;

const COMPLEXITIES = ['trivial', 'simple', 'moderate', 'complex', 'unknown'] as const;

const SPECS: readonly ToolSpec[] = [
	{
		name: MODEL_LIST,
		description:
			'List every model known to the app, with provider, availability, access, capabilities, ' +
			'context window, price and limits. Fields the catalog does not know are listed under ' +
			"'unknown' instead of being guessed. Optionally filter by providerId.",
		parameters: {
			type: 'object',
			properties: {
				providerId: {
					type: 'string',
					description: 'Only models from this provider. Omit for all providers.',
				},
			},
		},
		riskLevel: 'safe',
		category: 'other',
	},
	{
		name: MODEL_DETAILS,
		description:
			"Everything known about one model: capabilities, context window, max output, price, " +
			"access, measured latency and observations. Missing facts are returned under 'unknown'.",
		parameters: {
			type: 'object',
			properties: {
				model: { type: 'string', description: 'The model id, exactly as listed' },
				providerId: { type: 'string', description: 'Provider, when two providers serve the same id' },
			},
			required: ['model'],
		},
		riskLevel: 'safe',
		category: 'other',
	},
	{
		name: MODEL_REFRESH,
		description:
			'Ask the provider(s) for the current model list and update what the app knows. ' +
			'Returns, per provider, how many models were published or why the request failed.',
		parameters: {
			type: 'object',
			properties: {
				providerId: { type: 'string', description: 'Refresh only this provider. Omit for all enabled ones.' },
			},
		},
		// Consulta a rede de um provedor que o usuário já configurou e grava o
		// resultado no catálogo: não é leitura pura, mas também não escreve
		// nada do usuário — por isso pede aprovação em vez de ser automática.
		riskLevel: 'moderate',
		category: 'network',
	},
	{
		name: MODEL_RECOMMEND,
		description:
			'Recommend models for a task. Uses the same selector and scoring the router uses for a ' +
			'turn, including the preferences Evelyn recorded. Returns the pick, the alternatives and ' +
			'the score components that produced them.',
		parameters: {
			type: 'object',
			properties: {
				task: { type: 'string', description: 'The task, in words — the same text a user would write' },
				domain: { type: 'string', description: 'Override the detected domain', enum: [...DOMAINS] },
				complexity: {
					type: 'string',
					description: 'Override the detected complexity',
					enum: [...COMPLEXITIES],
				},
				needsTools: { type: 'boolean', description: 'Override whether the task needs tools' },
				requiredCapabilities: {
					type: 'array',
					items: { type: 'string' },
					description: 'Capabilities the task requires, e.g. reasoning, code-generation, long-context',
				},
				maxCandidates: {
					type: 'number',
					description: 'How many alternatives to return. Defaults to 2.',
				},
			},
			required: ['task'],
		},
		riskLevel: 'safe',
		category: 'other',
	},
];

/** A descrição da ferramenta de pesquisa, separada porque é longa. */
const RESEARCH_SPEC: ToolSpec = {
	name: MODEL_RESEARCH,
	description:
		'Pesquisa na web, em vários passos, o que falta saber de um modelo — ou de um assunto: ' +
		'capacidades, contexto, limites gratuitos, preço, disponibilidade e como conectar. O ciclo ' +
		'procura, abre as páginas e segue links sozinho (até 8 rodadas e 20 páginas), e devolve a ' +
		'conclusão com as fontes REALMENTE abertas, as datas e o que não foi encontrado. ' +
		'NADA é gravado no catálogo por esta chamada: ela só propõe. Use "goal" para uma pesquisa ' +
		'exploratória (ex.: "modelos gratuitos para programação") e "model" para um modelo do catálogo.',
	parameters: {
		type: 'object',
		properties: {
			model: { type: 'string', description: 'The model id, exactly as listed' },
			providerId: { type: 'string', description: 'Provider, when two providers serve the same id' },
			goal: {
				type: 'string',
				description:
					'What to find out, in words. Required when "model" is omitted; for a model it narrows ' +
					'what the research should look for.',
			},
		},
	},
	// A pesquisa chama o provedor configurado (consome tokens): passa pelo cartão
	// de permissão como tudo que gasta.
	riskLevel: 'moderate',
	category: 'network',
};

const SAVE_RESEARCH_SPEC: ToolSpec = {
	name: MODEL_RESEARCH_SAVE,
	description:
		'Grava no catálogo o que a pesquisa encontrou e o usuário confirmou, preservando a fonte ' +
		'de cada campo. Valores estimados NÃO são gravados como fato: continuam desconhecidos. ' +
		'Só chame depois de mostrar as fontes e receber confirmação explícita.',
	parameters: {
		type: 'object',
		properties: {
			providerId: { type: 'string', description: 'The provider as listed' },
			model: { type: 'string', description: 'The model id as listed' },
			query: { type: 'string', description: 'The query the research used' },
			answer: {
				type: 'string',
				description: 'The raw research answer, exactly as research_model returned it',
			},
			fields: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Which fields the user confirmed (e.g. context, tools, price-input). Omit to save every ' +
					'field that has a real source.',
			},
		},
		required: ['providerId', 'model', 'answer'],
	},
	riskLevel: 'moderate',
	category: 'other',
};

const ALL_SPECS: readonly ToolSpec[] = [...SPECS, RESEARCH_SPEC, SAVE_RESEARCH_SPEC];

/** O que a recomendação diz sobre um candidato, no formato da ferramenta. */
interface ExplainedReason {
	readonly providerName: string;
	readonly modelId: string;
	readonly chosen: boolean;
	readonly score?: number;
	readonly reason: string;
	readonly components?: readonly {
		readonly id: string;
		readonly points: number;
		readonly detail: string;
	}[];
	readonly excludedBecause?: readonly string[];
	readonly confidence?: readonly string[];
}

/** Uma linha de `summary`, sem depender do tipo de um modelo do host. */
function explain(entry: ExplainedReason): Record<string, unknown> {
	return {
		provider: entry.providerName,
		model: entry.modelId,
		score: entry.score,
		reason: entry.reason,
		...(entry.components !== undefined
			? {
					components: entry.components.map((component) => ({
						id: component.id,
						points: component.points,
						detail: component.detail,
					})),
				}
			: {}),
		...(entry.excludedBecause !== undefined && entry.excludedBecause.length > 0
			? { excludedBecause: entry.excludedBecause }
			: {}),
		...(entry.confidence !== undefined && entry.confidence.length > 0
			? { confidence: entry.confidence }
			: {}),
	};
}

/**
 * As quatro ferramentas, sobre um diretório e uma porta de seleção.
 *
 * Construídas por chamada, e não uma vez para a sessão: o diretório é o do
 * host que atende o turno, e no modo conectado é o **serviço** quem lê o
 * catálogo — a janela não tem autoridade sobre o que o serviço conhece.
 */
export function createModelCatalogTools(
	directory: ModelDirectory,
	selection: ModelSelectionPort,
	research: ModelResearchPort,
): readonly {
	readonly tool: AgentTool<unknown, unknown>;
	readonly spec: ToolSpec;
}[] {
	const listTool: AgentTool<unknown, unknown> = {
		descriptor: descriptorOf(MODEL_LIST),
		async execute(input): Promise<ToolResult<unknown>> {
			try {
				const providerId = optionalString(input, 'providerId');
				const models = await directory.list(providerId !== undefined ? { providerId } : {});
				return {
					ok: true,
					output: {
						count: models.length,
						providers: [...new Set(models.map((model) => model.providerName))],
						models: models.map(summarize),
						note:
							"models come from the app catalog (declared + discovered). " +
							"Fields under 'unknown' were not recorded — do not infer them.",
					},
				};
			} catch (error) {
				return { ok: false, error: messageOf(error) };
			}
		},
	};

	const detailsTool: AgentTool<unknown, unknown> = {
		descriptor: descriptorOf(MODEL_DETAILS),
		async execute(input): Promise<ToolResult<unknown>> {
			try {
				const model = optionalString(input, 'model');
				if (model === undefined) {
					return { ok: false, error: 'model_details needs a model id' };
				}
				const providerId = optionalString(input, 'providerId');
				const models = await directory.list(providerId !== undefined ? { providerId } : {});
				const matches = models.filter((entry) => entry.modelId === model);
				if (matches.length === 0) {
					return {
						ok: true,
						output: {
							found: false,
							model,
							note: 'no such model in the catalog; use list_models to see the exact ids',
						},
					};
				}
				return {
					ok: true,
					output: {
						found: true,
						count: matches.length,
						models: matches.map((entry) => ({
							...summarize(entry),
							...(entry.observations !== undefined ? { observations: entry.observations } : {}),
							...(entry.medianTotalMs !== undefined ? { medianTotalMs: entry.medianTotalMs } : {}),
						})),
					},
				};
			} catch (error) {
				return { ok: false, error: messageOf(error) };
			}
		},
	};

	const refreshTool: AgentTool<unknown, unknown> = {
		descriptor: descriptorOf(MODEL_REFRESH),
		async execute(input): Promise<ToolResult<unknown>> {
			try {
				const providerId = optionalString(input, 'providerId');
				const result: DiscoveryRefreshResult = await directory.refreshDiscovery(providerId);
				return { ok: true, output: result };
			} catch (error) {
				return { ok: false, error: messageOf(error) };
			}
		},
	};

	const recommendTool: AgentTool<unknown, unknown> = {
		descriptor: descriptorOf(MODEL_RECOMMEND),
		async execute(input): Promise<ToolResult<unknown>> {
			try {
				const text = optionalString(input, 'task');
				if (text === undefined) {
					return { ok: false, error: 'recommend_model needs a task' };
				}
				const needsTools =
					typeof input === 'object' && input !== null &&
					typeof (input as Record<string, unknown>).needsTools === 'boolean'
						? (input as { readonly needsTools: boolean }).needsTools
						: undefined;
				const required = (input as { readonly requiredCapabilities?: unknown } | null)
					?.requiredCapabilities;
				const task = selection.classify(text, {
					...(optionalString(input, 'domain') !== undefined
						? { domain: optionalString(input, 'domain') as string }
						: {}),
					...(optionalString(input, 'complexity') !== undefined
						? { complexity: optionalString(input, 'complexity') as string }
						: {}),
					...(needsTools !== undefined ? { needsTools } : {}),
					...(Array.isArray(required)
						? {
								requiredCapabilities: required.filter(
									(entry): entry is string => typeof entry === 'string' && entry.length > 0,
								),
							}
						: {}),
				});
				const models = await directory.list();
				const [guidance, allowPaid] = await Promise.all([
					directory.guidance(),
					directory.allowPaid(),
				]);
				const maxCandidates =
					typeof input === 'object' && input !== null &&
					typeof (input as Record<string, unknown>).maxCandidates === 'number'
						? Math.max(0, Math.min(10, (input as { readonly maxCandidates: number }).maxCandidates))
						: 2;
				const result = selection.recommend({
					task,
					models,
					guidance,
					allowPaid,
					maxCandidates,
				});
				const byKey = new Map(
					models.flatMap((entry) => [
						[`${entry.providerId}:${entry.modelId}`, entry] as const,
						[`${entry.providerName}:${entry.modelId}`, entry] as const,
					]),
				);
				// Quando nada é elegível, todos os candidatos são alternativa —
				// cada um com o motivo de ter sido descartado. Sem isso o
				// chamador não saberia por que não há resposta.
				const alternatives = result.reasons
					.filter((reason) => !reason.chosen || result.primary === undefined)
					.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
					.slice(0, maxCandidates)
					.map((reason) => {
						const record = byKey.get(`${reason.providerName}:${reason.modelId}`);
						return {
							...explain(reason),
							...(record !== undefined ? { unknown: unknownFields(record) } : {}),
						};
					});
				const chosen = result.reasons.find((reason) => reason.chosen);
				const chosenRecord =
					chosen !== undefined ? byKey.get(`${chosen.providerName}:${chosen.modelId}`) : undefined;
				return {
					ok: true,
					output: {
						task: {
							domain: task.domain,
							complexity: task.complexity,
							needsTools: task.needsTools,
							requiredCapabilities: task.requiredCapabilities,
						},
						recommended:
							chosen !== undefined
								? {
										...explain(chosen),
										...(chosenRecord !== undefined ? { unknown: unknownFields(chosenRecord) } : {}),
									}
								: undefined,
						alternatives,
						...(result.primary === undefined
							? {
									note:
										'no eligible model for this task under the current access policy; ' +
										'see excludedBecause for the reason',
								}
							: {}),
					},
				};
			} catch (error) {
				return { ok: false, error: messageOf(error) };
			}
		},
	};

	const researchTool: AgentTool<unknown, unknown> = {
		descriptor: descriptorOf(MODEL_RESEARCH),
		async execute(input): Promise<ToolResult<unknown>> {
			try {
				const goal = optionalString(input, 'goal');
				const model = optionalString(input, 'model');
				const providerInput = optionalString(input, 'providerId');

				// Pesquisa exploratória: o objetivo é a pergunta, e o resultado é
				// uma conclusão — não o formulário de um modelo já conhecido.
				if (goal !== undefined && model === undefined) {
					const answered = await research.research({
						providerId: providerInput ?? 'exploratory',
						modelId: goal,
						goal,
					});
					if (answered === undefined) {
						return {
							ok: true,
							output: {
								found: false,
								goal,
								research: null,
								note:
									'no usable provider (or no search) was available: nothing was researched, ' +
									'and nothing was invented. Say you could not search.',
							},
						};
					}
					const seen = new Set<string>();
					const sources = (answered.run?.visited ?? [])
						.filter((entry) => entry.ok && /^https?:\/\//i.test(entry.target))
						.map((entry) => entry.target)
						.filter((url) => (seen.has(url) ? false : (seen.add(url), true)));
					return {
						ok: true,
						output: {
							found: true,
							goal,
							query: answered.query,
							conclusion: answered.answer,
							cycles: answered.run?.cycles ?? null,
							stopped: answered.run?.stopped ?? null,
							visited: answered.run?.visited ?? [],
							// Só as páginas **abertas** contam como fonte. Uma URL que
							// o modelo citou sem abrir não entra aqui.
							openedSources: sources,
							stored: false,
							note:
								'nothing was saved. Every claim must point at a page in visited with ok=true; ' +
								'if "stopped" is cycle-limit or page-limit the research is incomplete — say so. ' +
								'Show the sources and ask the user before saving anything to the catalog.',
						},
					};
				}

				if (model === undefined) {
					return {
						ok: false,
						error: 'research_model needs a model id (or a goal for an open research)',
					};
				}
				const models = await directory.list(providerInput !== undefined ? { providerId: providerInput } : {});
				const matches = models.filter(
					(entry) =>
						entry.modelId === model &&
						(providerInput === undefined ||
							entry.providerId === providerInput ||
							entry.providerName === providerInput),
				);
				const providerId = providerInput;
				if (matches.length === 0) {
					// O modelo não está no catálogo: é exatamente o caso em que a
					// pesquisa autônoma procura fora dele. Pesquisa pelo nome e
					// devolve o que encontrou, sem criar entrada.
					const outside = await research.research({
						providerId: providerInput ?? 'fora-do-catalogo',
						modelId: model,
						goal:
							goal ??
							`Pesquise o modelo "${model}" fora do catálogo local: o que ele é, quem oferece, ` +
								`capacidades, contexto, preço e limites gratuitos, e como conectar.`,
					});
					if (outside === undefined) {
						return {
							ok: true,
							output: {
								found: false,
								model,
								research: null,
								note:
									'no such model in the catalog, and no usable provider to search the web with; ' +
									'nothing was invented',
							},
						};
					}
					return {
						ok: true,
						output: {
							found: false,
							model,
							outsideCatalog: true,
							query: outside.query,
							conclusion: outside.answer,
							cycles: outside.run?.cycles ?? null,
							stopped: outside.run?.stopped ?? null,
							visited: outside.run?.visited ?? [],
							stored: false,
							note:
								'the model is not in the local catalog; this is what the web research found. ' +
								'Nothing was added to the catalog — that needs the user\'s confirmation and a ' +
								'provider already configured.',
						},
					};
				}
				// Um id em dois provedores: cada um é pesquisado com o seu nome,
				// e a resposta diz qual foi qual. Escolher um seria inventar.
				const targets = providerId !== undefined ? matches.slice(0, 1) : matches;
				const proposals = [];
				for (const target of targets) {
					const answered = await research.research({
						providerId: target.providerName,
						modelId: target.modelId,
					});
					if (answered === undefined) {
						proposals.push({
							provider: target.providerName,
							model: target.modelId,
							research: null,
							note: 'no usable provider to search with; the fields stay unknown',
						});
						continue;
					}
					const parsed = parseResearch(answered.answer, new Date().toISOString());
					const proposal = proposeResearch({
						providerId: target.providerName,
						modelId: target.modelId,
						query: answered.query,
						researchedAt: new Date().toISOString(),
						parsed,
					});
					const sources = sourcesOf(proposal);
					proposals.push({
						provider: target.providerName,
						model: target.modelId,
						research: {
							query: proposal.query,
							limits: proposal.limits,
							capabilities: proposal.capabilities,
							pricing: proposal.pricing,
							access: proposal.access,
							notes: proposal.notes,
							unknown: proposal.unknown,
							sources,
						},
						rejected: parsed.rejected,
						// O ciclo autônomo: quantas rodadas, o que foi aberto e por
						// que parou. Sem isto, "não encontrei" e "não procurei"
						// pareceriam a mesma coisa.
						...(answered.run !== undefined
							? {
									researchRun: {
										cycles: answered.run.cycles,
										stopped: answered.run.stopped,
										visited: answered.run.visited,
									},
								}
							: {}),
						// O que a pesquisa encontrou **não** está no catálogo.
						stored: false,
					});
				}
				return {
					ok: true,
					output: {
						found: true,
						proposals,
						note:
							'nothing was saved. Every field carries its level: provider (the provider itself), ' +
							'secondary (a third-party source, URL included) or estimated (no source — a hint, ' +
							'not a fact). Fields under "unknown" were not found and stay unknown. ' +
							'Show the sources to the user and ask which fields to confirm before saving.',
					},
				};
			} catch (error) {
				return { ok: false, error: messageOf(error) };
			}
		},
	};

	const confirmTool: AgentTool<unknown, unknown> = {
		descriptor: descriptorOf(MODEL_RESEARCH_SAVE),
		async execute(input): Promise<ToolResult<unknown>> {
			try {
				const model = optionalString(input, 'model');
				const providerInput = optionalString(input, 'providerId');
				const answer = optionalString(input, 'answer');
				if (model === undefined || providerInput === undefined || answer === undefined) {
					return {
						ok: false,
						error: 'save_researched_model needs providerId, model and the research answer',
					};
				}
				// O modelo pode nomear o provedor pelo id ou pelo nome de exibição —
				// ele vê os dois na lista. O catálogo só aceita o id, então a
				// ferramenta resolve o nome **aqui**, no catálogo, em vez de gravar
				// uma entrada órfã que a recomendação nunca encontraria.
				const known = await directory.list();
				const providerId =
					known.find((entry) => entry.providerId === providerInput)?.providerId ??
					known.find((entry) => entry.providerName === providerInput)?.providerId ??
					providerInput;
				const fields = Array.isArray((input as { readonly fields?: unknown })?.fields)
					? ((input as { readonly fields: unknown[] }).fields).filter(
							(entry): entry is string => typeof entry === 'string' && entry.length > 0,
						)
					: undefined;
				const parsed = parseResearch(answer, new Date().toISOString());
				const proposal = proposeResearch({
					providerId,
					modelId: model,
					query: optionalString(input, 'query') ?? model,
					researchedAt: new Date().toISOString(),
					parsed,
				});
				const confirmed = confirmedResearch(proposal, fields ?? 'all');
				if (confirmed.applied.length === 0) {
					return {
						ok: true,
						output: {
							saved: false,
							applied: [],
							skipped: confirmed.skipped,
							note: 'nothing was worth saving: only estimated values, or none confirmed',
						},
					};
				}
				await research.apply({
					providerId,
					modelId: model,
					confirmed,
					sources: sourcesOf(proposal),
				});
				return {
					ok: true,
					output: {
						saved: true,
						applied: confirmed.applied,
						skipped: confirmed.skipped,
						provenance: sourcesOf(proposal).map((source) => source.url ?? source.kind),
					},
				};
			} catch (error) {
				return { ok: false, error: messageOf(error) };
			}
		},
	};

	return [
		{ tool: listTool, spec: SPECS[0] },
		{ tool: detailsTool, spec: SPECS[1] },
		{ tool: refreshTool, spec: SPECS[2] },
		{ tool: recommendTool, spec: SPECS[3] },
		{ tool: researchTool, spec: RESEARCH_SPEC },
		{ tool: confirmTool, spec: SAVE_RESEARCH_SPEC },
	];
}

function descriptorOf(name: string): ToolDescriptor {
	const spec = ALL_SPECS.find((entry) => entry.name === name);
	if (spec === undefined) {
		throw new Error(`No spec declared for tool "${name}"`);
	}
	return {
		id: name,
		name,
		category: spec.category,
		riskLevel: spec.riskLevel,
		description: spec.description,
	};
}

/** As specs, para um host que só quer anunciar as ferramentas. */
export const MODEL_CATALOG_TOOL_SPECS: readonly ToolSpec[] = ALL_SPECS;
