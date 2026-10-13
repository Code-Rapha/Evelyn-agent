/**
 * Composition root for the agent stack.
 *
 * This is the one place that knows which tools exist. The runtime receives a
 * populated `ToolRegistry` and never learns a tool's name, so adding one is a
 * line here and nowhere else.
 *
 * Permission is deliberately not decided here. The root injects whatever
 * `PermissionPort` it is given — a host with a UI supplies one that prompts, a
 * script supplies one that grants everything. The tools carry a risk level and
 * the port interprets it. There is no second policy engine inside the tools.
 */
import { ToolRegistry } from './toolRegistry';
import { MVP_TOOL_SPECS, createMvpTools, type CommandRunner } from './mvpTools';
import type { AgentTool } from './types';
import { allowAllGateway as allowAll } from '../permissions/gateway';
import type { PermissionPort } from './runtime';

/** What a composition needs in order to wire an agent. */
export interface AgentStack {
	readonly registry: ToolRegistry;
	/** Removes every tool this stack registered. */
	dispose(): void;
}

/**
 * Builds a registry with the MVP tools.
 *
 * `extraTools` are registered alongside, so a host can add its own without this
 * file growing. Specs for extras are required because the model is told what a
 * tool does through its spec.
 */
export function createMvpAgentStack(options: {
	/** Defaults to the real runner. Tests inject a fake. */
	readonly commandRunner?: CommandRunner;
	readonly extraTools?: readonly { readonly tool: AgentTool; readonly spec: ToolSpecLike }[];
}): AgentStack {
	const registry = new ToolRegistry();
	const unregisters: Array<() => void> = [];

	const tools = createMvpTools(options.commandRunner);
	for (const tool of tools) {
		const spec = MVP_TOOL_SPECS.find((candidate) => candidate.name === tool.descriptor.name);
		if (spec === undefined) {
			// Unreachable while the two lists agree; throwing here is better than
			// advertising a tool with no description.
			throw new Error(`No spec declared for tool "${tool.descriptor.name}"`);
		}
		unregisters.push(registry.register(tool, spec));
	}

	for (const extra of options.extraTools ?? []) {
		unregisters.push(registry.register(extra.tool, extra.spec));
	}

	return {
		registry,
		dispose: () => {
			for (const unregister of [...unregisters].reverse()) {
				unregister();
			}
			unregisters.length = 0;
		},
	};
}

/** Structural alias so this file does not re-export the registry's type. */
type ToolSpecLike = Parameters<ToolRegistry['register']>[1];

/**
 * Grants everything.
 *
 * Kept only so a script or a test can be written in one line, and renamed from
 * `allowAllPermissions` to say plainly that it is a gateway and not a policy.
 * It is never a default: a host must pass it explicitly, so "I forgot to
 * configure permissions" cannot silently mean "allow".
 *
 * A desktop host passes a `createCallbackGateway` that opens a dialog instead.
 */
export function allowAllGateway(): PermissionPort {
	return allowAll();
}