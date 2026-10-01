/**
 * Small, dependency-free utilities shared across ModelHub modules.
 * These must never import `vscode` so they stay unit-testable in isolation.
 */

export interface DisposableLike {
	dispose(): void;
}

/**
 * Collects disposables and disposes them in reverse registration order.
 */
export class DisposableCollection implements DisposableLike {
	private readonly items: DisposableLike[] = [];

	push(...items: readonly DisposableLike[]): void {
		this.items.push(...items);
	}

	get size(): number {
		return this.items.length;
	}

	dispose(): void {
		for (const item of [...this.items].reverse()) {
			item.dispose();
		}
		this.items.length = 0;
	}
}

export type EventListener<T> = (event: T) => void;
export type Unsubscribe = () => void;

/**
 * Minimal typed event emitter, independent from the VS Code API.
 */
export class Emitter<T> implements DisposableLike {
	private readonly listeners = new Set<EventListener<T>>();

	event(listener: EventListener<T>): Unsubscribe {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	fire(event: T): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	dispose(): void {
		this.listeners.clear();
	}
}
