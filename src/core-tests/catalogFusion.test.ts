/**
 * A fusão catálogo↔descoberta e a política de acesso, no núcleo puro.
 *
 * Nenhum I/O: as duas funções recebem o tempo como argumento, então cada teste
 * descreve o instante exato em que pergunta.
 */
import * as assert from 'assert';

import {
	comparePrices,
	discoveredPriceState,
	effectivePricing,
	pricesComparable,
	type DiscoveredPriceOffer,
} from '../core/catalog/merge';
import {
	describeNoEligibleModel,
	describePolicyApplication,
	evaluatePolicy,
	orderByPolicy,
	parsePolicyPhrase,
	type PolicyCandidate,
} from '../core/catalog/policy';
import { parseAccessPolicy, serializeAccessPolicy } from '../core/storage/accessPolicyLedger';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const ISO = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const userPrice = { currency: 'USD', unit: 'per_1m_tokens' as const, input: 3, output: 15 };

function discovered(overrides: Partial<DiscoveredPriceOffer> = {}): DiscoveredPriceOffer {
	return {
		pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 2, output: 8 },
		source: 'provider',
		verifiedAt: ISO(-60_000),
		expiresAt: ISO(24 * 60 * 60_000),
		stale: false,
		...overrides,
	};
}

suite('Fusion: user price versus discovered price', () => {
	test('the declared price is what applies when the user chose nothing', () => {
		const result = comparePrices({
			user: { pricing: userPrice },
			discovered: discovered(),
			nowMs: NOW,
		});
		assert.strictEqual(result.comparison.selected, 'user');
		assert.strictEqual(result.comparison.fellBack, false);
		assert.strictEqual(result.effective?.pricing.input, 3);
		assert.strictEqual(result.effective?.origin, 'manual');
	});

	test('both sides are shown, and they are comparable', () => {
		const result = comparePrices({ user: { pricing: userPrice }, discovered: discovered(), nowMs: NOW });
		assert.strictEqual(result.comparison.comparable, true);
		assert.deepStrictEqual(result.comparison.user?.pricing, userPrice);
		assert.strictEqual(result.comparison.discovered?.pricing.output, 8);
	});

	test('choosing the discovered price applies it and keeps the declared one intact', () => {
		const result = comparePrices({
			user: { pricing: userPrice },
			discovered: discovered(),
			chosen: 'discovered',
			nowMs: NOW,
		});
		assert.strictEqual(result.comparison.selected, 'discovered');
		assert.strictEqual(result.effective?.pricing.input, 2);
		assert.strictEqual(result.effective?.origin, 'provider');
		assert.deepStrictEqual(result.comparison.user?.pricing, userPrice, 'the declared value is untouched');
	});

	test('switching back returns the declared value exactly', () => {
		const there = comparePrices({
			user: { pricing: userPrice },
			discovered: discovered(),
			chosen: 'discovered',
			nowMs: NOW,
		});
		const back = comparePrices({
			user: { pricing: userPrice },
			discovered: discovered(),
			chosen: 'user',
			nowMs: NOW,
		});
		assert.notDeepStrictEqual(there.effective?.pricing, back.effective?.pricing);
		assert.deepStrictEqual(back.effective?.pricing, userPrice);
		assert.strictEqual(back.comparison.fellBack, false);
	});

	test('choosing a price that no longer exists falls back, and says so', () => {
		const result = comparePrices({ user: { pricing: userPrice }, chosen: 'discovered', nowMs: NOW });
		assert.strictEqual(result.comparison.selected, 'user');
		assert.strictEqual(result.comparison.fellBack, true);
	});

	test('a stale discovery is not used even when chosen', () => {
		const result = comparePrices({
			user: { pricing: userPrice },
			discovered: discovered({ stale: true }),
			chosen: 'discovered',
			nowMs: NOW,
		});
		assert.strictEqual(result.comparison.selected, 'user');
		assert.strictEqual(result.comparison.fellBack, true);
		assert.strictEqual(result.effective?.pricing.input, 3);
	});

	test('an expired discovery is not used, and its expiry is reported', () => {
		const offer = discovered({ expiresAt: ISO(-1) });
		const state = discoveredPriceState(offer, NOW);
		assert.strictEqual(state.usable, false);
		assert.strictEqual(state.expired, true);
		const result = comparePrices({ user: { pricing: userPrice }, discovered: offer, chosen: 'discovered', nowMs: NOW });
		assert.strictEqual(result.comparison.selected, 'user');
	});

	test('with no declared price, a usable discovered price applies', () => {
		const result = comparePrices({ discovered: discovered(), nowMs: NOW });
		assert.strictEqual(result.effective?.side, 'discovered');
		assert.strictEqual(result.effective?.pricing.input, 2);
	});

	test('with neither price there is no effective price - never zero', () => {
		const result = comparePrices({ nowMs: NOW });
		assert.strictEqual(result.effective, undefined);
		assert.strictEqual(effectivePricing({ nowMs: NOW }), undefined);
	});

	test('a price with only one direction stays partly unknown', () => {
		const result = comparePrices({
			discovered: discovered({ pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 2 } }),
			nowMs: NOW,
		});
		assert.strictEqual(result.effective?.pricing.output, undefined, 'absent output is not zero');
	});
});

suite('Fusion: currencies, units and missing amounts', () => {
	test('different currencies are not comparable', () => {
		const check = pricesComparable(userPrice, { currency: 'EUR', unit: 'per_1m_tokens', input: 2 });
		assert.strictEqual(check.comparable, false);
		assert.ok(check.reason?.includes('moedas'));
	});

	test('different units are not comparable', () => {
		const check = pricesComparable(userPrice, { currency: 'USD', unit: 'per_1k_tokens', input: 2 });
		assert.strictEqual(check.comparable, false);
		assert.ok(check.reason?.includes('unidades'));
	});

	test('currency case does not make two prices incompatible', () => {
		assert.strictEqual(pricesComparable(userPrice, { currency: 'usd', unit: 'per_1m_tokens' }).comparable, true);
	});

	test('an incompatible discovered price cannot be chosen over the declared one', () => {
		const result = comparePrices({
			user: { pricing: userPrice },
			discovered: discovered({ pricing: { currency: 'EUR', unit: 'per_1m_tokens', input: 2 } }),
			chosen: 'discovered',
			nowMs: NOW,
		});
		assert.strictEqual(result.comparison.selected, 'user');
		assert.strictEqual(result.comparison.fellBack, true);
		assert.strictEqual(result.comparison.incompatibleReason !== undefined, true);
	});

	test('a discovered price with no amounts is not usable', () => {
		const state = discoveredPriceState(discovered({ pricing: { currency: 'USD', unit: 'per_1m_tokens' } }), NOW);
		assert.strictEqual(state.usable, false);
	});

	test('no conversion is ever applied', () => {
		const result = comparePrices({
			user: { pricing: userPrice },
			discovered: discovered({ pricing: { currency: 'EUR', unit: 'per_1m_tokens', input: 1 } }),
			chosen: 'discovered',
			nowMs: NOW,
		});
		// Não há taxa de câmbio: a escolha é recusada e o declarado vale.
		assert.strictEqual(result.comparison.fellBack, true);
		assert.strictEqual(result.comparison.selected, 'user');
		assert.ok(result.comparison.incompatibleReason?.includes('moedas'));
		assert.strictEqual(result.effective?.side, 'user');
	});
});

suite('Policy: free, paid and unknown', () => {
	const free = (overrides: Partial<PolicyCandidate['freeEvidence']> = {}): PolicyCandidate => ({
		providerId: 'p',
		modelId: 'm',
		freeEvidence: { access: 'free', source: 'provider', usable: true, ...overrides },
	});

	test('free_only accepts a confirmed free model', () => {
		assert.deepStrictEqual(evaluatePolicy(free(), 'free_only'), { eligible: true });
	});

	test('free_only accepts a free model the user classified', () => {
		const manual: PolicyCandidate = {
			providerId: 'p',
			modelId: 'm',
			freeEvidence: { access: 'free', source: 'manual' },
		};
		assert.deepStrictEqual(evaluatePolicy(manual, 'free_only'), { eligible: true });
	});

	test('free_only refuses a paid model', () => {
		const paid: PolicyCandidate = {
			providerId: 'p',
			modelId: 'm',
			freeEvidence: { access: 'paid', source: 'manual', usable: true },
		};
		assert.deepStrictEqual(evaluatePolicy(paid, 'free_only'), { eligible: false, reason: 'paid' });
	});

	test('free_only refuses a model with no classification', () => {
		assert.deepStrictEqual(evaluatePolicy({ providerId: 'p', modelId: 'm' }, 'free_only'), {
			eligible: false,
			reason: 'free_not_confirmed',
		});
	});

	test('free_only refuses a price-free model that was never classified', () => {
		// A price of zero is not an access classification: this candidate has
		// no `freeEvidence` at all, exactly as it would with a zero price and
		// no classification.
		const unclassified: PolicyCandidate = {
			providerId: 'p',
			modelId: 'zero-price',
			freeEvidence: { access: 'unknown', source: 'provider', usable: true },
		};
		assert.deepStrictEqual(evaluatePolicy(unclassified, 'free_only'), {
			eligible: false,
			reason: 'free_not_confirmed',
		});
	});

	test('free_only refuses expired free evidence', () => {
		assert.deepStrictEqual(evaluatePolicy(free({ usable: false }), 'free_only'), {
			eligible: false,
			reason: 'free_evidence_expired',
		});
	});

	test('free_only refuses a "free" with no trustworthy source', () => {
		assert.deepStrictEqual(evaluatePolicy(free({ source: 'unknown' }), 'free_only'), {
			eligible: false,
			reason: 'free_not_confirmed',
		});
	});

	test('any and free_preferred never exclude', () => {
		const paid: PolicyCandidate = {
			providerId: 'p',
			modelId: 'm',
			freeEvidence: { access: 'paid', source: 'manual', usable: true },
		};
		assert.strictEqual(evaluatePolicy(paid, 'any').eligible, true);
		assert.strictEqual(evaluatePolicy(paid, 'free_preferred').eligible, true);
		assert.strictEqual(evaluatePolicy({ providerId: 'p', modelId: 'm' }, 'free_preferred').eligible, true);
	});
});

suite('Policy: ordering and fallback set', () => {
	const candidates: readonly PolicyCandidate[] = [
		{ providerId: 'p', modelId: 'paid', freeEvidence: { access: 'paid', source: 'manual' } },
		{ providerId: 'p', modelId: 'free', freeEvidence: { access: 'free', source: 'provider', usable: true } },
		{ providerId: 'p', modelId: 'unknown' },
		{ providerId: 'p', modelId: 'free-manual', freeEvidence: { access: 'free', source: 'manual' } },
	];

	test('free_only keeps only the confirmed free models', () => {
		assert.deepStrictEqual(
			orderByPolicy(candidates, 'free_only').map((candidate) => candidate.modelId),
			['free', 'free-manual'],
		);
	});

	test('free_preferred puts free first and keeps the rest behind', () => {
		assert.deepStrictEqual(
			orderByPolicy(candidates, 'free_preferred').map((candidate) => candidate.modelId),
			['free', 'free-manual', 'paid', 'unknown'],
		);
	});

	test('any keeps the declared order', () => {
		assert.deepStrictEqual(
			orderByPolicy(candidates, 'any').map((candidate) => candidate.modelId),
			['paid', 'free', 'unknown', 'free-manual'],
		);
	});

	test('free_only with nothing eligible is an empty set, not a fallback', () => {
		const none = candidates.filter((candidate) => candidate.modelId !== 'free' && candidate.modelId !== 'free-manual');
		assert.deepStrictEqual(orderByPolicy(none, 'free_only'), []);
	});

	test('the no-eligible message names the count and the expired evidence', () => {
		const message = describeNoEligibleModel({ total: 3, expired: 1 });
		assert.ok(message.includes('somente gratuitos'));
		assert.ok(message.includes('3'));
		assert.ok(message.includes('1'));
		assert.ok(message.includes('Nenhuma chamada'));
		assert.ok(describeNoEligibleModel({ total: 0, expired: 0 }).includes('Nenhum modelo'));
	});
});

suite('Policy: the sentence', () => {
	test('"use somente os modelos gratuitos" turns on free_only', () => {
		assert.strictEqual(parsePolicyPhrase('Seshyina, use somente os modelos gratuitos')?.policy, 'free_only');
	});

	test('accents and case do not matter', () => {
		assert.strictEqual(parsePolicyPhrase('use SÓ os modelos GRÁTIS')?.policy, 'free_only');
		assert.strictEqual(parsePolicyPhrase('use apenas modelos gratis')?.policy, 'free_only');
	});

	test('"only free" in English is recognized too', () => {
		assert.strictEqual(parsePolicyPhrase('use only free models')?.policy, 'free_only');
	});

	test('a preference is free_preferred, not free_only', () => {
		assert.strictEqual(parsePolicyPhrase('prefira modelos gratuitos')?.policy, 'free_preferred');
	});

	test('a question does not change the policy', () => {
		assert.strictEqual(parsePolicyPhrase('posso usar somente os modelos gratuitos?'), undefined);
		assert.strictEqual(parsePolicyPhrase('sera que uso só os gratuitos'), undefined);
	});

	test('a negation does not change the policy', () => {
		assert.strictEqual(parsePolicyPhrase('não use somente os modelos gratuitos'), undefined);
		assert.strictEqual(parsePolicyPhrase('não quero usar só modelos grátis'), undefined);
	});

	test('unrelated text changes nothing', () => {
		assert.strictEqual(parsePolicyPhrase('explique este código'), undefined);
		assert.strictEqual(parsePolicyPhrase(''), undefined);
	});

	test('the application message says what was applied', () => {
		const text = describePolicyApplication('free_only');
		assert.ok(text.includes('somente'));
		assert.ok(text.includes('confirmado'));
	});
});

suite('Policy: persistence format', () => {
	test('a stored record round-trips', () => {
		const record = {
			policy: 'free_only' as const,
			priceSource: 'discovered' as const,
			limitsSource: 'user' as const,
			capabilitiesSource: 'user' as const,
			updatedAt: ISO(0),
			changedBy: 'phrase' as const,
		};
		assert.deepStrictEqual(parseAccessPolicy(serializeAccessPolicy(record)), record);
	});

	test('no file reads as no policy', () => {
		assert.strictEqual(parseAccessPolicy(undefined), undefined);
		assert.strictEqual(parseAccessPolicy(''), undefined);
		assert.strictEqual(parseAccessPolicy('{ not json'), undefined);
	});

	test('an invalid policy falls back per field, not for the whole record', () => {
		const parsed = parseAccessPolicy(JSON.stringify({ policy: 'sometimes', priceSource: 'discovered' }));
		assert.strictEqual(parsed?.policy, 'any');
		assert.strictEqual(parsed?.priceSource, 'discovered', 'one bad field does not undo another');
	});

	test('the file holds no credential', () => {
		const raw = serializeAccessPolicy({
			policy: 'free_only',
			priceSource: 'user',
			limitsSource: 'user',
			capabilitiesSource: 'user',
			updatedAt: ISO(0),
			changedBy: 'user',
		});
		assert.strictEqual(/api[_-]?key|authorization|bearer|secret|sk-/i.test(raw), false);
	});
});
