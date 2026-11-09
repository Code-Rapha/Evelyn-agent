/**
 * O portão de orçamento no motor de roteamento.
 *
 * A regra que estes testes fixam: o orçamento **não pode** derrubar uma
 * conversa. Um portão que lança, que devolve lixo ou que responde "desconhecido"
 * deixa a tentativa acontecer; só um veto explícito a impede, e o veto é
 * registrado como `skipped`/`budget_exhausted` — nunca como falha do modelo.
 */
import * as assert from 'assert';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import { runRoute } from '../core/providers/routing/engine';
import { RouteExhaustedError } from '../core/providers/routing/failure';
import type { BudgetGate, RouteAttempt, RoutePolicy, RouteTarget } from '../core/providers/routing/types';
import type { ChatProvider, ChatRequest, ChatStream, ChatStreamEvent } from '../core/providers/chat/types';

function fixedStream(events: readonly ChatStreamEvent[]): ChatStream {
	let index = 0;
	return {
		closedReason: 'completed',
		timing: {},
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
			};
		},
	};
}

class Provider implements ChatProvider {
	readonly calls: ChatRequest[] = [];
	constructor(private readonly script: () => Promise<ChatStream> | ChatStream) {}
	async streamChat(request: ChatRequest): Promise<ChatStream> {
		this.calls.push(request);
		return this.script();
	}
}

const ANSWER: readonly ChatStreamEvent[] = [
	{ type: 'TextDelta', text: 'ok' },
	{ type: 'Done', finishReason: 'stop' },
];

function policy(): RoutePolicy {
	return {
		retries: 0,
		retryBackoffMs: 0,
		maxRetryBackoffMs: 0,
		timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 0 },
		fallbackOn: ['timeout', 'unavailable', 'network'],
		breaker: { failureThreshold: 3, windowMs: 60_000, openMs: 30_000, halfOpenProbes: 1 },
	};
}

const breaker = (): CircuitBreaker =>
	new CircuitBreaker(() => policy().breaker, () => Date.now());

function target(providerId: string, modelId: string, provider: ChatProvider): RouteTarget {
	return { providerId, modelId, provider };
}

async function eventsOf(stream: ChatStream): Promise<ChatStreamEvent[]> {
	const events: ChatStreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function run(input: {
	readonly targets: readonly RouteTarget[];
	readonly budget?: BudgetGate;
	readonly metrics?: { recordAttempt(attempt: RouteAttempt): void };
}): ChatStream {
	return runRoute({
		request: { model: 'requested', messages: [{ role: 'user', content: 'hi' }] },
		requestId: 'req-1',
		targets: input.targets,
		policy: policy(),
		breaker: breaker(),
		...(input.budget !== undefined ? { budget: input.budget } : {}),
		...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
	});
}

suite('routing engine: budget gate', () => {
	test('a vetoed paid candidate is skipped and the free one answers', async () => {
		const paid = new Provider(() => fixedStream(ANSWER));
		const free = new Provider(() => fixedStream(ANSWER));
		const records: RouteAttempt[] = [];
		const asked: string[] = [];
		const gate: BudgetGate = {
			check: ({ modelId }) => {
				asked.push(modelId);
				return modelId === 'paid'
					? { allowed: false, message: 'Limite mensal de USD 5,00 atingido.' }
					: { allowed: true };
			},
		};

		const stream = run({
			targets: [target('p', 'paid', paid), target('p', 'free', free)],
			budget: gate,
			metrics: { recordAttempt: (attempt) => records.push(attempt) },
		});
		const events = await eventsOf(stream);

		assert.strictEqual(paid.calls.length, 0, 'the paid model was never called');
		assert.strictEqual(free.calls.length, 1);
		assert.deepStrictEqual(asked, ['paid', 'free'], 'the free model is asked too, and allowed');
		assert.strictEqual(events[events.length - 1].type, 'Done');

		const skipped = records.find((record) => record.modelId === 'paid');
		assert.ok(skipped !== undefined);
		assert.strictEqual(skipped.outcome, 'skipped');
		assert.strictEqual(skipped.errorClass, 'budget_exhausted');
		assert.strictEqual(skipped.budgetMessage, 'Limite mensal de USD 5,00 atingido.');
	});

	test('a budget veto does not count against the breaker', async () => {
		const paid = new Provider(() => fixedStream(ANSWER));
		const circuit = breaker();
		const gate: BudgetGate = { check: () => ({ allowed: false, message: 'no budget' }) };
		const stream = runRoute({
			request: { model: 'requested', messages: [{ role: 'user', content: 'hi' }] },
			requestId: 'req-1',
			targets: [target('p', 'paid', paid)],
			policy: policy(),
			breaker: circuit,
			budget: gate,
		});
		await eventsOf(stream);

		const snapshot = circuit.snapshot(CircuitBreaker.key('p', 'paid'));
		assert.strictEqual(snapshot.failures, 0, 'the model is not unhealthy, it is unaffordable');
		assert.strictEqual(snapshot.state, 'closed');
	});

	test('every candidate vetoed ends with a budget error that names the block', async () => {
		const first = new Provider(() => fixedStream(ANSWER));
		const second = new Provider(() => fixedStream(ANSWER));
		const stream = run({
			targets: [target('a', 'm1', first), target('b', 'm2', second)],
			budget: { check: () => ({ allowed: false, message: 'orçamento esgotado' }) },
		});
		const events = await eventsOf(stream);
		const last = events[events.length - 1];
		assert.strictEqual(last.type, 'Error');
		if (last.type !== 'Error') {
			return;
		}
		assert.ok(last.error instanceof RouteExhaustedError);
		assert.strictEqual(last.error.errorClass, 'budget_exhausted');
		assert.deepStrictEqual(
			last.error.budgetBlocked.map((entry) => `${entry.providerId}/${entry.modelId}:${entry.sequence}`),
			['a/m1:1', 'b/m2:2'],
		);
		assert.strictEqual(first.calls.length, 0);
		assert.strictEqual(second.calls.length, 0);
	});

	test('a gate that throws allows the attempt: bookkeeping never fails a conversation', async () => {
		const provider = new Provider(() => fixedStream(ANSWER));
		const stream = run({
			targets: [target('p', 'm', provider)],
			budget: {
				check: () => {
					throw new Error('ledger unreadable');
				},
			},
		});
		const events = await eventsOf(stream);
		assert.strictEqual(provider.calls.length, 1);
		assert.strictEqual(events[events.length - 1].type, 'Done');
	});

	test('a gate that rejects asynchronously also allows the attempt', async () => {
		const provider = new Provider(() => fixedStream(ANSWER));
		const stream = run({
			targets: [target('p', 'm', provider)],
			budget: { check: async () => Promise.reject(new Error('store down')) },
		});
		const events = await eventsOf(stream);
		assert.strictEqual(provider.calls.length, 1);
		assert.strictEqual(events[events.length - 1].type, 'Done');
	});

	test('a malformed answer from the gate is read as allowed, not as a veto', async () => {
		const provider = new Provider(() => fixedStream(ANSWER));
		const stream = run({
			targets: [target('p', 'm', provider)],
			budget: { check: () => ({}) as never },
		});
		const events = await eventsOf(stream);
		assert.strictEqual(provider.calls.length, 1);
		assert.strictEqual(events[events.length - 1].type, 'Done');
	});

	test('without a gate nothing changes', async () => {
		const provider = new Provider(() => fixedStream(ANSWER));
		const stream = run({ targets: [target('p', 'm', provider)] });
		await eventsOf(stream);
		assert.strictEqual(provider.calls.length, 1);
	});
});
