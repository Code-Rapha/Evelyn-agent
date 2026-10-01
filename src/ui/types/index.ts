/**
 * UI boundary types.
 *
 * These types are deliberately free of `vscode` imports so the view model can
 * be unit-tested outside a VS Code host. The TreeDataProvider in `./treeView`
 * is the only place that translates these nodes into real VS Code objects.
 */
import type { ModelInfo, ProviderStatus, ProviderType } from '../../providers/types';

/** Activity bar container id (see `contributes.viewsContainers` in package.json). */
export const MODELHUB_VIEW_CONTAINER_ID = 'modelhub';

/** Sidebar view id (see `contributes.views` in package.json). */
export const MODELHUB_VIEW_ID = 'modelhub.main';

/** Extension id used by the settings search filter. */
export const MODELHUB_EXTENSION_ID = 'modelhub-vscode';

export type ModelHubNodeKind = 'section' | 'provider' | 'model' | 'empty' | 'action';

/** Mirrors `vscode.TreeItemCollapsibleState` without importing vscode. */
export type CollapsibleState = 'none' | 'collapsed' | 'expanded';

export interface CommandRequest {
	readonly command: string;
	readonly title: string;
	readonly args?: readonly unknown[];
}

/**
 * A single node of the ModelHub tree. `contextValue` is what `when` clauses in
 * `contributes.menus` match against, so keep these strings stable.
 */
export interface ModelHubTreeNode {
	readonly id: string;
	readonly kind: ModelHubNodeKind;
	readonly label: string;
	readonly description?: string;
	readonly tooltip?: string;
	/** ThemeIcon id, e.g. `server-environment`. */
	readonly icon?: string;
	readonly contextValue: string;
	readonly collapsible: CollapsibleState;
	readonly command?: CommandRequest;
	readonly children?: readonly ModelHubTreeNode[];
}

/**
 * Provider data flattened for display. Produced by the adapter in
 * `./context`, the only module that touches `ProviderRegistry`.
 */
export interface ProviderSummary {
	readonly id: string;
	readonly name: string;
	readonly type: ProviderType;
	readonly status: ProviderStatus;
	readonly models: readonly ModelInfo[];
}

/**
 * Read-only port over the provider registry. The view model depends on this
 * interface only, which keeps it independent of the registry implementation.
 */
export interface ProviderCatalog {
	list(): readonly ProviderSummary[];
	onDidChange(listener: () => void): () => void;
}

/**
 * Everything the UI needs, assembled once in `ModelHubApplication` and injected
 * into the view model, the tree provider and the commands.
 */
export interface ModelHubUiContext {
	readonly version: string;
	readonly providers: ProviderCatalog;
}
