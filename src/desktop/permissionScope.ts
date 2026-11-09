/**
 * Autorização por escopo, para a tarefa em curso.
 *
 * ## O problema
 *
 * O broker abria um diálogo para **todo** `riskLevel !== 'safe'`. No modo DEV,
 * quase tudo é `moderate` (`dev_read`, `dev_search`) ou `dangerous`
 * (`dev_write`, `dev_run`) — então uma tarefa de dez etapas pedia dez
 * autorizações, e a pessoa não conseguia deixar a tarefa correr.
 *
 * ## A regra, e o que ela **não** faz
 *
 * A concessão é por **tarefa** (o turno) e por **escopo** — nunca "permitir
 * tudo":
 *
 * | Classe | Como se decide |
 * | --- | --- |
 * | leitura (`dev_read`, `dev_search`, pesquisa) | automática, sem pergunta |
 * | escrita no escopo DEV (`dev_write`, `dev_run`) | uma pergunta por tarefa; vale enquanto o escopo não mudar |
 * | perigoso de verdade (excluir, credencial, ação externa) | sempre pergunta, sem reutilização |
 *
 * O escopo é um conjunto de **chaves de recurso** que a pessoa concedeu. Uma
 * chave de escrita é o diretório onde a escrita cai; a de execução é a raiz do
 * repositório. Conceder `G:\repo\src` não autoriza `G:\repo\config` — a
 * segunda escrita pergunta de novo.
 *
 * ## Por que a exceção precisa ser explícita
 *
 * "Excluir" e "credencial" não são `riskLevel` no produto: `dev_apply` e
 * `run_command` são `dangerous`, e é o **nome/argumento** que diz o que vão
 * fazer. Em vez de tentar adivinhar a intenção, a classe é uma função pura
 * sobre o pedido, e tudo o que ela não reconhece como seguro de reutilizar cai
 * no caminho antigo: perguntar.
 */
import { isAbsolute, resolve } from 'node:path';

import type { PermissionRequest } from '../core/permissions/gateway';

/** O que a concessão cobre. */
export interface GrantScope {
	/** A tarefa (o turno) a que a concessão pertence. */
	readonly taskId: string;
	/** Chaves de recurso autorizadas, normalizadas por `scopeKey`. */
	readonly keys: ReadonlySet<string>;
}

/** Como o pedido deve ser tratado. */
export type PermissionClass =
	/** Não pergunta: ler e pesquisar nunca precisaram de confirmação. */
	| { readonly kind: 'automatic' }
	/** Pergunta uma vez por escopo; a resposta vale para o resto da tarefa. */
	| { readonly kind: 'scoped'; readonly key: string; readonly scopeLabel: string }
	/** Pergunta **sempre**, sem reutilização. */
	| { readonly kind: 'explicit'; readonly reason: string };

/**
 * Ferramentas de leitura do DEV, e as de pesquisa — sempre automáticas.
 *
 * É uma lista explícita, não "tudo o que não é escrever": uma ferramenta nova
 * que ninguém classificou cai em `explicit` e pergunta, que é o lado seguro do
 * erro.
 */
const READING_TOOLS: ReadonlySet<string> = new Set([
	'dev_read',
	'dev_search',
	'dev_status',
	'dev_diff',
	'dev_list',
	'dev_pending',
	// DEV-AUDIT-01: listar checkpoints é leitura pura, e o rótulo `safe` não
	// bastava — a ferramenta não estava na lista e pedia autorização.
	'dev_checkpoint',
	'model_catalog_list',
	'model_catalog_search',
	'web_search',
	'web_fetch',
	'web_open',
	'skill_list',
	'memory_recall',
]);

/**
 * Ferramentas que, no escopo DEV, podem ser reutilizadas na tarefa.
 *
 * Só `dev_write`: escrever no mesmo diretório já autorizado não é uma
 * decisão nova a cada arquivo.
 *
 * **`dev_run` saiu daqui na DEV-9.1.** Ele executava um comando arbitrário da
 * allowlist com as permissões do usuário; reutilizar a aprovação de
 * `npm run test` para `npm run build` seria exatamente o "aprovar uma coisa,
 * executar outra" que a auditoria pediu para fechar. Agora ele sempre pergunta,
 * com o comando exato (ver `EXPLICIT_TOOLS`).
 */
const SCOPED_TOOLS: ReadonlySet<string> = new Set(['dev_write']);

/**
 * O que nunca se reutiliza, e por quê.
 *
 * O nome aparece na razão para a interface poder dizer *o que* perguntou; a
 * razão viaja no pedido, não é inventada depois.
 */
const EXPLICIT_TOOLS: Readonly<Record<string, string>> = {
	dev_apply: 'aplicar uma mudança reescreve o repositório; isso não se estende a outras etapas',
	dev_checkpoint_restore: 'restaurar um checkpoint desfaz trabalho; confirme a cada vez',
	dev_configure: 'configurar a autorização do DEV é uma ação de credencial',
	dev_recover: 'recuperar a credencial do DEV apaga a existente',
	run_command: 'comandos podem fazer qualquer coisa; cada um é confirmado',
	dev_run: 'cada comando executado é aprovado sozinho, com o texto exato (DEV-9.1)',
	system_write: 'alterar o prompt de sistema muda o comportamento da Evelyn',
	// DEV-AUDIT-01: ferramentas de memória/skill **não** são do repositório.
	// Sem uma concessão explícita de escopo próprio, elas perguntam — o padrão
	// seguro. Elas nunca foram `scoped` por desenho; passaram a ser por causa da
	// regex que classificava qualquer nome com "write"/"delete".
	delete_memory: 'apagar uma memória é irreversível; confirme a cada vez',
	delete_skill: 'apagar uma skill é irreversível; confirme a cada vez',
	write_memory: 'gravar na memória escreve fora do repositório; confirme a cada vez',
	write_skill: 'gravar uma skill escreve fora do repositório; confirme a cada vez',
};

/**
 * Escritas no repositório DEV, classificadas **por nome**, não por padrão.
 *
 * DEV-AUDIT-01: a versão anterior usava `/(write|create|delete|…)/` sobre o
 * nome da ferramenta, e isso tornava `write_file`, `write_memory`,
 * `write_skill` e `delete_memory` "escopo DEV" — ferramentas que nem tocam o
 * repositório, e cujo caminho podia ser montado fora dele. A lista explícita
 * abaixo é a única fonte: o que não está nela não herda escopo.
 */
const DEV_REPOSITORY_WRITES: ReadonlySet<string> = new Set(['dev_write']);

/**
 * Escritas no **workspace do projeto**, não no repositório DEV.
 *
 * `write_file` opera no diretório do projeto da conversa (`Workspace`), que
 * pode ser qualquer pasta — inclusive fora do checkout da Evelyn. A chave
 * delas é o próprio caminho do workspace, e não há concessão de escopo por
 * diretório: cada workspace é um escopo, e a autorização de um não vale para
 * outro. Sem raiz DEV na sessão, o caminho ainda é usado como chave, mas a
 * permissão continua perguntando (ver `classifyRequest`).
 */
const WORKSPACE_WRITES: ReadonlySet<string> = new Set(['write_file', 'create_file']);

/**
 * Normaliza uma chave de escopo.
 *
 * Minúsculas e separador único: `G:\repo\src` e `g:/repo/src/` são o mesmo
 * diretório no Windows, e duas concessões para a mesma pasta seriam duas
 * perguntas.
 */
export function scopeKey(path: string): string {
	// Um caminho Windows (`C:\repo`) chega com barras invertidas e caixa
	// variável mesmo em processo que não é win32 (um teste no POSIX, um
	// caminho vindo de um guest). `resolve` só normaliza o cwd local, então o
	// caminho é normalizado aqui, sem tocar no disco.
	const normalized = path.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
	const isWindowsPath = /^[a-z]:\//i.test(normalized);
	return isWindowsPath || process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * A **pasta** de uma chave de escrita.
 *
 * A concessão é por diretório, não por arquivo: autorizar `src/a.ts` e depois
 * perguntar por `src/b.ts` seria dez perguntas numa edição de dez arquivos —
 * exatamente a interrupção que a pessoa relatou. E o perdão é só para dentro
 * da pasta: `src/a.ts` cobre `src/b.ts`, não `src/sub/x.ts` de outro
 * diretório, e nunca `src2/…`.
 */
function scopeDirectory(key: string): string {
	const cut = key.lastIndexOf('/');
	return cut <= 0 ? key : key.slice(0, cut);
}

/**
 * Classifica um pedido.
 *
 * `root` é a raiz do repositório DEV, quando há um: é ele que define o escopo
 * de execução e o que conta como "dentro do DEV". Sem raiz, nenhuma escrita é
 * classificada como escopo — o caminho antigo (perguntar) continua valendo.
 */
export function classifyRequest(
	request: PermissionRequest,
	options: { readonly root?: string } = {},
): PermissionClass {
	if (request.riskLevel === 'safe' || READING_TOOLS.has(request.toolName)) {
		return { kind: 'automatic' };
	}

	const explicit = EXPLICIT_TOOLS[request.toolName];
	if (explicit !== undefined) {
		return { kind: 'explicit', reason: explicit };
	}

	// Somente as escritas do DEV, por nome. Nada de regex sobre o nome da
	// ferramenta: ele classificava `write_memory` e `delete_memory` como se
	// fossem o repositório (DEV-AUDIT-01).
	if (DEV_REPOSITORY_WRITES.has(request.toolName)) {
		const target = typeof request.arguments['path'] === 'string' ? request.arguments['path'] : undefined;
		if (options.root === undefined) {
			return { kind: 'explicit', reason: 'não há escopo DEV definido para esta escrita' };
		}
		const inside = resolveInside(options.root, target);
		if (inside === undefined) {
			// Um caminho absoluto ou com `..` que sai da raiz **não** ganha
			// chave de escopo: cairia numa chave inventada (antes:
			// `g:/repo/c:/fora`), que uma concessão ampla poderia cobrir.
			return {
				kind: 'explicit',
				reason: 'a escrita aponta para fora do repositório DEV; confirme a cada vez',
			};
		}
		// A chave é a **pasta** do arquivo: a concessão vale para o diretório,
		// que é a unidade de uma edição — não para o arquivo isolado.
		return { kind: 'scoped', key: scopeDirectory(scopeKey(inside)), scopeLabel: scopeDirectory(scopeKey(inside)) };
	}

	if (WORKSPACE_WRITES.has(request.toolName)) {
		// O workspace do projeto é outro escopo, e a autorização de um
		// workspace não vale para outro. A chave é o diretório do destino —
		// nunca a raiz DEV, que não tem relação com ele.
		const target = typeof request.arguments['path'] === 'string' ? request.arguments['path'] : undefined;
		if (target === undefined) {
			return { kind: 'explicit', reason: `"${request.toolName}" sem caminho não tem escopo definido` };
		}
		const resolved = absoluteOrRelative(target);
		if (resolved === undefined) {
			return { kind: 'explicit', reason: 'caminho inválido para escrita' };
		}
		return {
			kind: 'scoped',
			key: scopeDirectory(scopeKey(resolved)),
			scopeLabel: scopeDirectory(scopeKey(resolved)),
		};
	}

	if (SCOPED_TOOLS.has(request.toolName)) {
		if (options.root === undefined) {
			return { kind: 'explicit', reason: 'não há escopo DEV definido para esta ação' };
		}
		// Execução não tem "pasta de destino": o escopo é o repositório.
		const key = scopeKey(options.root);
		return { kind: 'scoped', key, scopeLabel: key };
	}

	return {
		kind: 'explicit',
		reason: `"${request.toolName}" não tem escopo de reutilização definido`,
	};
}

/**
 * O caminho pedido, resolvido dentro de `root` — ou `undefined` se sair.
 *
 * O que antes era concatenação de strings vira resolução de verdade: um alvo
 * absoluto (`C:\Windows\…`) ou com `..` que sobe acima da raiz não produz
 * chave nenhuma, e a concessão não tem como alcançá-lo.
 */
function resolveInside(root: string, target: string | undefined): string | undefined {
	if (target === undefined) {
		return root;
	}
	if (isAbsolute(target)) {
		return undefined;
	}
	const base = root.replace(/[\\/]+$/, '');
	const resolved = resolve(base, target);
	const baseKey = scopeKey(base);
	const resolvedKey = scopeKey(resolved);
	return resolvedKey === baseKey || resolvedKey.startsWith(`${baseKey}/`) ? resolved : undefined;
}

/** Um caminho absoluto como veio, ou o resolvido contra o cwd quando relativo. */
function absoluteOrRelative(target: string): string | undefined {
	const trimmed = target.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

/**
 * A concessão já cobre esta chave?
 *
 * Cobre a chave exata e também as **filhas** dela: autorizar uma pasta
 * significa autorizar o que se escreve dentro — não o irmão homônimo
 * (`src` cobre `src/a/b`, não `src2`).
 *
 * A comparação é por **segmento** (`granted + '/'`), e ambas as pontas passam
 * por `scopeKey` antes: no Windows, `G:\REPO\SRC` e `g:/repo/src` são o mesmo
 * diretório, e comparar strings cruas deixaria a segunda escapar.
 */
export function grantCovers(keys: ReadonlySet<string>, key: string): boolean {
	const normalized = scopeKey(key);
	for (const granted of keys) {
		// As duas pontas normalizadas: no Windows, `G:\REPO\SRC` (concedido) e
		// `g:/repo/src` (pedido) são o mesmo diretório. Comparar a concessão
		// crua deixava a segunda pedir de novo — e pior, deixava um caminho
		// escrito de outra forma escapar da comparação.
		const grantedKey = scopeKey(granted);
		if (normalized === grantedKey || normalized.startsWith(`${grantedKey}/`)) {
			return true;
		}
	}
	return false;
}

/**
 * Acrescenta uma chave a uma concessão, devolvendo uma nova.
 *
 * Imutável de propósito: quem tem a concessão antiga (um turno que já a
 * recebeu) não ganha escopo por um pedido de outro turno.
 */
export function extendGrant(grant: GrantScope, keys: readonly string[]): GrantScope {
	const next = new Set(grant.keys);
	for (const key of keys) {
		next.add(key);
	}
	return { taskId: grant.taskId, keys: next };
}
