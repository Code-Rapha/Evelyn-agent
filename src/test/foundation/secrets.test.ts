import * as assert from 'assert';
import {
	InMemorySecretStore,
	providerApiKeyRef,
	assertValidSecretRef,
} from '../../core/providers/secrets';
import { ValidationError } from '../../core/errors';

suite('Foundation: secret store', () => {
	let store: InMemorySecretStore;

	setup(() => {
		store = new InMemorySecretStore();
	});

	test('store then get returns the value behind the reference', async () => {
		await store.store('modelhub.provider.openai.apiKey', 'sk-test-value');

		assert.strictEqual(
			await store.get('modelhub.provider.openai.apiKey'),
			'sk-test-value',
		);
		assert.strictEqual(await store.size, 1);
	});

	test('get on an unknown reference returns undefined instead of throwing', async () => {
		assert.strictEqual(await store.get('modelhub.provider.absent.apiKey'), undefined);
		assert.strictEqual(await store.has('modelhub.provider.absent.apiKey'), false);
	});

	test('store replaces an existing value rather than duplicating it', async () => {
		await store.store('ref', 'first');
		await store.store('ref', 'second');

		assert.strictEqual(await store.get('ref'), 'second');
		assert.strictEqual(await store.size, 1);
	});

	test('delete removes the value and is a no-op when absent', async () => {
		await store.store('ref', 'value');
		await store.delete('ref');

		assert.strictEqual(await store.get('ref'), undefined);
		assert.strictEqual(await store.has('ref'), false);

		await store.delete('ref');
		assert.strictEqual(await store.size, 0);
	});

	test('has reports true only while a value is present', async () => {
		await store.store('ref', 'value');
		assert.strictEqual(await store.has('ref'), true);

		await store.delete('ref');
		assert.strictEqual(await store.has('ref'), false);
	});

	test('an empty secret value is storable: absence is expressed by no reference', async () => {
		await store.store('ref', '');
		assert.strictEqual(await store.has('ref'), true);
		assert.strictEqual(await store.get('ref'), '');
	});

	test('references are kept independent of each other', async () => {
		await store.store(providerApiKeyRef('openai'), 'key-openai');
		await store.store(providerApiKeyRef('groq'), 'key-groq');

		assert.strictEqual(await store.get(providerApiKeyRef('openai')), 'key-openai');
		assert.strictEqual(await store.get(providerApiKeyRef('groq')), 'key-groq');

		await store.delete(providerApiKeyRef('openai'));
		assert.strictEqual(await store.get(providerApiKeyRef('groq')), 'key-groq');
	});

	test('a blank reference is rejected before any storage is touched', async () => {
		await assert.rejects(() => store.get('   '), ValidationError);
		await assert.rejects(() => store.store('', 'value'), ValidationError);
		await assert.rejects(() => store.delete('  '), ValidationError);
		assert.strictEqual(await store.size, 0);
	});

	test('assertValidSecretRef returns the reference and rejects padded ones', () => {
		assert.strictEqual(assertValidSecretRef('ref'), 'ref');
		assert.throws(() => assertValidSecretRef(' ref'), ValidationError);
		assert.throws(() => assertValidSecretRef('ref '), ValidationError);
	});

	test('a non-string secret value is rejected', async () => {
		await assert.rejects(
			() => store.store('ref', 42 as unknown as string),
			ValidationError,
		);
	});

	test('providerApiKeyRef namespaces per provider', () => {
		assert.strictEqual(providerApiKeyRef('openai'), 'modelhub.provider.openai.apiKey');
		assert.notStrictEqual(providerApiKeyRef('openai'), providerApiKeyRef('groq'));
	});
});