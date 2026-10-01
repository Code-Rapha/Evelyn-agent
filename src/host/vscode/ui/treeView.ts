/**
 * VS Code TreeDataProvider for the ModelHub view.
 *
 * This is the ONLY module under `ui/` that imports `vscode` for rendering. It
 * contains no decisions: it translates `ModelHubTreeNode` (from the pure view
 * model) into `vscode.TreeItem`s and forwards refresh events from the catalog.
 */
import * as vscode from 'vscode';
import type { DisposableLike } from '../../../core/utils';
import { buildRootNodes } from './viewModel';
import type { CollapsibleState, ModelHubTreeNode, ModelHubUiContext } from './types';

const COLLAPSIBLE_STATE: Readonly<Record<CollapsibleState, vscode.TreeItemCollapsibleState>> = {
	none: vscode.TreeItemCollapsibleState.None,
	collapsed: vscode.TreeItemCollapsibleState.Collapsed,
	expanded: vscode.TreeItemCollapsibleState.Expanded,
};

export class ModelHubTreeProvider
	implements vscode.TreeDataProvider<ModelHubTreeNode>, DisposableLike
{
	private readonly changeEmitter = new vscode.EventEmitter<ModelHubTreeNode | undefined>();
	private readonly unsubscribe: () => void;

	readonly onDidChangeTreeData: vscode.Event<ModelHubTreeNode | undefined> =
		this.changeEmitter.event;

	constructor(private readonly context: ModelHubUiContext) {
		// Re-render whenever a provider is registered or unregistered.
		this.unsubscribe = context.providers.onDidChange(() => this.refresh());
	}

	getTreeItem(node: ModelHubTreeNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.label,
			COLLAPSIBLE_STATE[node.collapsible],
		);

		if (node.description) {
			item.description = node.description;
		}
		if (node.tooltip) {
			item.tooltip = node.tooltip;
		}
		if (node.icon) {
			item.iconPath = new vscode.ThemeIcon(node.icon);
		}
		item.contextValue = node.contextValue;
		item.id = node.id;

		if (node.command) {
			item.command = {
				command: node.command.command,
				title: node.command.title,
				arguments: node.command.args ? [...node.command.args] : [],
			};
		}

		return item;
	}

	getChildren(node?: ModelHubTreeNode): ModelHubTreeNode[] {
		if (!node) {
			return buildRootNodes(this.context);
		}
		return [...(node.children ?? [])];
	}

	getParent(node: ModelHubTreeNode): ModelHubTreeNode | undefined {
		// Parents are only needed for `reveal`; the view is small enough that
		// a full scan is cheaper than maintaining an index.
		const stack: ModelHubTreeNode[] = buildRootNodes(this.context);
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) {
				break;
			}
			for (const child of current.children ?? []) {
				if (child.id === node.id) {
					return current;
				}
				stack.push(child);
			}
		}
		return undefined;
	}

	refresh(node?: ModelHubTreeNode): void {
		this.changeEmitter.fire(node);
	}

	dispose(): void {
		this.unsubscribe();
		this.changeEmitter.dispose();
	}
}
