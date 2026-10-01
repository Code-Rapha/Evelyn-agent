import { Provider, ProviderDescriptor } from '../types';
import { ProviderError } from '../../errors';
import { Emitter } from '../../utils';

/**
 * Registry of model providers. Predefined and custom
 * OpenAI-compatible providers register here through the same interface.
 */
export class ProviderRegistry {
	readonly id = 'provider-registry';

	private readonly providers = new Map<string, Provider>();
	private readonly changeEmitter = new Emitter<void>();

	readonly onDidChangeProviders = (listener: () => void): (() => void) =>
		this.changeEmitter.event(listener);

	register(provider: Provider): () => void {
		const id = provider.descriptor.id;
		if (this.providers.has(id)) {
			throw new ProviderError(`Provider "${id}" is already registered`, {
				details: { providerId: id },
			});
		}
		this.providers.set(id, provider);
		this.changeEmitter.fire();
		return () => {
			this.unregister(id);
		};
	}

	unregister(providerId: string): boolean {
		const removed = this.providers.delete(providerId);
		if (removed) {
			this.changeEmitter.fire();
		}
		return removed;
	}

	get(providerId: string): Provider | undefined {
		return this.providers.get(providerId);
	}

	getRequired(providerId: string): Provider {
		const provider = this.providers.get(providerId);
		if (!provider) {
			throw new ProviderError(`Provider "${providerId}" is not registered`, {
				details: { providerId },
			});
		}
		return provider;
	}

	list(): readonly Provider[] {
		return [...this.providers.values()].sort((a, b) =>
			a.descriptor.name.localeCompare(b.descriptor.name),
		);
	}

	listDescriptors(): readonly ProviderDescriptor[] {
		return this.list().map((provider) => provider.descriptor);
	}

	get size(): number {
		return this.providers.size;
	}

	dispose(): void {
		this.providers.clear();
		this.changeEmitter.dispose();
	}
}
