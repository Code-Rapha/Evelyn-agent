/** Testes do diálogo onde a Evelyn registra as próprias preferências de modelo. */

import * as assert from 'assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import {
	MODEL_GUIDANCE_FILE,
	createModelGuidanceStore,
	guidanceFor,
	interpretModelGuidance,
} from '../desktop/modelGuidance';

const FORMATO = [
	'- deepseek-ai/DeepSeek-V4.1-Flash | tools: sim | reasoning: sim | valor: 0.8 | uso: código e ferramentas',
	'- Qwen/Qwen3.8-27B-FP8 | tools: sim | contexto-longo: sim | valor: 0.6 | uso: arquivos grandes',
].join('\n');

describe('modelGuidance', () => {
	describe('interpretModelGuidance', () => {
		it('lê a lista no formato declarado', () => {
			const result = interpretModelGuidance(FORMATO);
			assert.strictEqual(result.entries.length, 2);
			assert.deepStrictEqual(result.entries[0], {
				model: 'deepseek-ai/DeepSeek-V4.1-Flash',
				tools: true,
				reasoning: true,
				value: 0.8,
				useFor: 'código e ferramentas',
			});
			assert.strictEqual(result.entries[1].longContext, true);
			assert.strictEqual(result.rejected.length, 0);
		});

		it('ignora prosa e cerca de código', () => {
			const text = [
				'Segue o que medi:',
				'```',
				FORMATO,
				'```',
				'No geral, o DeepSeek é o meu padrão.',
			].join('\n');
			const result = interpretModelGuidance(text);
			// Uma frase de conversa não tem `|` e não vira preferência vazia.
			assert.strictEqual(result.entries.length, 2);
			assert.strictEqual(result.rejected.length, 0);
		});

		it('registra o que não reconheceu em vez de adivinhar', () => {
			const text = [
				'- modelo-x | capacidade: alta',
				'- | tools: sim',
				'- modelo-y | tools: talvez | valor: 3',
			].join('\n');
			const result = interpretModelGuidance(text);
			assert.strictEqual(result.entries.length, 0, 'nenhuma linha virou preferência');
			assert.strictEqual(result.rejected.length, 3);
			assert.match(result.rejected[0].reason, /nenhum campo reconhecido/);
		});

		it('descarta o que não entende dentro de uma linha válida', () => {
			const result = interpretModelGuidance('- modelo-y | tools: sim | valor: 3 | uso: leitura');
			assert.strictEqual(result.entries.length, 1);
			assert.strictEqual(result.entries[0].tools, true);
			// `3` está fora de 0..1: não é custo-benefício, é um erro de formato.
			assert.strictEqual(result.entries[0].value, undefined);
			assert.strictEqual(result.entries[0].useFor, 'leitura');
		});

		it('a última linha de um modelo repetido vence', () => {
			const result = interpretModelGuidance(
				['- modelo-z | tools: nao', '- modelo-z | tools: sim | valor: 0.9'].join('\n'),
			);
			assert.strictEqual(result.entries.length, 1);
			assert.strictEqual(result.entries[0].tools, true);
			assert.strictEqual(result.entries[0].value, 0.9);
		});

		it('não inventa campo que a Evelyn não escreveu', () => {
			const result = interpretModelGuidance('- modelo-w | uso: resumos');
			assert.deepStrictEqual(result.entries[0], { model: 'modelo-w', useFor: 'resumos' });
		});
	});

	describe('guidanceFor', () => {
		const guidance = {
			conversationId: 'c',
			updatedAt: '2024-01-01T00:00:00.000Z',
			entries: [
				{ model: 'sem-provedor', tools: true },
				{ model: 'com-provedor', providerId: 'p2', tools: false },
			],
			rows: [],
			rejected: [],
		};

		it('casa pelo nome do modelo', () => {
			assert.strictEqual(
				guidanceFor(guidance, { providerId: 'p1', modelId: 'sem-provedor' })?.tools,
				true,
			);
		});

		it('respeita o provedor quando ela o nomeou', () => {
			assert.strictEqual(
				guidanceFor(guidance, { providerId: 'p1', modelId: 'com-provedor' }),
				undefined,
			);
			assert.strictEqual(
				guidanceFor(guidance, { providerId: 'p2', modelId: 'com-provedor' })?.tools,
				false,
			);
		});

		it('sem registro, não há preferência', () => {
			assert.strictEqual(guidanceFor(undefined, { providerId: 'p', modelId: 'm' }), undefined);
		});
	});

	describe('createModelGuidanceStore', () => {
		it('grava o que foi aceito e o que foi recusado, e relê igual', async () => {
			const root = await mkdtemp(join(tmpdir(), 'guidance-'));
			try {
				const store = createModelGuidanceStore(root);
				assert.strictEqual(await store.read(), undefined, 'sem arquivo é ausência');

				const written = await store.write({
					conversationId: 'conv-1',
					text: `${FORMATO}\n- modelo-x | nada: 1`,
					now: () => '2024-05-05T00:00:00.000Z',
				});
				assert.strictEqual(written.entries.length, 2);
				assert.strictEqual(written.rejected.length, 1);

				const onDisk = JSON.parse(await readFile(join(root, MODEL_GUIDANCE_FILE), 'utf8'));
				assert.strictEqual(onDisk.entries.length, 2);

				const read = await store.read();
				assert.deepStrictEqual(read?.entries, written.entries);

				await store.clear();
				assert.strictEqual(await store.read(), undefined);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it('um arquivo ilegível é ausência, não erro', async () => {
			const root = await mkdtemp(join(tmpdir(), 'guidance-'));
			try {
				await writeFile(join(root, MODEL_GUIDANCE_FILE), '{ isto não é json');
				assert.strictEqual(await createModelGuidanceStore(root).read(), undefined);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});
});
