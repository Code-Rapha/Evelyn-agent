/**
 * O interruptor do aprendizado automático pela interface web.
 *
 * ## Por que este caminho existe
 *
 * No modo conectado — que é como o pacote abre — o Core é o do serviço. Sem
 * esta rota, o painel do desktop não tinha como desligar o que o serviço faz
 * em nome do usuário: a leitura caía no stub do modo conectado e a tela dizia
 * não conseguir ler um estado que o serviço conhecia.
 *
 * ## O que se prova
 *
 * 1. A leitura devolve o estado em vigor, no formato que a janela valida;
 * 2. Desligar grava e uma nova leitura confirma — não é só a resposta que diz;
 * 3. O estado sobrevive a uma nova montagem sobre a mesma raiz;
 * 4. Um corpo sem booleano é recusado, e o estado anterior continua;
 * 5. Sem Core, ler e salvar são recusados;
 * 6. As rotas estão nas tabelas do servidor — a leitura na de leitura, a
 *    escrita na de escrita, e em caminhos diferentes.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { SkillAuto } from '../web/skillAuto';
import { API_ROUTES, SKILL_AUTO_WRITE_ROUTE } from '../web/server';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const silent = new ConsoleLogSink({ out: () => undefined, err: () => undefined });

suite('Web: o interruptor do aprendizado automático', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-skill-auto-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function core(): AssembledCore {
		return assembleCore({ rootPath: root, logSink: silent });
	}

	test('a leitura devolve o estado em vigor, no formato da janela', async () => {
		const reply = await new SkillAuto(core()).read();

		assert.strictEqual(reply.status, 200);
		const view = reply.body as {
			enabled: boolean;
			minConfidence: number;
			maxAutoSkills: number;
			allowedTools: readonly string[];
			learned: readonly unknown[];
		};
		assert.strictEqual(view.enabled, true, 'o caminho nasce ligado');
		assert.strictEqual(view.minConfidence, 0.6);
		assert.strictEqual(view.maxAutoSkills, 10);
		assert.ok(view.allowedTools.includes('skill.read'));
		assert.deepStrictEqual(view.learned, []);
	});

	test('desligar grava, e a leitura seguinte confirma', async () => {
		const assembled = core();
		const off = await new SkillAuto(assembled).save({ enabled: false });

		assert.strictEqual(off.status, 200);
		assert.strictEqual((off.body as { enabled: boolean }).enabled, false);
		// A resposta não é a prova: o arquivo é.
		const read = await new SkillAuto(assembled).read();
		assert.strictEqual((read.body as { enabled: boolean }).enabled, false);
		assert.strictEqual(await assembled.autoSkills.status().then((s) => s.settings.enabled), false);
	});

	test('o que foi desligado sobrevive a uma nova montagem sobre a mesma raiz', async () => {
		const first = core();
		await new SkillAuto(first).save({ enabled: false });

		const second = core();
		const read = await new SkillAuto(second).read();
		assert.strictEqual((read.body as { enabled: boolean }).enabled, false);
	});

	test('um corpo sem booleano é recusado, e o estado anterior continua', async () => {
		const assembled = core();
		const settings = new SkillAuto(assembled);
		await settings.save({ enabled: false });

		for (const body of [{}, { enabled: 'sim' }, { enabled: 0 }, [], null, 'nao']) {
			const reply = await settings.save(body);
			assert.strictEqual(reply.status, 400, `recusa ${JSON.stringify(body)}`);
			assert.ok(String((reply.body as { error: string }).error).includes('enabled'));
		}

		const read = await settings.read();
		assert.strictEqual((read.body as { enabled: boolean }).enabled, false, 'nada mudou');
	});

	test('ligar de novo é aceito depois de desligar', async () => {
		const assembled = core();
		const settings = new SkillAuto(assembled);
		await settings.save({ enabled: false });
		const on = await settings.save({ enabled: true });

		assert.strictEqual(on.status, 200);
		assert.strictEqual((on.body as { enabled: boolean }).enabled, true);
		const read = await settings.read();
		assert.strictEqual(read.status, 200);
		assert.strictEqual((read.body as { enabled: boolean }).enabled, true);
	});

	test('sem Core, ler e salvar são recusados', async () => {
		const settings = new SkillAuto(undefined);
		assert.strictEqual((await settings.read()).status, 404);
		assert.strictEqual((await settings.save({ enabled: true })).status, 404);
	});

	test('as rotas estão nas tabelas do servidor, e em caminhos diferentes', () => {
		// Uma rota fora da tabela não existe: o servidor responde 404 antes de
		// chegar no módulo. Este teste é o que impede a tabela de divergir do
		// código que a usa.
		assert.strictEqual(API_ROUTES['/api/skills/auto'], 'autoSkills');
		assert.strictEqual(SKILL_AUTO_WRITE_ROUTE, '/api/skills/auto/set');
		assert.notStrictEqual(
			SKILL_AUTO_WRITE_ROUTE,
			'/api/skills/auto',
			'um caminho é de leitura ou de escrita, nunca os dois',
		);
		assert.strictEqual(
			API_ROUTES[SKILL_AUTO_WRITE_ROUTE],
			undefined,
			'a rota de escrita não mora na tabela de leitura',
		);
	});
});
