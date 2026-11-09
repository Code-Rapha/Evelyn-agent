/**
 * As descrições em texto da janela de configuração.
 *
 * ## Por que um módulo sem DOM
 *
 * O renderer monta a tela; este módulo diz **o que** ela diz. A separação
 * permite testar os estados que importam - desconhecido, desatualizado,
 * incompatível, caiu para o preço do usuário, não elegível pela política, cota
 * que não é oficial - sem um DOM no ambiente de teste.
 *
 * E obriga a uma regra que é Easy de quebrar de outra forma: **desconhecido
 * nunca é zero**. Não existe caminho que produza "0" para um preço que ninguém
 * informou, e nenhum texto aqui diz "grátis" por ausência de valor.
 */
import type { MergedModelView, MergedPriceView, PolicyStatusView } from '../catalogFusion';
import type { DiscoveredQuotaView } from '../discoveryView';

/** O preço em uma frase, ou o que se sabe dele quando não há preço. */
export function describePriceAmounts(price: {
	readonly currency: string;
	readonly unit: 'per_1k_tokens' | 'per_1m_tokens';
	readonly input?: number;
	readonly output?: number;
}): string {
	const unit = price.unit === 'per_1m_tokens' ? 'por 1M tokens' : 'por 1k tokens';
	const parts: string[] = [];
	if (price.input !== undefined) {
		parts.push(`entrada ${price.input}`);
	}
	if (price.output !== undefined) {
		parts.push(`saída ${price.output}`);
	}
	return parts.length === 0
		? `${price.currency} (valores ausentes)`
		: `${parts.join(', ')} ${price.currency} ${unit}`;
}

/** O preço declarado, ou a ausência dele. */
export function describeDeclaredPrice(price: MergedPriceView | undefined): string {
	if (price === undefined) {
		return 'O seu preço: não declarado';
	}
	if (price.user === undefined) {
		return 'O seu preço: não declarado';
	}
	const saved = price.user.updatedAt !== undefined ? ` (salvo em ${price.user.updatedAt})` : '';
	return `O seu preço: ${describePriceAmounts(price.user)}${saved}`;
}

/** O preço publicado, com origem, data e validade. */
export function describeDiscoveredPrice(price: MergedPriceView | undefined): string {
	if (price === undefined || price.discovered === undefined) {
		return 'Preço do provedor: não publicado';
	}
	const found = price.discovered;
	const state = found.usable ? 'válido' : `não utilizável: ${found.unusableReason ?? 'desatualizado'}`;
	return `Preço do provedor: ${describePriceAmounts(found)} · ${found.source} · verificado em ${found.verifiedAt} · ${state}`;
}

/** O que impede a comparação, quando impede. */
export function describeIncompatibility(price: MergedPriceView | undefined): string | undefined {
	if (price === undefined || price.comparable) {
		return undefined;
	}
	return `Não comparável: ${price.incompatibleReason ?? 'os dois lados não podem ser lidos juntos'}. Nada é convertido.`;
}

/** A queda de volta ao preço declarado, quando acontece. */
export function describePriceFallback(price: MergedPriceView | undefined): string | undefined {
	if (price === undefined || !price.fellBack) {
		return undefined;
	}
	return 'O preço do provedor foi escolhido, mas não pode ser usado agora; vale o seu preço.';
}

/** O preço que vale, e por que. */
export function describeEffectivePrice(price: MergedPriceView | undefined): string {
	if (price === undefined || price.effective === undefined) {
		return 'Preço em vigor: desconhecido (nunca zero)';
	}
	const side = price.effective.side === 'user' ? 'o seu' : 'do provedor';
	return `Preço em vigor: ${describePriceAmounts(price.effective)} · ${side} · ${price.effective.reason}`;
}

/** A classificação de acesso, e de onde ela veio. */
export function describeAccessLine(model: MergedModelView): string {
	const parts: string[] = [];
	if (!model.listed) {
		parts.push('fora da listagem');
	}
	const access = model.access;
	if (access !== undefined) {
		const validity = access.usable ? '' : ', evidência vencida';
		parts.push(`acesso ${access.access} (${access.source}${validity})`);
	} else if (model.declaredAccess !== undefined && model.declaredAccess !== 'unknown') {
		parts.push(`acesso ${model.declaredAccess} (declarado)`);
	} else {
		parts.push('acesso desconhecido');
	}
	const status = model.policyStatus;
	if (!status.eligible) {
		parts.push(`não elegível pela política: ${describePolicyExclusion(status)}`);
	}
	return parts.length === 0 ? '' : ` — ${parts.join('; ')}`;
}

/** Por que a política não aceitou o modelo. */
export function describePolicyExclusion(status: PolicyStatusView): string {
	switch (status.reason) {
		case 'paid':
			return 'classificado como pago';
		case 'free_evidence_expired':
			return 'evidência de gratuito vencida';
		case 'free_not_confirmed':
			return 'sem confirmação de gratuito';
		default:
			return 'motivo desconhecido';
	}
}

/** A política em vigor, e como ela chegou até ali. */
export function describePolicy(policy: {
	readonly policy: 'any' | 'free_only' | 'free_preferred';
	readonly changedBy: 'user' | 'phrase';
}): string {
	const origin = policy.changedBy === 'phrase' ? 'aplicada pela frase no chat' : 'definida nesta janela';
	switch (policy.policy) {
		case 'free_only':
			return `Somente gratuitos confirmados (${origin})`;
		case 'free_preferred':
			return `Gratuitos primeiro, demais permitidos (${origin})`;
		case 'any':
			return `Sem filtro de acesso (${origin})`;
	}
}

	/**
	 * O nome da origem de uma cota, com a distinção que importa.
	 *
	 * Uma estimativa local é estimada, e o texto diz isso. Um limite publicado é
	 * publicado. Uma observação em teste é observação. Nenhum dos três vira
	 * "limite oficial" por elegância.
	 */
export function describeQuotaSource(source: string): string {
	switch (source) {
		case 'published':
			return 'Limite oficial publicado pelo provedor';
		case 'account':
			return 'Informado pela API para esta conta';
		case 'usage':
			return 'Uso contabilizado pela Evelyn';
		case 'estimate':
			return 'Estimativa local (não é limite oficial)';
		case 'observed':
			return 'Observado em teste (não é limite oficial)';
		default:
			return 'Origem desconhecida';
	}
}

/**
 * Um valor fundido, em uma frase.
 *
 * Mostra os dois lados quando eles discordam, e diz de que lado veio o
 * valor em vigor. Um valor ausente vira "desconhecido" — nunca `0` e nunca
 * `false`.
 */
export function describeFusedField(
	field:
		| {
				readonly user?: unknown;
				readonly discovered?: {
					readonly value: unknown;
					readonly source: string;
					readonly verifiedAt: string;
					readonly expiresAt: string;
					readonly stale: boolean;
					readonly usable: boolean;
					readonly unusableReason?: string;
				};
				readonly conflict: boolean;
				readonly selected: 'user' | 'discovered';
				readonly effective?: unknown;
				readonly fellBack: boolean;
				readonly unusableReason?: string;
		  }
		| undefined,
): string {
	if (field === undefined) {
		return 'desconhecido';
	}
	const format = (value: unknown): string => {
		if (typeof value === 'boolean') {
			return value ? 'sim' : 'não';
		}
		if (typeof value === 'number') {
			return value.toLocaleString('pt-BR');
		}
		return String(value);
	};
	const parts: string[] = [];
	if (field.user !== undefined) {
		parts.push(`você: ${format(field.user)}`);
	}
	if (field.discovered !== undefined) {
		const state = field.discovered.usable ? '' : ` (${field.discovered.unusableReason ?? 'desatualizado'})`;
		parts.push(
			`provedor: ${format(field.discovered.value)} · ${field.discovered.source} · verificado em ${field.discovered.verifiedAt}${state}`,
		);
	}
	if (parts.length === 0) {
		return 'desconhecido';
	}
	if (field.conflict) {
		parts.push('os dois discordam');
	}
	const chosen = field.selected === 'user' ? 'vale o seu' : 'vale o do provedor';
	if (field.fellBack) {
		parts.push(`${chosen} (a escolha caiu para lá)`);
	} else if (field.effective !== undefined) {
		parts.push(`${chosen}: ${format(field.effective)}`);
	}
	return parts.join(' · ');
}

/** O relatório de decisão, em linhas legíveis. */
export function describeDecisionReport(report: {
	readonly strategy: string;
	readonly policy: string;
	readonly policyApplied: boolean;
	readonly chosen?: { readonly providerId: string; readonly modelId: string; readonly reason: string; readonly access: string };
	readonly alternatives: readonly { readonly providerId: string; readonly modelId: string; readonly reason: string }[];
	readonly attempts: readonly { readonly modelId: string; readonly outcome: string; readonly errorClass?: string; readonly fallback: boolean; readonly cost?: { readonly status: 'estimated' | 'unknown'; readonly currency?: string; readonly total?: number } }[];
	readonly result: string;
	readonly summary: string;
}): string[] {
	const lines: string[] = [];
	lines.push(
		`Estratégia ${report.strategy} · política ${report.policy}${report.policyApplied ? ' (aplicada)' : ''} · resultado ${report.result}`,
	);
	if (report.chosen !== undefined) {
		lines.push(
			`Escolhido ${report.chosen.providerId}/${report.chosen.modelId} (${report.chosen.access}) — ${report.chosen.reason}`,
		);
	}
	for (const alternative of report.alternatives.slice(0, 5)) {
		lines.push(
			`Descartado ${alternative.providerId}/${alternative.modelId} — ${alternative.reason}`,
		);
	}
	for (const attempt of report.attempts) {
		const why = attempt.errorClass !== undefined ? ` (${attempt.errorClass})` : '';
		lines.push(
		`Tentativa ${attempt.modelId}: ${attempt.outcome}${why}${attempt.fallback ? ' — fallback' : ''}${describeCost(attempt.cost)}`,
		);
	}
	lines.push(report.summary);
	return lines;
}

	/** O custo de uma tentativa, com a natureza dele. */
	function describeCost(
		cost: { readonly status: 'estimated' | 'unknown'; readonly currency?: string; readonly total?: number } | undefined,
	): string {
		if (cost === undefined) {
			return '';
		}
		if (cost.status === 'estimated') {
			const amount = cost.total !== undefined ? cost.total : '?';
			const currency = cost.currency !== undefined ? ` ${cost.currency}` : '';
			return ` — custo estimado ${amount}${currency}`;
		}
		return ' — custo desconhecido';
	}

/**
 * A comparação de duas execuções, em linhas.
 *
 * A comparação tem um **status** — aceita, limitada ou recusada — e as
 * métricas uma a uma, cada uma com a natureza do seu valor: medida,
 * publicada, estimada, desconhecida ou indisponível. Uma métrica que não é
 * comparável diz **por que** não é, e o limite fica escrito: duas execuções
 * sob condições diferentes não são um experimento controlado, e a tela não
 * as apresenta como se fossem.
 */
export function describeComparison(comparison: {
	readonly status: 'accepted' | 'limited' | 'refused';
	readonly reason?: string;
	readonly detail?: string;
	readonly a?: {
		readonly executionId: string;
		readonly timestamp: string;
		readonly model?: { readonly modelId: string };
		readonly score?: number;
		readonly result: string;
	};
	readonly b?: {
		readonly executionId: string;
		readonly timestamp: string;
		readonly model?: { readonly modelId: string };
		readonly score?: number;
		readonly result: string;
	};
	readonly metrics?: readonly {
		readonly id: string;
		readonly label: string;
		readonly comparable: boolean;
		readonly limit?: string;
		readonly a?: { readonly text: string; readonly kind: string };
		readonly b?: { readonly text: string; readonly kind: string };
		readonly difference?: string;
	}[];
	readonly differences?: readonly string[];
	readonly context?: readonly {
		readonly what: string;
		readonly a: string;
		readonly b: string;
		readonly affects: readonly string[];
	}[];
	readonly limits?: readonly string[];
}): string[] {
	if (comparison.status === 'refused') {
		return [`Comparação recusada: ${comparison.detail ?? 'sem dados'}.`];
	}
	const lines: string[] = [];
	const statusLabel =
		comparison.status === 'accepted'
			? 'Comparação aceita — condições iguais'
			: 'Comparação limitada — as condições não eram as mesmas';
	lines.push(`${statusLabel}. ${comparison.reason ?? ''}`.trim());
	for (const side of [comparison.a, comparison.b]) {
		if (side === undefined) {
			continue;
		}
		lines.push(
			`${side.timestamp}: ${side.model?.modelId ?? 'sem modelo'} · ${
				side.score !== undefined ? `score ${side.score} (pontuado)` : 'score não pontuado'
			} · ${side.result}`,
		);
	}
	for (const metric of comparison.metrics ?? []) {
		const kind = (value: { readonly kind: string } | undefined): string =>
			value === undefined ? 'ausente' : value.kind;
		const comparable = metric.comparable ? 'comparável' : `não comparável (${metric.limit ?? 'condições diferentes'})`;
		lines.push(
			`${metric.label}: ${comparable} · A ${metric.a?.text ?? '—'} (${kind(metric.a)}) · B ${
				metric.b?.text ?? '—'
			} (${kind(metric.b)})`,
		);
	}
	if ((comparison.context ?? []).length > 0) {
		lines.push('Condições que diferem:');
		for (const difference of comparison.context ?? []) {
			lines.push(
				`  ${difference.what}: ${difference.a} contra ${difference.b} — afeta ${difference.affects.join(', ')}`,
			);
		}
	}
	for (const limit of comparison.limits ?? []) {
		lines.push(`Limite: ${limit}`);
	}
	if ((comparison.differences ?? []).length > 0) {
		lines.push('Diferenças:');
		for (const difference of comparison.differences ?? []) {
			lines.push(`  ${difference}`);
		}
	}
	return lines;
}

/**
 * A explicação da classificação, em linhas.
 *
 * A classificação explica **como** a tarefa foi entendida: o domínio e as
 * palavras-chave que o indicaram, a evidência da complexidade, o motivo de cada
 * capacidade exigida, a base da confiança e o que faltou. Nenhuma linha aqui
 * contém o texto do usuário.
 */
export function describeTaskExplanation(task: {
	readonly domain: {
		readonly detected: string;
		readonly hits: readonly { readonly rule: string; readonly keyword: string; readonly detail: string }[];
		readonly considered: readonly { readonly domain: string; readonly hits: number }[];
		readonly reason: string;
	};
	readonly complexity: {
		readonly detected: string;
		readonly evidence: readonly { readonly source: string; readonly detail: string }[];
	};
	readonly capabilities: readonly {
		readonly capability: string;
		readonly hits: readonly { readonly rule: string; readonly keyword: string; readonly detail: string }[];
		readonly reason: string;
	}[];
	readonly tools: {
		readonly needed: boolean;
		readonly hits: readonly { readonly rule: string; readonly keyword: string; readonly detail: string }[];
	};
	readonly confidence: {
		readonly value: number;
		readonly level: string;
		readonly basis: string;
	};
	readonly missingInformation: readonly { readonly item: string; readonly rule: string }[];
}): string[] {
	const lines: string[] = [];
	lines.push(
		`Domínio: ${task.domain.detected} — ${task.domain.reason}`,
	);
	for (const hit of task.domain.hits) {
		lines.push(`  ${hit.rule}: "${hit.keyword}"`);
	}
	lines.push(`Complexidade: ${task.complexity.detected}`);
	for (const evidence of task.complexity.evidence) {
		lines.push(`  ${evidence.source}: ${evidence.detail}`);
	}
	lines.push(`Ferramentas: ${task.tools.needed ? 'necessárias' : 'não necessárias'}`);
	for (const hit of task.tools.hits) {
		lines.push(`  ${hit.rule}: "${hit.keyword}"`);
	}
	for (const capability of task.capabilities) {
		lines.push(`Capacidade ${capability.capability}: ${capability.reason}`);
		for (const hit of capability.hits) {
			lines.push(`  ${hit.rule}: "${hit.keyword}"`);
		}
	}
	lines.push(
		`Confiança: ${task.confidence.level} (${task.confidence.value}) — ${task.confidence.basis}`,
	);
	if (task.missingInformation.length > 0) {
		lines.push('Faltou:');
		for (const missing of task.missingInformation) {
			lines.push(`  ${missing.item} (${missing.rule})`);
		}
	}
	return lines;
}

/** Uma cota, com o que a fonte disse e o que a Evelyn contou. */
export function describeQuota(quota: DiscoveredQuotaView): string[] {
	const lines: string[] = [];
	const account = quota.account;
	if (account === undefined) {
		lines.push('Limite oficial: desconhecido.');
	} else {
		const parts: string[] = [describeQuotaSource(account.source)];
		if (account.value !== undefined) {
			parts.push(`valor ${account.value}`);
		}
		if (account.resetAt !== undefined) {
			parts.push(`reinicia em ${account.resetAt}`);
		}
		if (account.retryAfterMs !== undefined) {
			parts.push(`tentar de novo em ${Math.round(account.retryAfterMs / 1000)}s`);
		}
		parts.push(`verificado em ${account.verifiedAt}`);
		lines.push(parts.join(' · '));
	}
	const usage = quota.usage;
	if (usage !== undefined) {
		lines.push(
			`Uso contabilizado pela Evelyn: ${usage.requests} requisições, ${usage.inputTokens} tokens de entrada, ${usage.outputTokens} de saída (desde ${usage.since}).`,
		);
	}
	return lines;
}
