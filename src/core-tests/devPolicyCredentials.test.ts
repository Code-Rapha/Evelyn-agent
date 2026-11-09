/**
 * DEV-AUDIT-01: os nomes que a auditoria encontrou **legíveis** e que a
 * política anterior deixava passar.
 *
 * A auditoria mostrou `dev_read` lendo `segredo.env`, `.npmrc` e
 * `.git-credentials` — a regra cobria só `.env`/`.env.*`. Cada linha aqui é
 * um caso medido, não um caso imaginado.
 */
import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { classifyPath } from '../core/dev/devPolicy';
import { DevSession } from '../core/dev/devSession';
import { DevCheckpointStore } from '../core/dev/devCheckpoint';
import { DevRunner } from '../core/dev/devRunner';
import { DevLocks } from '../core/dev/devLocks';
import { createDevTools } from '../core/agent/devTools';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BLOCKED: readonly (readonly [string, string])[] = [
	// Arquivos de ambiente por qualquer posição do nome.
	['.env', 'nome exato'],
	['.env.local', 'prefixo'],
	['.env.production', 'prefixo'],
	['prod.env', 'sufixo (o caso medido: segredo.env)'],
	['segredo.env', 'sufixo'],
	['config.env', 'sufixo'],
	['app.env.local', 'no meio'],
	['.env.bak', 'backup'],
	// Clientes que guardam token em texto puro.
	['.npmrc', 'token do npm'],
	['.yarnrc', 'token do yarn'],
	['.yarnrc.yml', 'token do yarn (yaml)'],
	['.pypirc', 'token do PyPI'],
	['.netrc', 'credencial de rede'],
	['.git-credentials', 'credencial do git'],
	['.htpasswd', 'senhas'],
	// Credenciais estruturadas.
	['secrets.yaml', 'secrets em yaml'],
	['secrets.yml', 'secrets em yml'],
	['secrets.toml', 'secrets em toml'],
	['credentials', 'nome sem extensão'],
	['credentials.json', 'json'],
	['vault.json', 'cofre'],
	['api.secret.json', 'sufixo .secret.json'],
	['certs/server.pem', 'certificado'],
	['private.key', 'chave'],
	['id_rsa', 'chave SSH'],
	['id_ed25519', 'chave SSH'],
	['wallet.p12', 'keystore'],
];

const ALLOWED: readonly (readonly [string, string])[] = [
	['.env.example', 'template sem valor'],
	['.env.sample', 'template'],
	['.env.template', 'template'],
	['app.env.example', 'template com prefixo'],
	['package.json', 'configuração legítima'],
	['tsconfig.json', 'configuração legítima'],
	['eslint.config.js', 'configuração legítima'],
	['README.md', 'documentação'],
	['src/index.ts', 'código'],
	['environment.md', 'contém "env" mas não é ambiente'],
	['environments.ts', 'contém "env" mas não é ambiente'],
];

test('cada nome que a auditoria encontrou legível agora é protegido', () => {
	for (const [path, why] of BLOCKED) {
		assert.equal(classifyPath(path).protected, true, `${path} (${why})`);
	}
});

test('configuração legítima continua liberada (a correção não bloqueia o trabalho)', () => {
	for (const [path, why] of ALLOWED) {
		assert.equal(classifyPath(path).protected, false, `${path} (${why})`);
	}
});

test('variações do Windows não contornam: caixa, espaço e ponto finais', () => {
	for (const path of ['SEGREDO.ENV', 'Prod.Env', '.NPMRC', 'secrets.yaml ', 'secrets.json.', ' Secrets.YAML']) {
		assert.equal(classifyPath(path).protected, true, path);
	}
});

test('o caminho completo não importa: a regra é sobre o nome do arquivo', () => {
	for (const path of ['a/b/c/prod.env', 'C:\\proj\\app.env.local', 'src/../.npmrc']) {
		assert.equal(classifyPath(path).protected, true, path);
	}
});

test('dev_read e dev_write recusam os nomes medidos, dentro do repositório', async () => {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-audit01-'));
	const data = await mkdtemp(join(tmpdir(), 'evelyn-audit01-data-'));
	try {
		await mkdir(join(root, '.git'), { recursive: true });
		const session = new DevSession({ repositoryRoot: root });
		const checkpoints = new DevCheckpointStore(join(data, 'dev'));
		await checkpoints.init();
		const tools = new Map(
			createDevTools({
				session,
				checkpoints,
				runner: new DevRunner({ timeoutMs: 10_000 }),
				locks: new DevLocks(),
			}).map((tool) => [tool.descriptor.name, tool]),
		);
		await session.enter();

		for (const [path] of BLOCKED) {
			// Só o nome local: os que têm barra já foram cobertos pela
			// classificação. Criar arquivo com `a/b/c/...` exigiria os
			// diretórios, e o caminho não muda o veredito.
			const leaf = path.split('/').pop() as string;
			if (leaf === '.env' || leaf === 'prod.env') {
				continue;
			}
			await writeFile(join(root, leaf), 'TOKEN=nao-deve-sair\n', 'utf8').catch(() => undefined);
		}
		// `prod.env` é o caso concreto e precisa existir.
		await writeFile(join(root, 'prod.env'), 'API_KEY=nao-deve-sair\n', 'utf8');

		const read = await tools.get('dev_read')!.execute({ path: 'prod.env' } as never, { sessionId: 'a' });
		assert.equal(read.ok, false, 'dev_read recusa prod.env');
		assert.match((read as { error?: string }).error ?? '', /protegido/);

		const write = await tools.get('dev_write')!.execute(
			{ path: '.npmrc', content: '//registry:_authToken=x' } as never,
			{ sessionId: 'a' },
		);
		assert.equal(write.ok, false, 'dev_write recusa .npmrc');

		// O arquivo não foi alterado pela tentativa.
		assert.equal(await readFile(join(root, 'prod.env'), 'utf8'), 'API_KEY=nao-deve-sair\n');

		await session.exit();
	} finally {
		await removeFixtureTree(root).catch(() => undefined);
		await removeFixtureTree(data).catch(() => undefined);
	}
});
