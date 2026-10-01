/**
 * UI commands for ModelHub.
 *
 * `modelhub.open` focuses the ModelHub view instead of the old QuickPick — the
 * tree view is now the primary surface. Provider add/remove is implemented in
 * `./providerFlow` as pure logic over ports; this module only binds those
 * ports to the real VS Code dialogs, so no decision lives here.
 */
import * as vscode from 'vscode';
import type { LoggingService } from '../core/logging';
import type { ProviderRegistry } from '../providers/registry';
import type { ProviderConfigService } from '../providers/config';
import type { SecretStore } from '../providers/secrets';
import { DisposableCollection } from '../utils';
import { MODELHUB_VIEW_CONTAINER_ID, MODELHUB_VIEW_ID } from './types';
import type { ModelHubTreeProvider } from './treeView';
import { ProviderFlow, type ProviderPromptPort, type ProviderNotifierPort } from './providerFlow';

export const MODELHUB_OPEN_COMMAND = 'modelhub.open';
export const MODELHUB_ADD_PROVIDER_COMMAND = 'modelhub.addProvider';
export const MODELHUB_REMOVE_PROVIDER_COMMAND = 'modelhub.removeProvider';
export const MODELHUB_REFRESH_COMMAND = 'modelhub.refresh';
export const MODELHUB_SHOW_ABOUT_COMMAND = 'modelhub.showAbout';

/**
 * Ownership port back to the application.
 *
 * The command layer registers providers but does not own them: it hands the
 * unregister back so `deactivate` can guarantee teardown, and it asks the
 * application to refresh models so the "list every provider" policy lives in
 * one place.
 */
export interface ProviderLifecycle {
	trackProvider(unregister: () => void): void;
	refreshModels(): Promise<void>;
}

export interface CommandDependencies {
	readonly treeProvider: ModelHubTreeProvider;
	readonly logger: LoggingService;
	readonly version: string;
	readonly secrets: SecretStore;
	readonly config: ProviderConfigService;
	readonly registry: ProviderRegistry;
	readonly lifecycle: ProviderLifecycle;
}

/**
 * Real prompt implementation.
 *
 * `InputBox.ignoreFocusOut` keeps the box open while the user tabs away, and
 * `password: true` masks the key so it is never echoed on screen.
 */
export function createVsCodePrompt(): ProviderPromptPort {
	return {
		async askBaseUrl(defaultValue: string) {
			const value = await vscode.window.showInputBox({
				title: 'Add provider',
				prompt: 'Base URL of an OpenAI-compatible server',
				value: defaultValue,
				ignoreFocusOut: true,
				validateInput: (input) =>
					input.trim().length === 0 ? 'A base URL is required.' : undefined,
			});
			return value === undefined
				? { kind: 'cancelled' as const }
				: { kind: 'accepted' as const, value };
		},

		async askApiKey(providerName: string) {
			const value = await vscode.window.showInputBox({
				title: 'Add provider',
				prompt: `API key for ${providerName} (leave empty for a server without authentication)`,
				password: true,
				ignoreFocusOut: true,
			});
			// An empty box means "no key", which is a valid choice for a local
			// server — so it is reported as skipped, not cancelled.
			return value === undefined || value.length === 0
				? { kind: 'skipped' as const }
				: { kind: 'accepted' as const, value };
		},
	};
}

/** Real notifier implementation. */
export function createVsCodeNotifier(logger: LoggingService): ProviderNotifierPort {
	return {
		info(message: string) {
			logger.info(message);
			void vscode.window.showInformationMessage(message);
		},
		error(message: string) {
			logger.error(message);
			void vscode.window.showErrorMessage(message);
		},
	};
}

/**
 * Pulls the provider id out of the tree node a context-menu action was invoked
 * on. `view/item/context` passes the node, so its id is the only input needed.
 */
export function providerIdFromNode(node: unknown): string | undefined {
	if (typeof node !== 'object' || node === null) {
		return undefined;
	}
	const id = (node as { id?: unknown }).id;
	if (typeof id !== 'string') {
		return undefined;
	}
	const prefix = 'provider::';
	return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

/**
 * Reveals the ModelHub view in the activity bar.
 *
 * `workbench.view.extension.<containerId>` is the documented way to show an
 * activity bar container; focusing the view afterwards puts the cursor in it.
 */
export async function focusModelHubView(): Promise<void> {
	await vscode.commands.executeCommand(
		`workbench.view.extension.${MODELHUB_VIEW_CONTAINER_ID}`,
	);
	await vscode.commands.executeCommand(`${MODELHUB_VIEW_ID}.focus`);
}

export function registerModelHubCommands(deps: CommandDependencies): DisposableCollection {
	const disposables = new DisposableCollection();
	const { treeProvider, logger, version, secrets, config, registry, lifecycle } = deps;

	const flow = new ProviderFlow({
		prompt: createVsCodePrompt(),
		notifier: createVsCodeNotifier(logger),
		secrets,
		config,
		registry,
	});

	disposables.push(
		vscode.commands.registerCommand(MODELHUB_OPEN_COMMAND, async () => {
			try {
				await focusModelHubView();
			} catch (error) {
				logger.error('modelhub.open failed', { error });
			}
		}),

		vscode.commands.registerCommand(MODELHUB_REFRESH_COMMAND, async () => {
			try {
				// The application owns the per-provider error handling and the
				// final tree refresh.
				await lifecycle.refreshModels();
			} catch (error) {
				logger.error('modelhub.refresh failed', { error });
			}
		}),

		vscode.commands.registerCommand(MODELHUB_ADD_PROVIDER_COMMAND, async () => {
			try {
				const outcome = await flow.addProvider();
				if (outcome.ok && outcome.unregister !== undefined) {
					// Ownership goes to the application so deactivate can unregister.
					lifecycle.trackProvider(outcome.unregister);
				}
				treeProvider.refresh();
			} catch (error) {
				logger.error('modelhub.addProvider failed', { error });
				void vscode.window.showErrorMessage(
					'Could not add the provider. See the ModelHub output for details.',
				);
			}
		}),

		vscode.commands.registerCommand(MODELHUB_REMOVE_PROVIDER_COMMAND, async (node?: unknown) => {
			const providerId = providerIdFromNode(node);
			if (providerId === undefined) {
				void vscode.window.showErrorMessage(
					'Select a provider in the ModelHub view to remove it.',
				);
				return;
			}
			try {
				const removed = await flow.removeProvider(providerId);
				if (!removed) {
					void vscode.window.showInformationMessage(
						`Provider "${providerId}" is not registered.`,
					);
					return;
				}
				treeProvider.refresh();
			} catch (error) {
				logger.error('modelhub.removeProvider failed', { error });
				void vscode.window.showErrorMessage(
					'Could not remove the provider. See the ModelHub output for details.',
				);
			}
		}),

		vscode.commands.registerCommand(MODELHUB_SHOW_ABOUT_COMMAND, () => {
			void vscode.window.showInformationMessage(
				`ModelHub v${version} — modular AI development workspace (Phase 1: foundation).`,
			);
		}),
	);

	return disposables;
}
