/**
 * A pesquisa de catálogo: o que ela aceita, o que rebaixa e o que recusa.
 *
 * O ponto destes testes é o mesmo de `modelGuidance`: um campo sem fonte não
 * pode herdar o peso de um documento. Se este arquivo passar com um parser
 * permissivo, a recomendação passa a decidir sobre boatos.
 */

import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
	confirmedResearch,
	parseResearch,
	proposeResearch,
	sourcesOf,
} from '../core/agent/modelResearch';

const AT = '2026-11-03T12:00:00.000Z';

const RESPOSTA = [
	'# Pesquisa',
	'',
	'- context | provider | 128000 | https://docs.provider.com/models | janela de 128k tokens',
	'- tools | provider | sim | https://docs.provider.com/models | suporta function calling',
	'- price-input | secondary | 0.50 | https://benchmarks.example.com/pricing | US$ 0,50 por milhão',
	'- price-output | secondary | 1.50 | https://benchmarks.example.com/pricing | saida US$ 1,50',
	'- price-currency | secondary | usd | https://benchmarks.example.com/pricing | dólares',
	'- price-unit | secondary | per_1m_tokens | https://benchmarks.example.com/pricing | por milhão',
	'- reasoning | estimated | sim | sem-fonte | parece raciocinar bem',
].join('\n');

describe('modelResearch', () => {
	describe('parseResearch', () => {
		it('lê o formulário, com fonte e trecho por linha', () => {
			const parsed = parseResearch(RESPOSTA, AT);
			assert.strictEqual(parsed.facts.length, 7);
			const context = parsed.facts.find((fact) => fact.field === 'context');
			assert.strictEqual(context?.value, '128000');
			assert.strictEqual(context?.level, 'provider');
			assert.strictEqual(context?.source?.url, 'https://docs.provider.com/models');
			assert.strictEqual(context?.source?.kind, 'documentation');
			assert.strictEqual(context?.source?.quote, 'janela de 128k tokens');
		});

		it('rebaixa para estimated o que se diz oficial sem fonte', () => {
			// Dizer "está na doc oficial" sem URL não é conferível: manter o
			// nível daria a um boato o peso de um documento.
			const parsed = parseResearch('- context | provider | 200000 | sem-fonte | ?', AT);
			assert.strictEqual(parsed.facts[0].level, 'estimated');
			assert.strictEqual(parsed.facts[0].source, undefined);
		});

		it('rebaixa URL que não é URL', () => {
			const parsed = parseResearch('- tools | secondary | sim | doc oficial | texto', AT);
			assert.strictEqual(parsed.facts[0].level, 'estimated');
		});

		it('recusa nível inventado e registra o motivo', () => {
			const parsed = parseResearch('- context | talvez | 1000 | https://x.dev | trecho', AT);
			assert.strictEqual(parsed.facts.length, 0);
			assert.strictEqual(parsed.rejected.length, 1);
			assert.match(parsed.rejected[0].reason, /nivel desconhecido/);
		});

		it('ignora campo com valor desconhecido em vez de virar fato', () => {
			const parsed = parseResearch('- context | provider | ? | https://x.dev | trecho', AT);
			assert.strictEqual(parsed.facts.length, 0);
		});

		it('ignora prosa e cerca de código', () => {
			const parsed = parseResearch(
				['Segue o que encontrei.', '```', '- tools | provider | sim | https://x.dev | t', '```', 'Fim.'].join(
					'\n',
				),
				AT,
			);
			assert.strictEqual(parsed.facts.length, 1);
			assert.strictEqual(parsed.rejected.length, 0);
		});
	});

	describe('proposeResearch', () => {
		const proposal = proposeResearch({
			providerId: 'river',
			modelId: 'alpha',
			query: 'research river/alpha',
			researchedAt: AT,
			parsed: parseResearch(RESPOSTA, AT),
		});

		it('agrupa por campo, preservando nível e fonte', () => {
			assert.strictEqual(proposal.limits?.contextTokens?.value, 128_000);
			assert.strictEqual(proposal.limits?.contextTokens?.level, 'provider');
			assert.strictEqual(proposal.capabilities?.toolCalling?.value, true);
			assert.strictEqual(proposal.capabilities?.reasoning?.level, 'estimated');
			assert.strictEqual(proposal.pricing?.input?.value, 0.5);
			assert.strictEqual(proposal.pricing?.unit?.value, 'per_1m_tokens');
			assert.strictEqual(proposal.pricing?.currency?.value, 'USD');
		});

		it('nomeia o que não encontrou em vez de deixar em branco', () => {
			assert.deepStrictEqual(proposal.unknown, ['access']);
		});

		it('escolhe o nível mais forte quando a mesma linha se repete', () => {
			const parsed = parseResearch(
				[
					'- context | estimated | 64000 | sem-fonte | achismo',
					'- context | provider | 128000 | https://docs.x.dev | doc oficial',
				].join('\n'),
				AT,
			);
			const chosen = proposeResearch({
				providerId: 'p',
				modelId: 'm',
				query: 'q',
				researchedAt: AT,
				parsed,
			});
			assert.strictEqual(chosen.limits?.contextTokens?.value, 128_000);
			assert.strictEqual(chosen.limits?.contextTokens?.level, 'provider');
		});

		it('lista cada fonte uma vez', () => {
			const urls = sourcesOf(proposal).map((source) => source.url);
			assert.deepStrictEqual([...new Set(urls)].length, urls.length);
			assert.ok(urls.includes('https://docs.provider.com/models'));
		});
	});

	describe('confirmedResearch', () => {
		const proposal = proposeResearch({
			providerId: 'river',
			modelId: 'alpha',
			query: 'research river/alpha',
			researchedAt: AT,
			parsed: parseResearch(RESPOSTA, AT),
		});

		it('grava só o que tem fonte, e diz o que ficou de fora', () => {
			const confirmed = confirmedResearch(proposal, 'all');
			assert.strictEqual(confirmed.model?.toolCalling, true);
			assert.strictEqual(confirmed.limits?.contextTokens, 128_000);
			assert.strictEqual(confirmed.pricing?.input, 0.5);
			// A estimativa de raciocínio não foi gravada — e foi dita recusada.
			assert.strictEqual(confirmed.model?.reasoning, undefined);
			assert.ok(
				confirmed.skipped.some(
					(entry) => entry.field === 'reasoning' && /estimativa/.test(entry.reason),
				),
			);
		});

		it('respeita a escolha do usuário', () => {
			const confirmed = confirmedResearch(proposal, ['context']);
			assert.deepStrictEqual(confirmed.limits, { contextTokens: 128_000 });
			assert.strictEqual(confirmed.model, undefined);
			assert.strictEqual(confirmed.pricing, undefined);
		});

		it('não grava preço sem moeda e unidade com fonte', () => {
			const semUnidade = proposeResearch({
				providerId: 'p',
				modelId: 'm',
				query: 'q',
				researchedAt: AT,
				parsed: parseResearch('- price-input | secondary | 2 | https://x.dev | por token', AT),
			});
			const confirmed = confirmedResearch(semUnidade, 'all');
			assert.strictEqual(confirmed.pricing, undefined);
			assert.ok(confirmed.skipped.some((entry) => entry.field === 'pricing'));
		});

		it('nada com fonte real, nada gravado', () => {
			const vazio = proposeResearch({
				providerId: 'p',
				modelId: 'm',
				query: 'q',
				researchedAt: AT,
				parsed: parseResearch('- tools | estimated | sim | sem-fonte | parece', AT),
			});
			const confirmed = confirmedResearch(vazio, 'all');
			assert.strictEqual(confirmed.model, undefined);
			assert.deepStrictEqual(confirmed.applied, []);
		});
	});
});
