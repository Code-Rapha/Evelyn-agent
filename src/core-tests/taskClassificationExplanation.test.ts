/**
 * A classificação explicável.
 *
 * ## O que se prova
 *
 * 1. Cada regra que disparou é nomeada, com a **palavra-chave do vocabulário
 *    fixo** que disparou — e nunca um trecho da mensagem;
 * 2. A classificação ambígua diz que não teve evidência;
 * 3. A confiança é o número que o classificador **já calculava**, com a base
 *    que o produziu — nenhuma probabilidade inventada;
 * 4. O texto do usuário não aparece na explicação.
 */
import * as assert from 'assert';

import { classifyTask, type TaskClassification } from '../desktop/taskDiscovery';

suite('Task classification: the explanation', () => {
	test('the domain names the keywords that pointed at it', () => {
		const task = classifyTask('escreva um código em python para corrigir este bug');
		assert.strictEqual(task.domain, 'coding');
		const explanation = task.explanation;
		assert.ok(explanation !== undefined);
		assert.strictEqual(explanation.domain.detected, 'coding');
		assert.ok(explanation.domain.hits.length > 0, 'as palavras-chave estão lá');
		assert.ok(
			explanation.domain.hits.every((hit) => hit.rule === 'domain.coding'),
			'toda regra é do domínio que venceu',
		);
		assert.ok(
			explanation.domain.considered.some((entry) => entry.domain === 'coding'),
			'os domínios considerados estão lá',
		);
	});

	test('the keywords are the fixed vocabulary, never the message', () => {
		const task = classifyTask('quero discutir o orçamento da empresa e o contrato');
		const explanation = task.explanation;
		assert.ok(explanation !== undefined);
		for (const hit of [...explanation.domain.hits, ...explanation.tools.hits]) {
			assert.ok(
				hit.keyword.length > 0 && hit.keyword.length < 40,
				`a palavra-chave "${hit.keyword}" é um item de vocabulário`,
			);
		}
	});

	test('the complexity carries its evidence', () => {
		const task = classifyTask(
			'preciso de uma arquitetura de sistema complexa que suporte muitos serviços e uma fila de mensagens',
		);
		const explanation = task.explanation;
		assert.ok(explanation !== undefined);
		assert.ok(
			explanation.complexity.evidence.some((evidence) => evidence.source === 'message_length'),
			'a contagem de palavras é a evidência principal',
		);
		assert.ok(
			explanation.complexity.evidence.some((evidence) => evidence.source === 'marker'),
			'o marcador de complexidade também entra',
		);
	});

	test('each required capability says why it was required', () => {
		const task = classifyTask('pense passo a passo e gere código para o serviço');
		const explanation = task.explanation;
		assert.ok(explanation !== undefined);
		const reasoning = explanation.capabilities.find((c) => c.capability === 'reasoning');
		assert.ok(reasoning !== undefined, 'a capacidade de raciocínio foi exigida');
		assert.ok(reasoning.hits.length > 0, 'a palavra-chave que a exigiu está lá');
		assert.ok(reasoning.reason.length > 0, 'o motivo está lá');
	});

	test('a capability assumed by the domain says it was assumed', () => {
		const task = classifyTask('escreva um código em python para o projeto');
		const explanation = task.explanation;
		assert.ok(explanation !== undefined);
		const generation = explanation.capabilities.find((c) => c.capability === 'code-generation');
		assert.ok(generation !== undefined);
		assert.ok(
			generation.reason.includes('assumida'),
			'a capacidade assumida é dita como assumida, e não como detectada',
		);
	});

	test('the confidence is the number the classifier already computed, with its basis', () => {
		const task = classifyTask('escreva um código em python para corrigir este bug do serviço');
		const explanation = task.explanation;
		assert.ok(explanation !== undefined);
		assert.strictEqual(explanation.confidence.value, task.confidence);
		assert.ok(explanation.confidence.basis.length > 0, 'a base da confiança está lá');
		assert.ok(
			['low', 'medium', 'high'].includes(explanation.confidence.level),
			'o nível qualitativo vem do número',
		);
	});

	test('an ambiguous classification says it had no evidence', () => {
		const task = classifyTask('olá');
		const explanation = task.explanation;
		assert.ok(explanation !== undefined);
		assert.strictEqual(explanation.domain.detected, 'general');
		assert.ok(explanation.domain.hits.length === 0, 'nenhuma palavra-chave disparou');
		assert.ok(
			explanation.domain.reason.includes('nenhuma palavra-chave'),
			'a ausência de evidência é dita',
		);
		assert.strictEqual(explanation.confidence.level, 'low');
	});

	test('the missing information names the rule that looked for it', () => {
		const task = classifyTask('escreva um código em python');
		const explanation = task.explanation;
		assert.ok(explanation !== undefined);
		const missing = explanation.missingInformation.find((m) => m.rule === 'coding.sem_alvo');
		assert.ok(missing !== undefined);
		assert.ok(missing.item.length > 0);
	});

	test('the explanation carries no fragment of the message', () => {
		const secret = 'Zé das Batatas';
		const task = classifyTask(`escreva um código sobre ${secret} e o contrato da empresa`);
		const explanation = task.explanation;
		assert.ok(explanation !== undefined);
		const raw = JSON.stringify(explanation);
		assert.strictEqual(raw.includes(secret), false, 'o nome do usuário não aparece');
		assert.strictEqual(raw.includes('contrato da empresa'), false, 'a frase não aparece');
	});

	test('the primary goal is the only place the text appears', () => {
		const task = classifyTask('escreva um código em python para o projeto');
		assert.ok(task.primaryGoal.length > 0, 'o objetivo ainda existe na classificação');
		// E a explicação é justamente o lugar onde ele não está.
		assert.strictEqual(
			JSON.stringify(task.explanation).includes(task.primaryGoal),
			false,
		);
	});

	test('the classification itself did not change', () => {
		// A explicação é uma camada por cima: os campos que o seletor lê
		// continuam exatamente os mesmos.
		const task: TaskClassification = classifyTask('escreva um código em python');
		assert.strictEqual(task.domain, 'coding');
		assert.strictEqual(task.complexity, 'trivial');
		assert.strictEqual(task.needsTools, true, '"escreva" é uma pista de ferramenta');
		assert.deepStrictEqual(task.requiredCapabilities, ['code-generation']);
		assert.deepStrictEqual(task.missingInformation, [
			'linguagem ou framework alvo',
			'caminho do workspace/projeto',
		]);
	});

	test('the confidence number is unchanged for the same message', () => {
		const before = classifyTask('escreva um código em python para o projeto');
		const after = classifyTask('escreva um código em python para o projeto');
		assert.strictEqual(before.confidence, after.confidence);
		assert.strictEqual(before.domain, after.domain);
		assert.strictEqual(before.complexity, after.complexity);
		assert.deepStrictEqual(before.requiredCapabilities, after.requiredCapabilities);
	});
});
