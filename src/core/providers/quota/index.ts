/**
 * Cotas e limites de uso de provedores.
 *
 * Módulo puro: lê o que a API informou (cabeçalhos, `429`, `Retry-After`) e
 * mantém o "esgotado agora" com prazo. Não conhece HTTP, disco nem host.
 */
export * from './headers';
export {
	createQuotaTracker,
	type QuotaCheck,
	type QuotaExhaustion,
	type QuotaScope,
	type QuotaScopeKey,
	type QuotaTracker,
	type QuotaTrackerOptions,
} from './tracker';
