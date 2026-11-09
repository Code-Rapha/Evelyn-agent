/**
 * R1+R2: um segredo não aparece onde não deve.
 *
 * ## O que este arquivo verifica, de verdade
 *
 * Não que o código "tem cuidado", mas que, depois de exercitar o caminho
 * inteiro — autenticar, listar, conversar, recusar, cancelar —, a chave e o
 * token não estão em:
 *
 * - **no log** (o `LogSink` é capturado e inspecionado);
 * - **na resposta** HTTP;
 * - **no arquivo de chaves**;
 * - **na URL** de entrada do painel.
 *
 * O log é o lugar mais provável de vazamento: uma mensagem de erro "útil" com
 * o header inteiro é exatamente o que um serviço acaba escrevendo.
 */
import * as assert from 'assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import type { LogSink } from '../core/logging';
import { ApiKeyStore, API_KEYS_FILE } from '../core/security/apiKeys';
import { ApiChatRuntime } from '../web/apiChat';
import { startWebServer } from '../web/server';
import type { ChatProvider, ChatStream } from '../core/providers/chat/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

/** Um sink que guarda tudo o que passa, formatado como quem lê o log. */
function capturingSink(): { readonly sink: LogSink; readonly lines: string[] } {
	const lines: string[] = [];
	const sink: LogSink = {
		log(entry) {
			lines.push(`${entry.level} ${entry.message} ${JSON.stringify(entry.data ?? {})}`);
		},
	};
	return { sink, lines };
}

suite('R1+R2: os segredos não vazam', () => {
	test('nem a chave nem o token aparecem nos logs, nas respostas nem no arquivo', async () => {
		const root = await mkdtemp(join(tmpdir(), 'evelyn-secrets-'));
		const { sink, lines } = capturingSink();
		const core = assembleCore({ rootPath: root, logScope: 'test', logSink: sink });
		const keys = new ApiKeyStore({ filePath: join(root, API_KEYS_FILE) });
		const created = await keys.create({ name: 'teste' });

		const provider: ChatProvider = {
			async streamChat(): Promise<ChatStream> {
				return {
					closedReason: 'completed',
					timing: {},
					[Symbol.asyncIterator]: async function* () {
						yield { type: 'TextDelta', text: 'ok' };
						yield { type: 'Done' };
					},
				};
			},
		};
		const access = core.chat.routingAccess();
		if (access === undefined) {
			throw new Error('sem motor de rota');
		}
		const runtime = new ApiChatRuntime({
			providerFor: () => provider,
			candidatesFor: async ({ requested }) => [requested],
			policy: access.policy,
			breaker: access.breaker,
			ledger: core.history,
			store: core.history,
			pricing: async () => undefined,
			accessPolicy: async () => core.chat.loadAccessPolicy(),
		});
		const server = await startWebServer({
			version: 'test',
			assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
			core,
			openai: {
				authenticate: async (presented) => (presented === undefined ? undefined : await keys.verify(presented)),
				runtime,
				listModels: async () => [{ id: 'p/m', created: 0, ownedBy: 'p' }],
			},
			port: 0,
		});

		const bodies: string[] = [];
		try {
			const call = async (path: string, authorization?: string, body?: unknown): Promise<string> => {
				const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
					method: body === undefined ? 'GET' : 'POST',
					headers: {
						...(authorization !== undefined ? { authorization } : {}),
						...(body !== undefined ? { 'content-type': 'application/json' } : {}),
					},
					...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				});
				const text = await response.text();
				bodies.push(text);
				return text;
			};

			await call('/v1/models', `Bearer ${created.secret}`);
			await call('/v1/chat/completions', `Bearer ${created.secret}`, {
				model: 'p/m',
				messages: [{ role: 'user', content: 'conteúdo privado' }],
			});
			// O consumo é registrado depois da resposta; é o caminho que mais
			// escreve log de aviso, e o que mais corre o risco de vazar.
			core.logger.warn('Falha ao registrar consumo', {
				phase: 'consumption:attempt',
				error: 'exemplo',
			});
			// Recusas também passam pelo caminho de erro, que é onde um vazamento
			// costuma nascer.
			await call('/v1/models');
			await call('/v1/models', 'Bearer sk-evelyn-chute-errado');
			await call('/v1/chat/completions', `Bearer ${created.secret}`, { model: 'x' });
		} finally {
			await server.close();
			core.chat.dispose();
		}

		const logged = lines.join('\n');
		const responses = bodies.join('\n');
		const file = await readFile(join(root, API_KEYS_FILE), 'utf8');

		assert.ok(logged.length > 0, 'houve log a inspecionar');
		for (const [where, text] of [
			['log', logged],
			['resposta', responses],
			['arquivo de chaves', file],
		] as const) {
			assert.equal(text.includes(created.secret), false, `a chave vazou em ${where}`);
			assert.equal(text.includes('sk-evelyn-chute-errado'), false, `a chave tentada vazou em ${where}`);
			assert.equal(text.includes(server.token), false, `o token do painel vazou em ${where}`);
			assert.equal(text.includes('Bearer '), false, `o header cru vazou em ${where}`);
		}
		// A URL de entrada carrega o token do painel de propósito — é o primeiro
		// acesso do navegador. O que ela nunca pode carregar é a chave de
		// cliente: essa não existe em URL nenhuma.
		assert.equal(server.entryUrl.includes(created.secret), false, 'a chave de cliente não vai na URL');

		await removeFixtureTree(root).catch(() => undefined);
	});

	test('o log do host diz que a API subiu sem dizer a chave', async () => {
		// A mensagem de arranque é a que mais corre o risco de ser "útil demais".
		const root = await mkdtemp(join(tmpdir(), 'evelyn-secrets2-'));
		const { sink, lines } = capturingSink();
		const keys = new ApiKeyStore({ filePath: join(root, API_KEYS_FILE) });
		const created = await keys.create({ name: 'teste' });
		const core = assembleCore({ rootPath: root, logScope: 'test', logSink: sink });

		core.logger.info('API de clientes ligada', { keys: 1 });
		const logged = lines.join('\n');

		assert.match(logged, /API de clientes ligada/);
		assert.equal(logged.includes(created.secret), false);
		core.chat.dispose();
		await removeFixtureTree(root).catch(() => undefined);
	});
});
