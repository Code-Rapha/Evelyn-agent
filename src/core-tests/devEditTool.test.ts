/**
 * DEV-10 — `dev_edit`: trocar um trecho sem reescrever o arquivo.
 *
 * O caso medido: a agente encontrou a linha certa em `index.ts` e recusou-se a
 * regravar 6 805 linhas por causa de uma palavra — com razão. `dev_write` toma
 * o conteúdo completo, e um erro no meio corromperia o arquivo inteiro.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDevEditTool, type DevToolDeps } from '../core/agent/devTools';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

async function makeRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-dev10-edit-'));
	roots.push(root);
	execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
	return root;
}

suite('DEV-10: `dev_edit` troca um trecho sem reescrever o arquivo', () => {
	interface Harness {
		readonly root: string;
		readonly tool: ReturnType<typeof createDevEditTool>;
		readonly checkpoints: { id: string; path: string; content: string }[];
		setActive(active: boolean): void;
	}

	async function harness(linhas: number): Promise<Harness> {
		const root = await makeRepo();
		const body: string[] = [];
		for (let index = 0; index < linhas; index += 1) {
			body.push(index === 1 ? "\t\t\t\t: 'Assistant';" : `const linha${index} = ${index};`);
		}
		await writeFile(join(root, 'grande.ts'), `${body.join('\n')}\n`, 'utf8');

		const checkpoints: Harness['checkpoints'] = [];
		let active = true;
		const deps: DevToolDeps = {
			session: {
				isActive: () => active,
				root: () => root,
				sessionToken: () => 'token',
			} as unknown as DevToolDeps['session'],
			checkpoints: {
				capture: async ({ path: requested }: { readonly path: string }) => {
					const id = `cp-${checkpoints.length + 1}`;
					checkpoints.push({ id, path: requested, content: await readFile(join(root, requested), 'utf8') });
					return id;
				},
				seal: async () => undefined,
			} as unknown as DevToolDeps['checkpoints'],
			locks: { acquire: async () => () => undefined } as unknown as DevToolDeps['locks'],
			// `dev_edit` não executa comandos; o runner existe para o tipo.
			runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', aborted: false }) } as unknown as DevToolDeps['runner'],
		};
		return {
			root,
			tool: createDevEditTool(deps),
			checkpoints,
			setActive: (value) => {
				active = value;
			},
		};
	}

	const ctx = { signal: undefined } as unknown as Parameters<ReturnType<typeof createDevEditTool>['execute']>[1];

	test('troca uma linha num arquivo grande; o resto fica intacto', async () => {
		const h = await harness(6_805);
		const before = await readFile(join(h.root, 'grande.ts'), 'utf8');

		const result = await h.tool.execute(
			{ path: 'grande.ts', oldText: ": 'Assistant';", newText: ": 'Evelyn';" },
			ctx,
		);

		assert.equal(result.ok, true, result.ok ? '' : result.error);
		const after = await readFile(join(h.root, 'grande.ts'), 'utf8');
		assert.ok(after.includes(": 'Evelyn';"), 'a linha mudou');
		assert.ok(!after.includes(": 'Assistant';"), 'a linha antiga saiu');
		assert.equal(after.split('\n').length, before.split('\n').length, 'nenhuma linha a mais ou a menos');
		// O checkpoint guarda o conteúdo anterior: a troca é recuperável.
		assert.equal(h.checkpoints.length, 1);
		assert.ok(h.checkpoints[0]?.content.includes(": 'Assistant';"));
	});

	test('um trecho ausente é recusa com instrução, não uma escrita cega', async () => {
		const h = await harness(10);
		const result = await h.tool.execute(
			{ path: 'grande.ts', oldText: 'isto-nao-existe', newText: 'x' },
			ctx,
		);
		assert.equal(result.ok, false);
		assert.match(result.ok ? '' : (result.error ?? ''), /não aparece/);
	});

	test('um trecho ambíguo é recusa dizendo quantas vezes aparece', async () => {
		const h = await harness(10);
		const result = await h.tool.execute({ path: 'grande.ts', oldText: 'const', newText: 'let' }, ctx);
		assert.equal(result.ok, false);
		assert.match(result.ok ? '' : (result.error ?? ''), /aparece \d+ vezes/);
	});

	test('`replaceAll` troca todas as ocorrências, e diz quantas', async () => {
		const h = await harness(10);
		// "const" aparece em todas as linhas de `const linhaN` — 9 das 10.
		const antes = h.checkpoints.length;
		const resultado = await h.tool.execute(
			{ path: 'grande.ts', oldText: 'const', newText: 'let', replaceAll: true },
			ctx,
		);
		assert.equal(resultado.ok, true, resultado.ok ? '' : (resultado.error ?? ''));
		assert.equal(resultado.ok ? resultado.output?.replacements : 0, 9);
		assert.ok(h.checkpoints.length >= antes);
		const depois = await readFile(join(h.root, 'grande.ts'), 'utf8');
		assert.ok(!depois.includes('const '), 'todas foram trocadas');
	});

	test('sem sessão ativa, nada é escrito', async () => {
		const h = await harness(10);
		h.setActive(false);
		const before = await readFile(join(h.root, 'grande.ts'), 'utf8');
		const result = await h.tool.execute({ path: 'grande.ts', oldText: 'const', newText: 'let' }, ctx);
		assert.equal(result.ok, false);
		assert.equal(await readFile(join(h.root, 'grande.ts'), 'utf8'), before);
	});
});
