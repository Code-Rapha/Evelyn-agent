/**
 * O diário das execuções do `dev_run` (DEV-9.1).
 *
 * ## O que é registrado
 *
 * Comando, diretório, horário de início e fim, se houve aprovação e qual foi
 * a decisão, duração, código de saída, motivo do encerramento e **tamanhos**
 * de saída. Não se grava a saída: um `npm test` imprime o que os testes
 * quiserem, e um teste pode imprimir um token por acidente. O tamanho e o
 * código bastam para investigar, e o conteúdo fica no resultado que a pessoa
 * vê — não num arquivo que dura mais que o turno.
 *
 * ## O que é redigido
 *
 * O **comando** pode conter segredo em hipótese: `npm run x --token=...` é
 * recusado pela política, mas um `node script.js env=ABC` não é. Antes de
 * gravar, o texto passa por `redactCommand`, que:
 *
 * - esconde o valor de `--token`, `--password`, `--secret`, `--key` e
 *   `--api-key`, com `=` ou com espaço;
 * - esconde um valor com forma de chave (`sk-…`, `ghp_…`, `AKIA…`, JWT);
 * - esconde valores com 32+ caracteres alfanuméricos depois de `=`.
 *
 * A redação é **best effort**: um segredo inventado pelo modelo e passado como
 * argumento posicional não é reconhecível. Ela reduz o vazamento, não o
 * elimina — e o documento diz isso.
 *
 * ## Por que em memória, por padrão
 *
 * Gravar em disco por padrão faria o diário sobreviver à sessão e ao
 * fechamento do app, com o que isso implica para um diretório de dados. O
 * host que quiser persistir passa um `DevAuditSink`; o padrão guarda as
 * últimas `AUDIT_MEMORY_LIMIT` execuções em memória, que é o suficiente para
 * "consultar o histórico" dentro da mesma execução.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { DevTermination } from './devRunner';

/** Quantas execuções o histórico em memória guarda. */
export const AUDIT_MEMORY_LIMIT = 50;

/** Um registro. Nada aqui contém saída de comando. */
export interface DevAuditRecord {
	/** Identificador do registro (`run-…`). */
	readonly id: string;
	/** O comando, já redigido. */
	readonly command: string;
	/** O diretório de trabalho. */
	readonly cwd: string;
	/** Início, em ISO-8601. */
	readonly startedAt: string;
	/** Fim, em ISO-8601 (igual ao início se nunca começou). */
	readonly finishedAt: string;
	/**
	 * Como a execução foi autorizada.
	 *
	 * - `approved`: a pessoa viu o comando e aprovou aquele comando;
	 * - `refused`: a pessoa recusou (ou o prazo da pergunta venceu);
	 * - `cancelled`: cancelada antes de começar;
	 * - `not-required`: nenhuma pergunta era necessária (não acontece hoje
	 *   para `dev_run`, que sempre pergunta; existe para o diário ser
	 *   completo se a política mudar).
	 */
	readonly approval: 'approved' | 'refused' | 'cancelled' | 'not-required';
	/** Duração em ms. Zero quando nunca começou. */
	readonly durationMs: number;
	/** Código de saída; `null` quando o processo não iniciou. */
	readonly exitCode: number | null;
	/** Por que terminou. */
	readonly termination: DevTermination;
	/** Bytes de stdout e stderr (não o conteúdo). */
	readonly outputBytes: { readonly stdout: number; readonly stderr: number };
	/** `true` quando a saída passou do teto. */
	readonly truncated: boolean;
	/** Motivo curto da recusa, quando houve. */
	readonly reason?: string;
}

/** A porta de persistência. Ausente = só memória. */
export interface DevAuditSink {
	/** Chamado uma vez por execução, depois do fim. */
	record(entry: DevAuditRecord): Promise<void>;
	/** O histórico, mais recente primeiro. */
	list(limit?: number): Promise<readonly DevAuditRecord[]>;
}

/**
 * Redige segredos reconhecíveis em uma linha de comando.
 *
 * Exportada para o teste fixar cada padrão: um segredo a mais no diário é um
 * vazamento que não se desfaz.
 */
export function redactCommand(command: string): string {
	return (
		command
			// `--token=abc` / `--password abc` / `--api-key=abc`
			.replace(
				/(--(?:token|password|passwd|secret|api-key|apikey|key|auth)(?:=|\s+))(\S+)/gi,
				'$1[redigido]',
			)
			// `token=abc` (sem `--`), inclusive no fim do argumento
			.replace(/\b(token|password|secret|apikey|api_key|auth)=([^\s]+)/gi, '$1=[redigido]')
			// Chaves com forma conhecida.
			.replace(/\b(sk-[A-Za-z0-9_-]{12,})/g, '[redigido]')
			.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, '[redigido]')
			.replace(/\b(AKIA[0-9A-Z]{16})\b/g, '[redigido]')
			.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redigido-jwt]')
			// Um valor longo depois de `=`, quando não é um caminho.
			.replace(/=([A-Za-z0-9+/_-]{32,})/g, '=[redigido]')
	);
}

/** O histórico padrão: em memória, com um teto. */
export class InMemoryDevAudit implements DevAuditSink {
	private readonly entries: DevAuditRecord[] = [];

	async record(entry: DevAuditRecord): Promise<void> {
		this.entries.unshift(entry);
		if (this.entries.length > AUDIT_MEMORY_LIMIT) {
			this.entries.length = AUDIT_MEMORY_LIMIT;
		}
	}

	async list(limit = AUDIT_MEMORY_LIMIT): Promise<readonly DevAuditRecord[]> {
		return this.entries.slice(0, Math.max(0, Math.min(limit, AUDIT_MEMORY_LIMIT)));
	}
}

/**
 * Um diário em arquivo JSONL, um registro por linha.
 *
 * Usado pelo host que quer o histórico durável. Cada linha é escrita com
 * `appendFile`: um registro a mais não reescreve os anteriores, e um app que
 * cai no meio não corrompe o histórico.
 */
export class FileDevAudit implements DevAuditSink {
	constructor(private readonly file: string) {}

	async record(entry: DevAuditRecord): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
	}

	async list(limit = AUDIT_MEMORY_LIMIT): Promise<readonly DevAuditRecord[]> {
		const { readFile } = await import('node:fs/promises');
		const raw = await readFile(this.file, 'utf8').catch(() => '');
		const entries: DevAuditRecord[] = [];
		for (const line of raw.split('\n')) {
			if (line.trim().length === 0) {
				continue;
			}
			try {
				entries.push(JSON.parse(line) as DevAuditRecord);
			} catch {
				// Uma linha truncada (queda no meio da escrita) é ignorada: o
				// histórico continua legível em vez de falhar inteiro.
			}
		}
		return entries.reverse().slice(0, Math.max(0, limit));
	}
}
