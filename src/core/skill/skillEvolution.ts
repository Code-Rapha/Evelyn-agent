/**
 * Skill evolution: turning evaluated experience into reviewable proposals.
 *
 * ## What this is, and what it is not
 *
 * It is the *reasoning* half of controlled self-improvement: given what actually
 * happened on past runs — outcomes, criteria that failed, steps that turned out
 * to be wasted — it decides which skills look improvable and by how much
 * evidence. It writes nothing. Every function here is pure and host-free, and no
 * import from `desktop/` is reachable from this file by construction: the Core
 * must stay free of the host, and the boundary is enforced by a test.
 *
 * It is not a trainer. Nothing here touches model weights, and nothing here
 * changes a skill. It produces a *proposal* that a person approves or rejects,
 * and activation lives in `skillEvolutionService.ts`.
 *
 * ## Why it does not trust the model
 *
 * The strongest signal available is a recorded outcome, not the model's opinion
 * of its own answer. So the input is a list of run summaries produced by the
 * experimentation and evaluation layers, and every opportunity carries the
 * sample size behind it. A single bad run is an *observation*; three similar
 * ones are a *hypothesis*; only sustained agreement across a task type earns
 * `sustained-pattern`, and even then the proposal says in plain words what it
 * was tested on and what it was not.
 *
 * That distinction is not decoration. It is the reason the consumer can refuse a
 * strong-looking conclusion, and the reason the tests below assert that a
 * one-sample run never produces one.
 */

/** How an outcome was established. Never `model-opinion`. */
export type RunOutcomeSource = 'experiment' | 'evaluation' | 'conversation';

/** The verdict a past run reached, mirroring the evaluation layer. */
export type RunVerdict = 'passed' | 'failed' | 'inconclusive';

/** One past run, reduced to what a skill improvement could be argued from. */
export interface EvolvedRunSummary {
	/** The skill the run used, or `''` when the run had no skill at all. */
	readonly skillId: string;
	/** Verdict the evaluation layer reached. */
	readonly verdict: RunVerdict;
	/** Where the verdict came from. */
	readonly source: RunOutcomeSource;
	/** Stable id of the underlying experiment or evaluation, for traceability. */
	readonly refId?: string;
	/** Task domain, e.g. `coding`. Groups comparable runs. */
	readonly domain?: string;
	/** Which criterion ids failed. Empty when nothing failed. */
	readonly failedCriteria?: readonly string[];
	/** Steps that turned out to be unnecessary or repeated. */
	readonly wastedSteps?: number;
	/** Attempts beyond the first on the same task. */
	readonly retries?: number;
	/**
	 * A signature of the procedure that was followed.
	 *
	 * Two runs that share a signature were solved the same way, which is what
	 * makes "this approach keeps working" or "this step keeps being wasted"
	 * say something about a procedure rather than about a single session.
	 */
	readonly procedureSignature?: string;
	/** ISO timestamp of the run. Used only for ordering. */
	readonly at?: string;
}

/** What kind of improvement an opportunity points at. */
export type OpportunityKind =
	| 'recurring-failure'
	| 'inefficient-steps'
	| 'ambiguous-instructions'
	| 'repeated-success'
	| 'reusable-procedure';

/**
 * How well supported an opportunity is.
 *
 * The whole point of the enum: a conclusion and an observation are different
 * kinds of object, and a consumer must be able to tell them apart without
 * parsing prose.
 */
export type OpportunityStrength =
	/** One case seen. Worth writing down, not worth acting on. */
	| 'observation'
	/** Two or more similar cases. Plausible, not established. */
	| 'hypothesis'
	/** Enough agreeing cases to justify a proposal, within the tested scope. */
	| 'sustained-pattern';

/** How much evidence a pattern needs before it may be called sustained. */
export const SUSTAINED_PATTERN_MIN_SAMPLES = 5;

/** Below this many runs nothing is proposed at all. */
export const MIN_SAMPLES_TO_PROPOSE = 3;

/** Wasted steps above this per run makes the inefficiency worth raising. */
export const WASTED_STEPS_THRESHOLD = 2;

/** Instructions shorter than this are treated as under-specified. */
export const MIN_INSTRUCTIONS_CHARS = 200;

/** One improvable thing found in the history. */
export interface ImprovementOpportunity {
	/** Stable identity, used to refuse duplicates. */
	readonly fingerprint: string;
	readonly kind: OpportunityKind;
	/**
	 * The skill to change.
	 *
	 * `undefined` means the evidence points at a gap rather than at a defect:
	 * the run failed with no skill loaded, repeatedly.
	 */
	readonly skillId?: string;
	/** Title in one line, for a list the user scans. */
	readonly title: string;
	/** What was observed, stated as an observation. */
	readonly problem: string;
	readonly strength: OpportunityStrength;
	/** How many runs the claim rests on. Never zero. */
	readonly sampleSize: number;
	/** Ids of the runs behind it, so the claim can be checked. */
	readonly supportingRuns: readonly string[];
	/** Domains it was observed in. Narrower means less general. */
	readonly domains: readonly string[];
	/** Procedure signature, when the runs shared one. */
	readonly procedureSignature?: string;
	/** What this has *not* been tested on. */
	readonly untestedCases: readonly string[];
	/**
	 * Whether the pattern may be described as holding beyond its sample.
	 *
	 * Only true for a sustained pattern, and even then only within
	 * `domains` — the wording exists because "works well" is the sentence a
	 * single lucky run invites.
	 */
	readonly generalizesBeyondSample: boolean;
	/** A number a caller may sort by. Not a probability. */
	readonly weight: number;
}

/** Result of looking through the history. */
export interface OpportunityScanResult {
	readonly ok: boolean;
	readonly opportunities: readonly ImprovementOpportunity[];
	/** Runs that were read but produced nothing. Reported so silence is legible. */
	readonly runsConsidered: number;
	/** Why nothing was proposed, when nothing was. */
	readonly reason?: string;
	readonly error?: string;
}

/** Optional filters over the history. */
export interface OpportunityScanInput {
	readonly runs: readonly EvolvedRunSummary[];
	/** Fingerprints already proposed or filed. Duplicates are dropped. */
	readonly knownFingerprints?: readonly string[];
	/** Skills that currently exist, with their instructions. */
	readonly existingSkills?: readonly { readonly id: string; readonly instructions: string }[];
	/** Most opportunities to return. Defaults to 5. */
	readonly maxOpportunities?: number;
}

const DEFAULT_MAX_OPPORTUNITIES = 5;

/** One past run, with its optional fields defaulted. */
interface NormalizedRun {
	readonly skillId: string;
	readonly verdict: RunVerdict;
	readonly source: RunOutcomeSource;
	readonly refId: string;
	readonly domain: string;
	readonly failedCriteria: readonly string[];
	readonly wastedSteps: number;
	readonly retries: number;
	readonly procedureSignature?: string;
}

/**
 * Fills in the optional fields so the detectors never branch on absence.
 *
 * A missing `refId` still gets a stable one — its position — because a claim
 * with no traceable runs behind it is a claim nobody can check.
 */
function normalize(runs: readonly EvolvedRunSummary[]): readonly NormalizedRun[] {
	return runs.map((run, index) => ({
		skillId: run.skillId ?? '',
		verdict: run.verdict,
		source: run.source,
		refId: run.refId ?? `${run.source}-${index}`,
		domain: run.domain ?? 'unspecified',
		failedCriteria: run.failedCriteria ?? [],
		wastedSteps: run.wastedSteps ?? 0,
		retries: run.retries ?? 0,
		...(run.procedureSignature !== undefined ? { procedureSignature: run.procedureSignature } : {}),
	}));
}

/** Grades a claim by how many runs are behind it. */
function grade(sampleSize: number): OpportunityStrength {
	if (sampleSize >= SUSTAINED_PATTERN_MIN_SAMPLES) {
		return 'sustained-pattern';
	}
	if (sampleSize >= MIN_SAMPLES_TO_PROPOSE) {
		return 'hypothesis';
	}
	return 'observation';
}

/** A fingerprint that survives reordering but changes with the substance. */
function fingerprintOf(kind: OpportunityKind, skillId: string, key: string): string {
	return `${kind}:${skillId || 'no-skill'}:${key}`;
}

/** Domains a set of runs covered, most frequent first. */
function domainsOf(runs: readonly NormalizedRun[]): readonly string[] {
	return [...new Set(runs.map((r) => r.domain))].sort();
}

/**
 * What the runs did *not* cover.
 *
 * Stated on every opportunity rather than only on the weak ones, because a
 * proposal that reads "works well" without it is the failure mode this whole
 * module exists to avoid.
 */
function untestedFor(runs: readonly NormalizedRun[]): readonly string[] {
	const untested: string[] = [];
	const covered = new Set(runs.map((r) => r.domain));
	if (covered.size === 1) {
		const only = [...covered][0];
		untested.push(`Nenhum domínio além de "${only}" foi testado.`);
	}
	untested.push('A eficácia em execução real não foi medida automaticamente.');
	if (runs.every((r) => r.verdict === 'inconclusive')) {
		untested.push('Todas as execuções foram inconclusivas: a evidência é fraca.');
	}
	return untested;
}

/** Recurring failures of the same criterion on the same skill. */
function detectRecurringFailures(runs: readonly NormalizedRun[]): readonly ImprovementOpportunity[] {
	const byKey = new Map<string, NormalizedRun[]>();

	for (const run of runs) {
		if (run.verdict !== 'failed') {
			continue;
		}
		for (const criterion of run.failedCriteria) {
			const key = `${run.skillId}|${criterion}|${run.domain}`;
			const bucket = byKey.get(key);
			if (bucket === undefined) {
				byKey.set(key, [run]);
			} else {
				bucket.push(run);
			}
		}
	}

	const opportunities: ImprovementOpportunity[] = [];
	for (const [key, bucket] of byKey) {
		// Below the proposal threshold this is not a finding. Two runs of the same
		// failure is something to remember, not something to act on, and merging
		// buckets across domains to reach the threshold would be a claim about a
		// failure that only happens in two unrelated places.
		if (bucket.length < MIN_SAMPLES_TO_PROPOSE) {
			continue;
		}
		const [skillId = '', criterion = '', domain = ''] = key.split('|');
		const strength = grade(bucket.length);
		opportunities.push({
			fingerprint: fingerprintOf('recurring-failure', skillId, `${criterion}@${domain}`),
			kind: 'recurring-failure',
			...(skillId.length > 0 ? { skillId } : {}),
			title: `Falha recorrente: ${criterion}`,
			problem:
				`O critério "${criterion}" falhou em ${bucket.length} execuções no domínio "${domain}" ` +
				`usando a skill "${skillId || '(nenhuma)'}".`,
			strength,
			sampleSize: bucket.length,
			supportingRuns: bucket.map((r) => r.refId),
			domains: [domain],
			untestedCases: untestedFor(bucket),
			generalizesBeyondSample: strength === 'sustained-pattern',
			weight: bucket.length,
		});
	}
	return opportunities;
}

/** Runs that keep spending steps they did not need. */
function detectInefficientSteps(runs: readonly NormalizedRun[]): readonly ImprovementOpportunity[] {
	const bySkill = new Map<string, NormalizedRun[]>();
	for (const run of runs) {
		if (run.wastedSteps < WASTED_STEPS_THRESHOLD) {
			continue;
		}
		const bucket = bySkill.get(run.skillId);
		if (bucket === undefined) {
			bySkill.set(run.skillId, [run]);
		} else {
			bucket.push(run);
		}
	}

	const opportunities: ImprovementOpportunity[] = [];
	for (const [skillId, bucket] of bySkill) {
		if (bucket.length < MIN_SAMPLES_TO_PROPOSE) {
			continue;
		}
		const total = bucket.reduce((sum, run) => sum + run.wastedSteps, 0);
		const mean = total / bucket.length;
		const strength = grade(bucket.length);
		opportunities.push({
			fingerprint: fingerprintOf('inefficient-steps', skillId, 'wasted-steps'),
			kind: 'inefficient-steps',
			...(skillId.length > 0 ? { skillId } : {}),
			title: 'Etapas desnecessárias repetidas',
			problem:
				`A skill "${skillId || '(nenhuma)'}" gastou em média ${mean.toFixed(1)} etapas ` +
				`desnecessárias por execução, em ${bucket.length} execuções.`,
			strength,
			sampleSize: bucket.length,
			supportingRuns: bucket.map((r) => r.refId),
			domains: domainsOf(bucket),
			untestedCases: untestedFor(bucket),
			generalizesBeyondSample: strength === 'sustained-pattern',
			// Above the threshold but not far above: a run wasting ten steps is a
			// bigger claim than one wasting two, and the ordering should say so.
			weight: bucket.length * mean,
		});
	}
	return opportunities;
}

/** A skill that was used but never says anything concrete about how to act. */
function detectAmbiguousInstructions(
	runs: readonly NormalizedRun[],
	existing: readonly { readonly id: string; readonly instructions: string }[],
): readonly ImprovementOpportunity[] {
	const used = new Set(runs.filter((r) => r.skillId.length > 0).map((r) => r.skillId));
	const opportunities: ImprovementOpportunity[] = [];

	for (const skill of existing) {
		if (!used.has(skill.id)) {
			continue;
		}
		if (!isUnderSpecified(skill.instructions)) {
			continue;
		}
		const bucket = runs.filter((r) => r.skillId === skill.id);
		const failures = bucket.filter((r) => r.verdict === 'failed').length;
		// A skill that has only ever succeeded is not evidence of ambiguity.
		// Being short is a suspicion; being short *and* failing is the claim.
		if (bucket.length < MIN_SAMPLES_TO_PROPOSE || failures === 0) {
			continue;
		}
		const strength = grade(bucket.length);
		opportunities.push({
			fingerprint: fingerprintOf('ambiguous-instructions', skill.id, 'under-specified'),
			kind: 'ambiguous-instructions',
			skillId: skill.id,
			title: 'Instruções ambíguas ou incompletas',
			problem:
				`A skill "${skill.id}" tem instruções curtas ou sem etapas enumeradas e falhou em ` +
				`${failures} de ${bucket.length} execuções em que foi usada.`,
			strength,
			sampleSize: bucket.length,
			supportingRuns: bucket.filter((r) => r.verdict === 'failed').map((r) => r.refId),
			domains: domainsOf(bucket),
			untestedCases: [
				...untestedFor(bucket),
				'Não se sabe se a ambiguidade é a causa da falha: pode haver outras.',
			],
			generalizesBeyondSample: false,
			weight: bucket.length,
		});
	}
	return opportunities;
}

/**
 * Whether instructions say something a reader could follow.
 *
 * Two cheap structural signals and nothing clever: too short to be a procedure,
 * or with no numbered step for anyone to number. Deliberately not a semantic
 * judgement — this module does not get to decide what a skill "means".
 */
export function isUnderSpecified(instructions: string): boolean {
	if (typeof instructions !== 'string' || instructions.trim().length < MIN_INSTRUCTIONS_CHARS) {
		return true;
	}
	return !/^\s*(?:\d+[.)]|[-*])\s+\S/m.test(instructions);
}

/** The same procedure, followed, passing every time. */
function detectRepeatedSuccess(runs: readonly NormalizedRun[]): readonly ImprovementOpportunity[] {
	const bySignature = new Map<string, NormalizedRun[]>();
	for (const run of runs) {
		if (run.procedureSignature === undefined || run.verdict !== 'passed') {
			continue;
		}
		const key = `${run.skillId}|${run.procedureSignature}`;
		const bucket = bySignature.get(key);
		if (bucket === undefined) {
			bySignature.set(key, [run]);
		} else {
			bucket.push(run);
		}
	}

	const opportunities: ImprovementOpportunity[] = [];
	for (const [key, bucket] of bySignature) {
		if (bucket.length < MIN_SAMPLES_TO_PROPOSE) {
			continue;
		}
		const [skillId = '', signature = ''] = key.split('|');
		const strength = grade(bucket.length);
		opportunities.push({
			fingerprint: fingerprintOf('repeated-success', skillId, signature),
			kind: 'repeated-success',
			...(skillId.length > 0 ? { skillId } : {}),
			title: 'Estratégia que funcionou repetidamente',
			problem:
				`O procedimento "${signature}" produziu êxito em ${bucket.length} execuções com a skill ` +
				`"${skillId || '(nenhuma)'}". Isso sugere que ele pode ser registrado como estratégia reutilizável.`,
			strength,
			sampleSize: bucket.length,
			supportingRuns: bucket.map((r) => r.refId),
			domains: domainsOf(bucket),
			procedureSignature: signature,
			untestedCases: untestedFor(bucket),
			// The one case where the evidence can speak for itself is still scoped
			// to the domains it ran in, and `generalizesBeyondSample` is the flag a
			// consumer reads before repeating the claim outside them.
			generalizesBeyondSample: strength === 'sustained-pattern',
			weight: bucket.length,
		});
	}
	return opportunities;
}

/**
 * A procedure that keeps appearing with no skill to hold it.
 *
 * This is the "a new skill may be needed" case: the runs succeeded (or at least
 * were attempted) following the same shape, and nothing in the library encodes
 * that shape yet.
 */
function detectReusableProcedure(
	runs: readonly NormalizedRun[],
	existing: readonly { readonly id: string }[],
): readonly ImprovementOpportunity[] {
	const covered = new Set(existing.map((s) => s.id));
	const bySignature = new Map<string, NormalizedRun[]>();
	for (const run of runs) {
		if (run.procedureSignature === undefined) {
			continue;
		}
		if (covered.has(run.skillId)) {
			continue;
		}
		const bucket = bySignature.get(run.procedureSignature);
		if (bucket === undefined) {
			bySignature.set(run.procedureSignature, [run]);
		} else {
			bucket.push(run);
		}
	}

	const opportunities: ImprovementOpportunity[] = [];
	for (const [signature, bucket] of bySignature) {
		if (bucket.length < MIN_SAMPLES_TO_PROPOSE) {
			continue;
		}
		const strength = grade(bucket.length);
		opportunities.push({
			fingerprint: fingerprintOf('reusable-procedure', '', signature),
			kind: 'reusable-procedure',
			title: 'Procedimento repetido sem skill que o cubra',
			problem:
				`O procedimento "${signature}" foi seguido em ${bucket.length} execuções sem que uma skill ` +
				`o descrevesse. Pode justificar uma nova skill.`,
			strength,
			sampleSize: bucket.length,
			supportingRuns: bucket.map((r) => r.refId),
			domains: domainsOf(bucket),
			procedureSignature: signature,
			untestedCases: untestedFor(bucket),
			generalizesBeyondSample: strength === 'sustained-pattern',
			weight: bucket.length,
		});
	}
	return opportunities;
}

/**
 * Reads the history and reports what looks improvable.
 *
 * Dedup is by fingerprint and happens before the limit is applied, so a caller
 * that rescans the same history gets the same answer rather than a second copy
 * of the first two findings — which is what turns an "improvement assistant"
 * into a spam generator.
 */
export function identifyImprovementOpportunities(input: OpportunityScanInput): OpportunityScanResult {
	try {
		if (!Array.isArray(input.runs)) {
			return {
				ok: false,
				opportunities: [],
				runsConsidered: 0,
				error: 'runs must be an array',
			};
		}
		const normalized = normalize(input.runs);
		const existing = input.existingSkills ?? [];
		const known = new Set(input.knownFingerprints ?? []);

		const found = [
			...detectRecurringFailures(normalized),
			...detectInefficientSteps(normalized),
			...detectAmbiguousInstructions(normalized, existing),
			...detectRepeatedSuccess(normalized),
			...detectReusableProcedure(normalized, existing),
		];

		// Strongest evidence first, and among equals the larger sample: a
		// five-run hypothesis outranks a three-run one regardless of which
		// detector found it, because the ranking is about evidence, not origin.
		const strengthRank: Record<OpportunityStrength, number> = {
			'sustained-pattern': 3,
			hypothesis: 2,
			observation: 1,
		};
		found.sort((a, b) => {
			const byStrength = strengthRank[b.strength] - strengthRank[a.strength];
			if (byStrength !== 0) {
				return byStrength;
			}
			if (b.sampleSize !== a.sampleSize) {
				return b.sampleSize - a.sampleSize;
			}
			return b.weight - a.weight;
		});

		const deduplicated: ImprovementOpportunity[] = [];
		const seen = new Set<string>();
		for (const opportunity of found) {
			if (known.has(opportunity.fingerprint) || seen.has(opportunity.fingerprint)) {
				continue;
			}
			seen.add(opportunity.fingerprint);
			deduplicated.push(opportunity);
		}

		const limited = deduplicated.slice(0, input.maxOpportunities ?? DEFAULT_MAX_OPPORTUNITIES);
		return {
			ok: true,
			opportunities: limited,
			runsConsidered: normalized.length,
			...(limited.length === 0
				? { reason: 'Nenhuma evidência suficiente no histórico para propor melhoria.' }
				: {}),
		};
	} catch (error) {
		return {
			ok: false,
			opportunities: [],
			runsConsidered: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

// ── proposals ───────────────────────────────────────────────────────────────

/** Where a proposal sits in its life. Never skips a step. */
export type ProposalStatus =
	/** Written, waiting for a person. Nothing about the live skill changed. */
	| 'pending'
	/** A person said yes. Still not live: activation is a separate act. */
	| 'approved'
	/** A person said no. Recorded with their reason. */
	| 'rejected'
	/** The approved content is what the skill now says. */
	| 'activated'
	/** It was live, and it has been taken back to an earlier version. */
	| 'reverted';

/** A concrete check the improvement has to pass before it may be judged. */
export interface ImprovementCriterion {
	readonly id: string;
	/** What has to be true. */
	readonly description: string;
	/** How the user would notice. Not an automated result. */
	readonly observableAs: string;
}

/** The skill content a proposal proposes, in full. */
export interface ProposedSkillContent {
	readonly title: string;
	readonly description: string;
	readonly instructions: string;
	readonly tags: readonly string[];
	readonly requiredTools: readonly string[];
	readonly riskLevel: 'safe' | 'moderate' | 'dangerous';
	readonly constraints: readonly string[];
}

/** Everything a proposal carries. */
export interface SkillEvolutionProposal {
	readonly id: string;
	readonly status: ProposalStatus;
	/**
	 * The skill being changed — or, when `createsNewSkill`, the id to create.
	 *
	 * A new skill has no live file to read, so the id cannot come from the
	 * current state; it is chosen by the proposal. `writeLive` refuses a
	 * new-skill proposal without one, because the id is also the filename.
	 */
	readonly skillId?: string;
	/** `true` when the proposal asks for a brand new skill. */
	readonly createsNewSkill: boolean;
	/** The problem, carried over from the opportunity verbatim. */
	readonly problem: string;
	/** The current version string, or `''` for a new skill. */
	readonly currentVersion: string;
	/** The current instructions, or `''` for a new skill. */
	readonly currentInstructions: string;
	/** The version the proposal would become. */
	readonly proposedVersion: string;
	/** The full proposed content, not a patch: a diff nobody can read is not reviewable. */
	readonly proposed: ProposedSkillContent;
	/** Why this change, in one paragraph. */
	readonly rationale: string;
	/** The evidence: run ids, sample size, domains. */
	readonly evidence: {
		readonly sampleSize: number;
		readonly supportingRuns: readonly string[];
		readonly domains: readonly string[];
		readonly sources: readonly RunOutcomeSource[];
	};
	/** What the change is expected to buy. */
	readonly expectedBenefits: readonly string[];
	/** What could go wrong, and what was never tested. */
	readonly risks: readonly string[];
	readonly untestedCases: readonly string[];
	/** How the user judges whether the change worked. */
	readonly validationCriteria: readonly ImprovementCriterion[];
	/** How strong the evidence is. Carried so approval is an informed choice. */
	readonly strength: OpportunityStrength;
	/** The fingerprint it came from, so it cannot be proposed twice. */
	readonly fingerprint: string;
	readonly createdAt: string;
	/** Who decided, and why. Empty until a person does. */
	readonly decision?: {
		readonly decidedBy: string;
		readonly reason: string;
		readonly decidedAt: string;
	};
}

/** What goes into a proposal. */
export interface CreateEvolutionProposalInput {
	readonly opportunity: ImprovementOpportunity;
	readonly currentVersion: string;
	readonly currentInstructions: string;
	readonly proposed: ProposedSkillContent;
	readonly proposedVersion: string;
	readonly expectedBenefits: readonly string[];
	readonly risks: readonly string[];
	readonly validationCriteria: readonly ImprovementCriterion[];
	readonly now: string;
	readonly generateId?: () => string;
	/**
	 * Forces the new-skill path.
	 *
	 * An opportunity with no `skillId` already means "a gap, not a defect", so
	 * this defaults to that. It is stated explicitly for the automatic learner,
	 * where the intent is a new skill even if the opportunity carries an id for
	 * traceability.
	 */
	readonly createsNewSkill?: boolean;
	/**
	 * The id of the skill to create.
	 *
	 * Only meaningful with `createsNewSkill`. Without it the proposal cannot be
	 * activated: `writeLive` has no filename to create.
	 */
	readonly newSkillId?: string;
}

/** Bumps a `major.minor.patch` version by one patch. */
export function nextPatchVersion(version: string): string {
	if (/^\d+\.\d+\.\d+$/.test(version)) {
		const [major = '0', minor = '0', patch = '0'] = version.split('.');
		return `${major}.${minor}.${Number(patch) + 1}`;
	}
	// A version this module cannot read (a prerelease, or a hand-typed string)
	// still has to advance to *something* identifiable, so it is replaced rather
	// than rejected: refusing here would strand a skill nobody could improve.
	return '1.0.0';
}

/**
 * Turns one opportunity into one proposal.
 *
 * Carries the opportunity's own uncertainty across verbatim. In particular
 * `strength` and `untestedCases` are copied, not reworded: a proposal that
 * restates a weak finding confidently is worse than no proposal, because it
 * looks like a reviewable thing when it is not one yet.
 */
export function createEvolutionProposal(input: CreateEvolutionProposalInput): SkillEvolutionProposal {
	const { opportunity } = input;
	const id =
		input.generateId?.() ??
		// A proposal id names a file. The ISO timestamp contains colons, which
		// Windows refuses; see `defaultProposalId` in the service.
		`skill-prop-${input.now.replace(/[^0-9A-Za-z]/g, '')}-${opportunity.fingerprint.length}`;
	const createsNewSkill = input.createsNewSkill ?? opportunity.skillId === undefined;
	// A new skill's id is chosen by the proposal, not read from a live file.
	// Carrying it on `skillId` is what lets `writeLive` create the file, and
	// the doc on that field says so rather than pretending it is only an
	// existing-skill reference.
	const skillId = createsNewSkill ? input.newSkillId : opportunity.skillId;

	return {
		id,
		status: 'pending',
		...(skillId !== undefined ? { skillId } : {}),
		createsNewSkill,
		problem: opportunity.problem,
		currentVersion: input.currentVersion,
		currentInstructions: input.currentInstructions,
		proposedVersion: input.proposedVersion,
		proposed: input.proposed,
		rationale: buildRationale(opportunity),
		evidence: {
			sampleSize: opportunity.sampleSize,
			supportingRuns: opportunity.supportingRuns,
			domains: opportunity.domains,
			sources: [...new Set(opportunity.supportingRuns.map((id) => id.split('-')[0] ?? 'unknown'))]
				.filter((source): source is RunOutcomeSource =>
					source === 'experiment' || source === 'evaluation' || source === 'conversation'),
		},
		expectedBenefits: input.expectedBenefits,
		risks: input.risks,
		untestedCases: opportunity.untestedCases,
		validationCriteria: input.validationCriteria,
		strength: opportunity.strength,
		fingerprint: opportunity.fingerprint,
		createdAt: input.now,
	};
}

/** One sentence saying how the evidence reads, in the proposal's own voice. */
function buildRationale(opportunity: ImprovementOpportunity): string {
	switch (opportunity.strength) {
		case 'sustained-pattern':
			return (
				`Padrão sustentado por ${opportunity.sampleSize} execuções nos domínios ` +
				`${opportunity.domains.join(', ')}. A mudança é sustentada dentro desse escopo, ` +
				`e apenas dentro dele.`
			);
		case 'hypothesis':
			return (
				`Hipótese apoiada por ${opportunity.sampleSize} execuções. Poucas amostras: ` +
				`tratar como sugestão a observar, não como melhoria comprovada.`
			);
		case 'observation':
			return (
				`Observação única, ainda sem confirmação. Serve para registro; ` +
				`não justifica ativar uma mudança por si só.`
			);
	}
}

/** A field-by-field comparison of what is live and what is proposed. */
export interface SkillContentDiff {
	readonly fieldsChanged: readonly string[];
	readonly instructionsChanged: boolean;
	readonly currentLength: number;
	readonly proposedLength: number;
	/** Lines removed, then added. Enough to read the change; not a patch. */
	readonly instructionsDiff: readonly string[];
	readonly identical: boolean;
}

/** Lines that differ between two texts, capped so a big rewrite stays readable. */
const MAX_DIFF_LINES = 40;

/**
 * Compares what is live with what is proposed.
 *
 * A proposal the user cannot diff is a proposal they cannot approve, so the
 * diff is part of the proposal's data rather than something the UI has to
 * reconstruct — and it is built from the two stored contents, so it cannot
 * disagree with what would actually be activated.
 */
export function diffSkillContent(
	current: ProposedSkillContent | undefined,
	proposed: ProposedSkillContent,
): SkillContentDiff {
	const fieldsChanged: string[] = [];
	if (current === undefined) {
		fieldsChanged.push('title', 'description', 'instructions', 'tags', 'requiredTools', 'riskLevel', 'constraints');
	} else {
		if (current.title !== proposed.title) {
			fieldsChanged.push('title');
		}
		if (current.description !== proposed.description) {
			fieldsChanged.push('description');
		}
		if (current.instructions !== proposed.instructions) {
			fieldsChanged.push('instructions');
		}
		if (current.tags.join('|') !== proposed.tags.join('|')) {
			fieldsChanged.push('tags');
		}
		if (current.requiredTools.join('|') !== proposed.requiredTools.join('|')) {
			fieldsChanged.push('requiredTools');
		}
		if (current.riskLevel !== proposed.riskLevel) {
			fieldsChanged.push('riskLevel');
		}
		if (current.constraints.join('|') !== proposed.constraints.join('|')) {
			fieldsChanged.push('constraints');
		}
	}

	const currentInstructions = current?.instructions ?? '';
	const instructionsDiff =
		currentInstructions === proposed.instructions
			? []
			: [
					...removedLines(currentInstructions, proposed.instructions),
					...addedLines(currentInstructions, proposed.instructions),
				].slice(0, MAX_DIFF_LINES);

	return {
		fieldsChanged,
		instructionsChanged: currentInstructions !== proposed.instructions,
		currentLength: currentInstructions.length,
		proposedLength: proposed.instructions.length,
		instructionsDiff,
		identical: fieldsChanged.length === 0,
	};
}

/** Lines in `before` that `after` does not contain, as `-` entries. */
function removedLines(before: string, after: string): readonly string[] {
	const afterLines = new Set(after.split('\n'));
	return before
		.split('\n')
		.filter((line) => !afterLines.has(line))
		.slice(0, MAX_DIFF_LINES)
		.map((line) => `- ${line}`);
}

/** Lines in `after` that `before` does not contain, as `+` entries. */
function addedLines(before: string, after: string): readonly string[] {
	const beforeLines = new Set(before.split('\n'));
	return after
		.split('\n')
		.filter((line) => !beforeLines.has(line))
		.slice(0, MAX_DIFF_LINES)
		.map((line) => `+ ${line}`);
}

// ── validation ───────────────────────────────────────────────────────────────

/** Severity of one finding. `error` blocks activation; `warning` does not. */
export type ValidationSeverity = 'error' | 'warning';

/** One thing a validator noticed. */
export interface ValidationFinding {
	readonly severity: ValidationSeverity;
	readonly field: string;
	readonly message: string;
}

/** The verdict of validating a proposal. */
export interface ProposalValidation {
	readonly ok: boolean;
	readonly findings: readonly ValidationFinding[];
	/**
	 * Whether effectiveness could be established without a person.
	 *
	 * Never a number, never a guess. `false` means the only honest answer to
	 * "did this work?" is "ask the user", and the UI has to say that rather
	 * than imply a test ran.
	 */
	readonly effectivenessAutomaticallyProven: boolean;
}

/**
 * Patterns that make instructions suspicious to run unattended.
 *
 * Content written by a model is data, not code, and none of this is executed —
 * the list exists so a proposal containing it is surfaced as `dangerous` for a
 * human to look at, and so it cannot quietly claim to be `safe`.
 */
const UNSAFE_PATTERNS: readonly { readonly pattern: RegExp; readonly message: string }[] = [
	{ pattern: /curl\s+[^\n]*\|\s*(?:sh|bash)/i, message: 'contém download com execução direta (curl | sh)' },
	{ pattern: /\brm\s+-rf\s+\/(?!\w)/, message: 'contém remoção recursiva da raiz do sistema' },
	{ pattern: /\bsudo\b/i, message: 'contém elevação de privilégio (sudo)' },
	{ pattern: /\b(?:chmod|chown)\s+777\b/i, message: 'contém permissão ampliada (chmod 777)' },
	{ pattern: /<\?script|eval\s*\(/i, message: 'contém código executável embutido' },
];

/**
 * Checks a proposal before it can be approved.
 *
 * Structural and lexical only: required fields present, content non-empty, no
 * internal contradiction between the declared risk level and what the
 * instructions ask for, and criteria defined so the change can be judged at
 * all. Nothing here runs the instructions, tries them, or judges whether they
 * are *good* — a proposal can pass every check and still be a bad idea, which
 * is what the approval step is for.
 */
export function validateEvolutionProposal(proposal: SkillEvolutionProposal): ProposalValidation {
	const findings: ValidationFinding[] = [];
	const { proposed } = proposal;

	const requireText = (field: string, value: unknown, limit: number): void => {
		if (typeof value !== 'string' || value.trim().length === 0) {
			findings.push({ severity: 'error', field, message: `${field} é obrigatório e não pode ser vazio` });
			return;
		}
		if (value.length > limit) {
			findings.push({ severity: 'error', field, message: `${field} excede o limite de ${limit} caracteres` });
		}
	};

	requireText('title', proposed.title, 200);
	requireText('description', proposed.description, 500);
	requireText('instructions', proposed.instructions, 200_000);
	requireText('rationale', proposal.rationale, 2_000);
	requireText('problem', proposal.problem, 2_000);

	if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(proposal.proposedVersion)) {
		findings.push({
			severity: 'error',
			field: 'proposedVersion',
			message: 'proposedVersion deve ser uma versão semântica válida (ex.: "1.1.0")',
		});
	}

	if (!Array.isArray(proposed.tags) || proposed.tags.some((tag) => typeof tag !== 'string' || tag.length === 0)) {
		findings.push({ severity: 'error', field: 'tags', message: 'tags deve ser uma lista de textos não vazios' });
	}
	if (
		!Array.isArray(proposed.requiredTools) ||
		proposed.requiredTools.some((tool) => typeof tool !== 'string' || tool.length === 0)
	) {
		findings.push({
			severity: 'error',
			field: 'requiredTools',
			message: 'requiredTools deve ser uma lista de textos não vazios',
		});
	}
	if (!['safe', 'moderate', 'dangerous'].includes(proposed.riskLevel)) {
		findings.push({ severity: 'error', field: 'riskLevel', message: 'riskLevel deve ser safe, moderate ou dangerous' });
	}

	if (proposal.validationCriteria.length === 0) {
		findings.push({
			severity: 'error',
			field: 'validationCriteria',
			message: 'a proposta precisa de ao menos um critério para avaliar a melhoria',
		});
	} else {
		for (const criterion of proposal.validationCriteria) {
			if (
				typeof criterion.description !== 'string' ||
				criterion.description.trim().length === 0 ||
				typeof criterion.observableAs !== 'string' ||
				criterion.observableAs.trim().length === 0
			) {
				findings.push({
					severity: 'error',
					field: 'validationCriteria',
					message: `critério "${criterion.id}" precisa de description e observableAs`,
				});
			}
		}
	}

	if (proposal.evidence.sampleSize <= 0) {
		findings.push({
			severity: 'error',
			field: 'evidence',
			message: 'a proposta precisa de pelo menos uma evidência de execução',
		});
	}
	if (proposal.evidence.supportingRuns.length === 0) {
		findings.push({
			severity: 'warning',
			field: 'evidence',
			message: 'nenhuma execução citada; a proposta não é rastreável a nenhuma',
		});
	}
	if (proposal.strength === 'observation') {
		findings.push({
			severity: 'warning',
			field: 'strength',
			message: 'evidência de observação única: aprovada, isto precisa ser tratado como não comprovado',
		});
	}
	if (proposal.untestedCases.length === 0) {
		findings.push({
			severity: 'warning',
			field: 'untestedCases',
			message: 'a proposta não declara o que não foi testado',
		});
	}

	// The contradiction check that matters: instructions asking for writes,
	// commands or deletions while the skill declares itself safe. Declaring
	// `safe` here is not a lie a validator can allow, because `safe` is what
	// makes the permission engine skip asking.
	const asksForSideEffects =
		/\b(?:rm|del|delete|apagar|remover|drop|truncate)\b/i.test(proposed.instructions) ||
		/\b(?:sudo|curl|wget|exec|spawn|system\s*\()\b/i.test(proposed.instructions) ||
		proposed.requiredTools.some((tool) => /write|modify|delete|execute|terminal/i.test(tool));

	if (asksForSideEffects && proposed.riskLevel === 'safe') {
		findings.push({
			severity: 'error',
			field: 'riskLevel',
			message:
				'as instruções pedem efeitos colaterais (escrita, comando ou remoção) mas a skill se declara "safe", o que a faria pular a confirmação',
		});
	}

	for (const { pattern, message } of UNSAFE_PATTERNS) {
		if (pattern.test(proposed.instructions)) {
			findings.push({ severity: 'error', field: 'instructions', message });
		}
	}

	return {
		ok: findings.every((finding) => finding.severity !== 'error'),
		findings,
		// There is no automated way to know whether better instructions produced a
		// better result. Said here rather than left for the UI to imply.
		effectivenessAutomaticallyProven: false,
	};
}
