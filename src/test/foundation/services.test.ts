import * as assert from 'assert';
import { ServiceContainer, type ServiceLike } from '../../core/services';

interface RecordingService extends ServiceLike {
	readonly events: string[];
}

function createService(id: string, events: string[], initialize?: () => void): RecordingService {
	return {
		id,
		events,
		initialize,
		dispose: () => {
			events.push(`dispose:${id}`);
		},
	};
}

suite('Foundation: service container', () => {
	test('registers, resolves and reports services', () => {
		const container = new ServiceContainer();
		const service = createService('a', []);

		container.register(service);

		assert.strictEqual(container.has('a'), true);
		assert.strictEqual(container.size, 1);
		assert.strictEqual(container.get<RecordingService>('a'), service);
		assert.strictEqual(container.has('b'), false);
	});

	test('rejects duplicate ids and unknown lookups', () => {
		const container = new ServiceContainer();
		container.register(createService('a', []));

		assert.throws(() => container.register(createService('a', [])), /already registered/);
		assert.throws(() => container.get('missing'), /not registered/);
	});

	test('initializes in registration order', async () => {
		const events: string[] = [];
		const container = new ServiceContainer();
		container.register(
			createService('first', events, () => {
				events.push('init:first');
			}),
		);
		container.register(
			createService('second', events, () => {
				events.push('init:second');
			}),
		);

		await container.initializeAll();

		assert.deepStrictEqual(events, ['init:first', 'init:second']);
		assert.strictEqual(container.isInitialized, true);
	});

	test('disposes in reverse order and clears state', () => {
		const events: string[] = [];
		const container = new ServiceContainer();
		container.register(createService('a', events));
		container.register(createService('b', events));

		container.disposeAll();

		assert.deepStrictEqual(events, ['dispose:b', 'dispose:a']);
		assert.strictEqual(container.size, 0);
		assert.strictEqual(container.isInitialized, false);
	});
});
