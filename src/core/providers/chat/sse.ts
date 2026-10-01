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
	readonly toolCalls: readonly {
		readonly index: number;
		readonly id?: string;
		readonly name?: string;
		readonly arguments?: string;
	}[];
	readonly finishReason?: string;
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
	const choices = (parsed as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		return undefined;
	}

	const first = choices[0] as {
		delta?: { content?: unknown; tool_calls?: unknown };
		finish_reason?: unknown;
	};

	const content = first.delta?.content;
	const text = typeof content === 'string' ? content : '';
	const toolCalls = parseToolCallDeltas(first.delta?.tool_calls);
	const finishReason =
		typeof first.finish_reason === 'string' && first.finish_reason.length > 0
			? first.finish_reason
			: undefined;

	if (text.length === 0 && toolCalls.length === 0 && finishReason === undefined) {
		// A keepalive or an empty delta: nothing to report.
		return undefined;
	}

	return { text, toolCalls, ...(finishReason !== undefined ? { finishReason } : {}) };
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