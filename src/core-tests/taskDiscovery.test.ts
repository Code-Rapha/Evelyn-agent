/** Tests for task discovery / classification. */

import * as assert from 'assert';
import { describe, it } from 'mocha';
import { classifyTask, type TaskClassification } from '../desktop/taskDiscovery';

function classify(userMessage: string, history?: readonly { role: string; content: string }[]): TaskClassification {
	return classifyTask(userMessage, history);
}

describe('taskDiscovery', () => {
	describe('classifyTask', () => {
		it('classifies a coding task', () => {
			const result = classify('Crie uma função em TypeScript que valide um email');
			assert.strictEqual(result.domain, 'coding');
			assert.ok(result.needsTools);
			assert.ok(result.requiredCapabilities.includes('code-generation'));
			assert.ok(result.confidence > 0.5);
		});

		it('classifies a file analysis task', () => {
			const result = classify('Leia o arquivo src/main.ts e me diga o que ele faz');
			assert.strictEqual(result.domain, 'file-analysis');
			assert.ok(result.needsTools);
			assert.ok(result.missingInformation.includes('caminho do workspace/projeto'));
		});

		it('classifies a Blender task', () => {
			const result = classify('Como criar um material brilhante no Blender usando Python API?');
			assert.strictEqual(result.domain, 'blender');
		});

		it('classifies an API design task', () => {
			const result = classify('Preciso desenhar uma API REST com versionamento e rate limiting');
			assert.strictEqual(result.domain, 'api-design');
		});

		it('classifies a database task', () => {
			const result = classify('Como criar uma migration no Prisma para adicionar uma tabela users?');
			assert.strictEqual(result.domain, 'database');
		});

		it('classifies a networking task', () => {
			const result = classify('Qual a diferença entre TCP e UDP para um servidor de jogos?');
			assert.strictEqual(result.domain, 'networking');
		});

		it('defaults to general for ambiguous short messages', () => {
			const result = classify('Olá');
			assert.ok(['general', 'unknown'].includes(result.domain));
			assert.ok(result.confidence <= 0.5);
		});

		it('detects reasoning capability requirement', () => {
			const result = classify('Pense passo a passo: como resolver este problema complexo de algoritmos?');
			assert.ok(result.requiredCapabilities.includes('reasoning'));
		});

		it('detects long-context requirement', () => {
			const result = classify('Analise todo o projeto inteiro e me diga a arquitetura geral');
			assert.ok(result.requiredCapabilities.includes('long-context'));
		});

		it('detects structured output requirement', () => {
			const result = classify('Retorne o resultado em JSON com schema TypeScript');
			assert.ok(result.requiredCapabilities.includes('structured-output'));
		});

		it('uses history for context', () => {
			const result = classify('Agora refatore esse código', [
				{ role: 'user', content: 'Crie uma classe User com validação' },
				{ role: 'assistant', content: 'Aqui está a classe...' },
			]);
			assert.strictEqual(result.domain, 'coding');
			assert.ok(result.confidence > 0.5);
		});

		it('reports missing information for coding without language', () => {
			const result = classify('Escreva uma função que some dois números');
			assert.ok(result.missingInformation.includes('linguagem ou framework alvo'));
		});

		it('reports missing information for database without target', () => {
			const result = classify('Como criar uma tabela de usuários?');
			assert.ok(result.missingInformation.includes('banco de dados alvo'));
		});

		it('estimates complexity from message length', () => {
			const trivial = classify('Oi');
			const simple = classify('Como fazer um loop for em Python?');
			const moderate = classify('Preciso implementar um sistema de autenticação com JWT, refresh tokens, validação de escopos e integração com OAuth2 para uma API REST em Node.js com Express');
			const complex = classify('Arquitetura completa de microsserviços com Kubernetes, service mesh Istio, monitoramento Prometheus/Grafana, CI/CD GitLab, logging distribuído ELK, tracing Jaeger, segurança mTLS, rate limiting, circuit breaker, saga pattern para transações distribuídas, event sourcing com Kafka, CQRS, e deploy blue-green');

			assert.ok(['unknown', 'trivial'].includes(trivial.complexity));
			assert.ok(['trivial', 'simple'].includes(simple.complexity));
			assert.ok(['simple', 'moderate'].includes(moderate.complexity));
			assert.ok(['moderate', 'complex'].includes(complex.complexity));
		});

		it('includes rationale for logging', () => {
			const result = classify('Crie uma API em Node.js');
			assert.ok(result.rationale.includes('domain=coding'));
			assert.ok(result.rationale.includes('tools=true'));
		});

		it('returns primary goal from first sentence', () => {
			const result = classify('Crie uma função. Depois teste ela. Por fim faça deploy.');
			assert.strictEqual(result.primaryGoal, 'Crie uma função');
		});
	});
});