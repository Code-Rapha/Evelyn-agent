/**
 * Lightweight service lifecycle container.
 *
 * Intentionally NOT a dependency-injection framework: it only tracks services
 * with an `id`, initializes them in registration order and disposes them in
 * reverse order. Future services (ProviderRegistry, PermissionService,
 * MemoryService, ChatService, AgentService, TaskService, UsageService,
 * BackendService, …) should fit into this shape.
 */

export interface ServiceLike {
	readonly id: string;
	initialize?(): void | Promise<void>;
	dispose?(): void;
}

export class ServiceContainer {
	private readonly services = new Map<string, ServiceLike>();
	private initialized = false;

	register(service: ServiceLike): void {
		if (this.services.has(service.id)) {
			throw new Error(`Service "${service.id}" is already registered`);
		}
		this.services.set(service.id, service);
	}

	get<T extends ServiceLike>(id: string): T {
		const service = this.services.get(id);
		if (!service) {
			throw new Error(`Service "${id}" is not registered`);
		}
		return service as T;
	}

	has(id: string): boolean {
		return this.services.has(id);
	}

	get size(): number {
		return this.services.size;
	}

	async initializeAll(): Promise<void> {
		for (const service of this.services.values()) {
			await service.initialize?.();
		}
		this.initialized = true;
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * Disposes services in reverse registration order.
	 */
	disposeAll(): void {
		for (const service of [...this.services.values()].reverse()) {
			service.dispose?.();
		}
		this.services.clear();
		this.initialized = false;
	}
}
