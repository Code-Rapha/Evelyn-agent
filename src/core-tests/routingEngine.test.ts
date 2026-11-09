/**
 * The routing engine: retries, fallback, timeouts, breaker and cancellation.
 *
 * Every provider and stream here is a fake. The engine never touches a socket,
 * and the injected clock and sleep make the schedules exact rather than timed
 * with real waits wherever a wait would otherwise be involved.
 */
import * as assert from 'assert';
import { ProviderError } from '../core/errors';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import { runRoute, type RouteRunInput } from '../core/providers/routing/engine';
import {
	RouteExhaustedError,
	RoutingFailure,
	isRoutingFailure,
} from '../core/providers/routing/failure';
import { RoutedChatProvider } from '../core/providers/routing/routedProvider';
import type {
	ChatProvider,
	ChatRequest,
	ChatStream,
	ChatStreamEvent,
	StreamTiming,
} from '../core/providers/chat/types';
import type {
	RouteAttempt,
	RoutePolicy,
	RouteTarget,
} from '../core/providers/routing/types';

// â”€â”€ fakes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** A stream that yields a fixed list, then ends. */
function fixedStream(events: readonly ChatStreamEvent[], options: {
	readonly timing?: StreamTiming;
	readonly closedReason?: ChatStream['closedReason'];
} = {}): ChatStream {
	let index = 0;
	return {
		closedReason: options.closedReason ?? 'completed',
		timing: options.timing ?? {},
		[Symbol.asyncIterator](): AsyncIterator<ChatStreamEvent> {
			return {
				async next(): Promise<IteratorResult<ChatStreamEvent>> {
					if (index < events.length) {
						const value = events[index];
						index += 1;
						return { done: false, value };
					}
					return { done: true, value: undefined };
				},
				async return(): Promise<IteratorResult<ChatStreamEvent>> {
					index = events.length;
					return { done: true, value: undefined };
				},
			};
		},
	};
}

/** A stream whose `next` never settles until the test pushes or ends it. */
class ControlledStream implements ChatStream {
	closedReason: ChatStream['closedReason'] = 'completed';
	timing: StreamTiming = {};
	private readonly queue: ChatStreamEvent[] = [];
	private waiter: ((result: IteratorResult<ChatStreamEvent>) => void) | undefined;
	private ended = false;

	push(event: ChatStreamEvent): void {
		if (this.waiter !== undefined) {
			const resolve = this.waiter;
			this.waiter = undefined;
			resolve({ done: false, value: event });
			return;
		}
		this.queue.push(event);
	}

	end(reason: ChatStream['closedReason'] = 'completed'): void {
		this.closedReason = reason;
		this.ended = true;
		if (this.waiter !== undefined) {
			const resolve = this.waiter;
			this.waiter = undefined;
			resolve({ done: true, value: undefined });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<ChatStreamEvent> {
		return {
			next: (): Promise<IteratorResult<ChatStreamEvent>> => {
				const queued = this.queue.shift();
				if (queued !== undefined) {
					return Promise.resolve({ done: false, value: queued });
				}
				if (this.ended) {
					return Promise.resolve({ done: true, value: undefined });
				}
				return new Promise((resolve) => {
					this.waiter = resolve;
				});
			},
			return: (): Promise<IteratorResult<ChatStreamEvent>> => {
				this.ended = true;
				if (this.waiter !== undefined) {
					const resolve = this.waiter;
					this.waiter = undefined;
					resolve({ done: true, value: undefined });
				}
				return Promise.resolve({ done: true, value: undefined });
			},
		};
	}
}

/** A stream that accepts the connection and then produces nothing. */
function stallingStream(): ControlledStream {
	return new ControlledStream();
}

interface ScriptedCall {
	readonly request: ChatRequest;
	readonly signal: AbortSignal | undefined;
}

class ScriptedProvider implements ChatProvider {
	readonly calls: ScriptedCall[] = [];

	constructor(
		private readonly script: (
			callIndex: number,
			request: ChatRequest,
		) => Promise<ChatStream> | ChatStream,
	) {}

	async streamChat(
		request: ChatRequest,
		options?: { readonly signal?: AbortSignal },
	): Promise<ChatStream> {
		const index = this.calls.length;
		this.calls.push({ request, signal: options?.signal });
		return this.script(index, request);
	}
}

function target(
	providerId: string,
	modelId: string,
	provider: ChatProvider,
): RouteTarget {
	return { providerId, modelId, provider };
}

function policy(overrides: Partial<RoutePolicy> = {}): RoutePolicy {
	return {
		retries: 0,
		retryBackoffMs: 0,
		maxRetryBackoffMs: 0,
		timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 0 },
		fallbackOn: [
			'timeout',
			'unavailable',
			'rate_limit',
			'network',
			'upstream_error',
			'auth',
			'model_not_found',
		],
		breaker: { failureThreshold: 3, windowMs: 60_000, openMs: 30_000, halfOpenProbes: 1 },
		...overrides,
	};
}

function breaker(now: () => number = Date.now): CircuitBreaker {
	return new CircuitBreaker(
		() => ({ failureThreshold: 3, windowMs: 60_000, openMs: 30_000, halfOpenProbes: 1 }),
		now,
	);
}

interface Recorded {
	readonly records: RouteAttempt[];
}

function metrics(): Recorded & { readonly port: { recordAttempt(a: RouteAttempt): void } } {
	const records: RouteAttempt[] = [];
	return {
		records,
		port: {
			recordAttempt(attempt: RouteAttempt): void {
				records.push(attempt);
			},
		},
	};
}

function run(
	partial: Omit<Partial<RouteRunInput>, 'targets' | 'request' | 'policy' | 'breaker' | 'requestId'> & {
		readonly targets: readonly RouteTarget[];
		readonly policy: RoutePolicy;
		readonly breaker: CircuitBreaker;
		readonly request?: ChatRequest;
		readonly requestId?: string;
	},
): ChatStream {
	return runRoute({
		request: partial.request ?? { model: 'requested', messages: [{ role: 'user', content: 'hi' }] },
		requestId: partial.requestId ?? 'req-1',
		...partial,
	});
}

async function eventsOf(stream: ChatStream): Promise<ChatStreamEvent[]> {
	const events: ChatStreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function httpError(status: number, message = `HTTP ${status}`): ProviderError {
	return new ProviderError(message, { details: { status } });
}

function terminal(events: readonly ChatStreamEvent[]): ChatStreamEvent {
	const last = events[events.length - 1];
	assert.ok(last !== undefined, 'the stream produced a terminal event');
	return last;
}

// â”€â”€ routing and commit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('routing engine: candidates and commit', () => {
	test('answers from the first candidate and reports its timing', async () => {
		const timing: StreamTiming = { headersMs: 3, firstTokenMs: 9, totalMs: 20 };
		const good = new ScriptedProvider(() =>
			fixedStream(
				[
					{ type: 'TextDelta', text: 'hello' },
					{ type: 'Done', finishReason: 'stop' },
				],
				{ timing },
			),
		);
		const stream = run({
			targets: [target('p', 'a', good)],
			policy: policy(),
			breaker: breaker(),
		});

		const events = await eventsOf(stream);
		assert.deepStrictEqual(
			events.map((e) => e.type),
			['TextDelta', 'Done'],
		);
		assert.strictEqual(stream.closedReason, 'completed');
		assert.deepStrictEqual(stream.timing, timing);
	});

	test('falls back before the first visible event', async () => {
		const bad = new ScriptedProvider(() => Promise.reject(httpError(503, 'down')));
		const good = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'second' },
				{ type: 'Done' },
			]),
		);
		const sink = metrics();

		const events = await eventsOf(
			run({
				targets: [target('p', 'a', bad), target('p', 'b', good)],
				policy: policy(),
				breaker: breaker(),
				metrics: sink.port,
			}),
		);

		assert.strictEqual(bad.calls.length, 1);
		assert.strictEqual(good.calls.length, 1);
		assert.deepStrictEqual(
			events.map((e) => (e.type === 'TextDelta' ? e.text : e.type)),
			['second', 'Done'],
		);
		assert.deepStrictEqual(
			sink.records.map((r) => `${r.modelId}:${r.outcome}`),
			['a:failure', 'b:success'],
		);
		assert.strictEqual(sink.records[0].errorClass, 'unavailable');
	});

	for (const type of ['TextDelta', 'ReasoningDelta', 'ToolCallDelta'] as const) {
		test(`does not fall back after a ${type}`, async () => {
			const first = new ScriptedProvider(() =>
				fixedStream([
					type === 'TextDelta'
						? { type, text: 'partial' }
						: type === 'ReasoningDelta'
							? { type, text: 'thinking' }
							: { type, call: { id: 'c1', name: 'read', arguments: '{}' } },
					{ type: 'Error', error: new Error('the connection dropped') },
				]),
			);
			const second = new ScriptedProvider(() =>
				fixedStream([
					{ type: 'TextDelta', text: 'should never run' },
					{ type: 'Done' },
				]),
			);

			const stream = run({
				targets: [target('p', 'a', first), target('p', 'b', second)],
				policy: policy(),
				breaker: breaker(),
			});
			const events = await eventsOf(stream);

			assert.strictEqual(first.calls.length, 1);
			assert.strictEqual(second.calls.length, 0, 'a committed attempt is not retried elsewhere');
			const last = terminal(events);
			assert.strictEqual(last.type, 'Error');
			assert.strictEqual(stream.closedReason, 'failed');
		});
	}

	test('a pre-commit failure is invisible: buffered data is dropped', async () => {
		const first = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'Usage', usage: { totalTokens: 7 } },
				{ type: 'Error', error: httpError(500, 'broken') },
			]),
		);
		const second = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'Usage', usage: { totalTokens: 11 } },
				{ type: 'TextDelta', text: 'second' },
				{ type: 'Done' },
			]),
		);

		const events = await eventsOf(
			run({
				targets: [target('p', 'a', first), target('p', 'b', second)],
				policy: policy(),
				breaker: breaker(),
			}),
		);

		assert.deepStrictEqual(events, [
			{ type: 'Usage', usage: { totalTokens: 11 } },
			{ type: 'TextDelta', text: 'second' },
			{ type: 'Done' },
		]);
	});

	test('an empty answer is a complete answer, not a failure', async () => {
		const provider = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'Usage', usage: { totalTokens: 2 } },
				{ type: 'Done', finishReason: 'stop' },
			]),
		);
		const stream = run({
			targets: [target('p', 'a', provider)],
			policy: policy(),
			breaker: breaker(),
		});

		const events = await eventsOf(stream);
		assert.deepStrictEqual(
			events.map((e) => e.type),
			['Usage', 'Done'],
		);
		assert.strictEqual(stream.closedReason, 'completed');
	});

	test('preserves reasoning, tool calls, usage and timing in order', async () => {
		const timing: StreamTiming = { headersMs: 1, firstTokenMs: 2, totalMs: 8 };
		const provider = new ScriptedProvider(() =>
			fixedStream(
				[
					{ type: 'ReasoningDelta', text: 'thinking' },
					{ type: 'TextDelta', text: 'answer' },
					{ type: 'ToolCallDelta', call: { id: 'c1', name: 'read', arguments: '{"p":1}' } },
					{ type: 'Usage', usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } },
					{ type: 'Done', finishReason: 'tool_calls' },
				],
				{ timing },
			),
		);

		const stream = run({
			targets: [target('p', 'a', provider)],
			policy: policy(),
			breaker: breaker(),
		});
		const events = await eventsOf(stream);

		assert.deepStrictEqual(
			events.map((e) => e.type),
			['ReasoningDelta', 'TextDelta', 'ToolCallDelta', 'Usage', 'Done'],
		);
		assert.deepStrictEqual(stream.timing, timing);
	});
});

// â”€â”€ retry and backoff â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('routing engine: retry and backoff', () => {
	test('retries the same candidate on a retryable failure', async () => {
		const provider = new ScriptedProvider((index) => {
			if (index === 0) {
				return Promise.reject(new Error('fetch failed'));
			}
			return fixedStream([
				{ type: 'TextDelta', text: 'recovered' },
				{ type: 'Done' },
			]);
		});
		const delays: number[] = [];
		const sink = metrics();

		const events = await eventsOf(
			run({
				targets: [target('p', 'a', provider)],
				policy: policy({ retries: 1, retryBackoffMs: 25, maxRetryBackoffMs: 100 }),
				breaker: breaker(),
				metrics: sink.port,
				sleep: async (ms) => {
					delays.push(ms);
					return true;
				},
			}),
		);

		assert.strictEqual(provider.calls.length, 2);
		assert.deepStrictEqual(delays, [25]);
		assert.deepStrictEqual(
			events.map((e) => e.type),
			['TextDelta', 'Done'],
		);
		assert.deepStrictEqual(
			sink.records.map((r) => r.outcome),
			['failure', 'success'],
		);
	});

	test('caps the exponential backoff', async () => {
		const provider = new ScriptedProvider(() => Promise.reject(new Error('fetch failed')));
		const delays: number[] = [];

		await eventsOf(
			run({
				targets: [target('p', 'a', provider)],
				policy: policy({ retries: 4, retryBackoffMs: 100, maxRetryBackoffMs: 250 }),
				breaker: breaker(),
				sleep: async (ms) => {
					delays.push(ms);
					return true;
				},
			}),
		);

		assert.deepStrictEqual(delays, [100, 200, 250, 250]);
		assert.strictEqual(provider.calls.length, 5);
	});

	test('does not retry a class that will fail the same way', async () => {
		const provider = new ScriptedProvider(() => Promise.reject(httpError(401, 'invalid api key')));
		const stream = run({
			targets: [target('p', 'a', provider)],
			policy: policy({ retries: 3, retryBackoffMs: 10, maxRetryBackoffMs: 10, fallbackOn: [] }),
			breaker: breaker(),
		});

		const events = await eventsOf(stream);
		assert.strictEqual(provider.calls.length, 1);
		assert.strictEqual(terminal(events).type, 'Error');
	});

	test('an exhausted route emits exactly one error', async () => {
		const a = new ScriptedProvider(() => Promise.reject(httpError(500, 'a failed')));
		const b = new ScriptedProvider(() => Promise.reject(httpError(500, 'b failed')));
		const sink = metrics();

		const stream = run({
			targets: [target('p', 'a', a), target('p', 'b', b)],
			policy: policy(),
			breaker: breaker(),
			metrics: sink.port,
		});
		const events = await eventsOf(stream);

		assert.strictEqual(events.length, 1);
		const last = terminal(events);
		assert.strictEqual(last.type, 'Error');
		if (last.type === 'Error') {
			assert.ok(last.error instanceof RouteExhaustedError);
			assert.strictEqual(last.error.attempts.length, 2);
		}
		assert.strictEqual(stream.closedReason, 'failed');
		assert.strictEqual(sink.records.length, 2);
	});

	test('records the connection time separately from the first visible event', async () => {
		// The defect this pins: reading `headersMs` as the model's latency. The
		// provider answers in 40ms and then thinks; the two numbers must not
		// collapse into one.
		let now = 1_000;
		const provider = new ScriptedProvider(() =>
			fixedStream(
				[
					{ type: 'Usage', usage: { totalTokens: 1 } },
					{ type: 'TextDelta', text: 'answer' },
					{ type: 'Done' },
				],
				{ timing: { headersMs: 40, firstTokenMs: 12_000, totalMs: 12_100 } },
			),
		);
		const sink = metrics();

		await eventsOf(
			run({
				targets: [target('p', 'a', provider)],
				policy: policy(),
				breaker: breaker(),
				metrics: sink.port,
				clock: () => (now += 25),
			}),
		);

		assert.strictEqual(sink.records.length, 1);
		assert.strictEqual(sink.records[0].headersMs, 40, 'from the provider, not from the clock');
		// A usage chunk arrives first and then a delta, so the two measures part
		// company: `ttfbMs` is "data began", the visible measure is "the answer
		// began". Both are the engine's clock, not the provider's 12s.
		assert.strictEqual(sink.records[0].ttfbMs, 25);
		assert.strictEqual(sink.records[0].firstVisibleEventMs, 50);
		assert.notStrictEqual(sink.records[0].firstVisibleEventMs, sink.records[0].headersMs);
		assert.ok(sink.records[0].totalMs !== undefined);
	});

	test('takes the first visible event from the first delta, not from a usage chunk', async () => {
		let now = 0;
		const provider = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'Usage', usage: { totalTokens: 4 } },
				{ type: 'TextDelta', text: 'answer' },
				{ type: 'Usage', usage: { totalTokens: 9 } },
				{ type: 'Done' },
			]),
		);
		const sink = metrics();

		await eventsOf(
			run({
				targets: [target('p', 'a', provider)],
				policy: policy(),
				breaker: breaker(),
				metrics: sink.port,
				clock: () => (now += 10),
			}),
		);

		assert.strictEqual(sink.records[0].ttfbMs, 10, 'the first event of any kind');
		assert.strictEqual(sink.records[0].firstVisibleEventMs, 20, 'the first thing seen');
	});

	test('keeps the usage the provider reported and leaves it absent otherwise', async () => {
		const reported = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'a' },
				{ type: 'Usage', usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } },
				{ type: 'Done' },
			]),
		);
		const silent = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'b' },
				{ type: 'Done' },
			]),
		);
		const sink = metrics();

		// Two separate routes: on one route, the first candidates succeed and
		// the second is never called, so the test would not be about the silent
		// provider at all.
		await eventsOf(
			run({
				targets: [target('p', 'a', reported)],
				policy: policy(),
				breaker: breaker(),
				metrics: sink.port,
			}),
		);
		await eventsOf(
			run({
				targets: [target('p', 'b', silent)],
				policy: policy(),
				breaker: breaker(),
				metrics: sink.port,
				requestId: 'req-2',
			}),
		);

		assert.deepStrictEqual(sink.records[0].usage, {
			promptTokens: 3,
			completionTokens: 4,
			totalTokens: 7,
		});
		// Absent, never `{}` and never zeros.
		assert.strictEqual('usage' in sink.records[1], false);
	});

	test('leaves headers absent when the provider measured none', async () => {
		const provider = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'a' },
				{ type: 'Done' },
			]),
		);
		const sink = metrics();

		await eventsOf(
			run({ targets: [target('p', 'a', provider)], policy: policy(), breaker: breaker(), metrics: sink.port }),
		);

		assert.strictEqual('headersMs' in sink.records[0], false);
	});

	test('a success that never produced a visible event still has no first visible time', async () => {
		const provider = new ScriptedProvider(() =>
			fixedStream([{ type: 'Usage', usage: { totalTokens: 1 } }, { type: 'Done' }]),
		);
		const sink = metrics();

		await eventsOf(
			run({ targets: [target('p', 'a', provider)], policy: policy(), breaker: breaker(), metrics: sink.port }),
		);

		assert.strictEqual(sink.records[0].outcome, 'success');
		assert.strictEqual('firstVisibleEventMs' in sink.records[0], false);
	});

	test('marks retries and fallbacks on the attempt they describe', async () => {
		const a = new ScriptedProvider(() => Promise.reject(new Error('fetch failed')));
		const b = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'ok' },
				{ type: 'Done' },
			]),
		);
		const sink = metrics();

		await eventsOf(
			run({
				targets: [target('p', 'a', a), target('p', 'b', b)],
				policy: policy({ retries: 1, retryBackoffMs: 1, maxRetryBackoffMs: 1 }),
				breaker: breaker(),
				metrics: sink.port,
			}),
		);

		assert.deepStrictEqual(
			sink.records.map((record) => `${record.modelId}:${record.retry}:${record.fallback}`),
			['a:false:false', 'a:true:false', 'b:false:true'],
			'the first try is neither, the second try is a retry, the next model is a fallback',
		);
	});

	test('counts each attempt once, on every way a route can end', async () => {
		// Five endings: success, a pre-commit failure, a timer, a user stop and
		// a consumer walking away. Each must produce exactly one record.
		const succeed = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'ok' },
				{ type: 'Done' },
			]),
		);
		const succeedSink = metrics();
		await eventsOf(
			run({ targets: [target('p', 'a', succeed)], policy: policy(), breaker: breaker(), metrics: succeedSink.port }),
		);
		assert.strictEqual(succeedSink.records.length, 1);

		const fail = new ScriptedProvider(() => Promise.reject(httpError(500, 'down')));
		const failSink = metrics();
		await eventsOf(
			run({
				targets: [target('p', 'a', fail)],
				policy: policy({ fallbackOn: [] }),
				breaker: breaker(),
				metrics: failSink.port,
			}),
		);
		assert.strictEqual(failSink.records.length, 1);

		const stalled = new ScriptedProvider(() => stallingStream());
		const timeoutSink = metrics();
		await eventsOf(
			run({
				targets: [target('p', 'a', stalled)],
				policy: policy({ timeouts: { ttfbMs: 15, idleMs: 0, totalMs: 0 } }),
				breaker: breaker(),
				metrics: timeoutSink.port,
			}),
		);
		assert.strictEqual(timeoutSink.records.length, 1);
		assert.strictEqual(timeoutSink.records[0].outcome, 'failure');

		const controller = new AbortController();
		const stopped = new ScriptedProvider(() => new Promise<ChatStream>(() => undefined));
		const stopSink = metrics();
		const stopStream = run({
			targets: [target('p', 'a', stopped)],
			policy: policy(),
			breaker: breaker(),
			metrics: stopSink.port,
			signal: controller.signal,
		});
		const collected = eventsOf(stopStream);
		setTimeout(() => controller.abort(), 5);
		await collected;
		assert.strictEqual(stopSink.records.length, 1);
		assert.strictEqual(stopSink.records[0].outcome, 'cancelled');

		const controlled = new ControlledStream();
		controlled.push({ type: 'TextDelta', text: 'one' });
		const abandoned = new ScriptedProvider(() => controlled);
		const abandonSink = metrics();
		for await (const _event of run({
			targets: [target('p', 'a', abandoned)],
			policy: policy(),
			breaker: breaker(),
			metrics: abandonSink.port,
		})) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.strictEqual(abandonSink.records.length, 1);
	});

	test('a metrics port that throws does not fail the answer', async () => {
		const provider = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'answer' },
				{ type: 'Done' },
			]),
		);
		const attempts: RouteAttempt[] = [];
		const stream = run({
			targets: [target('p', 'a', provider)],
			policy: policy(),
			breaker: breaker(),
			metrics: {
				recordAttempt: async (attempt) => {
					attempts.push(attempt);
					throw new Error('the metrics store is unavailable');
				},
			},
		});

		const events = await eventsOf(stream);
		assert.deepStrictEqual(
			events.map((event) => event.type),
			['TextDelta', 'Done'],
		);
		assert.strictEqual(attempts.length, 1);
	});

	test('never puts a prompt or a key in an attempt record', async () => {
		const provider = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'the secret answer' },
				{ type: 'Done' },
			]),
		);
		const sink = metrics();

		await eventsOf(
			run({
				targets: [target('p', 'a', provider)],
				policy: policy(),
				breaker: breaker(),
				metrics: sink.port,
				request: {
					model: 'requested',
					messages: [{ role: 'user', content: 'my api key is sk-should-never-appear' }],
				},
			}),
		);

		const serialized = JSON.stringify(sink.records[0]);
		assert.strictEqual(serialized.includes('sk-should-never-appear'), false);
		assert.strictEqual(serialized.includes('secret answer'), false);
		assert.strictEqual(serialized.includes('Bearer'), false);
	});

	test('reports the model of each attempt to the observer', async () => {
		const starts: Array<{ modelId: string; isFallback: boolean; isRetry: boolean }> = [];
		const a = new ScriptedProvider((index) =>
			index === 0 ? Promise.reject(new Error('fetch failed')) : Promise.reject(new Error('fetch failed')),
		);
		const b = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'ok' },
				{ type: 'Done' },
			]),
		);

		await eventsOf(
			run({
				targets: [target('p', 'a', a), target('p', 'b', b)],
				policy: policy({ retries: 1, retryBackoffMs: 1, maxRetryBackoffMs: 1 }),
				breaker: breaker(),
				observer: {
					onAttemptStart: (info) => {
						starts.push({
							modelId: info.modelId,
							isFallback: info.isFallback,
							isRetry: info.isRetry,
						});
					},
				},
			}),
		);

		assert.deepStrictEqual(starts, [
			{ modelId: 'a', isFallback: false, isRetry: false },
			{ modelId: 'a', isFallback: false, isRetry: true },
			{ modelId: 'b', isFallback: true, isRetry: false },
		]);
	});
});

// â”€â”€ timeouts and deadline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('routing engine: timeouts and deadlines', () => {
	test('a candidate that never produces data is abandoned by the ttfb budget', async () => {
		const stalled = stallingStream();
		const slow = new ScriptedProvider(() => stalled);
		const good = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'second' },
				{ type: 'Done' },
			]),
		);
		const sink = metrics();

		const events = await eventsOf(
			run({
				targets: [target('p', 'a', slow), target('p', 'b', good)],
				policy: policy({ timeouts: { ttfbMs: 20, idleMs: 0, totalMs: 0 } }),
				breaker: breaker(),
				metrics: sink.port,
			}),
		);

		assert.deepStrictEqual(
			events.map((e) => e.type),
			['TextDelta', 'Done'],
		);
		assert.strictEqual(sink.records[0].errorClass, 'timeout');
		assert.strictEqual(sink.records[0].abortCause, 'first-token');
		assert.strictEqual(sink.records[1].outcome, 'success');
	});

	test('an idle stream is abandoned without falling back after content', async () => {
		const controlled = new ControlledStream();
		controlled.push({ type: 'TextDelta', text: 'partial' });
		const provider = new ScriptedProvider(() => controlled);
		const other = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'should not run' },
				{ type: 'Done' },
			]),
		);

		const stream = run({
			targets: [target('p', 'a', provider), target('p', 'b', other)],
			policy: policy({ timeouts: { ttfbMs: 0, idleMs: 25, totalMs: 0 } }),
			breaker: breaker(),
		});
		const events = await eventsOf(stream);

		assert.strictEqual(other.calls.length, 0);
		assert.strictEqual(events[0].type, 'TextDelta');
		const last = terminal(events);
		assert.strictEqual(last.type, 'Error');
		if (last.type === 'Error') {
			assert.ok(isRoutingFailure(last.error));
			assert.strictEqual((last.error as RoutingFailure).abortCause, 'idle');
			assert.strictEqual((last.error as RoutingFailure).errorClass, 'timeout');
		}
	});

	test('an attempt that outlives its total budget is abandoned', async () => {
		const controlled = new ControlledStream();
		controlled.push({ type: 'TextDelta', text: 'partial' });
		const provider = new ScriptedProvider(() => controlled);

		const stream = run({
			targets: [target('p', 'a', provider)],
			policy: policy({ timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 25 } }),
			breaker: breaker(),
		});
		const events = await eventsOf(stream);

		const last = terminal(events);
		assert.strictEqual(last.type, 'Error');
		if (last.type === 'Error') {
			assert.strictEqual((last.error as RoutingFailure).abortCause, 'total-time');
		}
	});

	test('the global deadline stops the route even with candidates left', async () => {
		const stalled = new ScriptedProvider(() => stallingStream());
		const good = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'never reached' },
				{ type: 'Done' },
			]),
		);

		const stream = run({
			targets: [target('p', 'a', stalled), target('p', 'b', good)],
			policy: policy({ deadlineMs: 25 }),
			breaker: breaker(),
		});
		const events = await eventsOf(stream);

		assert.strictEqual(stalled.calls.length, 1);
		assert.strictEqual(good.calls.length, 0, 'the route budget is gone, so no further candidate');
		const last = terminal(events);
		assert.strictEqual(last.type, 'Error');
		if (last.type === 'Error') {
			assert.strictEqual((last.error as RoutingFailure).abortCause, 'deadline');
		}
	});
});

// â”€â”€ cancellation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('routing engine: cancellation', () => {
	test('a caller abort during connect stops the route with no terminal event', async () => {
		const controller = new AbortController();
		const provider = new ScriptedProvider(() => new Promise<ChatStream>(() => undefined));
		const sink = metrics();

		const stream = run({
			targets: [target('p', 'a', provider), target('p', 'b', provider)],
			policy: policy({ retries: 2, retryBackoffMs: 1, maxRetryBackoffMs: 1 }),
			breaker: breaker(),
			metrics: sink.port,
			signal: controller.signal,
		});
		const collected = eventsOf(stream);
		setTimeout(() => controller.abort(), 10);

		const events = await collected;
		assert.deepStrictEqual(events, []);
		assert.strictEqual(stream.closedReason, 'aborted');
		assert.strictEqual(provider.calls.length, 1, 'a stop is never retried');
		assert.strictEqual(sink.records.length, 1);
		assert.strictEqual(sink.records[0].outcome, 'cancelled');
		assert.strictEqual(sink.records[0].errorClass, 'cancelled');
	});

	test('a caller abort mid-stream stops without a terminal event', async () => {
		const controller = new AbortController();
		const controlled = new ControlledStream();
		const provider = new ScriptedProvider(() => controlled);

		const stream = run({
			targets: [target('p', 'a', provider)],
			policy: policy(),
			breaker: breaker(),
			signal: controller.signal,
		});
		const collected = eventsOf(stream);
		controlled.push({ type: 'TextDelta', text: 'partial' });
		setTimeout(() => controller.abort(), 10);

		const events = await collected;
		assert.deepStrictEqual(events, [{ type: 'TextDelta', text: 'partial' }]);
		assert.strictEqual(stream.closedReason, 'aborted');
	});

	test('a consumer that stops reading closes the stream without recording a failure', async () => {
		const controlled = new ControlledStream();
		controlled.push({ type: 'TextDelta', text: 'only one' });
		const provider = new ScriptedProvider(() => controlled);
		const sink = metrics();

		const stream = run({
			targets: [target('p', 'a', provider)],
			policy: policy(),
			breaker: breaker(),
			metrics: sink.port,
		});

		for await (const event of stream) {
			assert.strictEqual(event.type, 'TextDelta');
			break;
		}

		// The generator's finally runs when the iteration is abandoned.
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.strictEqual(stream.closedReason, 'closed');
		assert.strictEqual(sink.records.length, 1);
		assert.strictEqual(sink.records[0].outcome, 'cancelled');
	});
});

// â”€â”€ circuit breaker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('routing engine: circuit breaker', () => {
	test('skips an open candidate and uses the next one', async () => {
		let now = 0;
		const guard = breaker(() => now);
		const key = CircuitBreaker.key('p', 'a');
		for (let i = 0; i < 3; i++) {
			guard.recordFailure(key, 'network');
		}
		assert.strictEqual(guard.snapshot(key).state, 'open');

		const a = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'never' },
				{ type: 'Done' },
			]),
		);
		const b = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'b' },
				{ type: 'Done' },
			]),
		);
		const sink = metrics();

		const events = await eventsOf(
			run({
				targets: [target('p', 'a', a), target('p', 'b', b)],
				policy: policy(),
				breaker: guard,
				metrics: sink.port,
			}),
		);

		assert.strictEqual(a.calls.length, 0);
		assert.strictEqual(b.calls.length, 1);
		assert.strictEqual(sink.records[0].outcome, 'skipped');
		assert.strictEqual(sink.records[0].errorClass, 'breaker_open');
		assert.strictEqual(sink.records[0].retryAfterMs, 30_000 - now);
		assert.strictEqual(sink.records[0].retry, false);
		assert.strictEqual(sink.records[0].fallback, false, 'the first target is never a fallback');
		assert.deepStrictEqual(
			events.map((e) => e.type),
			['TextDelta', 'Done'],
		);
	});

	test('a half-open probe that succeeds closes the circuit', async () => {
		let now = 0;
		const guard = breaker(() => now);
		const key = CircuitBreaker.key('p', 'a');
		for (let i = 0; i < 3; i++) {
			guard.recordFailure(key, 'network');
		}
		now = 30_001;

		const a = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'healthy' },
				{ type: 'Done' },
			]),
		);
		await eventsOf(
			run({ targets: [target('p', 'a', a)], policy: policy(), breaker: guard, clock: () => now }),
		);

		assert.strictEqual(a.calls.length, 1);
		assert.strictEqual(guard.snapshot(key).state, 'closed');
	});

	test('a half-open probe that fails reopens the circuit', async () => {
		let now = 0;
		const guard = breaker(() => now);
		const key = CircuitBreaker.key('p', 'a');
		for (let i = 0; i < 3; i++) {
			guard.recordFailure(key, 'network');
		}
		now = 30_001;

		const a = new ScriptedProvider(() => Promise.reject(httpError(500, 'still broken')));
		await eventsOf(
			run({ targets: [target('p', 'a', a)], policy: policy(), breaker: guard, clock: () => now }),
		);

		assert.strictEqual(a.calls.length, 1);
		assert.strictEqual(guard.snapshot(key).state, 'open');
	});

	test('an ignored failure does not open the circuit', async () => {
		const guard = breaker();
		const key = CircuitBreaker.key('p', 'a');
		const provider = new ScriptedProvider(() => Promise.reject(httpError(400, 'bad request')));

		await eventsOf(run({ targets: [target('p', 'a', provider)], policy: policy(), breaker: guard }));

		assert.strictEqual(guard.snapshot(key).state, 'closed');
	});
});

// â”€â”€ the provider wrapper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('routed chat provider', () => {
	test('overrides the model per candidate', async () => {
		const a = new ScriptedProvider(() => Promise.reject(httpError(503, 'down')));
		const b = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'b' },
				{ type: 'Done' },
			]),
		);
		const routed = new RoutedChatProvider({
			targets: [target('p', 'a', a), target('p', 'b', b)],
			policy: policy(),
			breaker: breaker(),
		});

		await eventsOf(
			await routed.streamChat({ model: 'requested', messages: [{ role: 'user', content: 'hi' }] }),
		);

		assert.strictEqual(a.calls[0].request.model, 'a');
		assert.strictEqual(b.calls[0].request.model, 'b');
	});

	test('pins the winning candidate for later rounds', async () => {
		const a = new ScriptedProvider(() => Promise.reject(httpError(503, 'down')));
		const b = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'b' },
				{ type: 'Done' },
			]),
		);
		const routed = new RoutedChatProvider({
			targets: [target('p', 'a', a), target('p', 'b', b)],
			policy: policy(),
			breaker: breaker(),
		});

		await eventsOf(await routed.streamChat({ model: 'requested', messages: [] }));
		assert.strictEqual(routed.pinnedTarget?.modelId, 'b');

		// A second round, as the runtime makes after a tool result.
		await eventsOf(await routed.streamChat({ model: 'requested', messages: [] }));

		assert.strictEqual(a.calls.length, 1, 'the failed candidate is not reconsidered mid-turn');
		assert.strictEqual(b.calls.length, 2);
	});

	test('never switches models after a tool call committed the transcript', async () => {
		const a = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'a says hi' },
				{ type: 'ToolCallDelta', call: { id: 'c1', name: 'read', arguments: '{}' } },
				{ type: 'Done' },
			]),
		);
		const b = new ScriptedProvider(() =>
			fixedStream([
				{ type: 'TextDelta', text: 'b says hi' },
				{ type: 'Done' },
			]),
		);
		const routed = new RoutedChatProvider({
			targets: [target('p', 'a', a), target('p', 'b', b)],
			policy: policy(),
			breaker: breaker(),
		});

		await eventsOf(await routed.streamChat({ model: 'requested', messages: [] }));
		await eventsOf(await routed.streamChat({ model: 'requested', messages: [] }));

		assert.strictEqual(a.calls.length, 2);
		assert.strictEqual(b.calls.length, 0);
		assert.strictEqual(routed.pinnedTarget?.modelId, 'a');
	});
});
