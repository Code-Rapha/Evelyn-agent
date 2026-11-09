/**
 * Task discovery: classifies the user's request into a structured description
 * that can guide model selection and orchestration.
 *
 * Pure, host-free, no network. The caller provides only the user's message
 * and minimal context (recent history summary). No secrets, no full transcript.
 */

export type TaskDomain =
	| 'coding'
	| 'file-analysis'
	| 'blender'
	| 'api-design'
	| 'database'
	| 'networking'
	| 'general'
	| 'unknown';

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'unknown';

export interface TaskClassification {
	/** The main goal the user appears to have. */
	readonly primaryGoal: string;
	/** Probable domain, or 'unknown' when there isn't enough information. */
	readonly domain: TaskDomain;
	/** Estimated complexity. 'unknown' when the request is too short or ambiguous. */
	readonly complexity: TaskComplexity;
	/** Whether the task likely needs tools (file ops, commands, etc.). */
	readonly needsTools: boolean;
	/** Capabilities the task seems to require (e.g., 'reasoning', 'code-generation', 'long-context'). */
	readonly requiredCapabilities: readonly string[];
	/** Information the user did not provide but the task would need. */
	readonly missingInformation: readonly string[];
	/** 0..1: how confident the classification is. Low when the message is short/ambiguous. */
	readonly confidence: number;
	/** Human-readable reason for the classification (for logging/debugging). */
	readonly rationale: string;
	/**
	 * The rules that produced this classification.
	 *
	 * Absent on a classification built elsewhere (a test, a saved record). When
	 * present, it names the rules and the fixed vocabulary items that fired —
	 * never the message, and never a fragment of it.
	 */
	readonly explanation?: TaskClassificationExplanation;
}

/** Keywords and patterns that hint at each domain. */
const DOMAIN_HINTS: Readonly<Record<Exclude<TaskDomain, 'unknown' | 'general'>, readonly string[]>> = {
	coding: [
		'código', 'code', 'função', 'function', 'classe', 'class', 'bug', 'erro', 'error',
		'refator', 'refactor', 'teste', 'test', 'build', 'compil', 'typescript', 'javascript',
		'python', 'rust', 'go', 'java', 'c++', 'c#', 'api', 'endpoint', 'backend', 'frontend',
		'react', 'vue', 'node', 'express', 'fastapi', 'django', 'sql', 'query', 'migration',
		'git', 'commit', 'branch', 'merge', 'deploy', 'docker', 'kubernetes', 'ci/cd',
	],
	'file-analysis': [
		'arquivo', 'file', 'pasta', 'folder', 'diretório', 'directory', 'leia', 'read',
		'analise', 'analyze', 'resuma', 'summarize', 'liste', 'list', 'encontre', 'find',
		'grep', 'busca', 'search', 'conteúdo', 'content', 'estrutura', 'structure',
	],
	blender: [
		'blender', '3d', 'modelo', 'model', 'render', 'animação', 'animation',
		'material', 'shader', 'geometry nodes', 'python api', 'bpy',
	],
	'api-design': [
		'api', 'rest', 'graphql', 'grpc', 'endpoint', 'schema', 'openapi', 'swagger',
		'contrato', 'contract', 'versionamento', 'versioning', 'rate limit', 'autenticação',
		'authentication', 'oauth', 'jwt',
	],
	database: [
		'banco', 'database', 'sql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis',
		'tabela', 'table', 'índice', 'index', 'query', 'migration', 'schema', 'orm',
		'prisma', 'drizzle', 'sqlalchemy', 'entity', 'relation', 'join', 'transação',
	],
	networking: [
		'rede', 'network', 'http', 'https', 'tcp', 'udp', 'dns', 'ssl', 'tls', 'certificado',
		'proxy', 'load balancer', 'websocket', 'grpc', 'rpc', 'firewall', 'porta', 'port',
		'latência', 'latency', 'throughput', 'banda', 'bandwidth',
	],
};

/** Keywords that hint at tool usage. */
const TOOL_HINTS = [
	'crie', 'create', 'escreva', 'write', 'edite', 'edit', 'apague', 'delete',
	'rode', 'run', 'execute', 'build', 'teste', 'test', 'lint', 'formate', 'format',
	'liste', 'list', 'mostre', 'show', 'leia', 'read', 'busque', 'find', 'grep',
	'commit', 'push', 'pull', 'merge', 'branch', 'deploy', 'instale', 'install',
];

/** Keywords that hint at specific capabilities. */
const CAPABILITY_HINTS: Readonly<Record<string, readonly string[]>> = {
	reasoning: ['raciocine', 'reason', 'pense', 'think', 'analise profundamente', 'step by step', 'cadeia de pensamento', 'chain of thought'],
	'code-generation': ['gere código', 'generate code', 'escreva a implementação', 'write the implementation', 'implemente', 'implement'],
	'long-context': ['arquivo grande', 'large file', 'muito código', 'lot of code', 'contexto longo', 'long context', 'todo o projeto', 'whole project'],
	'structured-output': ['json', 'formato', 'format', 'estruturado', 'structured', 'schema', 'typescript types', 'type definitions', 'type hints'],
	'multilingual': ['traduza', 'translate', 'inglês', 'english', 'espanhol', 'spanish', 'francês', 'french'],
};

/**
 * A classification, with the rules that produced it.
 *
 * ## What is recorded, and what is not
 *
 * Recorded: the **rule** that fired and the **fixed vocabulary item** it
 * fired on. Both come from the tables in this module — `code`, `bug`,
 * `gere código` — so they are the rules themselves, not the user's sentence.
 *
 * Not recorded: the message, any excerpt of it, the conversation, the history
 * that was consulted, or anything else the user wrote. A classification is
 * enough to explain a routing decision without keeping what was said.
 *
 * ## The confidence number
 *
 * `classifyTask` already computes a confidence. It is recorded as computed —
 * the number and the basis that produced it — and a qualitative level is
 * derived from that same number. No probability is invented here.
 */
export interface TaskClassificationExplanation {
	/** The domain, and the rules that pointed at it. */
	readonly domain: {
		readonly detected: TaskDomain;
		/** The vocabulary items that fired for the winning domain. */
		readonly hits: readonly TaskRuleHit[];
		/** How many items each domain collected. Empty when nothing matched. */
		readonly considered: readonly { readonly domain: TaskDomain; readonly hits: number }[];
		/** Why the domain is what it is. */
		readonly reason: string;
	};
	/** The complexity, and what it was read from. */
	readonly complexity: {
		readonly detected: TaskComplexity;
		readonly evidence: readonly TaskComplexityEvidence[];
	};
	/** Each required capability, and why it was required. */
	readonly capabilities: readonly {
		readonly capability: string;
		readonly hits: readonly TaskRuleHit[];
		readonly reason: string;
	}[];
	/** Whether tools are needed, and on what basis. */
	readonly tools: {
		readonly needed: boolean;
		readonly hits: readonly TaskRuleHit[];
	};
	/** The confidence, the number the classifier computed and its basis. */
	readonly confidence: {
		readonly value: number;
		readonly level: 'low' | 'medium' | 'high';
		readonly basis: string;
	};
	/** What was missing, and the rule that looked for it. */
	readonly missingInformation: readonly {
		readonly item: string;
		readonly rule: string;
	}[];
}

/**
 * One rule that fired, and the vocabulary item that made it fire.
 *
 * The keyword is always one of the fixed tables of this module. It is the
 * rule's own name, not a fragment of the user's message.
 */
export interface TaskRuleHit {
	/** The rule, e.g. `domain.coding` or `capability.reasoning`. */
	readonly rule: string;
	/** The vocabulary item that fired. */
	readonly keyword: string;
	/** What the rule concluded. */
	readonly detail: string;
}

/** The evidence behind a complexity estimate. */
export interface TaskComplexityEvidence {
	/** Where the estimate came from. */
	readonly source: 'message_length' | 'marker';
	/** What was observed, in structural terms. */
	readonly detail: string;
}

/**
 * Classifies a task from the user's message and optional recent context.
 *
 * @param userMessage - The user's latest message (required).
 * @param recentHistory - Optional summary of recent messages (last 3-5 turns), for context.
 * @returns A structured classification. Never throws.
 */
export function classifyTask(
	userMessage: string,
	recentHistory?: readonly { role: string; content: string }[],
): TaskClassification {
	const text = userMessage.toLowerCase();
	const historyText = recentHistory?.map((m) => m.content.toLowerCase()).join(' ') ?? '';
	const combined = `${text} ${historyText}`.trim();

	// Domain detection
	let domain: TaskDomain = 'unknown';
	let domainScore = 0;
	const domainHits = new Map<string, string[]>();
	const considered: { domain: TaskDomain; hits: number }[] = [];
	for (const [d, keywords] of Object.entries(DOMAIN_HINTS)) {
		const fired = keywords.filter((kw) => combined.includes(kw));
		considered.push({ domain: d as TaskDomain, hits: fired.length });
		if (fired.length > 0) {
			domainHits.set(d, fired);
		}
		const score = fired.length;
		if (score > domainScore) {
			domainScore = score;
			domain = d as TaskDomain;
		}
	}
	if (domainScore === 0) {
		domain = 'general';
	}

	// Tool need detection
	const toolHits = TOOL_HINTS.filter((kw) => combined.includes(kw));
	const needsTools = toolHits.length > 0;

	// Capability detection
	const requiredCapabilities: string[] = [];
	const capabilityHits = new Map<string, string[]>();
	for (const [cap, keywords] of Object.entries(CAPABILITY_HINTS)) {
		const fired = keywords.filter((kw) => combined.includes(kw));
		if (fired.length > 0) {
			capabilityHits.set(cap, fired);
			requiredCapabilities.push(cap);
		}
	}
	// Default: if coding domain and no specific capability, assume code-generation
	if (domain === 'coding' && requiredCapabilities.length === 0) {
		requiredCapabilities.push('code-generation');
	}

	// Complexity estimation (very rough heuristic)
	let complexity: TaskComplexity = 'unknown';
	const wordCount = userMessage.trim().split(/\s+/).length;
	const complexityEvidence: TaskComplexityEvidence[] = [];
	if (wordCount < 5) {
		complexity = 'unknown';
	} else if (wordCount < 15) {
		complexity = 'trivial';
	} else if (wordCount < 40) {
		complexity = 'simple';
	} else if (wordCount < 100) {
		complexity = 'moderate';
	} else {
		complexity = 'complex';
	}
	complexityEvidence.push({
		source: 'message_length',
		detail: `a mensagem tem ${wordCount} palavra(s)`,
	});
	// Upgrade if specific complexity markers present
	const complexityMarker = /\b(complexo|complex|difícil|hard|avançado|advanced|arquitetura|architecture|sistema|system)\b/i.exec(
		combined,
	);
	if (complexityMarker !== null) {
		if (complexity === 'trivial' || complexity === 'simple') complexity = 'moderate';
		else if (complexity === 'moderate') complexity = 'complex';
		complexityEvidence.push({
			source: 'marker',
			detail: 'a mensagem contém um marcador de complexidade',
		});
	}

	// Missing information detection (very basic)
	const missingInformation: string[] = [];
	const missingEvidence: { item: string; rule: string }[] = [];
	if (domain === 'coding' && !/\b(linguagem|language|framework|biblioteca|library)\b/i.test(combined)) {
		missingInformation.push('linguagem ou framework alvo');
		missingEvidence.push({
			item: 'linguagem ou framework alvo',
			rule: 'coding.sem_alvo',
		});
	}
	if (domain === 'database' && !/\b(postgres|mysql|sqlite|mongo|redis)\b/i.test(combined)) {
		missingInformation.push('banco de dados alvo');
		missingEvidence.push({
			item: 'banco de dados alvo',
			rule: 'database.sem_alvo',
		});
	}
	if (needsTools && !/\b(workspace|projeto|project|pasta|folder|diretório)\b/i.test(combined)) {
		missingInformation.push('caminho do workspace/projeto');
		missingEvidence.push({
			item: 'caminho do workspace/projeto',
			rule: 'tools.sem_workspace',
		});
	}

	// Confidence: based on message length and domain match strength
	let confidence = Math.min(0.3 + wordCount * 0.01 + domainScore * 0.1, 0.95);
	if (domain === 'unknown') confidence = Math.min(confidence, 0.3);
	if (domain === 'general') confidence = Math.min(confidence, 0.5);

	// Primary goal: first sentence or first 120 chars
	const firstSentence = userMessage.trim().split(/[.!?]/)[0]?.trim() ?? userMessage.trim();
	const primaryGoal = firstSentence.length > 120 ? `${firstSentence.slice(0, 117)}…` : firstSentence;

	// Rationale for logging
	const rationaleParts: string[] = [];
	if (domain !== 'unknown' && domain !== 'general') rationaleParts.push(`domain=${domain} (${domainScore} hints)`);
	else rationaleParts.push('domain=unknown/general');
	rationaleParts.push(`tools=${needsTools}`);
	if (requiredCapabilities.length > 0) rationaleParts.push(`caps=[${requiredCapabilities.join(', ')}]`);
	if (missingInformation.length > 0) rationaleParts.push(`missing=[${missingInformation.join(', ')}]`);
	rationaleParts.push(`words=${wordCount}`);
	const rationale = rationaleParts.join('; ');

	const explanation: TaskClassificationExplanation = {
		domain: {
			detected: domain,
			hits: (domainHits.get(domain) ?? []).map((keyword) => ({
				rule: `domain.${domain}`,
				keyword,
				detail: `palavra-chave do domínio "${domain}"`,
			})),
			considered: considered.filter((entry) => entry.hits > 0),
			reason:
				domainScore === 0
					? 'nenhuma palavra-chave de domínio apareceu; a tarefa ficou como geral'
					: `${domainScore} palavra(s)-chave do domínio "${domain}" apareceram`,
		},
		complexity: { detected: complexity, evidence: complexityEvidence },
		capabilities: requiredCapabilities.map((capability) => {
			const hits = capabilityHits.get(capability) ?? [];
			return {
				capability,
				hits: hits.map((keyword) => ({
					rule: `capability.${capability}`,
					keyword,
					detail: `palavra-chave da capacidade "${capability}"`,
				})),
				reason:
					hits.length > 0
						? `${hits.length} palavra(s)-chave indicaram esta capacidade`
						: 'capacidade assumida pelo padrão do domínio de código, sem palavra-chave',
			};
		}),
		tools: {
			needed: needsTools,
			hits: toolHits.map((keyword) => ({
				rule: 'tools',
				keyword,
				detail: 'palavra-chave que indica uso de ferramenta',
			})),
		},
		confidence: {
			value: Number(confidence.toFixed(2)),
			level: confidence < 0.5 ? 'low' : confidence < 0.8 ? 'medium' : 'high',
			basis:
				domain === 'general'
					? `base ${wordCount} palavra(s) e ${domainScore} palavra(s)-chave de domínio, limitada a 0.5 por não haver domínio`
					: `base ${wordCount} palavra(s) e ${domainScore} palavra(s)-chave de domínio`,
		},
		missingInformation: missingEvidence,
	};

	return {
		primaryGoal,
		domain,
		complexity,
		needsTools,
		requiredCapabilities,
		missingInformation,
		confidence: Number(confidence.toFixed(2)),
		rationale,
		explanation,
	};
}