import * as assert from 'assert';
import {
	AgentError,
	BackendError,
	ConfigurationError,
	ModelHubError,
	PermissionError,
	ProviderError,
	StorageError,
	ValidationError,
	isModelHubError,
} from '../../core/errors';

suite('Foundation: errors', () => {
	test('each error class exposes its category and name', () => {
		const cases: readonly [ModelHubError, ModelHubError['category'], string][] = [
			[new ConfigurationError('cfg'), 'configuration', 'ConfigurationError'],
			[new ProviderError('prov'), 'provider', 'ProviderError'],
			[new AgentError('agent'), 'agent', 'AgentError'],
			[new PermissionError('perm'), 'permission', 'PermissionError'],
			[new StorageError('stor'), 'storage', 'StorageError'],
			[new BackendError('back'), 'backend', 'BackendError'],
			[new ValidationError('val'), 'validation', 'ValidationError'],
		];

		for (const [error, category, name] of cases) {
			assert.strictEqual(error.category, category);
			assert.strictEqual(error.name, name);
			assert.strictEqual(error.message, category === 'configuration' ? 'cfg' : error.message);
			assert.ok(error instanceof ModelHubError);
			assert.ok(error instanceof Error);
		}
	});

	test('isModelHubError discriminates ModelHub errors from plain errors', () => {
		assert.ok(isModelHubError(new ValidationError('x')));
		assert.ok(!isModelHubError(new Error('plain')));
		assert.ok(!isModelHubError('string'));
	});

	test('supports details and cause', () => {
		const cause = new Error('root cause');
		const error = new ProviderError('failed', {
			cause,
			details: { providerId: 'openrouter' },
		});

		assert.strictEqual(error.details?.providerId, 'openrouter');
		assert.strictEqual(error.cause, cause);
		assert.strictEqual(error.category, 'provider');
	});
});
