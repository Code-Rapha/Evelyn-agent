/**
 * Quais provedores do OpenCode têm credencial — sem ler credencial nenhuma.
 *
 * ## De onde vem a resposta
 *
 * Do **próprio CLI**: `opencode providers list` imprime, por provedor, o nome
 * e o número de credenciais. O app lê os **nomes** das linhas e descarta o
 * resto. Em particular:
 *
 * - não abre `auth.json` nem nenhum arquivo interno do OpenCode;
 * - não lê, guarda ou mostra o valor de uma credencial;
 * - descarta a saída bruta depois de extrair os nomes.
 *
 * ## Por que não `connected` de `/api/provider`
 *
 * Na versão instalada (1.18.34) a resposta de `/api/provider` não tem campo
 * `connected` — a lista traz `id`, `name`, `api` e `request`. Um app que
 * lesse `connected` de lá mostraria todos como desconectados. A fonte que
 * existe é a saída do CLI.
 *
 * ## Quando o CLI não responde
 *
 * `undefined` — "não se sabe". O catálogo então não afirma nem conexão nem
 * ausência dela: `connected` é `false` para todos, e a página diz que a
 * conexão dos provedores não pôde ser confirmada. Nada é suposto.
 */
import { execFile } from 'node:child_process';

/** O que a consulta do CLI disse. */
export interface ProviderCredentialReport {
	/** Os provedores que o CLI diz ter credencial, pelos ids dele. */
	readonly connected: ReadonlySet<string>;
	/** Os nomes como o CLI os mostra, para o catálogo exibir. */
	readonly names: ReadonlyMap<string, string>;
}

/** O resumo final do CLI: `2 credentials`. A saída pode vir sem cores, e o
 * resumo pode carregar um pedaço de moldura na frente — o que importa é o
 * número e a palavra. */
const SUMMARY = /(\d+)\s+credentials?\b/i;

/** O bloco vazio: `No credentials`. */
const NONE = /\bno\s+credentials?\b/i;

/**
 * Lê a saída de `opencode providers list`.
 *
 * ## Só o bloco de credenciais
 *
 * O bloco começa na linha que menciona `auth.json` e termina no resumo
 * (`N credentials`). Fora dele — banners, dicas, o rodapé de rolagem — nada é
 * considerado.
 *
 * ## O que conta como provedor
 *
 * Uma linha de conteúdo é um nome: um texto curto, com pelo menos uma letra,
 * e não um dos avisos conhecidos. O rodapé de rolagem é descartado; um `id`
 * entre parênteses é guardado junto com o nome.
 */
export function parseProvidersList(output: string): ProviderCredentialReport {
	// A saída do console traz cores, símbolos de caixa e marcadores de item: as
	// linhas são normalizadas antes de qualquer comparação. O banner do CLI
	// leva a palavra "OPENCODE" em blocos; só o bloco de credenciais interessa.
	const plain = output
		.replace(/\u001B\[[0-9;]*m/g, '')
		.split(/\r?\n/)
		.map((line) =>
			line
				.replace(/[\u2502\u2503|]/g, ' ')
				.replace(/^[\s•●◦*+–-]+/u, '')
				.trim(),
		)
		.filter((line) => line.length > 0);

	const names = new Map<string, string>();
	const connected = new Set<string>();
	let inside = false;
	// O nome do provedor lido na linha anterior, à espera do tipo ("api",
	// "oauth"). O CLI imprime um por linha; o `id` provável sai do nome.
	let pendingName: string | undefined;
	for (const line of plain) {
		if (/auth\.json/i.test(line)) {
			inside = true;
			continue;
		}
		if (!inside) {
			continue;
		}
		if (SUMMARY.test(line) || NONE.test(line)) {
			// O resumo fecha o bloco: zero credenciais não afirma nenhuma.
			break;
		}
		if (isScrollHint(line) || isCredentialKind(line)) {
			// O tipo fecha o registro do nome anterior.
			continue;
		}
		if (!isLikelyName(line)) {
			continue;
		}
		const withId = /^(.+?)\s+\(([a-z0-9][a-z0-9._-]*)\)$/i.exec(line);
		const name = (withId === null ? line : withId[1]).trim();
		if (pendingName !== undefined) {
			// Dois nomes seguidos sem o tipo no meio: o primeiro era a última
			// linha de um registro sem tipo. Ele conta, com o id do nome.
			connected.add(idFor(pendingName));
			names.set(idFor(pendingName), pendingName);
		}
		pendingName = name;
		if (withId !== null) {
			// Com o id explícito, o registro já está completo.
			const id = withId[2].toLowerCase();
			connected.add(id);
			names.set(id, name);
			pendingName = undefined;
		}
	}
	if (pendingName !== undefined) {
		connected.add(idFor(pendingName));
		names.set(idFor(pendingName), pendingName);
	}
	return { connected, names };
}

/** O tipo de credencial que o CLI imprime sob o nome: `api`, `oauth`, … */
function isCredentialKind(line: string): boolean {
	return /^(api|oauth|apikey|api key|token)$/i.test(line);
}

/**
 * As formas possíveis do id de um nome do CLI.
 *
 * O CLI imprime `OpenCode api`; o catálogo publica `opencode`. Nenhum dos dois
 * é "o id" do outro: o nome carrega o tipo de credencial, e os separadores
 * variam. Em vez de supor, o casamento tenta as formas e só aceita quando
 * **uma** bate com um provedor do catálogo.
 */
export function nameVariants(name: string): readonly string[] {
	const base = name.toLowerCase().trim().replace(/\s+/g, ' ');
	const withoutKind = base.replace(/\s+(api|oauth|apikey|token|key)$/i, '').trim();
	const values = new Set<string>([base, withoutKind]);
	for (const value of [base, withoutKind]) {
		values.add(value.replace(/\s+/g, '-'));
		values.add(value.replace(/\s+/g, ''));
		values.add(value.replace(/\s+/g, '_'));
		values.add(value.replace(/\s*(ai|zen)$/i, '').trim());
	}
	return [...values].filter((value) => value.length > 0);
}

/**
 * Os provedores do catálogo que o CLI diz ter credencial.
 *
 * Casa pelo id quando ele bate; senão, pelas formas do nome (ver
 * `nameVariants`). Um nome que casa com mais de um provedor é ambíguo e **não**
 * é usado: marcar o provedor errado como conectado seria pior que não saber.
 */
export function matchConnectedProviders(
	catalogProviderIds: readonly string[],
	report: ProviderCredentialReport,
): ReadonlySet<string> {
	const resolved = new Set<string>();
	const byLowerId = new Map(catalogProviderIds.map((id) => [id.toLowerCase(), id]));
	for (const catalogId of catalogProviderIds) {
		if (report.connected.has(catalogId.toLowerCase())) {
			resolved.add(catalogId);
		}
	}
	for (const name of report.names.values()) {
		const variants = nameVariants(name);
		const matches = catalogProviderIds.filter((id) => variants.includes(id.toLowerCase()));
		if (matches.length === 1) {
			resolved.add(matches[0]);
			continue;
		}
		// Sem casamento direto: o id que o CLI usa (nome com hífens) pode ser
		// o próprio id do catálogo de outro jeito.
		const idFromName = name.toLowerCase().replace(/\s+/g, '-');
		const direct = byLowerId.get(idFromName) ?? byLowerId.get(idFromName.replace(/-api$/, ''));
		if (direct !== undefined) {
			resolved.add(direct);
		}
	}
	return resolved;
}

/** O id provável de um provedor cujo nome veio sem id: o nome em minúsculas. */
function idFor(name: string): string {
	return name.toLowerCase().replace(/\s+/g, '-');
}

/** O rodapé de rolagem do console interativo, entre páginas de provedores. */
function isScrollHint(line: string): boolean {
	if (line.length === 0) {
		return false;
	}
	if (/^[↑↓]/.test(line) || /page:\s*\d+\/\d+/i.test(line)) {
		return true;
	}
	return false;
}

/** Para não confundir "dica", "api" ou o resumo com o nome de um provedor. */
function isLikelyName(value: string): boolean {
	if (value.length < 2 || value.length > 60) {
		return false;
	}
	if (!/[A-Za-z]/.test(value)) {
		return false;
	}
	if (/^(api|oauth|help|usage|credentials?|dica|hint)$/i.test(value)) {
		return false;
	}
	// Linhas de aviso e de dica não são provedores.
	return !/^(warning|error|nota|note|tip)\b/i.test(value);
}

/**
 * O que o CLI respondeu, em `undefined` quando não respondeu.
 *
 * O comando é fixo (`providers list`) e é executado **sem shell**: nenhum
 * argumento vem da página, e não há interpretador no meio.
 */
export async function readProviderCredentials(options: {
	readonly binary: string;
	readonly timeoutMs?: number;
}): Promise<ProviderCredentialReport | undefined> {
	return await new Promise<ProviderCredentialReport | undefined>((resolve) => {
		execFile(
			options.binary,
			['providers', 'list'],
			{ timeout: options.timeoutMs ?? 10_000, windowsHide: true, maxBuffer: 256 * 1024 },
			(error, stdout) => {
				const text = String(stdout ?? '');
				if (error !== null) {
					// Código de erro pode ser o CLI pedindo login; a saída ainda
					// é lida, porque o resumo pode estar nela.
					resolve(text.trim().length > 0 ? parseProvidersList(text) : undefined);
					return;
				}
				resolve(parseProvidersList(text));
			},
		);
	});
}
