/**
 * Cria conversas numa raiz, com o Core do projeto.
 *
 * Existe para os testes de integração do histórico: o serviço precisa de
 * conversas **gravadas de verdade** pelo `FileDataStore`, e o jeito de criá-las
 * é o mesmo que o app usa. Nada é escrito à mão no formato do arquivo.
 *
 * Uso: node seedConversations.js <root> '["título 1","título 2"]'
 * Imprime `{ "ids": [...] }`.
 */
import { assembleCore } from '../../app/assemble';
import { ConsoleLogSink } from '../../adapters/local/consoleLogSink';

async function main(): Promise<void> {
	const root = process.argv[2];
	const titles = JSON.parse(process.argv[3] ?? '[]') as string[];
	if (typeof root !== 'string' || root.length === 0) {
		throw new Error('informe a raiz');
	}
	const core = assembleCore({
		rootPath: root,
		logScope: 'seed',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
	});
	try {
		// A criação de uma conversa valida o provedor: ele precisa existir no
		// Core. Nenhuma chamada é feita a esse endereço aqui.
		await core.chat.saveProvider({ id: 'seed', name: 'Seed', baseUrl: 'http://127.0.0.1:1/v1' });
		const ids: string[] = [];
		for (const title of titles) {
			const created = await core.chat.createConversation({ providerId: 'seed', title });
			ids.push(created.summary.id);
		}
		process.stdout.write(`${JSON.stringify({ ids })}\n`);
	} finally {
		core.chat.dispose();
	}
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
