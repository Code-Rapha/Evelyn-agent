/**
 * O prompt de autorização local (DEV-7), atendido pelo **host**.
 *
 * ## Por que não é o renderer que pergunta
 *
 * Um `window.confirm` na página não prova nada: a página pode ter sido
 * reescrita pela agente, e a senha atravessaria o próprio contexto que ela
 * pode inspecionar. O `main` cria a pergunta e a envia só para a **janela do
 * host**; a página só mostra e devolve o que for digitado — e o `main` decide
 * se aquilo vale.
 *
 * ## O que não atravessa
 *
 * O desafio (aleatório, por pergunta) e o texto vão; a senha vem **uma vez**,
 * e é comparada no processo principal. Nenhum estado de autorização fica na
 * página, e nenhuma resposta anterior pode ser reutilizada: cada pergunta tem
 * um `id` novo e vale só até ser respondida, cancelada ou expirar.
 */

import { randomBytes } from 'node:crypto';

/** O que a página recebe para desenhar a pergunta. */
export interface OwnerPrompt {
	readonly id: string;
	readonly kind: 'authorize' | 'configure' | 'recover' | 'run-command';
	/** O texto para a pessoa (sem segredo). */
	readonly title: string;
	readonly detail: string;
	/** Quantos caracteres a página precisa enviar para configurar (mínimo). */
	readonly minLength?: number;
	/** Quando a pergunta deixa de valer (ISO). */
	readonly expiresAt: string;
}

/** A resposta da página. */
export type OwnerPromptAnswer =
	| { readonly id: string; readonly kind: 'cancel' }
	| {
			readonly id: string;
			readonly kind: 'password';
			readonly password: string;
			/**
			 * "Lembrar neste dispositivo", quando há como oferecer.
			 *
			 * Ausente = não lembrado. A escolha é da pessoa, por ativação: o
			 * recibo só é gravado quando esta marca chega verdadeira **e** o
			 * host oferece o recurso.
			 */
			readonly remember?: boolean;
	  }
	| { readonly id: string; readonly kind: 'configure'; readonly password: string; readonly confirmation: string };

export type OwnerPromptOutcome =
	| {
			readonly kind: 'answered';
			readonly password: string;
			readonly confirmation?: string;
			/** A pessoa pediu para lembrar neste dispositivo. */
			readonly remember?: boolean;
	  }
	/**
	 * A pessoa aprovou a execução de um comando (DEV-9.1).
	 *
	 * Não há senha: a pergunta de comando é uma confirmação de leitura —
	 * "este é o comando, este é o diretório, este é o escopo" — e a resposta
	 * vale só para aquela execução. Distinto de `answered`, que carrega
	 * credencial.
	 */
	| { readonly kind: 'approved' }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'expired' }
	| { readonly kind: 'rejected'; readonly reason: string };

/** O prazo de uma pergunta: curto, para não deixar a janela aberta esquecida. */
const PROMPT_TTL_MS = 120_000;

interface Pending {
	readonly prompt: OwnerPrompt;
	readonly resolve: (outcome: OwnerPromptOutcome) => void;
	readonly timer: NodeJS.Timeout;
}

/** O resolvedor: um por host. */
export class OwnerPromptBroker {
	private pending: Pending | undefined;

	constructor(
		private readonly send: (prompt: OwnerPrompt) => void,
		private readonly options: { readonly now?: () => Date; readonly ttlMs?: number } = {},
	) {}

	get waiting(): boolean {
		return this.pending !== undefined;
	}

	/**
	 * Abre uma pergunta e espera.
	 *
	 * Só uma por vez: uma segunda pergunta enquanto a primeira está aberta é
	 * recusada — duas janelas de senha é como uma interface de senha vira
	 * ruído, e uma delas pode não ser de quem acredita ser.
	 */
	ask(kind: OwnerPrompt['kind'], text: { readonly title: string; readonly detail: string; readonly minLength?: number; readonly canRemember?: boolean }): Promise<OwnerPromptOutcome> {
		if (this.pending !== undefined) {
			return Promise.resolve({ kind: 'rejected', reason: 'já há uma pergunta de autorização aberta' });
		}
		const now = this.options.now ?? (() => new Date());
		const ttl = this.options.ttlMs ?? PROMPT_TTL_MS;
		const prompt: OwnerPrompt = {
			id: `auth-${randomBytes(9).toString('hex')}`,
			kind,
			title: text.title,
			detail: text.detail,
			...(text.minLength !== undefined ? { minLength: text.minLength } : {}),
			...(text.canRemember === true ? { canRemember: true } : {}),
			expiresAt: new Date(now().getTime() + ttl).toISOString(),
		};
		return new Promise<OwnerPromptOutcome>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending?.prompt.id === prompt.id) {
					this.pending = undefined;
					resolve({ kind: 'expired' });
				}
			}, ttl);
			// Um prazo que não segura o processo aberto.
			timer.unref?.();
			this.pending = { prompt, resolve, timer };
			this.send(prompt);
		});
	}

	/**
	 * Atende a pergunta.
	 *
	 * `id` tem de ser o da pergunta **aberta**: uma resposta atrasada de uma
	 * pergunta anterior é ignorada, não aplicada à atual.
	 */
	answer(answer: unknown): { readonly accepted: boolean; readonly reason?: string } {
		const pending = this.pending;
		if (pending === undefined) {
			return { accepted: false, reason: 'não há pergunta de autorização aberta' };
		}
		if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
			return { accepted: false, reason: 'resposta inválida' };
		}
		const value = answer as Record<string, unknown>;
		if (value['id'] !== pending.prompt.id) {
			return { accepted: false, reason: 'a resposta não é para a pergunta aberta' };
		}
		const kind = value['kind'];
		if (kind === 'cancel') {
			this.finish({ kind: 'cancelled' });
			return { accepted: true };
		}
		// DEV-9.1: a aprovação de um comando não pede senha. Ela só é aceita
		// para a pergunta de comando — responder "aprovo" a uma pergunta de
		// autorização seria aprovar sem credencial.
		if (kind === 'approve') {
			if (pending.prompt.kind !== 'run-command') {
				return { accepted: false, reason: 'esta pergunta não aceita aprovação sem senha' };
			}
			this.finish({ kind: 'approved' });
			return { accepted: true };
		}
		const password = value['password'];
		if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
			return { accepted: false, reason: 'senha inválida' };
		}
		if (kind === 'password') {
			// "Lembrar" só conta como `true` explícito: qualquer outro valor é
			// "não lembrou", e o padrão continua sem gravar nada em disco.
			const remember = value['remember'] === true;
			this.finish({ kind: 'answered', password, ...(remember ? { remember } : {}) });
			return { accepted: true };
		}
		if (kind === 'configure') {
			const confirmation = value['confirmation'];
			if (typeof confirmation !== 'string' || confirmation.length > 1024) {
				return { accepted: false, reason: 'confirmação inválida' };
			}
			this.finish({ kind: 'answered', password, confirmation });
			return { accepted: true };
		}
		return { accepted: false, reason: 'tipo de resposta desconhecido' };
	}

	/** Encerra a pergunta aberta (janela fechada, sessão caindo). */
	cancel(): void {
		if (this.pending !== undefined) {
			this.finish({ kind: 'cancelled' });
		}
	}

	private finish(outcome: OwnerPromptOutcome): void {
		const pending = this.pending;
		if (pending === undefined) {
			return;
		}
		this.pending = undefined;
		clearTimeout(pending.timer);
		pending.resolve(outcome);
	}
}
