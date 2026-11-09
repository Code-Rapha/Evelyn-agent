/**
 * As credenciais dos clientes da API local.
 *
 * ## Por que existe um segundo tipo de credencial
 *
 * O token do painel (`createSessionToken`, em `server.ts`) é efêmero e nasce
 * com o processo: ele existe para provar "quem abriu esta página é o dono da
 * máquina", e morre quando o servidor reinicia. Isso é correto para um
 * navegador e inútil para um cliente que precisa de uma URL estável.
 *
 * Esta é a outra credencial: **de cliente**, gravada no disco, escolhida por
 * quem opera, e verificável depois de um reinício. As duas nunca se
 * confundem — ver `CredentialScope`.
 *
 * ## O que NUNCA é gravado
 *
 * A chave em si. O arquivo guarda `sha256(chave)`; a chave completa aparece
 * uma única vez, no retorno de `create`, e não existe em lugar nenhum depois
 * disso — nem no arquivo, nem na listagem, nem no log. Comparar hash em vez
 * de chave é o que torna "não é possível mostrar a chave de novo" uma
 * propriedade do desenho, e não uma promessa da interface.
 *
 * ## Formato do arquivo
 *
 * ```json
 * {
 *   "version": 1,
 *   "keys": [
 *     { "id": "key_…", "name": "opencode", "scopes": ["client"],
 *       "hash": "<hex>", "createdAt": "…", "lastUsedAt": "…" }
 *   ]
 * }
 * ```
 *
 * Sem `revokedAt`: revogar **apaga** a entrada. Uma entrada revogada que
 * continua no arquivo é uma entrada que alguém pode reativar por engano; a
 * remoção é a declaração mais simples de "esta chave não vale mais".
 *
 * Escrita atômica e serializada, pelo mesmo `writeFileAtomic` dos outros
 * stores. Um arquivo corrompido **não** derruba o servidor: ele recusa todas
 * as chaves (o lado seguro) e o erro é dito por quem chamou, nunca engolido.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, chmod, stat } from 'node:fs/promises';

import { writeFileAtomic } from '../../adapters/local/writeFileAtomic';

/** O dono do arquivo lê e escreve; mais ninguém. */
const OWNER_ONLY = 0o600;

/** Nome do arquivo dentro da raiz de dados. */
export const API_KEYS_FILE = 'api-keys.json';

/**
 * O que uma credencial pode fazer.
 *
 * A separação é a razão de existir desta fase: uma chave de cliente atende
 * `/v1` e **não** lê a configuração de provedores; uma sessão de painel lê a
 * configuração e **não** atende `/v1`. Nenhuma das duas é um superconjunto da
 * outra por acidente.
 */
export type CredentialScope = 'panel' | 'client';

/** Uma chave, como o arquivo a guarda. Nunca contém a chave em si. */
export interface StoredApiKey {
	readonly id: string;
	readonly name: string;
	readonly scopes: readonly CredentialScope[];
	/** `sha256(chave)` em hex. O único vestígio da chave. */
	readonly hash: string;
	/**
	 * Os primeiros caracteres da chave, para o operador reconhecê-la.
	 *
	 * Oito caracteres depois de `sk-evelyn-` deixam 192 bits fora do arquivo:
	 * não dá para reconstruir a chave a partir do prefixo nem de milhares de
	 * prefixos.
	 */
	readonly prefix: string;
	readonly createdAt: string;
	readonly lastUsedAt?: string;
}

/** Uma chave como o painel a mostra. Sem hash, sem segredo. */
export interface ApiKeySummary {
	readonly id: string;
	readonly name: string;
	readonly scopes: readonly CredentialScope[];
	readonly createdAt: string;
	readonly lastUsedAt?: string;
	/** Os quatro primeiros caracteres, para o operador reconhecer a chave. */
	readonly prefix: string;
}

/** O que `create` devolve: a única vez em que a chave aparece. */
export interface CreatedApiKey {
	readonly key: ApiKeySummary;
	/** A chave completa. Mostrada uma vez; não é gravada nem guardada. */
	readonly secret: string;
}

/** Quem apresentou a credencial, e o que ela vale. */
export interface CredentialIdentity {
	readonly keyId: string;
	readonly scopes: readonly CredentialScope[];
}

/** As opções do registro. */
export interface ApiKeyStoreOptions {
	/** Caminho absoluto do arquivo. */
	readonly filePath: string;
	readonly now?: () => Date;
	/** Fonte da aleatoriedade; injetada em teste para ser determinística. */
	readonly randomBytes?: (size: number) => Buffer;
}

/** Arquivo inexistente ou ilegível de um jeito que impede confiar nas chaves. */
export class ApiKeyStoreError extends Error {
	constructor(
		message: string,
		readonly cause: unknown,
	) {
		super(message);
		this.name = 'ApiKeyStoreError';
	}
}

/** O formato do arquivo, como é lido. */
interface KeysFile {
	readonly version: number;
	readonly keys: readonly StoredApiKey[];
}

const FORMAT_VERSION = 1;

/**
 * Quantos bytes aleatórios formam uma chave.
 *
 * 32 bytes de `randomBytes` são o mesmo material de uma chave de sessão do
 * painel: adivinhar não é um caminho, quebrar é um ataque offline a um hash
 * sem sal — por isso o hash abaixo não é suficiente sozinho, e a chave tem de
 * ser longa.
 */
const KEY_BYTES = 32;

/** `sk-evelyn-` deixa a chave reconhecível em um log sem revelar nada dela. */
const KEY_PREFIX_LABEL = 'sk-evelyn-';

/** Quantos caracteres do começo a listagem mostra. */
const SUMMARY_PREFIX_LENGTH = KEY_PREFIX_LABEL.length + 8;

/** O hash de uma chave. `sha256` porque a chave já é aleatória e longa. */
export function hashApiKey(secret: string): string {
	return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Compara dois hex de tamanho igual sem sair no primeiro byte diferente. */
function hexEqual(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}
	const a = Buffer.from(left, 'utf8');
	const b = Buffer.from(right, 'utf8');
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
}

/** O resumo de uma chave gravada. */
function toSummary(key: StoredApiKey): ApiKeySummary {
	return {
		id: key.id,
		name: key.name,
		scopes: [...key.scopes],
		createdAt: key.createdAt,
		...(key.lastUsedAt !== undefined ? { lastUsedAt: key.lastUsedAt } : {}),
		prefix: key.prefix,
	};
}

/** O registro das chaves de cliente. */
export class ApiKeyStore {
	private cache: StoredApiKey[] | undefined;
	/** Serializa as escritas, como o `FileSecretStore`. */
	private pending: Promise<void> = Promise.resolve();
	/** O erro da última leitura inválida, para não reler a cada requisição. */
	private failure: ApiKeyStoreError | undefined;
	/** O carimbo do arquivo na última leitura, para notar escrita alheia. */
	private fileStamp: { readonly mtimeMs: number; readonly size: number } | undefined;

	constructor(private readonly options: ApiKeyStoreOptions) {}

	/**
	 * As chaves gravadas.
	 *
	 * Um arquivo **ausente** é uma instalação nova: nenhuma chave, nenhum
	 * erro. Um arquivo **ilegível** é outra coisa — as chaves dele não podem
	 * ser verificadas, e tratar isso como "nenhuma chave" liberaria o sistema
	 * para aceitar qualquer coisa. A diferença é o erro.
	 */
	async list(): Promise<readonly ApiKeySummary[]> {
		const keys = await this.load();
		return keys.map(toSummary);
	}

	/** Cria uma chave. A única vez em que o segredo existe em memória. */
	async create(input: {
		readonly name: string;
		readonly scopes?: readonly CredentialScope[];
	}): Promise<CreatedApiKey> {
		const minted = this.mint(input);
		// A leitura acontece **dentro** da fila: ler fora dela e gravar
		// depois é o que perdia chaves quando duas criações se sobrepunham.
		await this.mutate((keys) => [...keys, minted.stored]);
		return { key: toSummary(minted.stored), secret: minted.secret };
	}

	/**
	 * Revoga uma chave.
	 *
	 * Apagar é a revogação: a entrada some do arquivo, e o hash deixa de
	 * existir. Não há "reativar" — uma chave nova é uma chave nova.
	 */
	async revoke(keyId: string): Promise<boolean> {
		return await this.mutate((keys) => {
			const remaining = keys.filter((key) => key.id !== keyId);
			return remaining.length === keys.length ? undefined : remaining;
		}).then((changed) => changed !== undefined);
	}

	/**
	 * Troca todas as chaves de uma vez.
	 *
	 * A rotação é "revogar tudo e criar outra" numa única escrita atômica: se
	 * o processo morrer no meio, o arquivo tem o conjunto antigo ou o novo,
	 * nunca os dois pela metade.
	 */
	async rotate(input: {
		readonly name: string;
		readonly scopes?: readonly CredentialScope[];
	}): Promise<CreatedApiKey> {
		const minted = this.mint(input);
		// Uma escrita só: o arquivo tem o conjunto antigo ou o novo.
		await this.mutate(() => [minted.stored]);
		return { key: toSummary(minted.stored), secret: minted.secret };
	}

	/**
	 * Verifica uma chave apresentada.
	 *
	 * Devolve a identidade **somente** quando o hash bate. A busca é linear
	 * sobre as chaves existentes, com comparação de tempo constante: o número
	 * delas é o de clientes de uma máquina local, e um índice por hash
	 * economizaria microssegundos ao custo de uma segunda estrutura para
	 * manter coerente.
	 */
	async verify(presented: string): Promise<CredentialIdentity | undefined> {
		if (typeof presented !== 'string' || presented.length === 0) {
			return undefined;
		}
		const keys = await this.load();
		const hash = hashApiKey(presented);
		for (const key of keys) {
			if (hexEqual(key.hash, hash)) {
				return { keyId: key.id, scopes: [...key.scopes] };
			}
		}
		return undefined;
	}

	/**
	 * Registra o uso, para o painel mostrar qual chave está em uso.
	 *
	 * Best-effort de propósito: falhar em gravar um carimbo de tempo não pode
	 * recusar uma requisição que já provou sua chave. O carimbo é gravado
	 * quando a diferença passa de um minuto, para não reescrever o arquivo a
	 * cada chamada.
	 */
	async touch(keyId: string): Promise<void> {
		try {
			const nowMs = this.options.now?.().getTime() ?? Date.now();
			await this.mutate((keys) => {
				const index = keys.findIndex((key) => key.id === keyId);
				if (index < 0) {
					return undefined;
				}
				const key = keys[index];
				const lastMs = key.lastUsedAt === undefined ? 0 : Date.parse(key.lastUsedAt);
				if (Number.isFinite(lastMs) && nowMs - lastMs < 60_000) {
					return undefined;
				}
				const next = [...keys];
				next[index] = { ...key, lastUsedAt: new Date(nowMs).toISOString() };
				return next;
			});
		} catch {
			// Um carimbo perdido não invalida a chave.
		}
	}

	/** Gera a chave e o registro, sem tocar no disco. */
	private mint(input: {
		readonly name: string;
		readonly scopes?: readonly CredentialScope[];
	}): { readonly stored: StoredApiKey; readonly secret: string } {
		const name = input.name.trim();
		if (name.length === 0) {
			throw new Error('a chave precisa de um nome');
		}
		const scopes = normalizeScopes(input.scopes ?? ['client']);
		if (scopes.length === 0) {
			throw new Error('a chave precisa de ao menos um escopo');
		}
		const make = this.options.randomBytes ?? randomBytes;
		const secret = `${KEY_PREFIX_LABEL}${make(KEY_BYTES).toString('hex')}`;
		return {
			stored: {
				id: `key_${make(8).toString('hex')}`,
				name,
				scopes,
				hash: hashApiKey(secret),
				prefix: secret.slice(0, SUMMARY_PREFIX_LENGTH),
				createdAt: this.nowIso(),
			},
			secret,
		};
	}

	private nowIso(): string {
		return (this.options.now?.() ?? new Date()).toISOString();
	}

	/**
	 * O arquivo mudou por fora?
	 *
	 * O cache é por instância, e duas instâncias sobre o mesmo arquivo **é** o
	 * caso real: a API que autentica e a ferramenta que revoga não são a mesma.
	 * Sem isto, uma chave revogada continuava valendo até o processo reiniciar
	 * — o oposto do que revogar significa.
	 *
	 * `mtimeMs` + tamanho é a checagem barata: qualquer escrita do
	 * `writeFileAtomic` troca o inode e, na prática, muda o `mtime`. A leitura
	 * do arquivo só custa quando algo mudou.
	 */
	private async isStale(): Promise<boolean> {
		const stamp = this.fileStamp;
		if (stamp === undefined) {
			return false;
		}
		try {
			const info = await stat(this.options.filePath);
			return info.mtimeMs !== stamp.mtimeMs || info.size !== stamp.size;
		} catch {
			// Sumiu: o estado em memória não descreve mais o disco.
			return true;
		}
	}

	/** Lê o arquivo uma vez; uma leitura inválida é lembrada, não repetida. */
	private async load(): Promise<readonly StoredApiKey[]> {
		if (this.failure !== undefined) {
			throw this.failure;
		}
		if (this.cache !== undefined && !(await this.isStale())) {
			return this.cache;
		}
		if (this.cache !== undefined) {
			// O disco mudou por fora: o cache é substituído pelo que está lá,
			// e não "mesclado" — mesclar reativaria o que foi revogado.
			this.cache = undefined;
		}
		let raw: string;
		try {
			raw = await readFile(this.options.filePath, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				this.cache = [];
				this.fileStamp = { mtimeMs: 0, size: 0 };
				return this.cache;
			}
			this.failure = new ApiKeyStoreError('não foi possível ler o arquivo de chaves da API', error);
			throw this.failure;
		}
		const parsed = parseKeysFile(raw);
		if (parsed === undefined) {
			this.failure = new ApiKeyStoreError(
				'o arquivo de chaves da API está corrompido; nenhuma chave será aceita até ele ser reparado',
				undefined,
			);
			throw this.failure;
		}
		this.cache = parsed;
		await this.rememberStamp();
		return this.cache;
	}

	/** Guarda o carimbo do arquivo, para notar uma escrita de outra instância. */
	private async rememberStamp(): Promise<void> {
		try {
			const info = await stat(this.options.filePath);
			this.fileStamp = { mtimeMs: info.mtimeMs, size: info.size };
		} catch {
			this.fileStamp = { mtimeMs: 0, size: 0 };
		}
	}

	/**
	 * Aplica uma mudança na fila, lendo o estado **dentro** dela.
	 *
	 * Leitura e escrita fora da fila foi o que perdia chaves: duas criações
	 * simultâneas liam o mesmo estado e cada uma gravava a sua, apagando a
	 * outra. Aqui a mudança recebe o estado atual e devolve o novo; `undefined`
	 * significa "nada a mudar" e não escreve.
	 */
	private mutate(
		change: (keys: readonly StoredApiKey[]) => readonly StoredApiKey[] | undefined,
	): Promise<readonly StoredApiKey[] | undefined> {
		const run = async (): Promise<readonly StoredApiKey[] | undefined> => {
			const current = await this.load();
			const next = change(current);
			if (next === undefined) {
				return undefined;
			}
			await this.write(next);
			return next;
		};
		const next = this.pending.then(run, run);
		// A fila nunca fica rejeitada: uma escrita que falhou não pode
		// bloquear todas as seguintes.
		this.pending = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/** Escrita atômica, seguida do cache. Chamada já dentro da fila. */
	private async write(keys: readonly StoredApiKey[]): Promise<void> {
		const file: KeysFile = { version: FORMAT_VERSION, keys: [...keys] };
		await writeFileAtomic(this.options.filePath, `${JSON.stringify(file, null, 2)}\n`, {
			mode: OWNER_ONLY,
		});
		// O modo é aplicado no temporário que o rename traz; reafirmar
		// custa nada e cobre uma plataforma que o descarte em silêncio.
		await chmod(this.options.filePath, OWNER_ONLY).catch(() => undefined);
		this.cache = [...keys];
		this.failure = undefined;
		await this.rememberStamp();
	}
}

/** Normaliza e deduplica escopos, descartando o que não é conhecido. */
function normalizeScopes(scopes: readonly unknown[]): CredentialScope[] {
	const known: CredentialScope[] = [];
	for (const scope of scopes) {
		if ((scope === 'panel' || scope === 'client') && !known.includes(scope)) {
			known.push(scope);
		}
	}
	return known;
}

/** Lê o arquivo; `undefined` quando o formato não é o esperado. */
function parseKeysFile(raw: string): StoredApiKey[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== 'object') {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if (record['version'] !== FORMAT_VERSION) {
		return undefined;
	}
	const keys = record['keys'];
	if (!Array.isArray(keys)) {
		return undefined;
	}
	const result: StoredApiKey[] = [];
	for (const entry of keys) {
		if (entry === null || typeof entry !== 'object') {
			return undefined;
		}
		const key = entry as Record<string, unknown>;
		const id = key['id'];
		const name = key['name'];
		const hash = key['hash'];
		const prefix = key['prefix'];
		const createdAt = key['createdAt'];
		if (
			typeof id !== 'string' ||
			id.length === 0 ||
			typeof name !== 'string' ||
			typeof hash !== 'string' ||
			// Um hash que não é hex de 64 caracteres não pode corresponder a
			// nenhuma chave válida, e aceitá-lo seria aceitar lixo.
			!/^[0-9a-f]{64}$/.test(hash) ||
			typeof prefix !== 'string' ||
			typeof createdAt !== 'string'
		) {
			return undefined;
		}
		const scopes = Array.isArray(key['scopes']) ? normalizeScopes(key['scopes']) : [];
		result.push({
			id,
			name,
			scopes,
			hash,
			prefix,
			createdAt,
			...(typeof key['lastUsedAt'] === 'string' ? { lastUsedAt: key['lastUsedAt'] } : {}),
		});
	}
	return result;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { readonly code?: unknown }).code === 'ENOENT'
	);
}
