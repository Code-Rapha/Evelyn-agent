/**
 * R4H: encerramento abrupto do serviço, com processo de verdade.
 *
 * ## O que acontece aqui
 *
 * 1. sobe `dist/web/main.js` numa raiz temporária;
 * 2. cria uma conversa e **inicia um turno** cujo modelo nunca responde
 *    (nenhum provedor configurado → o turno fica em curso ou falha rápido);
 * 3. **mata o processo** com `SIGKILL` — sem `close`, sem `finish`, sem
 *    limpeza de nenhum tipo;
 * 4. sobe **outro** processo na mesma raiz;
 * 5. confere o `turns.json`: o que estava `running` virou `interrupted`, e o
 *    histórico da conversa continua legível.
 *
 * ## O que este teste não faz
 *
 * Não usa provedor externo. Para o turno ficar em curso durante a queda, o
 * serviço é iniciado sem provedor configurado — um turno nesse estado é
 * recusado antes de chegar a um modelo, e o que se verifica é o registro e a
 * recuperação, não a geração.
 */
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeService } from '../app/discoverService';
import { TurnRecordStore, TURNS_FILE } from '../core/storage/turnRecords';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const SERVICE_ENTRY = join(process.cwd(), 'dist', 'web', 'main.js');

const children: ChildProcess[] = [];
const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4h-crash-'));
	roots.push(root);
	return root;
}

interface Running {
	readonly child: ChildProcess;
	readonly port: number;
	readonly token: string;
}

async function startService(root: string): Promise<Running> {
	assert.ok(existsSync(SERVICE_ENTRY), 'faltou `npm run web:build`');
	const child = spawn(process.execPath, [SERVICE_ENTRY, '--root', root, '--port', '0'], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	const deadline = Date.now() + 25_000;
	for (;;) {
		const probe = await probeService({ root });
		if (probe.kind === 'active') {
			return { child, port: probe.record.port, token: probe.record.chatToken };
		}
		if (Date.now() > deadline) {
			throw new Error('o serviço não ficou ativo a tempo');
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function stopService(root: string): Promise<void> {
	const child = spawn(process.execPath, [SERVICE_ENTRY, '--root', root, '--stop'], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	await new Promise((resolve) => child.on('exit', resolve));
}

async function waitExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			resolve();
		}, 15_000);
		child.on('exit', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/** POST autenticado com a credencial de conversa do serviço. */
async function post(
	service: Running,
	path: string,
	body: unknown,
): Promise<{ readonly status: number; readonly body: string }> {
	const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-seshyina-chat': service.token },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.text() };
}

teardown(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill('SIGKILL');
		}
	}
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('R4H: queda real do processo', () => {
	test('um turno em curso no momento do SIGKILL aparece `interrupted` depois', async () => {
		const seedEntry = join(__dirname, 'helpers', 'seedConversations.js');
		assert.ok(existsSync(SERVICE_ENTRY), 'faltou `npm run web:build`');
		assert.ok(existsSync(seedEntry), 'faltou `npm run compile-tests`');

		const root = await makeRoot();
		// Um provedor no disco, sem ninguém atendendo: o turno é aceito e fica
		// esperando a resposta que nunca vem.
		const seed = spawn(process.execPath, [seedEntry, root, JSON.stringify(['queda'])], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		children.push(seed);
		let seeded = '';
		seed.stdout?.setEncoding('utf8');
		seed.stdout?.on('data', (chunk: string) => (seeded += chunk));
		await new Promise((resolve) => seed.on('exit', resolve));
		const ids = (JSON.parse(seeded) as { ids: string[] }).ids;
		const conversationId = ids[0] as string;

		const first = await startService(root);
		// Inicia o turno **sem esperar**: ele vai para o provedor que não
		// existe e o registro já está gravado quando o processo morre.
		//
		// R4Q: o status do pedido é guardado. Se a mensagem não aparecer, o
		// teste diz **por quê** (o `POST` recusou, por exemplo) em vez de
		// esperar 10 s em silêncio.
		let postStatus: number | undefined;
		let postBody = '';
		const turn = fetch(`http://127.0.0.1:${first.port}/api/chat/turn`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-seshyina-chat': first.token },
			body: JSON.stringify({
				conversationId,
				providerId: 'seed',
				model: 'seed/modelo',
				text: 'esta resposta nunca chega',
			}),
		})
			.then(async (response) => {
				postStatus = response.status;
				postBody = await response.text().catch(() => '');
				return response;
			})
			.catch((error: unknown) => {
				postBody = error instanceof Error ? error.message : String(error);
				return undefined;
			});

		// R4O: a prova passou a ser a **mensagem no histórico**, não só o
		// registro do turno. O serviço confirma o início só depois de gravá-la,
		// então a espera — que antes olhava `turns.json` e matava numa janela em
		// que o texto ainda estava em memória — agora espera a garantia
		// contratual. `turns.json` continua sendo observado, para provar que o
		// registro também existe na queda.
		const deadline = Date.now() + 10_000;
		const conversationPath = join(root, 'conversations', `${conversationId}.json`);
		let persistedAt: number | undefined;
		while (Date.now() < deadline) {
			try {
				const raw = await readFile(conversationPath, 'utf8');
				const stored = JSON.parse(raw) as {
					readonly messages: readonly { readonly role: string; readonly content: string }[];
				};
				const index = stored.messages.findIndex(
					(message) => message.role === 'user' && message.content === 'esta resposta nunca chega',
				);
				if (index >= 0) {
					persistedAt = index;
					break;
				}
			} catch {
				// o arquivo ainda não existe (ou está sendo trocado de forma atômica)
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.notEqual(
			persistedAt,
			undefined,
			`a mensagem foi persistida antes de o turno rodar (POST: ${String(postStatus)} ${postBody.slice(0, 200)})`,
		);

		// O registro do turno é escrito **depois** do histórico: na hora da
		// queda ele já tem de estar lá.
		let recorded = false;
		const turnsDeadline = Date.now() + 10_000;
		while (!recorded && Date.now() < turnsDeadline) {
			try {
				const raw = await readFile(join(root, TURNS_FILE), 'utf8');
				recorded = raw.includes('"turnId"');
			} catch {
				// o arquivo ainda não existe
			}
			if (!recorded) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		assert.equal(recorded, true, 'o turno foi registrado antes da execução');

		const beforeCrash = await readFile(join(root, TURNS_FILE), 'utf8');
		first.child.kill('SIGKILL');
		await waitExit(first.child);
		void turn;

		// O processo morreu sem `finish`: o que ficou no disco é o último
		// estado que ele gravou.
		const afterCrash = await readFile(join(root, TURNS_FILE), 'utf8');
		assert.equal(afterCrash, beforeCrash, 'nada foi escrito depois da morte');

		// "Reinicialização": um store novo sobre a mesma raiz, com a mesma
		// recuperação que o host roda ao subir.
		const revived = new TurnRecordStore({ root });
		const recovered = await revived.recover();

		const turns = await revived.forConversation(conversationId);
		assert.ok(turns.length > 0, 'o turno ficou registrado');
		// Nenhum turno pode continuar `running` depois da recuperação.
		assert.equal(turns.every((entry) => entry.status !== 'running'), true);
		// Se estava `running` na queda, virou `interrupted` com motivo; se o
		// provedor já tinha falhado antes do kill, o estado terminal é
		// preservado — nos dois casos, o resultado é coerente.
		if (beforeCrash.includes('"running"')) {
			const interrupted = turns.filter((entry) => entry.status === 'interrupted');
			assert.equal(interrupted.length, 1, 'o que estava rodando virou interrompido');
			assert.match(interrupted[0]?.reason ?? '', /encerrado antes de o turno terminar/);
			assert.equal(recovered.interrupted, 1);
		}

		// O histórico da conversa continua legível e com a pergunta gravada.
		const raw = await readFile(join(root, 'conversations', `${conversationId}.json`), 'utf8');
		const record = JSON.parse(raw) as { messages: readonly { role: string; content: string }[] };
		assert.ok(record.messages.some((message) => message.content === 'esta resposta nunca chega'));

		// E o serviço sobe de novo na mesma raiz, servindo a conversa.
		const second = await startService(root);
		try {
			const states = await post(second, '/api/chat/turn-state', { id: conversationId });
			assert.equal(states.status, 200);
			const published = (JSON.parse(states.body) as { turns: { status: string }[] }).turns;
			assert.ok(published.length > 0);
			assert.equal(
				published.some((entry) => entry.status === 'running'),
				false,
				'nenhum turno aparece em curso depois do reinício',
			);
		} finally {
			await stopService(root);
		}
	});
});
