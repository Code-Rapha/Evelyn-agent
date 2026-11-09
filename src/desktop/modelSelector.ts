/**
 * Model selection: chooses an eligible model based on the task classification,
 * the catalog of declared/observed metadata, and the live available models.
 *
 * Pure, host-free, no network. All metadata comes from the user-declared catalog
 * and the server-reported model list — nothing is invented.
 */

import type { ModelCatalogEntry, ModelAccess } from '../core/storage/types/modelCatalog';
import type { AvailableModel, AbortCause } from './contract';
import type { ModelGuidanceEntry } from './modelGuidance';
import type { TaskClassification } from './taskDiscovery';

/** A model that is both available on the server and has catalog metadata. */
export interface EligibleModel {
	readonly providerId: string;
	readonly modelId: string;
	readonly providerName: string;
	/** Declared by the user, or observed from real runs. */
	readonly catalog: ModelCatalogEntry;
	/** Whether the server currently offers this model. */
	readonly available: true;
}

/** A model the server offers but has no catalog entry yet. */
export interface UnknownModel {
	readonly providerId: string;
	readonly modelId: string;
	readonly providerName: string;
	readonly available: true;
	readonly catalog: undefined;
}

/** Any model the selector can work with. */
export type SelectableModel = EligibleModel | UnknownModel;

/** Why a model was chosen or rejected. */
export interface SelectionReason {
	readonly modelId: string;
	readonly providerId: string;
	readonly chosen: boolean;
	readonly reason: string;
	/** Capabilities the model has (declared + observed). */
	readonly capabilities: readonly string[];
	/** Whether the model supports tools (declared). */
	readonly supportsTools: boolean;
	/** Whether the model supports streaming (assumed true for all unless known false). */
	readonly supportsStreaming: boolean;
	/** Access level: free, paid, unknown. */
	readonly access: ModelAccess;
	/** Context window if known. */
	readonly contextTokens?: number;
	/**
	 * The final score, when the candidate was scored.
	 *
	 * Absent for a candidate that never reached the scoring — a manual choice
	 * that was refused, for instance. A score that was never computed is not
	 * reported as zero.
	 */
	readonly score?: number;
	/** The terms that produced the score. */
	readonly components?: readonly ScoreComponent[];
	/**
	 * The constraints that removed the candidate, if any.
	 *
	 * Separate from the score on purpose: a paid model that is not authorized
	 * is not "a model with a very negative score", it is excluded.
	 */
	readonly constraints?: readonly SelectionConstraint[];
	/** What was missing or out of date, and what it cost the decision. */
	readonly confidence?: readonly SelectionConfidence[];
}

/** Input to the model selector. */
export interface ModelSelectorInput {
	/** The task to match against. */
	readonly task: TaskClassification;
	/** All models the server currently offers. */
	readonly availableModels: readonly AvailableModel[];
	/** Catalog entries for models the user has described. */
	readonly catalog: readonly ModelCatalogEntry[];
	/**
	 * The user's manual model choice, if any (providerId:modelId).
	 *
	 * A **preference**, not an authorization. It decides *which* model wins when
	 * more than one is eligible; it says nothing about whether that model may be
	 * used for money. A paid model named here is still refused while
	 * `allowPaid` is false, and refused rather than silently swapped for one the
	 * user did not ask for.
	 */
	readonly manualChoice?: string;
	/** Maximum number of fallback candidates to return. */
	readonly maxCandidates?: number;
	/**
	 * Whether paid models may be used.
	 *
	 * False (the default) is a global block, not a preference: a model the
	 * catalog records as `paid` is left out of the primary choice, the fallbacks
	 * and the manual choice alike. It is the one explicit authorization to
	 * spend, so it is what every path that can reach a model consults.
	 * `unknown` models stay eligible either way — a missing price is not
	 * evidence of a charge.
	 */
	readonly allowPaid?: boolean;
	/**
	 * O que a Evelyn escreveu sobre os modelos, no diálogo de preferências.
	 *
	 * É a opinião dela, não a do usuário e não a do catálogo: entra como uma
	 * contribuição a mais na pontuação, e só para o que ela declarou. Ausente
	 * ou vazio deixa a decisão exatamente como era antes.
	 */
	readonly guidance?: readonly ModelGuidanceEntry[];
}

/**
 * Whether a model is blocked by the paid-access policy.
 *
 * The policy is global: a paid model must not be reached as a primary choice,
 * as a fallback *or* by a manual pick while paid access has not been authorized.
 * A score cannot express that — a paid model with enough declared capabilities
 * clears zero on its own — so the exclusion is structural rather than a penalty,
 * and it is decided here once instead of in every caller.
 *
 * `unknown` is deliberately not blocked. A missing price is not evidence that
 * a model is paid, and refusing it would make the app unable to use any model
 * the user has not described. It is not credited as free either.
 */
export function isPaidBlocked(model: SelectableModel, allowPaid: boolean): boolean {
	return !allowPaid && model.catalog?.access === 'paid';
}

/**
 * Builds the list of selectable models from available models + catalog.
 */
function buildSelectableModels(
	available: readonly AvailableModel[],
	catalog: readonly ModelCatalogEntry[],
): SelectableModel[] {
	const catalogMap = new Map<string, ModelCatalogEntry>();
	for (const entry of catalog) {
		catalogMap.set(`${entry.providerId}:${entry.modelId}`, entry);
	}
	return available.map((am) => {
		const key = `${am.providerId}:${am.model}`;
		const cat = catalogMap.get(key);
		if (cat !== undefined) {
			return {
				providerId: am.providerId,
				modelId: am.model,
				providerName: am.providerName,
				catalog: cat,
				available: true as const,
			};
		}
		return {
			providerId: am.providerId,
			modelId: am.model,
			providerName: am.providerName,
			catalog: undefined,
			available: true as const,
		};
	});
}

/**
 * One contribution to a model's score.
 *
 * ## Why this exists
 *
 * The score used to be a single number computed in one function, and the
 * reason string said "Match: tools" without saying how much the tools were
 * worth or what else had contributed. A number nobody can decompose is a
 * number nobody can argue with — and a decision nobody can argue with is a
 * decision the user has to take on faith.
 *
 * ## What a component is
 *
 * Exactly one term of the sum that produced the score. The arithmetic is
 * unchanged: the components add up to the same number the old function
 * returned, and a test proves it against the old formula. A component that
 * did not participate in the score is not here — there is no "context window:
 * probably fine" line for a criterion the algorithm never looked at.
 */
export interface ScoreComponent {
	/** A stable id, for the UI and for tests. */
	readonly id: string;
	/** The criterion, in words. */
	readonly label: string;
	/** What it contributed. Zero is allowed and means "looked, did not match". */
	readonly points: number;
	/** Why it contributed what it contributed. */
	readonly detail: string;
}

/**
 * A constraint that removed a candidate before or apart from the score.
 *
 * These are **not** score components. A paid model with paid access
 * unauthorized is not "a model with a very negative score": it is excluded,
 * structurally, and no amount of declared capability can lift it back. Keeping
 * the two apart is what makes the report honest about what happened.
 */
export interface SelectionConstraint {
	readonly id: 'paid_not_allowed' | 'negative_score' | 'policy_excluded';
	readonly label: string;
	/** What removed it, in words. */
	readonly detail: string;
}

/**
 * A piece of data that was missing or out of date, and what that cost.
 *
 * The score is not wrong when a limit is unknown — it is *less informed*. This
 * is where the difference is recorded, so a decision made on thin data does
 * not look like a decision made on solid data.
 */
export interface SelectionConfidence {
	readonly id:
		| 'no_catalog_entry'
		| 'capabilities_unknown'
		| 'context_unknown'
		| 'no_observations'
		| 'metadata_stale';
	readonly label: string;
	/** What the absence cost the decision. */
	readonly detail: string;
}

/** The score of a model, with the terms that produced it. */
export interface ScoreBreakdown {
	readonly score: number;
	readonly components: readonly ScoreComponent[];
	/** What was missing or out of date, and what it cost. */
	readonly confidence: readonly SelectionConfidence[];
}

/**
 * Scores a model against the task, with the terms that produced the score.
 *
 * The arithmetic is the one that was there before, term by term. The only
 * change is that each term is also *recorded*, so the number can be read.
 */
function scoreModelDetailed(
	model: SelectableModel,
	task: TaskClassification,
	allowPaid: boolean,
	guidance?: ModelGuidanceEntry,
): ScoreBreakdown {
	const components: ScoreComponent[] = [];
	const confidence: SelectionConfidence[] = [];
	let score = 0;

	const add = (id: string, label: string, points: number, detail: string): void => {
		components.push({ id, label, points, detail });
		score += points;
	};

	// Unknown model: minimal score, but not zero (could still work)
	if (model.catalog === undefined) {
		add(
			'no_catalog_entry',
			'No catalog entry',
			1,
			'nothing is known about this model; it gets the minimal score and no comparison',
		);
		confidence.push({
			id: 'no_catalog_entry',
			label: 'No catalog entry',
			detail: 'the decision was made on the model id alone, with no declared metadata',
		});
		// A Evelyn pode ter falado do modelo mesmo sem o catálogo tê-lo
		// descrito, e nesse caso a opinião dela é tudo o que se sabe. Ela não
		// troca a entrada ausente por uma inventada — soma uma contribuição. A
		// contribuição entra **antes** do retorno: somar depois dele era somar
		// em uma cópia que ninguém lia.
		addGuidance(guidance, task, add, true);
		return { score, components, confidence };
	}

	const cat = model.catalog;

	// Access level: penalize paid unless explicitly allowed
	if (cat.access === 'paid' && !allowPaid) {
		add(
			'access.paid_not_allowed',
			'Paid access not authorized',
			-100,
			'the model is classified as paid and paid access is not authorized in this session',
		);
	} else if (cat.access === 'free') {
		add('access.free', 'Free access', 10, 'the model is classified as free');
	}

	// Capabilities match
	if (cat.capabilities !== undefined) {
		for (const req of task.requiredCapabilities) {
			if (cat.capabilities.includes(req)) {
				add(
					`capability.${req}`,
					`Requires ${req}`,
					20,
					`the model declares the capability the task requires (${req})`,
				);
			}
		}
		// Domain match
		if (cat.capabilities.includes(task.domain)) {
			add(
				'domain.match',
				`Domain ${task.domain}`,
				15,
				`the model is classified for this domain (${task.domain})`,
			);
		}
	} else {
		confidence.push({
			id: 'capabilities_unknown',
			label: 'Capabilities unknown',
			detail: 'the model has no task categories declared, so the match could not be scored',
		});
	}

	// Tool support
	if (task.needsTools) {
		const supportsTools = cat.capabilities?.includes('tools') ?? false;
		if (supportsTools) {
			add(
				'tools.supported',
				'Task needs tools',
				15,
				'the model declares the tools capability and the task needs tools',
			);
		} else {
			add(
				'tools.missing',
				'Task needs tools',
				-10,
				'the task needs tools and the model does not declare them',
			);
		}
	}

	// Context window for long-context tasks
	if (task.requiredCapabilities.includes('long-context')) {
		if (cat.limits?.contextTokens !== undefined) {
			if (cat.limits.contextTokens >= 100_000) {
				add(
					'context.large',
					'Long context',
					20,
					`the window is ${cat.limits.contextTokens} tokens, at or above 100k`,
				);
			} else if (cat.limits.contextTokens >= 32_000) {
				add(
					'context.medium',
					'Long context',
					10,
					`the window is ${cat.limits.contextTokens} tokens, at or above 32k`,
				);
			} else {
				add(
					'context.small',
					'Long context',
					-5,
					`the window is ${cat.limits.contextTokens} tokens, below 32k`,
				);
			}
		} else {
			add(
				'context.unknown',
				'Long context',
				-5,
				'the task needs a long context and the window is unknown',
			);
			confidence.push({
				id: 'context_unknown',
				label: 'Context window unknown',
				detail: 'the task needs a long context and no window is known for this model',
			});
		}
	}

	// Observations: real runs are a strong signal
	if (cat.observations.length > 0) {
		add(
			'observations.count',
			'Measured runs',
			Math.min(cat.observations.length * 2, 20),
			`${cat.observations.length} measured run(s), two points each, up to twenty`,
		);
		// Prefer models with good median latency
		const medianTotal = cat.observations
			.map((o) => o.totalMs)
			.filter((v): v is number => v !== undefined)
			.sort((a, b) => a - b);
		if (medianTotal.length > 0) {
			const mid = medianTotal[Math.floor(medianTotal.length / 2)];
			if (mid < 5000) {
				add(
					'latency.fast',
					'Measured latency',
					10,
					`the median measured run took ${mid}ms`,
				);
			} else if (mid < 15000) {
				add(
					'latency.acceptable',
					'Measured latency',
					5,
					`the median measured run took ${mid}ms`,
				);
			} else if (mid > 60000) {
				add(
					'latency.slow',
					'Measured latency',
					-10,
					`the median measured run took ${mid}ms`,
				);
			}
		}
	} else {
		confidence.push({
			id: 'no_observations',
			label: 'No measured runs',
			detail: 'no real run was measured for this model, so the latency term is absent',
		});
	}

	// Complexity alignment
	if (task.complexity === 'complex' && cat.capabilities?.includes('reasoning')) {
		add(
			'complexity.reasoning',
			'Complex task',
			10,
			'the task is complex and the model declares reasoning',
		);
	}

	// O metadado efetivo pode ter vencido: a decisão foi feita sobre um dado
	// antigo, e o relatório precisa dizer isso.
	if (cat.metadata?.stale === true) {
		confidence.push({
			id: 'metadata_stale',
			label: 'Metadata out of date',
			detail:
				cat.metadata.expiresAt !== undefined
					? `the metadata in force expired on ${cat.metadata.expiresAt}`
					: 'the metadata in force came from a failed update',
		});
	}

	// Por último, e de propósito: o que a Evelyn disse sobre o modelo é uma
	// opinião, e uma opinião não substitui um fato declarado. Ela soma pontos
	// onde o catálogo é mudo e não pode cancelar uma exclusão.
	addGuidance(guidance, task, add);

	return { score, components, confidence };
}

/**
 * As preferências da Evelyn, como termos da pontuação.
 *
 * Cada campo declarado vira um componente próprio, com id `evelyn.*`, para o
 * relatório da decisão poder mostrar que aquele peso veio dela e não do
 * catálogo. Um campo ausente não vira termo: ela não disse, e o motor não
 * inventa.
 *
 * A magnitude é a mesma das regras equivalentes do catálogo (20 para a
 * capacidade exigida, 15 para a tarefa que usa ferramentas, 10 para
 * raciocínio), de modo que a opinião dela pesa como uma declaração — nem mais
 * nem menos.
 */
function addGuidance(
	guidance: ModelGuidanceEntry | undefined,
	task: TaskClassification,
	add: (id: string, label: string, points: number, detail: string) => void,
	/**
	 * O modelo não tem entrada de catálogo.
	 *
	 * Muda quanto o custo-benefício pesa: num modelo descrito, ele é um
	 * desempate entre iguais; num modelo só nomeado, é a única opinião que
	 * existe sobre ele.
	 */
	semCatalogo = false,
): void {
	if (guidance === undefined) {
		return;
	}
	if (task.needsTools && guidance.tools !== undefined) {
		add(
			'evelyn.tools',
			'Evelyn: ferramentas',
			guidance.tools ? 20 : -20,
			guidance.tools
				? 'no diálogo de preferências, a Evelyn disse que este modelo serve para tarefas com ferramentas'
				: 'no diálogo de preferências, a Evelyn disse que este modelo NÃO serve para tarefas com ferramentas',
		);
	}
	if (task.complexity === 'complex' && guidance.reasoning !== undefined) {
		add(
			'evelyn.reasoning',
			'Evelyn: raciocínio',
			guidance.reasoning ? 10 : -10,
			guidance.reasoning
				? 'a Evelyn o descreveu como bom em raciocínio, e a tarefa é complexa'
				: 'a Evelyn o descreveu como fraco em raciocínio, e a tarefa é complexa',
		);
	}
	if (task.requiredCapabilities.includes('long-context') && guidance.longContext !== undefined) {
		add(
			'evelyn.long-context',
			'Evelyn: contexto longo',
			guidance.longContext ? 15 : -15,
			guidance.longContext
				? 'a Evelyn o indicou para contexto longo, e a tarefa pede isso'
				: 'a Evelyn o desaconselhou para contexto longo, e a tarefa pede isso',
		);
	}
	if (guidance.value !== undefined) {
		// -5..+5 para desempatar modelos equivalentes — mas num modelo SEM
		// catálogo esse é o único sinal que existe: sem o peso extra, a opinião
		// dela perderia para os 7 pontos que uma execução medida rende a outro
		// modelo, e ela teria dito qual prefere sem o app usar isso.
		const points = Number((((guidance.value - 0.5) * 10) * (semCatalogo ? 4 : 1)).toFixed(1));
		add(
			'evelyn.value',
			'Evelyn: custo-benefício',
			points,
			`a Evelyn o avaliou em ${guidance.value.toFixed(2)} de custo-benefício${guidance.useFor !== undefined ? ` (uso: ${guidance.useFor})` : ''}`,
		);
	}
}

/**
 * Scores a model against the task. Higher is better.
 *
 * Only uses declared/observed metadata — never guesses from the model name.
 */
function scoreModel(model: SelectableModel, task: TaskClassification, allowPaid: boolean): number {
	return scoreModelDetailed(model, task, allowPaid).score;
}

/**
 * Builds the reason for choosing or rejecting a model.
 */
function buildReason(
	model: SelectableModel,
	task: TaskClassification,
	score: number,
	allowPaid: boolean,
	breakdown?: ScoreBreakdown,
): SelectionReason {
	const caps = model.catalog?.capabilities ?? [];
	const supportsTools = caps.includes('tools');
	const supportsStreaming = true; // Assumed unless catalog says otherwise
	const access = model.catalog?.access ?? 'unknown';
	const contextTokens = model.catalog?.limits?.contextTokens;

	let reason: string;
	if (model.catalog === undefined) {
		reason = 'No catalog entry — capabilities unknown';
	} else if (score < 0) {
		reason = `Low score (${score}): ${access === 'paid' && !allowPaid ? 'paid model not allowed' : 'capability mismatch'}`;
	} else {
		const parts: string[] = [];
		if (access === 'free') parts.push('free');
		if (supportsTools) parts.push('tools');
		if (caps.includes(task.domain)) parts.push(`domain:${task.domain}`);
		for (const rc of task.requiredCapabilities) {
			if (caps.includes(rc)) parts.push(`cap:${rc}`);
		}
		if (model.catalog.observations.length > 0) parts.push(`observed:${model.catalog.observations.length}x`);
		reason = parts.length > 0 ? `Match: ${parts.join(', ')}` : 'No specific match';
	}

	return {
		modelId: model.modelId,
		providerId: model.providerId,
		chosen: false, // Set by caller
		reason,
		capabilities: caps,
		supportsTools,
		supportsStreaming,
		access,
		contextTokens,
		...(breakdown !== undefined
			? {
					score: breakdown.score,
					components: breakdown.components,
					confidence: breakdown.confidence,
				}
			: {}),
	};
}

/**
 * Selects the best model(s) for the task.
 *
 * Returns the primary choice plus an ordered list of fallback candidates.
 * A manual choice that is eligible wins and is returned as the only candidate;
 * a manual choice that is a paid model with paid access unauthorized is refused,
 * with no primary and a reason saying why.
 */
export function selectModels(input: ModelSelectorInput): {
	readonly primary: SelectableModel | undefined;
	readonly fallbacks: readonly SelectableModel[];
	readonly reasons: readonly SelectionReason[];
} {
	const { task, availableModels, catalog, manualChoice, maxCandidates = 3, allowPaid = false } = input;
	const guidanceOf = (model: SelectableModel): ModelGuidanceEntry | undefined =>
		input.guidance?.find(
			(entry) =>
				entry.model === model.modelId &&
				(entry.providerId === undefined || entry.providerId === model.providerId),
		);

	const selectable = buildSelectableModels(availableModels, catalog);

	// Manual choice takes priority — as a preference, subject to the same paid
	// policy everything else is.
	if (manualChoice !== undefined && manualChoice.length > 0) {
		const [providerId, modelId] = manualChoice.split(':');
		const manual = selectable.find((m) => m.providerId === providerId && m.modelId === modelId);
		if (manual !== undefined) {
			if (isPaidBlocked(manual, allowPaid)) {
				// Naming the model states an intent, not a budget. Refusing is the
				// honest answer: substituting an eligible model would answer with
				// something the user did not ask for and not say so.
				const blocked = buildReason(manual, task, -100, allowPaid);
				return {
					primary: undefined,
					fallbacks: [],
					reasons: [
						{
							...blocked,
							chosen: false,
							constraints: [
								{
									id: 'paid_not_allowed',
									label: 'Paid access not authorized',
									detail:
										'the model is classified as paid and paid access is not authorized in this session',
								},
							],
						},
					],
				};
			}
			const reason = buildReason(manual, task, 999, allowPaid);
			// Mesmo numa escolha manual, o que a Evelyn disse sobre o modelo
			// continua sendo o que se sabe a favor ou contra ele — o relatório
			// mostra os dois, e a escolha do usuário não apaga a ressalva dela.
			const guidanceEntry = guidanceOf(manual);
			if (guidanceEntry !== undefined) {
				const withGuidance = scoreModelDetailed(manual, task, allowPaid, guidanceEntry);
				return {
					primary: manual,
					fallbacks: [],
					reasons: [
						{
							...reason,
							chosen: true,
							components: withGuidance.components,
							confidence: withGuidance.confidence,
						},
					],
				};
			}
			return {
				primary: manual,
				fallbacks: [],
				reasons: [{ ...reason, chosen: true }],
			};
		}
		// Manual choice not available — fall through to automatic selection
	}

	// Score all models. The score is computed once, and the breakdown that
	// explains it is the same computation — not a second one that could
	// disagree.
	const scored = selectable.map((model) => {
		const breakdown = scoreModelDetailed(model, task, allowPaid, guidanceOf(model));
		return {
			model,
			score: breakdown.score,
			reason: buildReason(model, task, breakdown.score, allowPaid, breakdown),
			breakdown,
		};
	});

	// Sort by score descending
	scored.sort((a, b) => b.score - a.score);

	// Exclude what may not be used at all: paid models while paid access is not
	// authorized, and models whose declared capabilities scored against them.
	// Kept as a filter rather than a score floor so no amount of declared
	// capability can lift a paid model back over the line.
	const isViable = (entry: (typeof scored)[number]): boolean =>
		!isPaidBlocked(entry.model, allowPaid) && (entry.score >= 0 || entry.model.catalog === undefined);
	const viable = scored.filter(isViable);

	// The constraints that removed each candidate, kept apart from its score.
	const constraintsOf = (entry: (typeof scored)[number]): readonly SelectionConstraint[] => {
		const constraints: SelectionConstraint[] = [];
		if (isPaidBlocked(entry.model, allowPaid)) {
			constraints.push({
				id: 'paid_not_allowed',
				label: 'Paid access not authorized',
				detail:
					'the model is classified as paid and paid access is not authorized in this session',
			});
		}
		if (!isViable(entry)) {
			constraints.push({
				id: 'negative_score',
				label: 'Score below zero',
				detail: `the score (${entry.score}) is below zero, so the candidate was not viable`,
			});
		}
		return constraints;
	};

	if (viable.length === 0) {
		return {
			primary: undefined,
			fallbacks: [],
			// Ordenados como o resto da resposta: o chamador que mostra os
			// candidatos com o motivo dá a mesma leitura de "quem chegou mais
			// perto" que a lista de alternativas de um turno bem-sucedido.
			reasons: scored.map((s) => ({
				...s.reason,
				chosen: false,
				constraints: constraintsOf(s),
			})),
		};
	}

	const primary = viable[0].model;
	const fallbacks = viable.slice(1, maxCandidates).map((s) => s.model);
	const reasons = scored.map((s) => ({
		...s.reason,
		chosen: s.model === primary,
		constraints: constraintsOf(s),
	}));

	return { primary, fallbacks, reasons };
}

/** The structured reason a turn ended, as the orchestrator receives it. */
export interface RecoverableErrorInput {
	/** The failure as an error, when there was one. */
	readonly error?: unknown;
	/**
	 * Why the turn was aborted, when it was aborted.
	 *
	 * The field that decides a timeout. Read from data rather than from the
	 * message: the message is Portuguese and the substrings below are English, so
	 * matching one against the other returned `false` for every real timeout and
	 * the fallback path silently never ran.
	 */
	readonly abortCause?: AbortCause;
	/**
	 * Whether a timeout was actually configured for this turn.
	 *
	 * The gate on requirement "no fallback on an arbitrary delay". A stall is only
	 * a *timeout* if somebody set a budget; with no budget there is nothing to
	 * have exceeded, and treating a slow-but-progressing turn as a failure would
	 * make the app hop providers mid-answer.
	 */
	readonly timeoutConfigured?: boolean;
	/** Whether the failed turn already ran tools, and may have had side effects. */
	readonly hadToolCalls?: boolean;
}

/**
 * Checks if an error is recoverable (should trigger fallback).
 *
 * The error's *message* is still inspected, because a server that reports its own
 * failure (`503`, `rate limit`) has no other way to say so. What changed is that
 * the abort reason no longer has to survive a round trip through prose.
 */
export function isRecoverableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	// Recoverable: model overloaded, rate limited, timeout, temporary unavailable
	if (msg.includes('overloaded')) return true;
	if (msg.includes('rate limit')) return true;
	if (msg.includes('timeout')) return true;
	if (msg.includes('temporarily unavailable')) return true;
	if (msg.includes('service unavailable')) return true;
	if (msg.includes('503')) return true;
	if (msg.includes('502')) return true;
	if (msg.includes('504')) return true;
	// Not recoverable: auth, bad request, not found, context too long (config issue), cancelled
	if (msg.includes('401')) return false;
	if (msg.includes('403')) return false;
	if (msg.includes('400')) return false;
	if (msg.includes('404')) return false;
	if (msg.includes('context')) return false; // Context length is a config/task issue, not model failure
	if (msg.includes('abort') || msg.includes('cancel')) return false;
	return false;
}

/**
 * Whether a failed turn is worth retrying on another eligible model.
 *
 * Three rules, in this order, and the order is the point:
 *
 * 1. **The user stopped it.** Never recoverable. They meant it, and retrying on
 *    another model would override a decision they just made.
 * 2. **Something already happened.** A turn that ran tools may have written a
 *    file, run a command or spent money; repeating it is not a retry, it is a
 *    second execution whose side effects nobody reviewed. This is checked before
 *    anything about the error, because it holds however innocent the failure was.
 * 3. **The failure was recoverable.** Read from the structured abort cause when
 *    there is one, and from the server's own message otherwise.
 */
export function shouldFallback(input: RecoverableErrorInput): boolean {
	if (input.abortCause === 'user-stop') {
		return false;
	}
	if (input.hadToolCalls === true) {
		return false;
	}
	if (input.abortCause === 'first-token' || input.abortCause === 'total-time') {
		// A timer that fired. Recoverable only when a timer was actually set:
		// without a configured budget, "slow" is not a fault and must not move
		// the turn to a different model.
		return input.timeoutConfigured === true;
	}
	return isRecoverableError(input.error);
}