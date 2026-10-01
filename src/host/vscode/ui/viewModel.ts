/**
 * Pure view model for the ModelHub tree.
 *
 * NO `vscode` import in this file — that is the whole point. Everything here is
 * a pure function of the injected `ModelHubUiContext`, so the layout, labels
 * and empty-state behaviour can be unit-tested without a VS Code host.
 */
import type { ModelHubTreeNode, ModelHubUiContext, ProviderSummary } from './types';

const STATUS_ICON: Readonly<Record<ProviderSummary['status'], string>> = {
	available: 'vm-active',
	configured: 'vm-connect',
	unconfigured: 'vm-outline',
	error: 'error',
	disabled: 'circle-slash',
};

const STATUS_LABEL: Readonly<Record<ProviderSummary['status'], string>> = {
	available: 'available',
	configured: 'configured',
	unconfigured: 'not configured',
	error: 'error',
	disabled: 'disabled',
};

const TYPE_LABEL: Readonly<Record<ProviderSummary['type'], string>> = {
	predefined: 'predefined',
	'custom-openai-compatible': 'OpenAI-compatible',
};

function pluralize(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function buildModelNodes(provider: ProviderSummary): ModelHubTreeNode[] {
	if (provider.models.length === 0) {
		return [
			{
				id: `${provider.id}::no-models`,
				kind: 'empty',
				label: 'No models reported',
				contextValue: 'modelhub.empty',
				collapsible: 'none',
			},
		];
	}
	return provider.models.map((model) => ({
		id: `${provider.id}::model::${model.id}`,
		kind: 'model' as const,
		label: model.name,
		description: model.id,
		tooltip: model.contextWindow
			? `${model.id} — ${model.contextWindow.toLocaleString()} token context window`
			: model.id,
		icon: 'symbol-method',
		contextValue: 'modelhub.model',
		collapsible: 'none' as const,
	}));
}

function buildProviderNode(provider: ProviderSummary): ModelHubTreeNode {
	const description =
		provider.models.length > 0
			? `${STATUS_LABEL[provider.status]} — ${pluralize(provider.models.length, 'model', 'models')}`
			: `${STATUS_LABEL[provider.status]} — ${TYPE_LABEL[provider.type]}`;

	return {
		id: `provider::${provider.id}`,
		kind: 'provider',
		label: provider.name,
		description,
		tooltip: `${provider.name} (${provider.id}) — ${TYPE_LABEL[provider.type]}, ${STATUS_LABEL[provider.status]}`,
		icon: STATUS_ICON[provider.status],
		contextValue: `modelhub.provider.${provider.status}`,
		collapsible: 'collapsed',
		children: buildModelNodes(provider),
	};
}

/**
 * Builds the "Providers" section. With no providers registered (the Phase 2
 * state — no provider implementation exists yet) it renders an explicit empty
 * state instead of a bare, confusing list.
 */
export function buildProvidersSection(context: ModelHubUiContext): ModelHubTreeNode {
	const providers = context.providers.list();

	const children: ModelHubTreeNode[] =
		providers.length > 0
			? providers.map(buildProviderNode)
			: [
					{
						id: 'providers::empty',
						kind: 'empty',
						label: 'No providers registered',
						description: 'Add a provider to list and use AI models',
						contextValue: 'modelhub.empty',
						collapsible: 'none',
						command: {
							command: 'modelhub.addProvider',
							title: 'Add Provider',
						},
					},
				];

	return {
		id: 'section::providers',
		kind: 'section',
		label: 'Providers',
		description: providers.length > 0 ? pluralize(providers.length, 'provider', 'providers') : undefined,
		icon: 'server-environment',
		contextValue: 'modelhub.section',
		collapsible: 'expanded',
		children,
	};
}

export function buildSettingsNode(): ModelHubTreeNode {
	return {
		id: 'action::settings',
		kind: 'action',
		label: 'Settings',
		description: 'modelhub.* namespaces',
		icon: 'settings-gear',
		contextValue: 'modelhub.action',
		collapsible: 'none',
		command: {
			command: 'workbench.action.openSettings',
			title: 'Open ModelHub Settings',
			args: ['@ext:modelhub-vscode'],
		},
	};
}

export function buildAboutNode(context: ModelHubUiContext): ModelHubTreeNode {
	return {
		id: 'action::about',
		kind: 'action',
		label: 'About ModelHub',
		description: `v${context.version}`,
		icon: 'info',
		contextValue: 'modelhub.action',
		collapsible: 'none',
		command: {
			command: 'modelhub.showAbout',
			title: 'About ModelHub',
		},
	};
}

/** The full root list of the ModelHub view. */
export function buildRootNodes(context: ModelHubUiContext): ModelHubTreeNode[] {
	return [buildProvidersSection(context), buildSettingsNode(), buildAboutNode(context)];
}
