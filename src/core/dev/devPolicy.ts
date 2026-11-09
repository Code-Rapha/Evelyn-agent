/**
 * A política de caminhos do modo DEV (DEV-2.1).
 *
 * ## Por que existe
 *
 * O DEV lê e escreve no repositório **da Evelyn**. Um repositório de trabalho
 * contém, além do código, coisas que não são código: `.env` com chaves,
 * certificados, chaves privadas, fixtures que carregam dados de teste com
 * segredo. Entregar isso ao modelo porque "está dentro do repositório" é
 * confundir duas permissões diferentes: *mexer no código* e *ler os segredos
 * da máquina*.
 *
 * ## O que é protegido
 *
 * Regras por nome **e por sufixo de extensão** — nunca por diretório inteiro,
 * para não bloquear o que o desenvolvimento precisa:
 *
 * - arquivos de ambiente: `.env`, `.env.*` **e** `*.env` (`prod.env`,
 *   `config.env` — DEV-AUDIT-01: só o prefixo deixava esses legíveis);
 * - clientes de pacote/ Git: `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pypirc`,
 *   `.netrc`, `.git-credentials`, `.docker/config.json`;
 * - credenciais estruturadas: `secrets.yaml/yml/toml/ini`, `credentials`,
 *   `credentials.json`, `service.json`, `secrets.json`, `vault.json`,
 *   `*.secret.json`, `*.secrets.json`;
 * - chaves e certificados: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.cer`,
 *   `*.crt`, `*.jks`, `*.keystore`, `id_rsa`, `id_ed25519`, `*.ppk`;
 * - dumps de ambiente: `*.env.bak`, `*.env.local` (cobertos por `*.env*`).
 *
 * O que **não** é protegido: `package.json`, `tsconfig*.json`, `eslint` config,
 * `.env.example`/`.sample`/`.template`/`.dist`/`.env.dist`, qualquer
 * `.ts`/`.js`/`.md`, e um arquivo cuja extensão apenas **contém** a palavra
 * (`environment.md`, `environments.ts`) — o casamento é por segmento de
 * nome, não por substring solta.
 *
 * ## Como a comparação é feita
 *
 * Em minúsculas, porque no Windows o sistema de arquivos não distingue caixa:
 * `Secrets.JSON` abre o mesmo arquivo que `secrets.json`. A comparação é sobre
 * o **nome do arquivo** já resolvido pelo `Workspace` (sem `..`, sem symlink
 * para fora), então um caminho que tenta escapar não chega nem aqui.
 *
 * O nome ainda passa por `normalizeFinalName`, que remove pontos/ espaços
 * finais do Windows (`secrets.json ` e `secrets.json.` abrem o mesmo arquivo)
 * e reduz a forma Unicode (`NFKC`) — evita que um nome "parecido" passe.
 */

/** O motivo da recusa, quando o caminho é protegido. */
export interface ProtectedPathVerdict {
	readonly protected: true;
	readonly reason: string;
}

export type PathVerdict = { readonly protected: false } | ProtectedPathVerdict;

/** Arquivos protegidos por nome exato (comparados em minúsculas). */
const PROTECTED_NAMES: ReadonlySet<string> = new Set([
	'.env',
	'service.json',
	'secrets.json',
	'credentials.json',
	'credentials',
	'id_rsa',
	'id_dsa',
	'id_ecdsa',
	'id_ed25519',
	// DEV-AUDIT-01: clientes que guardam token em texto puro.
	'.npmrc',
	'.yarnrc',
	'.yarnrc.yml',
	'.pypirc',
	'.netrc',
	'netrc',
	'._netrc',
	'.git-credentials',
	'.htpasswd',
	'vault.json',
	'.docker-config.json',
]);

/** Extensões protegidas. */
const PROTECTED_EXTENSIONS: readonly string[] = [
	'.pem',
	'.key',
	'.p12',
	'.pfx',
	'.cer',
	'.crt',
	'.jks',
	'.keystore',
	'.ppk',
	// DEV-AUDIT-01: ambiente por sufixo (prod.env, app.env.local).
	'.env',
];

/** Sufixos protegidos, além da extensão. */
const PROTECTED_SUFFIXES: readonly string[] = [
	'.secret.json',
	'.secrets.json',
	// DEV-AUDIT-01: credenciais em YAML/TOML/INI, que não têm nome fixo.
	'secrets.yaml',
	'secrets.yml',
	'secrets.toml',
	'secrets.ini',
	'credentials.yaml',
	'credentials.yml',
	'credentials.toml',
	'.git-credentials',
];

/** Exemplos de ambiente, que não têm valor e servem ao desenvolvimento. */
const ENV_TEMPLATES: ReadonlySet<string> = new Set([
	'.env.example',
	'.env.sample',
	'.env.template',
	'.env.dist',
]);

/** Um template de ambiente também por sufixo: `app.env.example`. */
const ENV_TEMPLATE_SUFFIXES: readonly string[] = ['.env.example', '.env.sample', '.env.template', '.env.dist'];

/**
 * O nome final, como o Windows o resolve.
 *
 * `secrets.json ` (espaço no fim) e `secrets.json.` (ponto no fim) abrem o
 * mesmo arquivo que `secrets.json`, mas não casariam com a lista. O trims
 * remove os dois antes da comparação. `NFKC` reduz formas compostas
 * (`ｓｅｃｒｅｔｓ.json`) à forma canônica.
 */
function normalizeFinalName(path: string): string {
	const raw = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
	return raw.normalize('NFKC').replace(/[. ]+$/, '');
}

/**
 * Este arquivo pode ser lido/escrito pelo DEV?
 *
 * Recebe o caminho **já resolvido** dentro da raiz. Um caminho fora da raiz
 * não deveria chegar aqui — o `Workspace` já recusou —, mas a função é pura e
 * não depende disso.
 */
export function classifyPath(path: string): PathVerdict {
	const name = normalizeFinalName(path);
	if (name.length === 0) {
		return { protected: false };
	}
	if (ENV_TEMPLATES.has(name) || ENV_TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
		return { protected: false };
	}
	// `.env.local`, `.env.production`, `prod.env`, `app.env.local` — mas não
	// os templates acima. `includes('.env.')` cobre o caso com prefixo.
	if (name === '.env' || name.startsWith('.env.') || name.includes('.env.') || name.endsWith('.env')) {
		return { protected: true, reason: 'arquivo de ambiente (pode conter chaves de API)' };
	}
	if (PROTECTED_NAMES.has(name)) {
		return { protected: true, reason: 'arquivo de credenciais do serviço' };
	}
	for (const suffix of PROTECTED_SUFFIXES) {
		if (name.endsWith(suffix)) {
			return { protected: true, reason: 'arquivo de segredos' };
		}
	}
	for (const extension of PROTECTED_EXTENSIONS) {
		if (name.endsWith(extension)) {
			return { protected: true, reason: 'chave ou certificado' };
		}
	}
	return { protected: false };
}

/** A recusa em forma de texto, para a ferramenta devolver ao modelo. */
export function protectedMessage(path: string, verdict: ProtectedPathVerdict): string {
	return `"${path}" é um caminho protegido no modo DEV (${verdict.reason}) e não é acessível`;
}
