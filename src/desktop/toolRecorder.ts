/**
 * Records what each tool returned, without changing what ran.
 *
 * History: `ConversationRuntime` keeps the enriched history internally, and for
 * a long time `ToolCompleted` said *that* a tool finished but not what it
 * produced — so this wrapper noted the serialized result on the way past. The
 * event now carries the model-facing `output` itself, which is what the UI and
 * the transcript use; what remains here is `ok` for a tool that recorded a
 * result of its own, and the drain that keeps this queue from growing across
 * turns. The wrapper still delegates `execute` to the real tool with the
 * context untouched: the registry holds one entry per tool name, the runtime
 * still asks the permission gateway first, and the workspace still confines the
 * call — nothing here can reach a tool that did not already go through those
 * gates.
 *
 * Results are matched to calls by order, not by id. The runtime executes tool
 * calls sequentially and yields `ToolCompleted` in that same order, so the Nth
 * completion is the Nth call. `ToolExecutionContext` carries no call id, so
 * correlating by one is not possible without changing the Core.
 */
import type { AgentTool, ToolDescriptor, ToolExecutionContext, ToolResult } from '../core/agent/types';
import type { ToolRegistry } from '../core/agent/toolRegistry';

/** How a tool result is serialized on its way to the model. */
export type OutputSerializer = (output: unknown) => string;

/**
 * The Core's own format, reproduced rather than imported.
 *
 * `runtime.ts` keeps its copy private, and re-deriving it here from `ok` and the
 * output would be a second place to change when the format moves. This one is
 * kept adjacent to the comment explaining why the duplicate exists.
 */
export function serializeToolOutput(output: unknown): string {
	if (typeof output === 'string') {
		return output;
	}
	try {
		return JSON.stringify(output) ?? '';
	} catch {
		return String(output);
	}
}

/** The prefix `runtime.ts` puts on every failed tool result. */
export const TOOL_ERROR_PREFIX = 'ERROR:';

/** One recorded execution. */
export interface RecordedToolResult {
	/** Raw JSON the model sent, for display. */
	readonly rawArguments: string;
	readonly ok: boolean;
	/** Exactly what the model was told, including any `ERROR:` prefix. */
	readonly output: string;
}

/**
 * A tool that records its result on the way out.
 *
 * `delegate` is the real tool. The descriptor is the real one too, so the model
 * is advertised the same tool whether or not anything is recording it.
 */
export class RecordingTool implements AgentTool {
	/** Results in completion order, drained as the runtime reports each call. */
	private readonly queue: RecordedToolResult[] = [];

	constructor(
		readonly descriptor: ToolDescriptor,
		private readonly delegate: AgentTool,
	) {}

	/** The descriptor of the tool actually being run. */
	get inner(): AgentTool {
		return this.delegate;
	}

	/** Takes the oldest unclaimed result, if any. */
	take(): RecordedToolResult | undefined {
		return this.queue.shift();
	}

	/** Results not yet claimed by a `ToolCompleted` event. */
	get pending(): number {
		return this.queue.length;
	}

	async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
		const result = await this.delegate.execute(input, context);
		this.queue.push({
			rawArguments: safeStringify(input),
			ok: result.ok,
			output: result.ok
				? serializeToolOutput(result.output)
				: `${TOOL_ERROR_PREFIX} "${this.descriptor.name}" failed: ${
						result.error ?? 'no detail given'
					}`,
		});
		return result;
	}
}

/**
 * Wraps every tool in a registry, in place.
 *
 * The registry is mutated rather than rebuilt, so a caller that already holds it
 * keeps working and no tool ends up registered twice — `register` refuses a
 * duplicate name, and a rebuilt registry would silently drop whatever else was
 * in it.
 */
export function addRecorders(registry: ToolRegistry): Map<string, RecordingTool> {
	const recorders = new Map<string, RecordingTool>();

	for (const name of registry.names()) {
		const tool = registry.get(name);
		const spec = registry.spec(name);
		if (tool === undefined || spec === undefined) {
			continue;
		}
		if (tool instanceof RecordingTool) {
			// Already wrapped: wrapping twice would put two recorders in the
			// chain and make the queue ordering depend on how often this ran.
			recorders.set(name, tool);
			continue;
		}

		const recorder = new RecordingTool(tool.descriptor, tool);
		registry.unregister(name);
		registry.register(recorder, spec);
		recorders.set(name, recorder);
	}

	return recorders;
}

/** JSON that never throws, so recording cannot break a turn. */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return String(value);
	}
}