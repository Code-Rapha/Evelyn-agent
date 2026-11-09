/**
 * The `ChatStream` implementation over an SSE byte stream.
 *
 * Separate from the provider so the stream's lifecycle can be reasoned about —
 * and tested — without touching HTTP.
 *
 * Two rules shape this:
 *
 * - Aborting is not failure. An aborted stream ends cleanly with
 *   `closedReason: 'aborted'` and emits no `Error` event.
 * - A failure after the first chunk cannot be thrown at the consumer, because
 *   they have already rendered output. It arrives as a final `Error` event.
 */
import { SseDecoder, SSE_DONE, parseChatChunk } from './sse';
import type { ByteStreamLike } from '../openaiCompatible';
import type { ChatStream, ChatStreamEvent, StreamTiming } from './types';

/** Yields SSE events from a byte stream, mapping them onto chat events. */
export class SseChatStream implements ChatStream {
	private ended = false;
	private iterator: AsyncIterator<Uint8Array | string> | undefined;
	private reason: ChatStream['closedReason'] = 'completed';
	/** Injected so the timings are assertable without a real clock. */
	private readonly clock: () => number;
	private readonly requestedAt: number;
	private readonly headersMs: number;
	private firstTokenMs: number | undefined;
	/** Retained for the catalog; see `StreamTiming.firstByteMs`. */
	private readonly firstByteMs: number | undefined;
	private totalMs: number | undefined;
	/** The model the server published, when it published one. */
	private answeredModel: string | undefined;

	/**
	 * @param options.requestedAt
	 *   When the caller sent the request, from the same clock. The wait for the
	 *   response headers happens *before* this object exists, so measuring from
	 *   construction instead would report the generation time and call it the
	 *   whole request — and a total that excludes the connection is the one
	 *   number that looks healthy while the connection is what is slow.
	 * @param options.now
	 *   The clock, so tests can assert the timings rather than sleep for them.
	 */
	constructor(
		private readonly body: ByteStreamLike,
		private readonly signal?: AbortSignal,
		private readonly options: {
			readonly requestedAt?: number;
			readonly now?: () => number;
			/** Response headers, lower-cased. Read for rate limits; never stored raw. */
			readonly headers?: Readonly<Record<string, string>>;
		} = {},
	) {
		this.clock = options.now ?? Date.now;
		this.requestedAt = options.requestedAt ?? this.clock();
		// Derived here, at the one moment it is true: the response exists and
		// nothing has been read from it yet. This is the time to the *headers*,
		// not to any body byte — reading it as "the model started answering" is
		// exactly the confusion `firstTokenMs` exists to prevent.
		const responseAt = this.clock();
		this.headersMs = responseAt - this.requestedAt;
		this.firstByteMs = this.headersMs;
	}

	get closedReason(): ChatStream['closedReason'] {
		return this.reason;
	}

	/** The rate-limit headers the response carried, when any. */
	get responseHeaders(): Readonly<Record<string, string>> {
		return this.options.headers ?? {};
	}

	/**
	 * The model the server said answered, when it said.
	 *
	 * Absent means the server published nothing — not that the requested
	 * model answered. On a router the two are different, and the difference is
	 * the whole point.
	 */
	get respondedModel(): string | undefined {
		return this.answeredModel;
	}
	get timing(): StreamTiming {
		return {
			headersMs: this.headersMs,
			...(this.firstTokenMs !== undefined ? { firstTokenMs: this.firstTokenMs } : {}),
			...(this.firstByteMs !== undefined ? { firstByteMs: this.firstByteMs } : {}),
			...(this.totalMs !== undefined ? { totalMs: this.totalMs } : {}),
		};
	}

	/**
	 * Wraps the generator so the total is recorded on every way out.
	 *
	 * `finally` rather than a statement inside the generator, because there are
	 * five ways a stream ends — completed, aborted, failed, the body closing with
	 * no marker, and the consumer walking away early — and the last two are
	 * returns from the middle of the generator. Setting it in one place is the
	 * only way none of them can be missed.
	 */
	async *[Symbol.asyncIterator](): AsyncGenerator<ChatStreamEvent> {
		try {
			yield* this.generate();
		} finally {
			this.totalMs = this.clock() - this.requestedAt;
		}
	}

	private async *generate(): AsyncGenerator<ChatStreamEvent> {
		const source = this.body[Symbol.asyncIterator];
		if (source === undefined) {
			this.reason = 'failed';
			yield {
				type: 'Error',
				error: new Error('The response body is not a readable stream'),
			};
			return;
		}

		this.iterator = source.call(this.body);
		const decoder = new SseDecoder();
		// One decoder for the whole stream: a character split across two chunks
		// must carry its bytes over, or every ç/ã that lands on a boundary
		// decodes to replacement characters — silently, mid-word.
		const utf8 = new TextDecoder('utf-8');
		// Tool call deltas accumulate: a name arrives once, then arguments in
		// fragments, all under the same index.
		const pendingToolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();

		try {
			outer: for (;;) {
				if (this.isAborted()) {
					this.reason = 'aborted';
					return;
				}

				const next = await this.iterator.next();
				if (next.done === true) {
					// Bytes held back from a character the last chunk cut in
					// half; `''` when the body ended on a boundary. Resolved
					// before the decoder is drained so they join the block they
					// belong to instead of vanishing — at most one character,
					// and never a newline, so no event can start from them.
					const tail = utf8.decode();
					if (tail.length > 0) {
						decoder.push(tail);
					}
					// A stream can end right after `[DONE]` with no trailing
					// blank line, so the decoder gets one final chance.
					for (const event of decoder.flush()) {
						const done = this.toEvents(event, pendingToolCalls);
						if (done !== undefined) {
							yield* done;
							if (this.ended) {
								break outer;
							}
						}
					}
					yield* this.finalizeToolCalls(pendingToolCalls);
					// The body ended without `[DONE]`. That is still a completed
					// stream: the consumer must always get a terminal event, or it
					// cannot tell "finished" from "cut off".
					if (!this.ended) {
						yield { type: 'Done' };
						this.ended = true;
					}
					this.reason = 'completed';
					return;
				}

				// The signal may have fired while we awaited the source. Dropping
				// data that arrived after the user pressed stop matters more than
				// delivering one chunk that was already in flight.
				if (this.isAborted()) {
					this.reason = 'aborted';
					return;
				}

				const text =
					typeof next.value === 'string'
						? next.value
						: utf8.decode(next.value as Uint8Array, { stream: true });

				for (const event of decoder.push(text)) {
					const events = this.toEvents(event, pendingToolCalls);
					if (events !== undefined) {
						yield* events;
						if (this.ended) {
							break outer;
						}
					}
				}
			}
		} catch (error) {
			if (isAbortError(error)) {
				this.reason = 'aborted';
				return;
			}
			this.reason = 'failed';
			yield {
				type: 'Error',
				error: error instanceof Error ? error : new Error(String(error)),
			};
			return;
		} finally {
			// `for await ... break` calls the generator's return, landing here
			// with `ended` still false: the stream was closed by the consumer,
			// not completed by the server.
			if (!this.ended && this.reason === 'completed') {
				this.reason = 'closed';
			}
			this.ended = true;
			this.release();
		}
	}

	/**
	 * Maps one SSE event to chat events. Returns undefined for keepalives and
	 * for anything carrying no content, and sets `ended` on the terminal event.
	 */
	private toEvents(
		event: { readonly data: string | undefined },
		pendingToolCalls: Map<number, { id?: string; name?: string; arguments: string }>,
	): ChatStreamEvent[] | undefined {
		if (event.data === undefined || event.data.length === 0) {
			return undefined;
		}
		if (event.data.trim() === SSE_DONE) {
			// A server that already ended on `finish_reason` still sends the
			// closing marker. Ending again here would put a second `Done` — and,
			// until the pending map is drained below, a second copy of every tool
			// call — in front of a consumer that is contractually promised one.
			if (this.ended) {
				return undefined;
			}
			this.ended = true;
			return [...this.finalizeToolCalls(pendingToolCalls), { type: 'Done' } as const];
		}

		let chunk;
		try {
			chunk = parseChatChunk(event.data);
		} catch (error) {
			// A malformed chunk is fatal to the stream: the consumer cannot know
			// what was lost, so continuing would silently produce wrong text.
			this.ended = true;
			this.reason = 'failed';
			return [
				{
					type: 'Error',
					error:
						error instanceof Error
							? error
							: new Error(`The stream sent an unreadable chunk: ${String(error)}`),
				},
			];
		}
		if (chunk === undefined) {
			return undefined;
		}

		const events: ChatStreamEvent[] = [];
		// O `model` que o servidor publica. Num roteador, ele pode ser
		// diferente do pedido — e é a única afirmação existente sobre qual
		// respondeu.
		if (chunk.model !== undefined) {
			this.answeredModel = chunk.model;
		}
		// Reasoning first: a chunk carrying both is ordered thinking-then-answer by
		// every server that sends both, so this keeps that order.
		if (chunk.reasoning.length > 0) {
			events.push({ type: 'ReasoningDelta', text: chunk.reasoning });
		}
		if (chunk.text.length > 0) {
			events.push({ type: 'TextDelta', text: chunk.text });
		}
		if (chunk.reasoning.length > 0 || chunk.text.length > 0) {
			this.markFirstToken();
		}
		if (chunk.usage !== undefined) {
			// Emitted wherever it appears, which for a streamed response is the
			// final chunk. A server that never sends one produces no `Usage` event
			// at all, and that absence is the signal — it is not filled in with a
			// zero, which would read as a free request.
			events.push({ type: 'Usage', usage: chunk.usage });
		}
		for (const call of chunk.toolCalls) {
			const pending = pendingToolCalls.get(call.index) ?? { arguments: '' };
			pendingToolCalls.set(call.index, {
				id: call.id ?? pending.id,
				name: call.name ?? pending.name,
				arguments: pending.arguments + (call.arguments ?? ''),
			});
		}
		if (chunk.finishReason !== undefined) {
			events.push(...this.finalizeToolCalls(pendingToolCalls));
			// `finish_reason` *is* the end of the response, so it ends the
			// stream. Without this the loop keeps reading for a `[DONE]` that
			// most servers send anyway, and a body that simply closes would be
			// finalised a second time in the flush path — the same call emitted
			// twice, and a `Done` for each.
			this.ended = true;
			events.push({ type: 'Done', finishReason: chunk.finishReason });
		}
		return events;
	}

	/**
	 * Reads the signal each time rather than caching it: the flag is expected
	 * to flip mid-iteration, and an inline narrowing check would freeze it.
	 */
	private isAborted(): boolean {
		return this.signal?.aborted === true;
	}

	/**
	 * Emits every accumulated tool call, then drains them.
	 *
	 * The drain is what makes this safe to call twice. A server may end the
	 * response on `finish_reason` *and* send `[DONE]`, and the body may simply
	 * close with no marker at all — three paths that all reach here. A second
	 * pass over undrained entries would re-announce each call, and the runtime
	 * would run it once per copy.
	 */
	private finalizeToolCalls(
		pending: Map<number, { id?: string; name?: string; arguments: string }>,
	): ChatStreamEvent[] {
		const events: ChatStreamEvent[] = [];
		for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
			if (call.name === undefined) {
				continue;
			}
			events.push({
				type: 'ToolCallDelta',
				call: {
					id: call.id ?? `call_${index}`,
					name: call.name,
					arguments: call.arguments,
				},
			});
			// A tool call is the model's first answer too. Marked here rather
			// than only on text, so a model that opens with a call is measured
			// at the call rather than reported as never having started.
			this.markFirstToken();
		}
		pending.clear();
		return events;
	}

	/**
	 * Records the wait for the first content token, once.
	 *
	 * The earliest of text, reasoning and a tool call: from the caller's side
	 * all three mean "the model began to answer", and taking a later one would
	 * report a latency the user did not experience.
	 */
	private markFirstToken(): void {
		if (this.firstTokenMs === undefined) {
			this.firstTokenMs = this.clock() - this.requestedAt;
		}
	}

	/** Releases the underlying reader. Safe to call more than once. */
	private release(): void {
		const iterator = this.iterator;
		this.iterator = undefined;
		if (iterator?.return !== undefined) {
			void Promise.resolve(iterator.return()).catch(() => undefined);
		}
	}

	/**
	 * Stops iteration early. Called by a consumer that breaks out of the loop;
	 * the reason distinguishes an explicit stop from a completed stream.
	 */
	return(): Promise<IteratorResult<ChatStreamEvent>> {
		this.ended = true;
		if (this.reason === 'completed') {
			this.reason = 'closed';
		}
		this.release();
		return Promise.resolve({ done: true, value: undefined });
	}
}

/** A stream that was aborted before the request even completed. */
export class AbortedChatStream implements ChatStream {
	get closedReason(): ChatStream['closedReason'] {
		return 'aborted';
	}

	/**
	 * Empty rather than zeroed.
	 *
	 * There was no request that reached a response, so there is no first byte
	 * and no total to report. `{}` is the honest answer; a zero would read as an
	 * instantaneous reply and be averaged into a latency figure as though it
	 * meant something.
	 */
	get timing(): StreamTiming {
		return {};
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<ChatStreamEvent> {
		// An aborted-before-start stream yields nothing and simply ends.
		return;
	}

	return(): Promise<IteratorResult<ChatStreamEvent>> {
		return Promise.resolve({ done: true, value: undefined });
	}
}

/** True for the several shapes an abort takes across runtimes. */
export function isAbortError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	const candidate = error as { name?: unknown; code?: unknown };
	return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}

/** Builds the OpenAI-compatible JSON body for a chat request. */
export function buildChatRequestBody(request: {
	readonly model: string;
	readonly messages: readonly {
		readonly role: string;
		readonly content: string;
		readonly toolCallId?: string;
		readonly toolCalls?: readonly {
			readonly id: string;
			readonly name: string;
			readonly arguments: string;
		}[];
	}[];
	readonly tools?: readonly {
		readonly name: string;
		readonly description: string;
		readonly parameters: Readonly<Record<string, unknown>>;
	}[];
	readonly stream?: boolean;
	readonly maxTokens?: number;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: request.model,
		messages: request.messages
			// A tool result may not be followed directly by a user message on
			// stricter OpenAI-compatible servers. Preserve both by inserting the
			// assistant continuation that an uninterrupted round-trip would have
			// produced, rather than dropping the user or the tool result.
			.reduce((ordered, message) => {
				if (
					ordered.length > 0 &&
					ordered[ordered.length - 1].role === 'tool' &&
					message.role === 'user'
				) {
					ordered.push({ role: 'assistant', content: '' });
				}
				ordered.push(message);
				return ordered;
			}, [] as (typeof request.messages)[number][]).map((message) => ({
			role: message.role,
			content: message.content,
			...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
			// The structured half of an assistant round-trip. Without it a
			// `role:"tool"` message below has nothing to answer, and a strict
			// server (api.openai.com among them) rejects the whole request with
			// "messages with role 'tool' must be a response to a preceding
			// message with 'tool_calls'". Only ever set on assistant messages,
			// so a stray field cannot appear on a role that must not carry one.
			...(message.role === 'assistant' &&
			message.toolCalls !== undefined &&
			message.toolCalls.length > 0
				? {
						tool_calls: message.toolCalls.map((call) => ({
							id: call.id,
							type: 'function',
							function: { name: call.name, arguments: call.arguments },
						})),
					}
				: {}),
		})),
		// Streaming is the only mode this provider implements; asking for it is
		// explicit so the wire format never silently disagrees with the caller.
		stream: request.stream ?? true,
	};
	if (request.tools !== undefined && request.tools.length > 0) {
		body.tools = request.tools.map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
		body.tool_choice = 'auto';
	}
	// Sent only when the caller asked for a bound. A default here would apply
	// to every real turn, and silently truncating an answer is worse than
	// letting the server choose.
	if (request.maxTokens !== undefined) {
		body.max_tokens = request.maxTokens;
	}
	return body;
}