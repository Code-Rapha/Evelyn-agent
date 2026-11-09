import { type TokenUsage } from './types';

/**
 * SSE parsing for OpenAI-compatible streams.
 *
 * Wire format, per the SSE spec and how OpenAI-compatible servers emit it:
 *
 *   data: {"choices":[{"delta":{"content":"He"}}]}
 *   <blank line>
 *   data: {"choices":[{"delta":{"content":"llo"}}]}
 *   <blank line>
 *   data: [DONE]
 *   <blank line>
 *
 * Pure functions over strings, no I/O. The provider owns the socket; this file
 * only turns bytes into events, which makes the awkward parts testable:
 * events split across chunks, `\n\n` and `\r\n\r\n`, comment lines, and a
 * final event with no trailing blank line.
 */

/** One decoded SSE event: the joined `data:` lines, or null for a comment. */
export interface SseEvent {
	/** Concatenated `data:` payload, or undefined when the event was a comment. */
	readonly data: string | undefined;
}

/** The terminal sentinel OpenAI-compatible servers send. */
export const SSE_DONE = '[DONE]';

/**
 * Incremental SSE decoder. Feed it decoded text; it returns whatever complete
 * events became available and keeps the incomplete tail for the next chunk.
 */
export class SseDecoder {
	private buffer = '';

	/** Feeds a chunk and returns the events it completed. */
	push(chunk: string): readonly SseEvent[] {
		this.buffer += chunk;

		const events: SseEvent[] = [];
		// Normalise line endings so \r\n, \n and \r\n\r\n all split alike.
		this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

		let separator = this.buffer.indexOf('\n\n');
		while (separator !== -1) {
			const block = this.buffer.slice(0, separator);
			this.buffer = this.buffer.slice(separator + 2);
			const event = parseBlock(block);
			if (event !== undefined) {
				events.push(event);
			}
			separator = this.buffer.indexOf('\n\n');
		}
		return events;
	}

	/**
	 * Flushes a trailing event that arrived without its closing blank line.
	 * Servers that end the body right after `data: [DONE]` do this.
	 */
	flush(): readonly SseEvent[] {
		const remainder = this.buffer.trim();
		this.buffer = '';
		if (remainder.length === 0) {
			return [];
		}
		const event = parseBlock(remainder);
		return event === undefined ? [] : [event];
	}
}

/** Decodes one raw SSE block into an event, or undefined when ignorable. */
function parseBlock(block: string): SseEvent | undefined {
	const dataLines: string[] = [];
	let sawData = false;

	for (const line of block.split('\n')) {
		// Comments (`: ping`) and unknown fields carry no payload for us.
		if (line.length === 0 || line.startsWith(':')) {
			continue;
		}
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		if (field !== 'data') {
			continue;
		}
		// Exactly one optional leading space after the colon is stripped.
		const raw = colon === -1 ? '' : line.slice(colon + 1);
		dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
		sawData = true;
	}

	return sawData ? { data: dataLines.join('\n') } : undefined;
}

/** One decoded chunk from an OpenAI-compatible chat completion. */
export interface ChatCompletionChunk {
	readonly text: string;
	/**
	 * The thinking phase of a reasoning model, when it sends one.
	 *
	 * `content` stays empty for the whole of that phase, so a stream that reports
	 * only `text` looks like a stall followed by an answer that arrives out of
	 * nowhere. Kept apart from `text` because it is not part of the answer: a
	 * host that folded it in would show the model's private scratchpad as if the
	 * user had asked for it.
	 */
	readonly reasoning: string;
	/**
	 * Present only when the chunk carried a `usage` object.
	 *
	 * `undefined` rather than an empty object when the chunk had none: that is
	 * the difference between "the server reported nothing" and "the server
	 * reported zero", and only the first is knowable from an absent field.
	 */
	readonly usage?: TokenUsage;
	readonly toolCalls: readonly {
		readonly index: number;
		readonly id?: string;
		readonly name?: string;
		readonly arguments?: string;
	}[];
	readonly finishReason?: string;
	/**
	 * The model the server says answered.
	 *
	 * Present only when the response published it. That is the difference
	 * between knowing which model a **router** chose and not knowing: a
	 * router may answer with a different model than the one requested, and
	 * the server's own `model` field is the only statement about it that
	 * exists. Absent means the server said nothing, not that the requested
	 * model answered.
	 */
	readonly model?: string;
}

/**
 * Reads a `usage` object off a response.
 *
 * Shape confirmed against a live `api.atria-asi.ai` response:
 *
 *   {"prompt_tokens":18,"completion_tokens":16,"total_tokens":34,
 *    "completion_tokens_details":{"reasoning_tokens":16,"audio_tokens":null,
 *     "accepted_prediction_tokens":null,"rejected_prediction_tokens":null},
 *    "prompt_tokens_details":null}
 *
 * Every field is read defensively and anything unrecognised is dropped rather
 * than coerced. A negative, fractional or non-numeric token count is a server
 * that means something else by the field, and recording it as a number would
 * put it straight into a cost total. Nothing is inferred: `total` is never
 * summed up from the other two, because a server that omits `total_tokens` has
 * not said what the total is.
 *
 * Returns undefined when the object is absent or carries no usable number, so
 * "not reported" and "reported as zero" stay distinguishable.
 */
export function parseUsage(value: unknown): TokenUsage | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const source = value as {
		prompt_tokens?: unknown;
		completion_tokens?: unknown;
		total_tokens?: unknown;
		completion_tokens_details?: { reasoning_tokens?: unknown } | null;
		prompt_tokens_details?: { cached_tokens?: unknown } | null;
	};

	const count = (input: unknown): number | undefined =>
		typeof input === 'number' && Number.isInteger(input) && input >= 0 ? input : undefined;

	const promptTokens = count(source.prompt_tokens);
	const completionTokens = count(source.completion_tokens);
	const totalTokens = count(source.total_tokens);
	const reasoningTokens = count(source.completion_tokens_details?.reasoning_tokens);
	const cachedInputTokens = count(source.prompt_tokens_details?.cached_tokens);

	if (
		promptTokens === undefined &&
		completionTokens === undefined &&
		totalTokens === undefined &&
		reasoningTokens === undefined &&
		cachedInputTokens === undefined
	) {
		return undefined;
	}

	return {
		...(promptTokens !== undefined ? { promptTokens } : {}),
		...(completionTokens !== undefined ? { completionTokens } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
	};
}

/**
 * Maps one SSE `data:` payload to a chunk.
 *
 * Returns undefined for `[DONE]` (handled by the caller) and for payloads that
 * are valid JSON but carry no choices, which servers send as keepalives.
 */
export function parseChatChunk(payload: string): ChatCompletionChunk | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch (cause) {
		throw new SyntaxError(
			`The stream sent a chunk that is not valid JSON: ${payload.slice(0, 200)}`,
			{ cause },
		);
	}

	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}

	// Read `usage` before the choices, because the chunk that carries it is the
	// one with no choices at all: a server asked for streamed usage answers the
	// final event as `{"choices":[],"usage":{…}}`. Returning early on empty
	// choices — which is the right behaviour for a keepalive — would throw that
	// last chunk away, and it is the only one that ever says what the request
	// cost.
	const usage = parseUsage((parsed as { usage?: unknown }).usage);
	// O `model` que o servidor publica. Num roteador, ele pode ser diferente do
	// modelo pedido — e é a única afirmação que existe sobre qual respondeu.
	const publishedModel = (parsed as { model?: unknown }).model;
	const model = typeof publishedModel === 'string' && publishedModel.length > 0 ? publishedModel : undefined;

	const choices = (parsed as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		// A keepalive stays nothing to report; a usage-only chunk stays a chunk.
		return usage === undefined
			? undefined
			: { text: '', reasoning: '', usage, toolCalls: [], ...(model !== undefined ? { model } : {}) };
	}

	const first = choices[0] as {
		delta?: {
			content?: unknown;
			reasoning_content?: unknown;
			reasoning?: unknown;
			tool_calls?: unknown;
		};
		finish_reason?: unknown;
	};

	const content = first.delta?.content;
	const text = typeof content === 'string' ? content : '';
	// Reasoning models name this field several ways across servers, and a stream
	// that used a spelling we did not read would simply lose its thinking phase.
	// Only one of them ever carries text in a given chunk, so reading them all
	// cannot double-count.
	const reasoningDelta = first.delta?.reasoning_content ?? first.delta?.reasoning;
	const reasoning = typeof reasoningDelta === 'string' ? reasoningDelta : '';
	const toolCalls = parseToolCallDeltas(first.delta?.tool_calls);
	const finishReason =
		typeof first.finish_reason === 'string' && first.finish_reason.length > 0
			? first.finish_reason
			: undefined;

	if (
		text.length === 0 &&
		reasoning.length === 0 &&
		toolCalls.length === 0 &&
		finishReason === undefined
	) {
		// A keepalive or an empty delta: nothing to report.
		return undefined;
	}

	return {
		text,
		reasoning,
		toolCalls,
		...(usage !== undefined ? { usage } : {}),
		...(finishReason !== undefined ? { finishReason } : {}),
		...(model !== undefined ? { model } : {}),
	};
}

/** Reads the OpenAI `tool_calls` delta array off a chunk. */
function parseToolCallDeltas(
	raw: unknown,
): ChatCompletionChunk['toolCalls'] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const calls: Array<{
		index: number;
		id?: string;
		name?: string;
		arguments?: string;
	}> = [];

	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const call = entry as {
			index?: unknown;
			id?: unknown;
			function?: { name?: unknown; arguments?: unknown };
		};
		const index = typeof call.index === 'number' ? call.index : calls.length;
		const name = typeof call.function?.name === 'string' ? call.function.name : undefined;
		const args =
			typeof call.function?.arguments === 'string' ? call.function.arguments : undefined;
		const id = typeof call.id === 'string' ? call.id : undefined;

		if (id === undefined && name === undefined && args === undefined) {
			continue;
		}
		calls.push({
			index,
			...(id !== undefined ? { id } : {}),
			...(name !== undefined ? { name } : {}),
			...(args !== undefined ? { arguments: args } : {}),
		});
	}
	return calls;
}