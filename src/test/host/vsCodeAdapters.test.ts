import * as assert from 'assert';
import { VsCodeStateStore } from '../../host/vscode/storage/vsCodeStateStore';

/**
 * Tests for the VS Code adapters.
 *
 * These live under `test/host/` because they exercise code that depends on
 * `vscode` types. The Core's own tests never import an adapter — that is the
 * boundary the split is meant to prove.
 */

/** Structural stand-in for `vscode.Memento`. */
interface MementoLike {
	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
	keys(): readonly string[];
}

class FakeMemento implements MementoLike {
	readonly writes: unknown[] = [];
	constructor(private readonly values: Map<string, unknown> = new Map()) {}
	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.writes.push({ key, value });
		this.values.set(key, value);
	}
	keys(): readonly string[] {
		return [...this.values.keys()];
	}
	raw(key: string): unknown {
		return this.values.get(key);
	}
}

suite('Host: VS Code state store adapter', () => {
	test('delegates update to the Memento', async () => {
		const fake = new FakeMemento();
		const store = new VsCodeStateStore(fake);

		await store.update('a-key', { hello: 'world' });

		assert.deepStrictEqual(fake.raw('a-key'), { hello: 'world' });
		assert.deepStrictEqual(store.get('a-key', null), { hello: 'world' });
	});

	test('returns the default for an absent key', () => {
		const store = new VsCodeStateStore(new FakeMemento());

		assert.deepStrictEqual(store.get('missing', { fallback: true }), { fallback: true });
	});

	test('preserves the stored value across store instances', async () => {
		const fake = new FakeMemento();

		await new VsCodeStateStore(fake).update('k', ['a', 'b']);

		// Same Memento, fresh adapter: the state outlives the adapter.
		assert.deepStrictEqual(new VsCodeStateStore(fake).get('k', null), ['a', 'b']);
	});
});