/**
 * Tool registry: the runtime's view of what tools exist.
 *
 * The runtime never imports a concrete tool. It asks the registry for a name
 * and gets back an `AgentTool`, so adding `read_file` or a future MCP-backed
 * tool is a registration, not a runtime change.
 */
import { ProviderError } from '../errors';
import { Emitter } from '../utils';
import type { AgentTool, ToolDescriptor } from './types';

/** How a tool's arguments are described to the model. */
export interface ToolSpec {
	readonly name: string;
	readonly description: string;
	/** JSON Schema for the arguments, passed through to the model as-is. */
	readonly parameters: Readonly<Record<string, unknown>>;
	readonly riskLevel: ToolDescriptor['riskLevel'];
	readonly category: ToolDescriptor['category'];
}

export class ToolRegistry {
	readonly id = 'tool-registry';

	private readonly tools = new Map<string, AgentTool>();
	private readonly specs = new Map<string, ToolSpec>();
	private readonly changeEmitter = new Emitter<void>();

	readonly onDidChangeTools = (listener: () => void): (() => void) =>
		this.changeEmitter.event(listener);

	/**
	 * Registers a tool. Returns the unregister, so a host can drop it when a
	 * project closes or a plugin unloads.
	 */
	register(tool: AgentTool, spec: ToolSpec): () => void {
		const name = spec.name;
		if (this.tools.has(name)) {
			throw new ProviderError(`Tool "${name}" is already registered`, {
				details: { toolName: name },
			});
		}
		this.tools.set(name, tool);
		this.specs.set(name, spec);
		this.changeEmitter.fire();
		return () => {
			this.unregister(name);
		};
	}

	unregister(name: string): boolean {
		const removed = this.tools.delete(name);
		this.specs.delete(name);
		if (removed) {
			this.changeEmitter.fire();
		}
		return removed;
	}

	get(name: string): AgentTool | undefined {
		return this.tools.get(name);
	}

	/** The spec for a tool, used to build the permission summary. */
	spec(name: string): ToolSpec | undefined {
		return this.specs.get(name);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	/** Every registered tool name, sorted, for a stable prompt order. */
	names(): readonly string[] {
		return [...this.tools.keys()].sort();
	}

	/** Tool descriptions for the model, in registration-name order. */
	listSpecs(): readonly ToolSpec[] {
		return this.names().map((name) => this.specs.get(name) as ToolSpec);
	}

	get size(): number {
		return this.tools.size;
	}

	clear(): void {
		if (this.tools.size === 0) {
			return;
		}
		this.tools.clear();
		this.specs.clear();
		this.changeEmitter.fire();
	}
}