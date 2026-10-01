import * as assert from 'assert';
import {
	ConfigurationService,
	CONFIGURATION_NAMESPACES,
	type ConfigurationNamespace,
	type ConfigurationReader,
} from '../../core/config';
import { ConfigurationError } from '../../core/errors';

class FakeReader implements ConfigurationReader {
	private readonly values = new Map<string, unknown>();

	set(namespace: string, key: string, value: unknown): void {
		this.values.set(`${namespace}.${key}`, value);
	}

	get<T>(namespace: ConfigurationNamespace, key: string, defaultValue?: T): T | undefined {
		const value = this.values.get(`${namespace}.${key}`);
		return (value === undefined ? defaultValue : value) as T | undefined;
	}
}

suite('Foundation: configuration', () => {
	let reader: FakeReader;
	let service: ConfigurationService;

	setup(() => {
		reader = new FakeReader();
		service = new ConfigurationService(reader);
	});

	test('declares all planned namespaces', () => {
		assert.deepStrictEqual([...CONFIGURATION_NAMESPACES], [
			'general',
			'providers',
			'agent',
			'permissions',
			'memory',
			'backend',
			'terminal',
			'recovery',
		]);
	});

	test('returns configured values', () => {
		reader.set('general', 'logLevel', 'debug');
		assert.strictEqual(service.get('general', 'logLevel'), 'debug');
	});

	test('returns the default when nothing is configured', () => {
		assert.strictEqual(service.get('general', 'logLevel', 'info'), 'info');
		assert.strictEqual(service.get('providers', 'enableAutoDiscovery', false), false);
	});

	test('rejects unknown namespaces with a ConfigurationError', () => {
		assert.throws(
			() =>
				service.get(
					'unknown' as ConfigurationNamespace,
					'key',
				),
			(error: unknown) => error instanceof ConfigurationError,
		);
	});

	test('section() builds the fully qualified settings key', () => {
		assert.strictEqual(service.section('permissions'), 'modelhub.permissions');
	});
});
