/**
 * A fronteira IPC do painel DEV (DEV-6).
 *
 * ## O que esta camada decide
 *
 * Nada de autorização — isso é do `DevHost`. O que ela faz é **recusar cedo**
 * o que nem deveria chegar ao host: ação desconhecida, argumento com o tipo
 * errado, string longa demais, campo a mais. A página é a parte menos
 * confiável do app; a validação mora aqui, no processo principal, e não numa
 * condição do renderer.
 *
 * ## O que nunca atravessa
 *
 * Caminhos, comandos, tokens de sessão, conteúdo de arquivo. As duas únicas
 * coisas que a página manda são: **qual ação**, e o **id** de uma operação ou
 * de um checkpoint que o host já conhece. Ids são comparados com os que o host
 * tem em mãos — nunca usados para montar caminho.
 */

/**
 * As ações que a página pode pedir.
 *
 * `configure` e `recover` **não** carregam senha: quem a pede é o `main`
 * (`ownerPrompt`), e a resposta é atendida por um canal separado, só com o id
 * da pergunta aberta. Uma ação com `password` no payload é recusada pelo campo
 * a mais.
 */
export const DEV_ACTIONS = [
	'state',
	'refresh',
	'activate',
	'deactivate',
	'apply',
	'restore',
	'configure',
	'recover',
	'lock',
	'revoke',
	// DEV-9.1: o histórico das execuções do `dev_run`. Leitura pura: nenhum
	// argumento, nenhum efeito.
	'history',
] as const;

export type DevAction = (typeof DEV_ACTIONS)[number];

/** Um pedido validado. */
export type DevRequest =
	| {
			readonly action:
				| 'state'
				| 'refresh'
				| 'activate'
				| 'deactivate'
				| 'configure'
				| 'recover'
				| 'lock'
				| 'revoke'
				| 'history';
	  }
	| { readonly action: 'apply'; readonly operationId: string }
	| { readonly action: 'restore'; readonly checkpointId?: string };

/** A recusa da validação. */
export class DevIpcError extends Error {
	readonly code = 'dev_ipc_invalid';
	constructor(message: string) {
		super(message);
		this.name = 'DevIpcError';
	}
}

/** O tamanho máximo de um id aceito (os ids gerados pelo Core são bem menores). */
export const MAX_ID_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Valida a ação e o argumento.
 *
 * `payload` ausente é aceito para as ações sem argumento. Qualquer campo além
 * dos previstos recusa o pedido inteiro: um pedido que traz `root` ou `path` é
 * sinal de que a página está tentando outra coisa, não um pedido com lixo que
 * se pode ignorar.
 */
export function parseDevRequest(action: unknown, payload: unknown): DevRequest {
	if (typeof action !== 'string' || !(DEV_ACTIONS as readonly string[]).includes(action)) {
		throw new DevIpcError('ação DEV desconhecida');
	}
	if (payload === undefined || payload === null) {
		if (action === 'apply') {
			throw new DevIpcError('aplicar exige o identificador da operação');
		}
		return { action: action as DevRequest['action'] } as DevRequest;
	}
	if (!isRecord(payload)) {
		throw new DevIpcError('argumento DEV inválido');
	}
	const keys = Object.keys(payload);
	if ((action === 'apply' || action === 'restore') && keys.some((key) => key !== 'operationId' && key !== 'checkpointId')) {
		throw new DevIpcError('argumento DEV com campos não previstos');
	}
	if (
		(action === 'state' ||
			action === 'refresh' ||
			action === 'activate' ||
			action === 'deactivate' ||
			action === 'configure' ||
			action === 'recover' ||
			action === 'lock' ||
			action === 'revoke' ||
			action === 'history') &&
		keys.length > 0
	) {
		throw new DevIpcError('esta ação não aceita argumentos');
	}
	if (action === 'apply') {
		return { action, operationId: asId(payload['operationId'], 'operação') };
	}
	if (action === 'restore') {
		const checkpointId = payload['checkpointId'];
		if (checkpointId === undefined || checkpointId === null) {
			return { action };
		}
		return { action, checkpointId: asId(checkpointId, 'checkpoint') };
	}
	return { action: action as DevRequest['action'] } as DevRequest;
}

function asId(value: unknown, what: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
		throw new DevIpcError(`identificador de ${what} inválido`);
	}
	// Ids do Core: letras, dígitos, `-` e `_`. Nada de `/`, `\`, `..` — id não
	// é caminho, e recusar o formato impede que algum dia vire um.
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new DevIpcError(`identificador de ${what} inválido`);
	}
	return value;
}

/** O tamanho máximo de uma senha aceita na resposta do prompt (DEV-7). */
export const MAX_PASSWORD_LENGTH_IPC = 1024;

/**
 * Valida a resposta ao prompt de autorização (DEV-7).
 *
 * Separado do `parseDevRequest` porque é outro canal e outra forma: a página
 * devolve **o que foi digitado**, com o id que recebeu. A senha não é
 * formatada nem lida em log; aqui só se confere que é texto e que cabe.
 */
export function parseOwnerPromptAnswer(value: unknown):
	| { readonly id: string; readonly kind: 'cancel' }
	| {
			readonly id: string;
			readonly kind: 'password';
			readonly password: string;
			readonly remember?: boolean;
	  }
	| { readonly id: string; readonly kind: 'configure'; readonly password: string; readonly confirmation: string }
	// DEV-9.1: aprovar a execução de um comando. Sem senha: a pergunta é de
	// leitura, e o broker só aceita esta forma para a pergunta `run-command`.
	| { readonly id: string; readonly kind: 'approve' } {
	if (!isRecord(value)) {
		throw new DevIpcError('resposta de autorização inválida');
	}
	const id = value['id'];
	if (typeof id !== 'string' || !/^auth-[a-f0-9]{18}$/.test(id)) {
		throw new DevIpcError('identificador de autorização inválido');
	}
	const kind = value['kind'];
	if (kind === 'cancel') {
		return { id, kind };
	}
	// A aprovação de comando não carrega senha nem confirmação: só o id da
	// pergunta aberta. O broker confere se a pergunta aberta é mesmo do tipo
	// `run-command`; aqui só se confere a forma.
	if (kind === 'approve') {
		return { id, kind };
	}
	const password = value['password'];
	if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH_IPC) {
		throw new DevIpcError('senha inválida');
	}
	if (kind === 'password') {
		// Só `true` liga a lembrança. Um valor estranho é ignorado, e a
		// autorização vale sem persistir — o lado seguro.
		return value['remember'] === true
			? { id, kind, password, remember: true }
			: { id, kind, password };
	}
	if (kind === 'configure') {
		const confirmation = value['confirmation'];
		if (typeof confirmation !== 'string' || confirmation.length > MAX_PASSWORD_LENGTH_IPC) {
			throw new DevIpcError('confirmação inválida');
		}
		return { id, kind, password, confirmation };
	}
	throw new DevIpcError('tipo de resposta desconhecido');
}
