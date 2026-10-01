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
}

/**
 * Incremental events from a streamed response.
 *
 * Exactly one terminal event ends a successful stream: `Done`. `Error` ends a
 * failed one. Neither is ever followed by more events.
 */
export type ChatStreamEvent =
	| { readonly type: 'TextDelta'; readonly text: string }
	| { readonly type: 'ToolCallDelta'; readonly call: ToolCallRequest }
	| { readonly type: 'Done'; readonly finishReason?: string }
	| { readonly type: 'Error'; readonly error: Error };

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