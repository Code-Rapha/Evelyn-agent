/**
 * Os estados que a janela de configuração mostra.
 *
 * O renderer monta a tela; este módulo diz o que ela diz. Testar aqui é
 * testar o que o usuário lê — e, mais importante, testar a regra que a tela
 * precisa cumprir: **desconhecido nunca vira zero**, e uma estimativa local
 * nunca é apresentada como limite oficial.
 */
import * as assert from 'assert';

import {
	describeAccessLine,
	describeDeclaredPrice,
	describeDiscoveredPrice,
	describeEffectivePrice,
	describeIncompatibility,
	describePolicy,
	describePolicyExclusion,
	describePriceFallback,
	describeQuota,
	describeQuotaSource,
} from '../desktop/renderer/describePolicy';
import type { MergedModelView, MergedPriceView } from '../desktop/catalogFusion';

const T0 = '2026-10-20T12:00:00.000Z';

function price(overrides: Partial<MergedPriceView> = {}): MergedPriceView {
	return {
		comparable: true,
		fellBack: false,
		...overrides,
	};
}

function model(overrides: Partial<MergedModelView> = {}): MergedModelView {
	return {
		providerId: 'p',
		modelId: 'm',
		listed: true,
		updatedAt: T0,
		policyStatus: { policy: 'any', eligible: true },
		...overrides,
	};
}

suite('The window: the price states', () => {
	test('a declared price is shown with its currency and unit', () => {
		const text = describeDeclaredPrice(
			price({
				user: { currency: 'USD', unit: 'per_1m_tokens', input: 3, output: 15, updatedAt: T0 },
			}),
		);
		assert.ok(text.includes('O seu preço'));
		assert.ok(text.includes('entrada 3'));
		assert.ok(text.includes('saída 15'));
		assert.ok(text.includes('USD'));
		assert.ok(text.includes('1M'));
	});

	test('a missing declared price says so, and never says zero', () => {
		const text = describeDeclaredPrice(price());
		assert.ok(text.includes('não declarado'));
		assert.strictEqual(/\b0\b/.test(text), false);
	});

	test('a discovered price shows its source, its date and its validity', () => {
		const text = describeDiscoveredPrice(
			price({
				discovered: {
					currency: 'USD',
					unit: 'per_1m_tokens',
					input: 2,
					output: 8,
					source: 'provider',
					verifiedAt: T0,
					expiresAt: '2026-10-21T12:00:00.000Z',
					stale: false,
					usable: true,
				},
			}),
		);
		assert.ok(text.includes('provider'));
		assert.ok(text.includes(T0));
		assert.ok(text.includes('válido'));
	});

	test('a stale discovered price says it is not usable', () => {
		const text = describeDiscoveredPrice(
			price({
				discovered: {
					currency: 'USD',
					unit: 'per_1m_tokens',
					input: 2,
					source: 'provider',
					verifiedAt: T0,
					expiresAt: '2026-10-19T12:00:00.000Z',
					stale: true,
					usable: false,
					unusableReason: 'a verificação venceu',
				},
			}),
		);
		assert.ok(text.includes('não utilizável'));
		assert.ok(text.includes('a verificação venceu'));
	});

	test('a price nobody published is said to be unpublished', () => {
		assert.ok(describeDiscoveredPrice(price()).includes('não publicado'));
	});

	test('an unknown price in force is unknown, never zero', () => {
		const text = describeEffectivePrice(price());
		assert.ok(text.includes('desconhecido'));
		assert.ok(text.includes('nunca zero'));
		assert.strictEqual(/preço em vigor: 0/i.test(text), false);
	});

	test('the price in force names the side and the reason', () => {
		const text = describeEffectivePrice(
			price({
				selected: 'discovered',
				effective: {
					currency: 'USD',
					unit: 'per_1m_tokens',
					input: 2,
					side: 'discovered',
					origin: 'provider',
					reason: 'você escolheu usar o preço do provedor; o seu continua guardado',
				},
			}),
		);
		assert.ok(text.includes('do provedor'));
		assert.ok(text.includes('o seu continua guardado'));
	});
});

suite('The window: the incompatible and fallback states', () => {
	test('incompatible currencies are shown as not comparable, with no conversion', () => {
		const text = describeIncompatibility(
			price({ comparable: false, incompatibleReason: 'moedas distintas (USD e EUR); não há conversão' }),
		);
		assert.ok(text !== undefined);
		assert.ok(text.includes('Não comparável'));
		assert.ok(text.includes('Nada é convertido'));
	});

	test('a comparable price has no incompatibility line', () => {
		assert.strictEqual(describeIncompatibility(price()), undefined);
	});

	test('a fallback says the declared price is what applies', () => {
		const text = describePriceFallback(price({ selected: 'user', fellBack: true }));
		assert.ok(text !== undefined);
		assert.ok(text.includes('vale o seu preço'));
	});

	test('no fallback, no line', () => {
		assert.strictEqual(describePriceFallback(price()), undefined);
	});
});

suite('The window: the access states', () => {
	test('a free model confirmed by the provider is shown as such', () => {
		const text = describeAccessLine(
			model({
				access: {
					access: 'free',
					source: 'provider',
					verifiedAt: T0,
					expiresAt: '2026-10-21T12:00:00.000Z',
					usable: true,
				},
			}),
		);
		assert.ok(text.includes('acesso free'));
		assert.ok(text.includes('provider'));
	});

	test('expired evidence is marked on the line', () => {
		const text = describeAccessLine(
			model({
				access: {
					access: 'free',
					source: 'provider',
					verifiedAt: T0,
					expiresAt: '2026-10-19T12:00:00.000Z',
					usable: false,
				},
			}),
		);
		assert.ok(text.includes('evidência vencida'));
	});

	test('a model with no classification says the access is unknown', () => {
		const text = describeAccessLine(model());
		assert.ok(text.includes('acesso desconhecido'));
	});

	test('a model outside the policy says why', () => {
		const text = describeAccessLine(
			model({
				policyStatus: { policy: 'free_only', eligible: false, reason: 'free_not_confirmed' },
			}),
		);
		assert.ok(text.includes('não elegível pela política'));
		assert.ok(text.includes('sem confirmação de gratuito'));
	});

	test('each exclusion reason has its own words', () => {
		assert.ok(describePolicyExclusion({ policy: 'free_only', eligible: false, reason: 'paid' }).includes('pago'));
		assert.ok(
			describePolicyExclusion({ policy: 'free_only', eligible: false, reason: 'free_evidence_expired' }).includes(
				'vencida',
			),
		);
	});
});

suite('The window: the policy states', () => {
	test('each policy has its own description', () => {
		assert.ok(describePolicy({ policy: 'any', changedBy: 'user' }).includes('Sem filtro'));
		assert.ok(describePolicy({ policy: 'free_only', changedBy: 'user' }).includes('Somente gratuitos'));
		assert.ok(describePolicy({ policy: 'free_preferred', changedBy: 'user' }).includes('Gratuitos primeiro'));
	});

	test('a policy applied by a sentence says so', () => {
		assert.ok(describePolicy({ policy: 'free_only', changedBy: 'phrase' }).includes('frase no chat'));
	});
});

suite('The window: the quota states', () => {
	test('a published limit is presented as published', () => {
		assert.strictEqual(describeQuotaSource('published'), 'Limite oficial publicado pelo provedor');
	});

	test('a local estimate says it is not an official limit', () => {
		const text = describeQuotaSource('estimate');
		assert.ok(text.includes('Estimativa local'));
		assert.ok(text.includes('não é limite oficial'));
	});

	test('an observed limit says it was observed in a test', () => {
		const text = describeQuotaSource('observed');
		assert.ok(text.includes('Observado em teste'));
		assert.ok(text.includes('não é limite oficial'));
	});

	test('a quota with no number says the limit is unknown', () => {
		const lines = describeQuota({ providerId: 'p', updatedAt: T0 });
		assert.ok(lines[0]?.includes('desconhecido'));
	});

	test('the account number and the local usage are separate lines', () => {
		const lines = describeQuota({
			providerId: 'p',
			updatedAt: T0,
			account: { source: 'account', value: 7, verifiedAt: T0 },
			usage: { requests: 3, inputTokens: 10, outputTokens: 20, since: T0 },
		});
		assert.strictEqual(lines.length, 2);
		assert.ok(lines[0]?.includes('Informado pela API para esta conta'));
		assert.ok(lines[0]?.includes('valor 7'));
		assert.ok(lines[1]?.includes('Uso contabilizado pela Evelyn'));
		assert.ok(lines[1]?.includes('3 requisições'));
	});
});
