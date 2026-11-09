/**
 * A fusão de limites e capacidades, e a leitura do que o provedor publica.
 *
 * O núcleo puro: nenhuma entrada sai daqui, e nada é inventado a partir do
 * nome do modelo.
 */
import * as assert from 'assert';

import {
	effectiveCapabilities,
	effectiveLimits,
	fieldUsable,
	fuseCapabilities,
	fuseCatalog,
	fuseField,
	fuseLimits,
	type FusedField,
} from '../core/catalog/metadata';
import { readPublishedModelFields } from '../core/providers/discovery/published';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const ISO = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function discovered<T>(value: T, overrides: { readonly expiresAt?: string; readonly stale?: boolean } = {}): {
	value: T;
	source: string;
	verifiedAt: string;
	expiresAt: string;
	stale: boolean;
} {
	return {
		value,
		source: 'provider',
		verifiedAt: ISO(-60_000),
		expiresAt: overrides.expiresAt ?? ISO(24 * 60 * 60_000),
		stale: overrides.stale ?? false,
	};
}

suite('Metadata fusion: the field', () => {
	test('a value nobody stated is absent, not zero and not false', () => {
		const field = fuseField<number>({ chosen: 'user', nowMs: NOW });
		assert.strictEqual(field.effective, undefined);
		assert.strictEqual(field.user, undefined);
		assert.strictEqual(field.discovered, undefined);
		assert.strictEqual(field.conflict, false);
	});

	test('the declared value wins by default', () => {
		const field = fuseField<number>({
			user: 100,
			discovered: discovered(200),
			chosen: 'user',
			nowMs: NOW,
		});
		assert.strictEqual(field.effective, 100);
		assert.strictEqual(field.selected, 'user');
		assert.strictEqual(field.conflict, true, 'the two sides disagree, and it is said');
	});

	test('the discovered value applies when chosen', () => {
		const field = fuseField<number>({
			user: 100,
			discovered: discovered(200),
			chosen: 'discovered',
			nowMs: NOW,
		});
		assert.strictEqual(field.effective, 200);
		assert.strictEqual(field.selected, 'discovered');
		assert.strictEqual(field.user, 100, 'the declared value is kept');
	});

	test('an expired discovered value cannot be chosen', () => {
		const field = fuseField<number>({
			user: 100,
			discovered: discovered(200, { expiresAt: ISO(-1) }),
			chosen: 'discovered',
			nowMs: NOW,
		});
		assert.strictEqual(field.effective, 100);
		assert.strictEqual(field.fellBack, true);
		assert.ok(field.unusableReason?.includes('venceu'));
	});

	test('a stale discovered value cannot be chosen either', () => {
		const field = fuseField<number>({
			user: 100,
			discovered: discovered(200, { stale: true }),
			chosen: 'discovered',
			nowMs: NOW,
		});
		assert.strictEqual(field.effective, 100);
		assert.strictEqual(field.fellBack, true);
	});

	test('equal values on both sides are not a conflict', () => {
		const field = fuseField<number>({
			user: 100,
			discovered: discovered(100),
			chosen: 'user',
			nowMs: NOW,
		});
		assert.strictEqual(field.conflict, false);
		assert.strictEqual(field.effective, 100);
	});

	test('a value published only by the provider is usable', () => {
		const field = fuseField<number>({
			discovered: discovered(200),
			chosen: 'user',
			nowMs: NOW,
		});
		assert.strictEqual(field.effective, 200);
		assert.strictEqual(field.selected, 'discovered');
	});

	test('choosing a side that does not exist falls back, and says so', () => {
		const field = fuseField<number>({ user: 100, chosen: 'discovered', nowMs: NOW });
		assert.strictEqual(field.effective, 100);
		assert.strictEqual(field.fellBack, true);
	});

	test('usability says why a value is not current', () => {
		assert.deepStrictEqual(fieldUsable(undefined, NOW), { usable: false, reason: 'não publicado' });
		assert.strictEqual(fieldUsable({ expiresAt: ISO(1000), stale: false }, NOW).usable, true);
		assert.strictEqual(
			fieldUsable({ expiresAt: ISO(1000), stale: true }, NOW).usable,
			false,
		);
	});
});

suite('Metadata fusion: limits', () => {
	test('the context window and the output limit stay apart', () => {
		const fused = fuseLimits({
			user: { contextTokens: 1000 },
			discovered: discovered({ contextTokens: 2000, maxOutputTokens: 500 }),
			chosen: 'discovered',
			nowMs: NOW,
		});
		assert.strictEqual(fused.contextTokens?.effective, 2000);
		assert.strictEqual(fused.maxOutputTokens?.effective, 500);
		assert.strictEqual(fused.contextTokens?.user, 1000);
	});

	test('a provider that publishes only a window leaves the output limit unknown', () => {
		const fused = fuseLimits({
			discovered: discovered({ contextTokens: 2000 }),
			chosen: 'discovered',
			nowMs: NOW,
		});
		assert.strictEqual(fused.contextTokens?.effective, 2000);
		assert.strictEqual(fused.maxOutputTokens, undefined, 'the window is not the answer budget');
	});

	test('the effective limits omit what nobody knows', () => {
		const fused = fuseLimits({ user: { contextTokens: 1000 }, chosen: 'user', nowMs: NOW });
		assert.deepStrictEqual(effectiveLimits(fused), { contextTokens: 1000 });
		assert.strictEqual(effectiveLimits(fuseLimits({ chosen: 'user', nowMs: NOW })), undefined);
	});
});

suite('Metadata fusion: capabilities', () => {
	test('a capability nobody mentioned stays unknown, not false', () => {
		const fused = fuseCapabilities({ chosen: 'user', nowMs: NOW });
		assert.strictEqual(fused.toolCalling, undefined);
		assert.strictEqual(fused.structuredOutput, undefined);
		assert.strictEqual(fused.reasoning, undefined);
	});

	test('a published list of parameters settles the three capabilities', () => {
		const fused = fuseCapabilities({
			discovered: discovered({ toolCalling: true, structuredOutput: false, reasoning: false }),
			chosen: 'discovered',
			nowMs: NOW,
		});
		assert.strictEqual(fused.toolCalling?.effective, true);
		assert.strictEqual(fused.structuredOutput?.effective, false);
		assert.strictEqual(fused.reasoning?.effective, false);
	});

	test('a conflict between the user and the provider is shown', () => {
		const fused = fuseCapabilities({
			user: { toolCalling: false },
			discovered: discovered({ toolCalling: true }),
			chosen: 'user',
			nowMs: NOW,
		});
		assert.strictEqual(fused.toolCalling?.conflict, true);
		assert.strictEqual(fused.toolCalling?.effective, false);
		assert.strictEqual(fused.toolCalling?.discovered?.value, true);
	});

	test('the effective capabilities omit what nobody knows', () => {
		const effective = effectiveCapabilities(fuseCapabilities({ chosen: 'user', nowMs: NOW }));
		assert.deepStrictEqual(effective, {});
	});

	test('modalities are fused one by one', () => {
		const fused = fuseCapabilities({
			user: { inputs: { text: true } },
			discovered: discovered({ inputs: { text: true, image: true } }),
			chosen: 'discovered',
			nowMs: NOW,
		});
		assert.strictEqual(fused.inputs.text?.effective, true);
		assert.strictEqual(fused.inputs.image?.effective, true);
		assert.strictEqual(fused.inputs.audio, undefined, 'a modality nobody mentioned is unknown');
	});
});

suite('Metadata fusion: the catalog', () => {
	const entry = {
		providerId: 'p',
		modelId: 'm',
		access: 'unknown' as const,
		limits: { contextTokens: 1000 },
		model: { toolCalling: false },
		observations: [],
		createdAt: ISO(0),
		updatedAt: ISO(0),
	};

	test('the fused entry keeps the declared values when they win', () => {
		const fused = fuseCatalog(
			[entry],
			new Map([
				[
					'p:m',
					{
						limits: discovered({ contextTokens: 2000 }),
						capabilities: discovered({ toolCalling: true }),
					},
				],
			]),
			{ priceSource: 'user', limitsSource: 'user', capabilitiesSource: 'user' },
			NOW,
		);
		assert.strictEqual(fused[0]?.limits?.contextTokens, 1000);
		assert.strictEqual(fused[0]?.model?.toolCalling, false);
	});

	test('the fused entry uses the published values when they are chosen', () => {
		const fused = fuseCatalog(
			[entry],
			new Map([
				[
					'p:m',
					{
						limits: discovered({ contextTokens: 2000 }),
						capabilities: discovered({ toolCalling: true }),
					},
				],
			]),
			{ priceSource: 'user', limitsSource: 'discovered', capabilitiesSource: 'discovered' },
			NOW,
		);
		assert.strictEqual(fused[0]?.limits?.contextTokens, 2000);
		assert.strictEqual(fused[0]?.model?.toolCalling, true);
	});

	test('the declared entry on disk is never changed', () => {
		const before = JSON.stringify(entry);
		fuseCatalog(
			[entry],
			new Map([['p:m', { limits: discovered({ contextTokens: 2000 }) }]]),
			{ priceSource: 'user', limitsSource: 'discovered', capabilitiesSource: 'discovered' },
			NOW,
		);
		assert.strictEqual(JSON.stringify(entry), before);
	});
});

suite('Discovery: what the provider publishes', () => {
	test('a bare entry publishes nothing', () => {
		assert.deepStrictEqual(readPublishedModelFields({ id: 'm' }), {});
	});

	test('the context window and the output limit are read separately', () => {
		const fields = readPublishedModelFields({
			id: 'm',
			context_length: 8192,
			max_output_tokens: 4096,
		});
		assert.strictEqual(fields.contextTokens, 8192);
		assert.strictEqual(fields.maxOutputTokens, 4096);
	});

	test('the output limit is never copied from the window', () => {
		const fields = readPublishedModelFields({ id: 'm', context_length: 8192 });
		assert.strictEqual(fields.maxOutputTokens, undefined);
	});

	test('a list of supported parameters settles the capabilities', () => {
		const fields = readPublishedModelFields({
			id: 'm',
			supported_parameters: ['tools', 'structured_outputs', 'reasoning'],
		});
		assert.strictEqual(fields.capabilities?.toolCalling, true);
		assert.strictEqual(fields.capabilities?.structuredOutput, true);
		assert.strictEqual(fields.capabilities?.reasoning, true);
	});

	test('a published list that omits a capability says it is not supported', () => {
		const fields = readPublishedModelFields({ id: 'm', supported_parameters: ['temperature'] });
		assert.strictEqual(fields.capabilities?.toolCalling, false);
		assert.strictEqual(fields.capabilities?.reasoning, false);
	});

	test('a provider that publishes no list says nothing about capabilities', () => {
		const fields = readPublishedModelFields({ id: 'm' });
		assert.strictEqual(fields.capabilities, undefined);
	});

	test('the modalities are read from the architecture', () => {
		const fields = readPublishedModelFields({
			id: 'm',
			architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
		});
		assert.strictEqual(fields.capabilities?.inputs?.text, true);
		assert.strictEqual(fields.capabilities?.inputs?.image, true);
		assert.strictEqual(fields.capabilities?.inputs?.audio, false);
		assert.strictEqual(fields.capabilities?.outputs?.text, true);
		assert.strictEqual(fields.capabilities?.outputs?.image, false);
	});

	test('a capabilities list is read too', () => {
		const fields = readPublishedModelFields({ id: 'm', capabilities: ['tool_use', 'vision'] });
		assert.strictEqual(fields.capabilities?.toolCalling, true);
	});

	test('nothing is derived from the model name', () => {
		const fields = readPublishedModelFields({ id: 'gpt-4o-vision-preview-tools' });
		assert.strictEqual(fields.capabilities, undefined);
		assert.strictEqual(fields.contextTokens, undefined);
	});
});
