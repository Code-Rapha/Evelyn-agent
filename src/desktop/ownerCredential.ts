/**
 * A credencial local do proprietário (DEV-7).
 *
 * ## O que fica em disco — e o que **não** fica
 *
 * Três campos, e nenhum deles é a senha:
 *
 * - `salt`: aleatório por configuração (PBKDF2);
 * - `sealed`: a **chave derivada** da senha, cifrada pelo DPAPI no escopo do
 *   usuário do Windows — só essa conta, nesta máquina, abre;
 * - `verifier`: HMAC da chave sobre um rótulo fixo, para comparar em tempo
 *   constante sem guardar a senha.
 *
 * A senha não é gravada, não é registrada em log, não vai para o histórico, não
 * atravessa o IPC e não é exposta por método nenhum deste módulo. A verificação
 * acontece **no processo principal**.
 *
 * ## O limite honesto
 *
 * Isto é um **fechadura local**, não uma prova de identidade:
 *
 * - a senha prova que quem digitou **sabe a senha** — ela é o fator que separa
 *   "passei do login do Windows" de "segrador do Evelyn";
 * - o DPAPI impede abrir a chave **fora desta conta/máquina**;
 * - **não** impede um processo rodando como o mesmo usuário de pedir ao DPAPI
 *   a mesma chave. Foi medido: a chave aberta por um processo qualquer é
 *   configurável — é o mesmo id. Documentado em `windowsDpapi.ts` e no
 *   relatório, sem prometer o que não foi demonstrado.
 *
 * ## Tentativas
 *
 * Falhas acumulam. A partir de `MAX_ATTEMPTS` a autenticação fica bloqueada
 * por uma espera que dobra (`30s`, `60s`, `120s`, ... até `2h`). O contador é
 * guardado no mesmo arquivo e **não** é reiniciado por reiniciar o app: senão
 * "reabrir" seria a forma de escapar do limite. Uma autenticação correta
 * zera o contador.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHmac, pbkdf2 as pbkdf2Callback, randomBytes, timingSafeEqual } from 'node:crypto';

import { sealForCurrentUser, unsealForCurrentUser, type PowerShellRunner } from './windowsDpapi';

/** O nome do arquivo, dentro de `dev/`. */
export const CREDENTIAL_FILE = 'owner-credential.json';

/** A versão do formato. Um número novo = um formato novo. */
const FORMAT = 1;

/** Rótulo do verifier: um HMAC com este texto, para não guardar a senha. */
const VERIFIER_LABEL = 'evelyn-dev-credential-v1';

/** Custo do PBKDF2. Alto o bastante para desencorajar chute offline, baixo o
 * bastante para não bloquear a interface (medido: ~0,4 s no Windows). */
export const KDF_ITERATIONS = 310_000;

/** Falhas permitidas antes da espera. */
export const MAX_ATTEMPTS = 5;

/** A primeira espera, em ms; dobra a cada falha depois disso. */
const BASE_DELAY_MS = 30_000;

/** A espera máxima. */
const MAX_DELAY_MS = 2 * 60 * 60_000;

/** O tamanho mínimo da senha. Curta demais não é segredo. */
export const MIN_PASSWORD_LENGTH = 12;

/** O tamanho máximo aceito (evita hash de megabytes por engano). */
export const MAX_PASSWORD_LENGTH = 256;

/** O que fica gravado. Nada aqui é a senha. */
interface StoredCredential {
	readonly version: 1;
	readonly user: string;
	readonly salt: string;
	readonly sealed: string;
	readonly verifier: string;
	readonly createdAt: string;
	readonly failures: number;
	/** Quando a espera termina (ISO), quando há. */
	readonly blockedUntil?: string;
	readonly updatedAt: string;
}

/** O estado da credencial, para o painel (sem segredo nenhum). */
export type CredentialState =
	| { readonly kind: 'not-configured' }
	| { readonly kind: 'configured'; readonly configuredAt: string; readonly user: string }
	| { readonly kind: 'blocked'; readonly until: string; readonly failures: number }
	| { readonly kind: 'corrupt'; readonly reason: string }
	| { readonly kind: 'unavailable'; readonly reason: string };

/** O resultado de tentar autenticar. */
export type AuthenticateResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: 'not-configured' | 'invalid' | 'blocked' | 'corrupt' | 'unavailable'; readonly message: string; readonly retryAt?: string };

/** O resultado de configurar. */
export type ConfigureResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: 'weak' | 'unavailable' | 'exists'; readonly message: string };

export interface OwnerCredentialOptions {
	/** O diretório de DEV do host (`<dados>/dev`). */
	readonly dir: string;
	/** O usuário do Windows do processo (do ambiente, nunca do renderer). */
	readonly user: () => string | undefined;
	/** Relógio, injetável. */
	readonly now?: () => Date;
	/** O PowerShell (injetável: a suíte não depende dele). */
	readonly run?: PowerShellRunner;
	/** A plataforma (injetável: o mocha "sem DPAPI" prova a falha segura). */
	readonly platform?: NodeJS.Platform;
}

/** O resultado de `read`. */
export type StoredCredentialRead =
	| (StoredCredential & { readonly kind: 'stored' })
	| { readonly kind: 'absent' }
	| { readonly kind: 'corrupt'; readonly reason: string };

/**
 * O store da credencial.
 *
 * Toda gravação é atômica (temporário + `rename`), como os outros stores do
 * projeto: um app que morre no meio não deixa um JSON pela metade.
 */
export class OwnerCredentialStore {
	private readonly file: string;
	private readonly now: () => Date;

	constructor(private readonly options: OwnerCredentialOptions) {
		this.file = join(options.dir, CREDENTIAL_FILE);
		this.now = options.now ?? (() => new Date());
	}

	/**
	 * Lê o arquivo.
	 *
	 * Devolve `corrupt` para JSON inválido, campo errado ou base64 que não é
	 * base64 — e **não** trata isso como "não configurado": um arquivo
	 * adulterado é uma condição de segurança, não uma primeira execução.
	 */
	async read(): Promise<StoredCredentialRead> {
		let raw: string;
		try {
			raw = await readFile(this.file, 'utf8');
		} catch (error) {
			const code = (error as { readonly code?: unknown }).code;
			return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'corrupt', reason: 'não foi possível ler o arquivo da credencial' };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { kind: 'corrupt', reason: 'o arquivo da credencial não é JSON válido' };
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return { kind: 'corrupt', reason: 'o arquivo da credencial não tem o formato esperado' };
		}
		const value = parsed as Record<string, unknown>;
		const ok =
			value['version'] === FORMAT &&
			typeof value['user'] === 'string' &&
			typeof value['salt'] === 'string' &&
			typeof value['sealed'] === 'string' &&
			typeof value['verifier'] === 'string' &&
			typeof value['createdAt'] === 'string' &&
			typeof value['failures'] === 'number' &&
			typeof value['updatedAt'] === 'string' &&
			(value['blockedUntil'] === undefined || typeof value['blockedUntil'] === 'string');
		if (!ok) {
			return { kind: 'corrupt', reason: 'o arquivo da credencial tem campos inválidos' };
		}
		return {
			kind: 'stored',
			version: 1,
			user: value['user'] as string,
			salt: value['salt'] as string,
			sealed: value['sealed'] as string,
			verifier: value['verifier'] as string,
			createdAt: value['createdAt'] as string,
			failures: value['failures'] as number,
			...(typeof value['blockedUntil'] === 'string' ? { blockedUntil: value['blockedUntil'] } : {}),
			updatedAt: value['updatedAt'] as string,
		};
	}

	/** O estado para o painel — nunca inclui senha, salt, verifier ou blob. */
	async state(): Promise<CredentialState> {
		const stored = await this.read();
		if (stored.kind === 'corrupt') {
			return { kind: 'corrupt', reason: stored.reason };
		}
		if (stored.kind === 'absent') {
			return { kind: 'not-configured' };
		}
		const blockedUntil = stored.blockedUntil;
		if (blockedUntil !== undefined && Date.parse(blockedUntil) > this.now().getTime()) {
			return { kind: 'blocked', until: blockedUntil, failures: stored.failures };
		}
		return { kind: 'configured', configuredAt: stored.createdAt, user: stored.user };
	}

	/**
	 * Configura a credencial.
	 *
	 * Só roda quando **não há** credencial: trocar a senha exige o
	 * procedimento de recuperação, que apaga o arquivo com uma ação confiável
	 * do proprietário — não é substituir por cima.
	 */
	async configure(password: string, confirmation: string): Promise<ConfigureResult> {
		const user = this.options.user();
		if (user === undefined) {
			return { ok: false, reason: 'unavailable', message: 'o usuário do Windows deste processo não é conhecido' };
		}
		if (this.options.platform !== undefined && this.options.platform !== 'win32') {
			return { ok: false, reason: 'unavailable', message: 'a proteção do DPAPI só existe no Windows' };
		}
		if (password !== confirmation) {
			return { ok: false, reason: 'weak', message: 'a confirmação não confere com a senha' };
		}
		if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
			return { ok: false, reason: 'weak', message: `a senha precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres` };
		}
		if (password.trim().length === 0 || password.length > MAX_PASSWORD_LENGTH) {
			return { ok: false, reason: 'weak', message: 'a senha está vazia ou longa demais' };
		}
		const existing = await this.read();
		if (existing.kind !== 'absent') {
			return { ok: false, reason: 'exists', message: 'já existe uma credencial; use a recuperação para trocar' };
		}
		const salt = randomBytes(16);
		const key = await derive(password, salt);
		const sealed = await sealForCurrentUser(key, {
			...(this.options.run !== undefined ? { run: this.options.run } : {}),
			...(this.options.platform !== undefined ? { platform: this.options.platform } : {}),
		});
		if (sealed.kind !== 'sealed') {
			return { ok: false, reason: 'unavailable', message: `não foi possível proteger a credencial: ${sealed.reason}` };
		}
		const at = this.now().toISOString();
		const stored: StoredCredential = {
			version: 1,
			user,
			salt: salt.toString('base64'),
			sealed: sealed.base64,
			verifier: verifierFor(key),
			createdAt: at,
			failures: 0,
			updatedAt: at,
		};
		await this.write(stored);
		return { ok: true };
	}

	/**
	 * Valida a senha.
	 *
	 * Sempre devolve motivo na recusa; nenhum deles revela se a senha "quase"
	 * bateu, nem o conteúdo da credencial.
	 */
	async authenticate(password: unknown): Promise<AuthenticateResult> {
		const stored = await this.read();
		if (stored.kind === 'corrupt') {
			return { ok: false, reason: 'corrupt', message: 'a credencial local está ilegível; a recuperação é necessária' };
		}
		if (stored.kind === 'absent') {
			return { ok: false, reason: 'not-configured', message: 'nenhuma credencial local configurada' };
		}
		const blockedUntil = stored.blockedUntil;
		if (blockedUntil !== undefined && Date.parse(blockedUntil) > this.now().getTime()) {
			return {
				ok: false,
				reason: 'blocked',
				message: 'tentativas demais; aguarde para tentar de novo',
				retryAt: blockedUntil,
			};
		}
		const user = this.options.user();
		if (user === undefined || user !== stored.user) {
			await this.noteFailure(stored);
			return {
				ok: false,
				reason: 'unavailable',
				message: 'a credencial pertence a outro usuário do Windows ou ao usuário não é conhecido',
			};
		}
		if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
			await this.noteFailure(stored);
			return { ok: false, reason: 'invalid', message: 'autorização recusada' };
		}
		const opened = await unsealForCurrentUser(stored.sealed, {
			...(this.options.run !== undefined ? { run: this.options.run } : {}),
			...(this.options.platform !== undefined ? { platform: this.options.platform } : {}),
		});
		if (opened.kind === 'unavailable') {
			return { ok: false, reason: 'unavailable', message: 'a proteção do Windows não está disponível agora' };
		}
		if (opened.kind === 'corrupt') {
			return { ok: false, reason: 'corrupt', message: 'a credencial local não pôde ser aberta; a recuperação é necessária' };
		}
		const key = await derive(password, Buffer.from(stored.salt, 'base64'));
		const expected = Buffer.from(stored.verifier, 'hex');
		const actual = Buffer.from(verifierFor(key), 'hex');
		const same = expected.length === actual.length && timingSafeEqual(expected, actual);
		// DEV-7: a chave **aberta pelo DPAPI** também precisa ser a derivada da
		// senha. O DPAPI não tem binding — medido: um blob legítimo desta conta
		// aberto no lugar do original devolve outra chave, e o verifier sozinho
		// não veria (ele confere a senha, não o blob). Sem esta conferência, um
		// arquivo com o blob trocado continuaria autorizando.
		const sealedKey = Buffer.from(opened.base64, 'base64');
		const sameKey = sealedKey.length === key.length && timingSafeEqual(sealedKey, key);
		if (!same || !sameKey) {
			const retryAt = await this.noteFailure(stored);
			return {
				ok: false,
				reason: 'invalid',
				message: 'autorização recusada',
				...(retryAt !== undefined ? { retryAt } : {}),
			};
		}
		await this.resetFailures(stored);
		return { ok: true };
	}

	/**
	 * A recuperação: só um proprietário que **conhece o Windows e decide**
	 * pode chamar.
	 *
	 * Não recebe senha e não apaga nada sozinho: apaga o arquivo e devolve o
	 * estado a "não configurado". A decisão de chamar é do host, com uma
	 * confirmação explícita — nunca da agente.
	 */
	async reset(options: { readonly confirm: boolean }): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
		if (options.confirm !== true) {
			return { ok: false, message: 'a recuperação exige confirmação explícita' };
		}
		await rm(this.file, { force: true });
		return { ok: true };
	}

	private async write(stored: StoredCredential): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		});
		await rename(temporary, this.file);
	}

	/** Registra a falha e devolve quando a espera termina, se passou do limite. */
	private async noteFailure(stored: StoredCredential): Promise<string | undefined> {
		const failures = stored.failures + 1;
		let blockedUntil: string | undefined;
		if (failures >= MAX_ATTEMPTS) {
			const delay = Math.min(BASE_DELAY_MS * 2 ** (failures - MAX_ATTEMPTS), MAX_DELAY_MS);
			blockedUntil = new Date(this.now().getTime() + delay).toISOString();
		}
		await this.write({
			...stored,
			failures,
			...(blockedUntil !== undefined ? { blockedUntil } : {}),
			updatedAt: this.now().toISOString(),
		});
		return blockedUntil;
	}

	private async resetFailures(stored: StoredCredential): Promise<void> {
		if (stored.failures === 0 && stored.blockedUntil === undefined) {
			return;
		}
		await this.write({ ...stored, failures: 0, updatedAt: this.now().toISOString() });
	}
}

/** PBKDF2-SHA256 da senha. A mesma função para configurar e verificar. */
async function derive(password: string, salt: Buffer): Promise<Buffer> {
	return await new Promise<Buffer>((resolve, reject) => {
		pbkdf2Callback(password, salt, KDF_ITERATIONS, 32, 'sha256', (error, key) => {
			if (error !== null) {
				reject(error);
				return;
			}
			resolve(key);
		});
	});
}

/** O verifier: HMAC da chave sobre um rótulo fixo, em hexadecimal. */
function verifierFor(key: Buffer): string {
	return createHmac('sha256', key).update(VERIFIER_LABEL).digest('hex');
}
