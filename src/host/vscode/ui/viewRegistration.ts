/**
 * Registers the ModelHub view in the sidebar.
 *
 * Kept separate from `commands.ts` so the view registration and the command
 * registration can be disposed independently.
 */
import * as vscode from 'vscode';
import type { DisposableLike } from '../../../core/utils';
import { DisposableCollection } from '../../../core/utils';
import { MODELHUB_VIEW_ID } from './types';
import type { ModelHubTreeProvider } from './treeView';

export function registerModelHubView(
	treeProvider: ModelHubTreeProvider,
): DisposableCollection {
	const disposables = new DisposableCollection();
	const view = vscode.window.createTreeView(MODELHUB_VIEW_ID, {
		treeDataProvider: treeProvider,
		showCollapseAll: true,
	});
	disposables.push(view, treeProvider as DisposableLike);
	return disposables;
}
