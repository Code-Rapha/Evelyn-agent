/**
 * Model discovery: the short-lived `/models` cache.
 *
 * Every source here is a fake that counts its calls and can be held open, so
 * sharing, expiry and cancellation are asserted exactly rather than timed.
 */
import * as assert from 'assert';

import {
	DEFAULT_DISCOVERY_CONCURRENCY,
	DEFAULT_DISCOVERY_STALE_IF_ERROR_MS,
	DEFAULT_DISCOVERY_TTL_MS,
	createModelDiscovery,
	type ModelListSource,
} from '../core/providers/discovery';

interface FakeSource extends ModelListSource {
	readonly calls: (AbortSignal | undefined)[];
	/** Fails each call with this, when set. */
	fail: Error | undefined;
	/** When true, a call stays open until `release()` is called. */
	held?: boolean;
	answer: readonly string[];
}

/** A promise plus the two ways to settle it, for holding a call open. */
function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function source(key: string, answer: readonly string[] = ['modelo-a']): FakeSource {
	const fake: FakeSource = {
		discoveryKey: key,
		calls: [],
		fail: undefined,
		answer,
		listModels: async (options) => {
			const signal = options?.signal;
			fake.calls.push(signal);
			if (fake.held === true) {
				const gate = heldCalls.get(fake);
				// Waiting on the gate, or on the caller's abort. A held request
				// has to be stoppable, which is what the cancellation tests
				// assert. The gate wins when it opens first: releasing a call
				// that was cancelled must not reject a promise nobody awaits.
				let onAbort: (() => void) | undefined;
				const released = await new Promise<boolean>((resolve, reject) => {
					onAbort = (): void => reject(signal?.reason ?? new Error('aborted'));
					signal?.addEventListener('abort', onAbort, { once: true });
					void gate?.promise.then(() => resolve(true));
				})
					.catch(() => false)
					.finally(() => {
						if (onAbort !== undefined) {
							signal?.removeEventListener('abort', onAbort);
						}
					});
				if (!released) {
					throw signal?.reason ?? new Error('aborted');
				}
			}
			if (fake.fail !== undefined) {
				throw fake.fail;
			}
			if (signal?.aborted === true) {
				throw signal.reason ?? new Error('aborted');
			}
			return fake.answer.map((id) => ({ id }));
		},
	};
	return fake;
}

/** Per-source gates for tests that need a request to stay in flight. */
const heldCalls = new WeakMap<FakeSource, ReturnType<typeof deferred>>();

function hold(source: FakeSource): { readonly release: () => void; readonly promise: Promise<void> } {
	const gate = deferred();
	heldCalls.set(source, gate);
	source.held = true;
	return {
		promise: gate.promise,
		release: () => {
			source.held = false;
			gate.resolve();
		},
	};
}

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
	};
}

suite('model discovery', () => {
	test('the defaults are the documented ones', () => {
		assert.strictEqual(DEFAULT_DISCOVERY_TTL_MS, 60_000);
		assert.strictEqual(DEFAULT_DISCOVERY_STALE_IF_ERROR_MS, 15 * 60_000);
		assert.strictEqual(DEFAULT_DISCOVERY_CONCURRENCY, 3);
	});

	test('a second query inside the TTL is answered from the cache', async () => {
		const time = clock();
		const discovery = createModelDiscovery({ now: time.now });
		const local = source('local http://a/v1', ['modelo-a', 'modelo-b']);

		const first = await discovery.query(local);
		time.advance(DEFAULT_DISCOVERY_TTL_MS - 1);
		const second = await discovery.query(local);

		assert.strictEqual(local.calls.length, 1, 'one request for two queries');
		assert.deepStrictEqual(first.models, ['modelo-a', 'modelo-b']);
		assert.deepStrictEqual(second.models, ['modelo-a', 'modelo-b']);
		assert.strictEqual(second.stale, false);
		assert.strictEqual(second.fetchedAtMs, first.fetchedAtMs, 'the answer did not move');
	});

	test('a query at or past the TTL refreshes from the provider', async () => {
		const time = clock();
		const discovery = createModelDiscovery({ now: time.now });
		const local = source('local v1', ['antes']);

		await discovery.query(local);
		time.advance(DEFAULT_DISCOVERY_TTL_MS);
		local.answer = ['depois'];
		const refreshed = await discovery.query(local);

		assert.strictEqual(local.calls.length, 2);
		assert.deepStrictEqual(refreshed.models, ['depois']);
	});

	test('a TTL of zero never reuses an answer', async () => {
		const discovery = createModelDiscovery({ ttlMs: 0 });
		const local = source('local v1');

		await discovery.query(local);
		await discovery.query(local);

		assert.strictEqual(local.calls.length, 2);
	});

	test('concurrent queries share the one discovery in flight', async () => {
		const discovery = createModelDiscovery();
		const local = source('local v1', ['modelo-a']);


		const both = Promise.all([discovery.query(local), discovery.query(local)]);
		// Both callers are waiting on the same flight before it answers.
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.strictEqual(local.calls.length, 1, 'only one request was opened');
		const [a, b] = await both;

		assert.deepStrictEqual(a.models, b.models);
		assert.strictEqual(a.fetchedAtMs, b.fetchedAtMs);
	});

	test('different providers are discovered independently and in parallel', async () => {
		const discovery = createModelDiscovery();
		const a = source('a v1', ['a1']);
		const b = source('b v1', ['b1']);
		const c = source('c v1', ['c1']);
		const sources = new Map([
			[a.discoveryKey, a],
			[b.discoveryKey, b],
			[c.discoveryKey, c],
		]);

		const results = await discovery.queryMany([a.discoveryKey, b.discoveryKey, c.discoveryKey], sources);

		assert.deepStrictEqual(
			results.map((result) => ('models' in result ? result.models : ['failed'])),
			[['a1'], ['b1'], ['c1']],
		);
		assert.strictEqual(a.calls.length, 1);
		assert.strictEqual(b.calls.length, 1);
		assert.strictEqual(c.calls.length, 1);
	});

	test('the same provider on two endpoints is two entries', async () => {
		// The key carries the endpoint, so editing a URL cannot serve the old
		// answer — even for the same provider id.
		const discovery = createModelDiscovery();
		const old = source('p v1 http://old/v1', ['antigo']);
		const moved = source('p v1 http://new/v1', ['novo']);

		await discovery.query(old);
		const fresh = await discovery.query(moved);

		assert.deepStrictEqual(fresh.models, ['novo']);
		assert.strictEqual(moved.calls.length, 1);
		assert.strictEqual((await discovery.query(old)).models.length, 1);
		assert.strictEqual(old.calls.length, 1, 'the old endpoint was still cached');
	});

	test('a capped concurrency never opens more requests than the cap', async () => {
		const discovery = createModelDiscovery({ concurrency: 2 });
		let open = 0;
		let peak = 0;
		const keys = ['a', 'b', 'c', 'd'];
		const sources = new Map<string, ModelListSource>();
		for (const key of keys) {
			sources.set(key, {
				discoveryKey: key,
				listModels: async () => {
					open += 1;
					peak = Math.max(peak, open);
					await new Promise((resolve) => setTimeout(resolve, 5));
					open -= 1;
					return [{ id: key }];
				},
			});
		}

		const results = await discovery.queryMany(keys, sources);

		assert.strictEqual(peak, 2, 'never more than two at once');
		assert.deepStrictEqual(results.map((result) => ('models' in result ? result.models : [])), [
			['a'],
			['b'],
			['c'],
			['d'],
		]);
	});

	test('a failed refresh serves the previous answer, marked stale, inside the window', async () => {
		const time = clock();
		const discovery = createModelDiscovery({ now: time.now });
		const local = source('local v1', ['modelo-a']);

		await discovery.query(local);
		time.advance(DEFAULT_DISCOVERY_TTL_MS + 1_000);
		local.fail = new Error('ECONNREFUSED');
		const stale = await discovery.query(local);

		assert.deepStrictEqual(stale.models, ['modelo-a']);
		assert.strictEqual(stale.stale, true, 'the caller can tell it is not current');
		assert.strictEqual(local.calls.length, 2, 'the refresh was really attempted');
	});

	test('past the stale-if-error window the failure is reported', async () => {
		const time = clock();
		const discovery = createModelDiscovery({ now: time.now });
		const local = source('local v1', ['modelo-a']);

		await discovery.query(local);
		time.advance(DEFAULT_DISCOVERY_TTL_MS + DEFAULT_DISCOVERY_STALE_IF_ERROR_MS + 1);
		local.fail = new Error('ECONNREFUSED');

		await assert.rejects(() => discovery.query(local), /ECONNREFUSED/);
	});

	test('a failure with nothing cached rejects instead of inventing a list', async () => {
		const discovery = createModelDiscovery();
		const local = source('local v1');
		local.fail = new Error('HTTP 500');

		await assert.rejects(() => discovery.query(local), /HTTP 500/);
		assert.deepStrictEqual(discovery.snapshot(), [], 'a failure is not cached as an answer');
	});

	test('a failure of one provider leaves the others cached and served', async () => {
		const time = clock();
		const discovery = createModelDiscovery({ now: time.now });
		const good = source('good v1', ['g1']);
		const bad = source('bad v1', ['b1']);
		const sources = new Map([
			[good.discoveryKey, good],
			[bad.discoveryKey, bad],
		]);

		await discovery.queryMany([good.discoveryKey, bad.discoveryKey], sources);
		time.advance(DEFAULT_DISCOVERY_TTL_MS + DEFAULT_DISCOVERY_STALE_IF_ERROR_MS + 1);
		bad.fail = new Error('HTTP 503');
		const results = await discovery.queryMany([good.discoveryKey, bad.discoveryKey], sources);

		// The good provider was refreshed normally.
		assert.strictEqual('models' in results[0], true);
		assert.strictEqual('models' in results[0] ? results[0].stale : 'missing', false);
		assert.deepStrictEqual('models' in results[0] ? results[0].models : [], ['g1']);
		assert.strictEqual(good.calls.length, 2);
		// The bad one had nothing usable left and reports its own failure. The
		// call as a whole still returned.
		assert.strictEqual('error' in results[1], true);
	});

	test('one provider refuses to answer: the call still returns the others', async () => {
		const discovery = createModelDiscovery();
		const good = source('good v1', ['g1']);
		const broken: ModelListSource = {
			discoveryKey: 'broken v1',
			listModels: () => {
				throw new Error('synchronous explosion');
			},
		};
		const sources = new Map([
			[good.discoveryKey, good],
			[broken.discoveryKey, broken],
		]);

		const results = await discovery.queryMany([good.discoveryKey, broken.discoveryKey], sources);

		assert.strictEqual('models' in results[0], true);
		assert.strictEqual('error' in results[1], true);
	});

	test('a caller that cancels stops waiting without cancelling the others', async () => {
		const discovery = createModelDiscovery();
		const local = source('local v1', ['modelo-a']);
		const held = hold(local);

		const controller = new AbortController();

		const abandoned = discovery.query(local, { signal: controller.signal });
		const patient = discovery.query(local);
		await new Promise((resolve) => setTimeout(resolve, 5));

		controller.abort();
		await assert.rejects(abandoned, (error: unknown) => {
			assert.strictEqual((error as Error).name, 'AbortError');
			return true;
		});
		held.release();
		// The shared request was not aborted by the first caller leaving.
		assert.strictEqual((local.calls[0] as AbortSignal).aborted, false);
		const result = await patient;
		assert.deepStrictEqual(result.models, ['modelo-a']);
	});

	test('an already-aborted caller does not open a request at all', async () => {
		const discovery = createModelDiscovery();
		const local = source('local v1');
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(() => discovery.query(local, { signal: controller.signal }));
		assert.strictEqual(local.calls.length, 0);
	});

	test('a discovery every caller abandoned is aborted and leaves no flight behind', async () => {
		const discovery = createModelDiscovery();
		const local = source('local v1');
		const held = hold(local);
		const controller = new AbortController();

		const pending = discovery.query(local, { signal: controller.signal });
		// Waiting a tick lets the query open its request before the caller
		// leaves; without it the abort could arrive before anything started.
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await assert.rejects(pending, (error: unknown) => {
			assert.strictEqual((error as Error).name, 'AbortError');
			return true;
		});

		const signal = local.calls[0] as AbortSignal;		assert.strictEqual(signal.aborted, true, 'nobody wants the answer, so the request stopped');
		await discovery.settled();
		assert.deepStrictEqual(discovery.snapshot(), [], 'nothing was cached');
	});

	test('a caller that gives up is not served by the cache later as if it had waited', async () => {
		// The request keeps going for the other caller, so its answer is still
		// an answer — but the one that cancelled got a rejection, not a list.
		const discovery = createModelDiscovery();
		const local = source('local v1');
		const held = hold(local);
		const controller = new AbortController();
		const pending = discovery.query(local, { signal: controller.signal });
		const other = discovery.query(local);
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await assert.rejects(pending);
		assert.strictEqual((local.calls[0] as AbortSignal).aborted, false);
		held.release();
		await other;
	});

	test('manual invalidation makes the next query ask again', async () => {
		const discovery = createModelDiscovery();
		const local = source('local v1', ['antes']);

		await discovery.query(local);
		local.answer = ['depois'];
		discovery.invalidate(local.discoveryKey);
		const after = await discovery.query(local);

		assert.deepStrictEqual(after.models, ['depois']);
		assert.strictEqual(local.calls.length, 2);
	});

	test('invalidating one key leaves the others alone', async () => {
		const discovery = createModelDiscovery();
		const a = source('a v1');
		const b = source('b v1');

		await discovery.query(a);
		await discovery.query(b);
		discovery.invalidate(a.discoveryKey);
		await discovery.query(a);
		await discovery.query(b);

		assert.strictEqual(a.calls.length, 2);
		assert.strictEqual(b.calls.length, 1);
	});

	test('invalidating everything clears the whole cache', async () => {
		const discovery = createModelDiscovery();
		const a = source('a v1');
		const b = source('b v1');

		await discovery.query(a);
		await discovery.query(b);
		discovery.invalidate();
		assert.deepStrictEqual(discovery.snapshot(), []);
		await discovery.query(a);
		await discovery.query(b);
		assert.strictEqual(a.calls.length, 2);
		assert.strictEqual(b.calls.length, 2);
	});

	test('an invalidation during a request rejects the waiters and aborts it', async () => {
		const discovery = createModelDiscovery();
		const local = source('local v1', ['meio']);
		const held = hold(local);

		const pending = discovery.query(local);
		// Observed from the first tick: any rejection from the query, including
		// the one the abort triggers, is collected here rather than outliving
		// the test as an unhandled rejection.
		let settled: Error | 'resolved' | undefined;
		void pending.then(
			() => {
				settled = 'resolved';
			},
			(error: unknown) => {
				settled = error as Error;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		// An invalidate is a decision, so its waiters are told so, and the
		// request they were waiting on is stopped.
		discovery.invalidate(local.discoveryKey);
		await new Promise((resolve) => setTimeout(resolve, 5));

		const outcome = settled;
		assert.ok(outcome !== undefined && outcome !== 'resolved', 'the query was rejected');
		assert.match(String((outcome as Error).message), /invalidated/);
		assert.strictEqual((local.calls[0] as AbortSignal).aborted, true);

		// A fresh request is what the next caller gets, not the abandoned one.
		held.release();
		local.answer = ['novo'];
		const after = await discovery.query(local);
		assert.deepStrictEqual(after.models, ['novo']);
	});

	test('what is cached is ids and a timestamp, and nothing else', async () => {
		// The cache never sees a header, a key or a provider object; the answer
		// it stores is the list it was given, verbatim.
		const discovery = createModelDiscovery();
		const local = source('local v1', ['modelo:a', 'Modelo-B', 'with space']);

		const result = await discovery.query(local);

		assert.deepStrictEqual(result.models, ['modelo:a', 'Modelo-B', 'with space']);
		assert.deepStrictEqual(Object.keys(result).sort(), ['fetchedAtMs', 'key', 'models', 'stale']);
		assert.deepStrictEqual(
			discovery.snapshot().map((entry) => Object.keys(entry).sort()),
			[['fetchedAtMs', 'key']],
		);
	});

	test('ids survive exactly as the endpoint reported them', async () => {
		const discovery = createModelDiscovery();
		const ids = ['llama3', 'Org/Model-2', 'gpt-4o:2024-08-06', 'a b'];
		const local = source('local v1', ids);

		const first = await discovery.query(local);
		const second = await discovery.query(local);

		assert.deepStrictEqual(first.models, ids);
		assert.deepStrictEqual(second.models, ids);
	});

	test('a source without a key is refused rather than cached under nothing', async () => {
		const discovery = createModelDiscovery();
		const keyless: ModelListSource = { discoveryKey: '', listModels: async () => [] };

		await assert.rejects(() => discovery.query(keyless), /discovery key/);
	});

	test('settled resolves only once the request is over', async () => {
		const discovery = createModelDiscovery();
		const local = source('local v1');
		const held = hold(local);

		void discovery.query(local);

		let done = false;
		const waiting = discovery.settled().then(() => {
			done = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.strictEqual(done, false);
		held.release();
		await waiting;
		assert.strictEqual(done, true);
	});
});
