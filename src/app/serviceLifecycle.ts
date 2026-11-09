/**
 * Operações de vida do serviço local, para a CLI.
 *
 * ## Encerrar só o que é nosso
 *
 * `stop` não mata "o processo daquela porta". Ele confere, antes de qualquer
 * sinal:
 *
 * 1. o `service.json` existe e é válido;
 * 2. o pid dele está vivo;
 * 3. o health **autenticado** responde e diz que é o mesmo pid, na mesma
 *    porta, e sendo o dono do Core.
 *
 * Só então o sinal vai. Um registro obsoleto (processo morto) não recebe
 * sinal algum — não há o que encerrar —, e um pid **reciclado** por outro
 * programa é recusado justamente pela etapa 3: o impostor não tem a
 * credencial do registro.
 *
 * ## Por que SIGTERM, e não `kill`
 *
 * No Windows não existe SIGTERM de verdade: `process.kill(pid, 'SIGTERM')`
 * termina o processo à força. No Unix ele é a **solicitação** de encerrar, que
 * o servo trata para liberar o lock e os recursos — e é o que este código usa.
 * O encerramento forçado é a última linha: o lock é recuperado por
 * `isOwnerAlive` na próxima abertura, e o registro obsoleto é detectado como
 * `stale`.
 */
import { readServiceRecord, PROTOCOL_VERSION, type ServiceRecord } from './serviceRecord';
import { probeService, type ServiceProbe, type ServiceProbeOptions } from './discoverService';

/** O que `status` encontrou, em termos que a CLI imprime. */
export interface ServiceStatus {
	readonly probe: ServiceProbe;
	/** Uma linha para humano, sem caminho de dados e sem credencial. */
	readonly line: string;
}

/** Descreve o veredito em uma linha. */
export function describeProbe(probe: ServiceProbe): string {
	switch (probe.kind) {
		case 'active':
			return (
				`serviço ativo: processo ${probe.record.pid}, ` +
				`${probe.record.address}:${probe.record.port}, ` +
				`desde ${probe.record.startedAt}, Core ${probe.health.coreMounted ? 'montado' : 'não montado'}`
			);
		case 'absent':
			return 'serviço parado: nenhum registro encontrado';
		case 'incompatible':
			return `serviço incompatível: fala o protocolo ${probe.protocol}, e este cliente fala o ${PROTOCOL_VERSION}`;
		case 'invalid':
			return `registro do serviço inválido: ${probe.reason}`;
		case 'stale':
			return `serviço parado sem limpeza: ${probe.reason}`;
		case 'unresponsive':
			return `serviço não respondeu: ${probe.reason}`;
	}
}

/** Lê o estado do serviço. */
export async function serviceStatus(options: ServiceProbeOptions): Promise<ServiceStatus> {
	const probe = await probeService(options);
	return { probe, line: describeProbe(probe) };
}

/** O resultado de um pedido de encerramento. */
export type StopResult =
	| { readonly kind: 'stopped'; readonly pid: number }
	| { readonly kind: 'not-running'; readonly reason: string }
	/** Há algo que não é (ou não se prova ser) o serviço. Não foi tocado. */
	| { readonly kind: 'refused'; readonly reason: string };

/**
 * Pede ao serviço que encerre.
 *
 * ## Por que HTTP, e não sinal
 *
 * No Windows não existe SIGTERM tratável: `process.kill(pid, 'SIGTERM')`
 * termina o processo à força, o `close` do host não roda, e o lock e o
 * registro ficam para trás. O pedido vai por `POST /api/service/shutdown`,
 * autenticado com a credencial do painel — a mesma que prova que quem pede
 * fala com **este** serviço. No Unix o mesmo caminho funciona.
 *
 * O sinal continua existindo como **último recurso** (`signal`), usado só
 * quando o pedido HTTP não é aceito e a plataforma tem sinais tratáveis.
 *
 * Devolve depois de mandar o pedido; confirmar a saída é do `waitForStop`.
 */
export async function stopService(
	options: ServiceProbeOptions & {
		/** Manda um sinal, quando o pedido HTTP não é possível. Injetado em teste. */
		readonly signal?: (pid: number) => void;
		/** Envia o pedido de encerramento. Injetado em teste. */
		readonly requestShutdown?: (
			url: string,
			token: string,
		) => Promise<{ readonly status: number }>;
		/** Usa o sinal em vez do pedido HTTP (nunca no Windows por padrão). */
		readonly forceSignal?: boolean;
	},
): Promise<StopResult> {
	const probe = await probeService(options);
	switch (probe.kind) {
		case 'absent':
			return { kind: 'not-running', reason: 'não há registro de serviço' };
		case 'stale':
			return { kind: 'not-running', reason: probe.reason };
		case 'invalid':
			return { kind: 'refused', reason: `o registro do serviço não é confiável (${probe.reason}); nada foi encerrado` };
		case 'incompatible':
			return {
				kind: 'refused',
				reason: `o serviço fala o protocolo ${probe.protocol} e este cliente fala o ${PROTOCOL_VERSION}; encerre-o com a ferramenta daquele serviço`,
			};
		case 'unresponsive':
			return { kind: 'refused', reason: `${probe.reason}; nada foi encerrado` };
		case 'active':
			break;
	}
	const record: ServiceRecord = probe.record;

	// O caminho normal: pedido HTTP autenticado, que deixa o processo limpar.
	if (options.forceSignal !== true && options.signal === undefined) {
		const ask = options.requestShutdown ?? defaultRequestShutdown;
		try {
			const answer = await ask(`http://${record.address}:${record.port}/api/service/shutdown`, record.token);
			if (answer.status === 202 || answer.status === 200) {
				return { kind: 'stopped', pid: record.pid };
			}
			return {
				kind: 'refused',
				reason: `o serviço recusou o pedido de encerramento (status ${answer.status})`,
			};
		} catch (error) {
			return {
				kind: 'refused',
				reason: `não foi possível pedir o encerramento: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	const send = options.signal ?? defaultSignal;
	try {
		send(record.pid);
	} catch (error) {
		return {
			kind: 'refused',
			reason: `não foi possível sinalizar o processo ${record.pid}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return { kind: 'stopped', pid: record.pid };
}

/** O pedido HTTP de encerramento. */
async function defaultRequestShutdown(url: string, token: string): Promise<{ readonly status: number }> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'x-seshyina-token': token },
		signal: AbortSignal.timeout(2_000),
	});
	await response.text().catch(() => undefined);
	return { status: response.status };
}

/** O sinal de encerramento pedido (SIGTERM: pedido, não execução à força). */
function defaultSignal(pid: number): void {
	process.kill(pid, 'SIGTERM');
}

/** Espera o serviço sair, repetindo a descoberta. Usado pela CLI e pelos testes. */
export async function waitForStop(options: ServiceProbeOptions, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const probe = await probeService(options);
		if (probe.kind === 'absent' || probe.kind === 'stale') {
			return true;
		}
		if (Date.now() > deadline) {
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Um registro legível, para a CLI reportar sem falar com a rede. */
export async function peekRecord(root: string): Promise<ServiceRecord | undefined> {
	const read = await readServiceRecord(root);
	return read.kind === 'ok' ? read.record : undefined;
}
