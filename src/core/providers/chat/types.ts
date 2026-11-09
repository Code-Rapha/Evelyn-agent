/**
 * Chat and streaming contracts for providers.
 *
 * These types are provider-agnostic on purpose. A Hermes, OpenCode or Codex
 * backend, an OpenAI-compatible server and a local runtime all express a
 * conversation through these shapes, so adding one means implementing
 * `Provider.streamChat`, never widening the interface per vendor.
 *
 * Streaming uses SSE (`text/event-stream`) only. WebSocket is deliberately out
 * of scope: it would require a server, which a local-first product cannot
 * assume, and every OpenAI-compatible server already speaks SSE.
 */

/** One turn of a conversation. */
export interface ChatMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string;
	/** Set on `tool` messages to answer a tool call. */
	readonly toolCallId?: string;
	/**
	 * Set on the `assistant` message that asked for the calls its following
	 * `tool` messages answer.
	 *
	 * OpenAI's wire format makes this mandatory: a `tool` message must respond
	 * to an id announced by a preceding assistant `tool_calls` array, and a
	 * strict server rejects the request without it. The `content` still carries
	 * the human-readable `[tool calls: …]` summary — the transcript the user
	 * reads does not change, only what the server is now also told.
	 */
	readonly toolCalls?: readonly ToolCallRequest[];
}

/** A tool the caller offers the model. Wire format follows OpenAI. */
export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly parameters: Readonly<Record<string, unknown>>;
}

/** A model's request to call a tool. */
export interface ToolCallRequest {
	readonly id: string;
	readonly name: string;
	/** Raw JSON arguments, still unparsed. */
	readonly arguments: string;
}

/** Parameters for a chat turn. */
export interface ChatRequest {
	readonly model: string;
	readonly messages: readonly ChatMessage[];
	readonly tools?: readonly ToolDefinition[];
	/**
	 * `false` (default) yields a single assembled message; `true` yields a
	 * `TextDelta` event per SSE chunk.
	 */
	readonly stream?: boolean;
	/**
	 * Upper bound on the tokens the server may produce.
	 *
	 * Absent means "the server decides", which is the right default for a real
	 * turn. It exists for probes that must cost as little as possible: a
	 * diagnostic asks for one token, so it measures latency rather than
	 * generation, and an accidental long answer cannot be billed for.
	 */
	readonly maxTokens?: number;
}

/**
 * Incremental events from a streamed response.
 *
 * Exactly one terminal event ends a successful stream: `Done`. `Error` ends a
 * failed one. Neither is ever followed by more events.
 *
 * Exception: an abort, and a consumer closing the stream early, end it with
 * *no* terminal event at all — those outcomes are read from
 * `ChatStream.closedReason`, never from an event.
 */
export type ChatStreamEvent =
	| { readonly type: 'TextDelta'; readonly text: string }
	/**
	 * The thinking phase of a reasoning model, separate from the answer.
	 *
	 * A consumer that wants to show a "thinking" indicator must not have to
	 * infer it from silence: on a reasoning model `content` is empty for the
	 * whole phase, and without this event a healthy stream is indistinguishable
	 * from a hung connection.
	 */
	| { readonly type: 'ReasoningDelta'; readonly text: string }
	/**
	 * What the request cost, as the server reported it.
	 *
	 * A separate terminal-adjacent event rather than a field on `Done`, because
	 * the server decides when to send it: a non-streaming response carries it in
	 * the body, and a streaming one only in the final chunk, and only when the
	 * request asked. Emitted whenever it appears and never otherwise, so its
	 * absence is the signal that the provider did not report.
	 */
	| { readonly type: 'Usage'; readonly usage: TokenUsage }
	| { readonly type: 'ToolCallDelta'; readonly call: ToolCallRequest }
	| { readonly type: 'Done'; readonly finishReason?: string }
	| { readonly type: 'Error'; readonly error: Error };

/**
 * What one request cost, as the server reported it.
 *
 * Every field is optional and an absent field means **unknown**, never zero.
 * That distinction is the whole point: a provider that omits `usage` has told us
 * nothing about cost, and recording it as `0` would make an unmetered request
 * indistinguishable from a genuinely free one in every total built from this.
 * Nothing here is ever estimated — if the server did not say, this is empty.
 *
 * Field names are the wire names flattened: `completion_tokens_details` is a
 * nested object on the wire and one scalar here, because the only number in it
 * worth keeping is the reasoning split, and a consumer wanting the rest should
 * not have to know the nesting.
 */
export interface TokenUsage {
	readonly promptTokens?: number;
	readonly completionTokens?: number;
	readonly totalTokens?: number;
	/** The share of `completionTokens` spent thinking, on a reasoning model. */
	readonly reasoningTokens?: number;
	/**
	 * The share of `promptTokens` the provider served from its own cache.
	 *
	 * A **subset** of `promptTokens`, not an addition to it: the wire field
	 * (`prompt_tokens_details.cached_tokens`) counts tokens already included in
	 * `prompt_tokens`, and providers bill them at a different rate. Present only
	 * when the provider published the breakdown; a provider that reports no
	 * details has said nothing about caching, which is not the same as saying
	 * nothing was cached.
	 */
	readonly cachedInputTokens?: number;
}

/**
 * How long a request took, in milliseconds.
 *
 * Three phases, kept apart because they answer different questions and because
 * collapsing them is how a slow connection gets reported as a slow model:
 *
 * - `headersMs` — from sending the request to the HTTP response existing.
 * - `firstTokenMs` — from sending the request to the first chunk that carries
 *   content. This is what a user experiences as "it started answering".
 * - `totalMs` — from sending the request to the stream ending.
 *
 * `totalMs` is undefined while the stream is still running.
 */
export interface StreamTiming {
	/**
	 * From sending the request to the HTTP response headers.
	 *
	 * Measured by the provider at the moment the response object exists. It says
	 * nothing about generation: a fast header followed by a slow token is the
	 * shape of a model that is queueing, not of a model that is answering.
	 */
	readonly headersMs?: number;
	/**
	 * From sending the request to the first content chunk.
	 *
	 * Optional, and honestly so: a stream that ends without ever carrying a
	 * token — an immediate `[DONE]`, an error before the first chunk, an abort —
	 * has no first token, and reporting `0` would read as an instant reply.
	 */
	readonly firstTokenMs?: number;
	/**
	 * From sending the request to the first byte of the response body.
	 *
	 * Kept for the model catalog, which persists a median of it under
	 * `medianFirstByteMs`. That measurement has always been taken when the
	 * response object appears — the same instant as `headersMs` — so the two
	 * hold the same number. The name is historical; changing what the stored
	 * number means would silently relabel every measurement already recorded.
	 */
	readonly firstByteMs?: number;
	/** From sending the request to the stream reaching a terminal event. */
	readonly totalMs?: number;
}

/**
 * A cancellable stream of chat events.
 *
 * The consumer drives iteration; closing the stream releases the underlying
 * connection. `return()` is always safe to call, including after the stream
 * has already ended, because cancellation is a normal outcome here and not an
 * error.
 */
export interface ChatStream extends AsyncIterable<ChatStreamEvent> {
	/** Present only when the stream was closed early; lets callers report why. */
	readonly closedReason: 'completed' | 'aborted' | 'failed' | 'closed';
	/**
	 * How long the request took.
	 *
	 * Present as soon as the headers land, so a caller can show a slow
	 * connection while the answer is still generating. On the same pattern as
	 * `closedReason`: measured by the provider, read by the consumer, never
	 * reconstructed from events.
	 */
	readonly timing: StreamTiming;
	/**
	 * The model the server said answered, when it said.
	 *
	 * On the same pattern as `closedReason`: measured by the provider, read by
	 * the consumer, never reconstructed from events. It matters on a **router**,
	 * where the model that answered can be another one than the one requested —
	 * and the server's own statement is the only thing that says which.
	 *
	 * Absent means the server published nothing. It never means "the requested
	 * model answered".
	 */
	readonly respondedModel?: string;
}

/**
 * What a provider may implement.
 *
 * Split from `Provider` deliberately: a provider that only lists models (a
 * local catalog, an admin console) should not be forced to grow a chat method
 * it cannot serve. The runtime accepts `ChatProvider` where it needs chat.
 */
export interface ChatProvider {
	streamChat(
		request: ChatRequest,
		options?: { readonly signal?: AbortSignal },
	): Promise<ChatStream>;
}

/** Type guard for a provider that can also converse. */
export function isChatProvider(provider: unknown): provider is ChatProvider {
	return (
		typeof provider === 'object' &&
		provider !== null &&
		typeof (provider as { streamChat?: unknown }).streamChat === 'function'
	);
}