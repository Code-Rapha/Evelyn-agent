import * as assert from 'assert';
import { buildRootNodes, buildProvidersSection } from '../../ui/viewModel';
import type { ModelHubUiContext, ProviderCatalog, ProviderSummary } from '../../ui/types';

/**
 * Decision D2: test the view MODEL (pure logic), not the vscode widget.
 * A fake `ProviderCatalog` is all the view model needs.
 */
function createCatalog(summaries: readonly ProviderSummary[]): ProviderCatalog {
	const listeners = new Set<() => void>();
	return {
		list: () => summaries,
		onDidChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function createContext(summaries: readonly ProviderSummary[] = []): ModelHubUiContext {
	return { version: '0.0.1', providers: createCatalog(summaries) };
}

function summary(overrides: Partial<ProviderSummary> & { id: string }): ProviderSummary {
	return {
		name: overrides.id,
		type: 'predefined',
		status: 'configured',
		models: [],
		...overrides,
	};
}

suite('Foundation: UI view model', () => {
	test('renders an explicit empty state when no providers are registered', () => {
		const section = buildProvidersSection(createContext([]));

		assert.strictEqual(section.label, 'Providers');
		assert.strictEqual(section.children?.length, 1);

		const empty = section.children?.[0];
		assert.strictEqual(empty?.kind, 'empty');
		assert.strictEqual(empty?.label, 'No providers registered');
		assert.strictEqual(empty?.command?.command, 'modelhub.addProvider');
	});

	test('omits the provider count description in the empty state', () => {
		const section = buildProvidersSection(createContext([]));
		assert.strictEqual(section.description, undefined);
	});

	test('one provider produces one node and no empty state', () => {
		const section = buildProvidersSection(createContext([summary({ id: 'openrouter' })]));

		assert.strictEqual(section.description, '1 provider');
		assert.strictEqual(section.children?.length, 1);
		assert.strictEqual(section.children?.[0].kind, 'provider');
	});

	test('provider count is pluralized', () => {
		const section = buildProvidersSection(
			createContext([summary({ id: 'a' }), summary({ id: 'b' })]),
		);
		assert.strictEqual(section.description, '2 providers');
	});

	test('provider node description reports status and model count', () => {
		const section = buildProvidersSection(
			createContext([
				summary({
					id: 'groq',
					name: 'Groq',
					status: 'available',
					models: [{ id: 'llama', name: 'Llama' }],
				}),
			]),
		);

		const node = section.children?.[0];
		assert.strictEqual(node?.description, 'available — 1 model');
		assert.strictEqual(node?.icon, 'vm-active');
		assert.strictEqual(node?.collapsible, 'collapsed');
	});

	test('provider without models falls back to the provider type in the description', () => {
		const section = buildProvidersSection(
			createContext([
				summary({ id: 'local', type: 'custom-openai-compatible', status: 'unconfigured' }),
			]),
		);

		assert.strictEqual(section.children?.[0].description, 'not configured — OpenAI-compatible');
	});

	test('a provider with no models renders a "no models" child instead of nothing', () => {
		const section = buildProvidersSection(createContext([summary({ id: 'empty-provider' })]));
		const children = section.children?.[0].children;

		assert.strictEqual(children?.length, 1);
		assert.strictEqual(children?.[0].label, 'No models reported');
		assert.strictEqual(children?.[0].kind, 'empty');
	});

	test('models are listed as children with their id as description', () => {
		const section = buildProvidersSection(
			createContext([
				summary({
					id: 'groq',
					models: [
						{ id: 'llama-3', name: 'Llama 3', contextWindow: 8192 },
						{ id: 'mixtral', name: 'Mixtral' },
					],
				}),
			]),
		);

		const models = section.children?.[0].children;
		assert.strictEqual(models?.length, 2);
		assert.strictEqual(models?.[0].label, 'Llama 3');
		assert.strictEqual(models?.[0].description, 'llama-3');
		assert.ok(models?.[0].tooltip?.includes('8,192'));
		assert.strictEqual(models?.[1].tooltip, 'mixtral');
	});

	test('provider ids produce unique node ids', () => {
		const section = buildProvidersSection(
			createContext([
				summary({ id: 'a', models: [{ id: 'shared', name: 'S' }] }),
				summary({ id: 'b', models: [{ id: 'shared', name: 'S' }] }),
			]),
		);

		const [a, b] = section.children ?? [];
		assert.notStrictEqual(a.children?.[0].id, b.children?.[0].id);
	});

	test('root list contains providers, settings and about in order', () => {
		const roots = buildRootNodes(createContext());

		assert.strictEqual(roots.length, 3);
		assert.deepStrictEqual(
			roots.map((node) => node.kind),
			['section', 'action', 'action'],
		);
		assert.strictEqual(roots[1].command?.command, 'workbench.action.openSettings');
		assert.deepStrictEqual(roots[1].command?.args, ['@ext:modelhub-vscode']);
		assert.strictEqual(roots[2].label, 'About ModelHub');
		assert.strictEqual(roots[2].description, 'v0.0.1');
	});

	test('about node reflects the injected version', () => {
		const roots = buildRootNodes({ version: '9.9.9', providers: createCatalog([]) });
		assert.strictEqual(roots[2].description, 'v9.9.9');
	});
});
