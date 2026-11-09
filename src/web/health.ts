/**
 * O `GET /api/health`: o servidor está de pé, e nada além disso.
 *
 * ## O que ele responde
 *
 * Se o servidor está servindo, qual versão, qual host ele **é** e o que ele
 * já conseguiu montar. É o que um operador precisa para saber "o servidor
 * está no ar?" sem abrir a interface.
 *
 * ## O que ele nunca responde
 *
 * Nenhum dado pessoal e nenhum segredo: sem caminho do diretório de dados,
 * sem nome de provedor, sem chave — nem a referência dela. O diretório de
 * dados é útil para um humano e é um caminho com o nome de usuário dentro;
 * o health não tem por que carregá-lo. Se um dia precisar, será um endpoint
 * autenticado a mais, não este.
 */
import { CONTENT_SECURITY_POLICY } from './policy';

/** O health, como o servidor o monta. */
export interface HealthReport {
	readonly status: 'ok';
	readonly app: string;
	readonly version: string;
	/** O host que o servidor é, e em que porta — o mesmo que ele aceita. */
	readonly listening: string;
	readonly uptimeSeconds: number;
	/** O que já montou. Falso é o estado normal da Fase 1. */
	readonly coreMounted: boolean;
	/** O host dono da raiz de dados, quando há uma. `null` = não pediu a raiz. */
	readonly storageHost: string | null;
	/**
	 * O processo que responde.
	 *
	 * É o que permite ao cliente conferir que quem respondeu naquela porta é
	 * o mesmo processo que gravou o registro do serviço — e não um impostor
	 * que tomou a porta depois. Um número não é dado pessoal.
	 */
	readonly pid?: number;
}

export interface HealthContext {
	readonly app: string;
	readonly version: string;
	readonly port: number;
	readonly startedAt: number;
	readonly coreMounted: boolean;
	readonly storageHost: string | null;
	/** O pid de quem responde; ausente só em teste que não o informa. */
	readonly pid?: number;
	readonly now?: () => number;
}

/** Monta o corpo do health a partir do que o servidor sabe de si. */
export function buildHealth(context: HealthContext): HealthReport {
	const now = (context.now ?? Date.now)();
	return {
		status: 'ok',
		app: context.app,
		version: context.version,
		listening: `127.0.0.1:${context.port}`,
		uptimeSeconds: Math.max(0, Math.round((now - context.startedAt) / 1000)),
		coreMounted: context.coreMounted,
		storageHost: context.storageHost,
		...(context.pid !== undefined ? { pid: context.pid } : {}),
	};
}

/** Os headers de toda resposta JSON desta API. */
export function jsonHeaders(): Record<string, string> {
	return {
		'Content-Type': 'application/json; charset=utf-8',
		// A resposta de API não é um documento: sem CSP de página, mas com a
		// proibição de ser lida de fora mantida pelos base headers.
		'Content-Security-Policy': CONTENT_SECURITY_POLICY,
	};
}
