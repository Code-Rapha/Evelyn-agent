/**
 * Adapters that connect the pure UI layer to the real services.
 *
 * This is the only module under `ui/` that imports from `providers/` and
 * `core/`. Everything else depends on the interfaces declared in `./types`.
 */
import type { ProviderRegistry } from '../providers/registry';
import type { ProviderCatalog, ProviderSummary, ModelHubUiContext } from './types';
import type { ProviderDescriptor } from '../providers/types';

function toSummary(descriptor: ProviderDescriptor): ProviderSummary {
	return {
		id: descriptor.id,
		name: descriptor.name,
		type: descriptor.type,
		status: descriptor.status,
		models: descriptor.models,
	};
}

/**
 * Exposes the registry as a read-only catalog. The registry's `list()` already
 * sorts by name, so the view model can rely on that ordering.
 */
export function createProviderCatalog(registry: ProviderRegistry): ProviderCatalog {
	return {
		list: () => registry.listDescriptors().map(toSummary),
		onDidChange: (listener) => registry.onDidChangeProviders(listener),
	};
}

export function createUiContext(version: string, registry: ProviderRegistry): ModelHubUiContext {
	return { version, providers: createProviderCatalog(registry) };
}
