/**
 * A autenticação das mensagens do serviço de sandbox.
 *
 * Duas propriedades, e nenhuma delas substitui a outra:
 *
 * - **Identidade**: só quem tem a chave de 32 bytes consegue assinar. A chave
 *   é gerada na instalação e vive num arquivo cujo ACL é `SYSTEM` + o usuário
 *   instalador — outro usuário local não a lê.
 * - **Freshness**: o `seq` cresce a cada mensagem e o `sentAt` tem de estar
 *   dentro de `CLOCK_SKEW_MS`. Uma mensagem capturada não serve depois, e
 *   reenviar a mesma não executa duas vezes.
 *
 * O HMAC é calculado sobre uma serialização **canônica** (campos em ordem
 * fixa, JSON sem espaços). Se o cliente e o serviço serializassem o mesmo
 * objeto de formas diferentes, o servidor recusaria mensagens legítimas; a
 * função `canonicalPayload` existe para que isso não aconteça.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
	CLOCK_SKEW_MS,
	type SandboxEnvelope,
	type SandboxRequest,
} from './sandboxProtocol';

/** 32 bytes: a chave do HMAC. Menos que isso enfraquece a assinatura. */
export const SANDBOX_KEY_BYTES = 32;

/** Gera uma chave nova. Chamada uma vez, na instalação. */
export function generateSandboxKey(): string {
	return randomBytes(SANDBOX_KEY_BYTES).toString('base64');
}

/** A serialização canônica: ordem fixa, sem espaços, sem surpresas. */
export function canonicalRequest(request: SandboxRequest): string {
	return JSON.stringify({
		op: request.op,
		root: request.root,
		command: request.command,
		timeoutMs: request.timeoutMs,
	});
}

/** O material assinado: versão, sequência, instante e o pedido canônico. */
export function signingMaterial(envelope: Pick<SandboxEnvelope, 'version' | 'seq' | 'sentAt'>, request: SandboxRequest): string {
	return `${envelope.version}|${envelope.seq}|${envelope.sentAt}|${canonicalRequest(request)}`;
}

/** Assina um pedido, devolvendo o envelope completo. */
export function signRequest(keyBase64: string, seq: number, request: SandboxRequest, now: Date = new Date()): SandboxEnvelope {
	const envelope: SandboxEnvelope = {
		version: 1,
		seq,
		sentAt: now.toISOString(),
		payload: request,
		signature: '',
	};
	const signature = createHmac('sha256', Buffer.from(keyBase64, 'base64'))
		.update(signingMaterial(envelope, request))
		.digest('base64');
	return { ...envelope, signature };
}

/** Como um envelope foi julgado. */
export type EnvelopeVerdict =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: 'protocolo-desconhecido' | 'assinatura-invalida' | 'fora-da-janela' | 'sequencia-fora-de-ordem';
	  };

/**
 * Valida um envelope.
 *
 * `lastSeq` é a maior sequência já aceita para esta chave (o estado vive no
 * serviço, em memória). `seq <= lastSeq` é recusado: delay, repetição ou
 * mensagem fora de ordem.
 *
 * A comparação da assinatura usa `timingSafeEqual` com buffers do mesmo
 * tamanho: comparar strings com `===` vazaria, pelo tempo de resposta, quanto
 * do prefixo correto foi adivinhado.
 */
export function verifyEnvelope(
	keyBase64: string,
	envelope: SandboxEnvelope,
	lastSeq: number,
	now: Date = new Date(),
): EnvelopeVerdict {
	if (envelope.version !== 1) {
		return { ok: false, reason: 'protocolo-desconhecido' };
	}
	const expected = createHmac('sha256', Buffer.from(keyBase64, 'base64'))
		.update(signingMaterial(envelope, envelope.payload))
		.digest();
	let received: Buffer;
	try {
		received = Buffer.from(envelope.signature, 'base64');
	} catch {
		return { ok: false, reason: 'assinatura-invalida' };
	}
	if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
		return { ok: false, reason: 'assinatura-invalida' };
	}
	const sentAt = Date.parse(envelope.sentAt);
	if (!Number.isFinite(sentAt) || Math.abs(now.getTime() - sentAt) > CLOCK_SKEW_MS) {
		return { ok: false, reason: 'fora-da-janela' };
	}
	if (!Number.isInteger(envelope.seq) || envelope.seq <= lastSeq) {
		return { ok: false, reason: 'sequencia-fora-de-ordem' };
	}
	return { ok: true };
}
