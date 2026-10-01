import * as vscode from 'vscode';
import { ModelHubApplication } from './core/application';

/**
 * Extension lifecycle:
 *
 * activate()
 *   -> ModelHubApplication.start(context):
 *        initialize configuration -> initialize logging ->
 *        initialize core services -> register commands/providers/views -> ready
 *
 * All disposables (application, output channel, commands) are registered in
 * `context.subscriptions`, so VS Code disposes them automatically.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	await ModelHubApplication.start(context);
}

/**
 * Disposal already happened through `context.subscriptions`; kept as the
 * explicit shutdown hook of the extension lifecycle.
 */
export function deactivate(): void {
	// ModelHubApplication.dispose() is invoked via context.subscriptions.
}
