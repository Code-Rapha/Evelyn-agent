/**
 * ModelHub application: owns the extension lifecycle.
 *
 * activate()
 *   → initialize configuration
 *   → initialize logging
 *   → initialize core services
 *   → register commands/providers/views
 *   → ready
 *
 * deactivate()
 *   → unregister every provider this session registered
 *   → dispose resources (reverse order, via context.subscriptions)
 *   → shutdown services
 *
 * The application — not the command layer — owns the provider lifetime. Every
 * `register()` call, whether it came from a restore or from the user adding a
 * provider, is paired with its unregister here so `dispose` can never leave a
 * provider behind.
 */
import * as vscode from 'vscode';
import { ConfigurationService, VsCodeConfigurationReader } from '../config';
import { LoggingService, type LogLevel } from '../../../core/logging';
import { ServiceContainer } from '../../../core/services';
import { DisposableCollection } from '../../../core/utils';
import { ProviderRegistry } from '../../../core/providers/registry';
import { createUiContext } from '../ui/context';
import { ModelHubTreeProvider } from '../ui/treeView';
import { registerModelHubView } from '../ui/viewRegistration';
import { registerModelHubCommands, type ProviderLifecycle } from '../ui/commands';
import { VsCodeSecretStore } from '../storage/vsCodeSecretStore';
import { VsCodeStateStore } from '../storage/vsCodeStateStore';
import { OutputChannelLogSink } from '../logging/vsCodeLogSink';
import { ProviderConfigService } from '../../../core/providers/config';
import type { Provider } from '../../../core/providers/types';

export class ModelHubApplication implements vscode.Disposable {
	private readonly disposables = new DisposableCollection();
	private readonly logger: LoggingService;
	private readonly configuration: ConfigurationService;
	private readonly services = new ServiceContainer();
	private readonly providers = new ProviderRegistry();
	private readonly secrets: VsCodeSecretStore;
	private readonly config: ProviderConfigService;
	private readonly treeProvider: ModelHubTreeProvider;

	/**
	 * One unregister per provider registered this session. Restored and
	 * user-added providers both land here, so teardown is a single loop.
	 */
	private readonly providerUnregisters: Array<() => void> = [];

	private constructor(context: vscode.ExtensionContext) {
		// 1. Logging — backed by a dedicated LogOutputChannel ("ModelHub").
		const channel = vscode.window.createOutputChannel('ModelHub', { log: true });
		this.disposables.push(channel);
		this.logger = new LoggingService(new OutputChannelLogSink(channel));

		// 2. Configuration — centralized abstraction over vscode settings.
		this.configuration = new ConfigurationService(new VsCodeConfigurationReader());

		// 3. Provider storage: keys in the OS keychain, config in globalState.
		this.secrets = new VsCodeSecretStore(context.secrets);
		this.config = new ProviderConfigService(new VsCodeStateStore(context.globalState));

		// 4. Core services (registration order = initialization order).
		this.services.register(this.logger);
		this.services.register(this.configuration);
		this.services.register(this.providers);
		this.services.register(this.config);

		// Apply user-configured log level (modelhub.general.logLevel).
		this.logger.setLevel(
			this.configuration.get<LogLevel>('general', 'logLevel', 'info'),
		);

		// 5. UI — view + commands, both driven by the same injected context.
		const uiContext = createUiContext(this.version(context), this.providers);
		this.treeProvider = new ModelHubTreeProvider(uiContext);
		this.disposables.push(registerModelHubView(this.treeProvider));
		this.disposables.push(
			registerModelHubCommands({
				treeProvider: this.treeProvider,
				logger: this.logger,
				version: uiContext.version,
				secrets: this.secrets,
				config: this.config,
				registry: this.providers,
				lifecycle: this.lifecycle(),
			}),
		);
	}

	/**
	 * The port the command layer uses to hand provider ownership back to the
	 * application. One-directional on purpose: a command must not be able to
	 * unregister a provider the application is still tracking.
	 */
	private lifecycle(): ProviderLifecycle {
		return {
			trackProvider: (unregister: () => void) => {
				this.providerUnregisters.push(unregister);
			},
			refreshModels: () => this.refreshModels(),
		};
	}

	/**
	 * Rebuilds providers from persisted configuration.
	 *
	 * Runs after the services are initialized so the application is fully
	 * built before any provider touches it, and every restored provider is
	 * tracked for teardown.
	 */
	private restorePersistedProviders(): number {
		let restored = 0;
		try {
			this.config.restoreAll(this.secrets, (provider) => {
				const unregister = this.providers.register(provider);
				this.providerUnregisters.push(unregister);
				restored += 1;
				return unregister;
			});
		} catch (error) {
			// A corrupt globalState must not prevent activation.
			this.logger.error('Could not restore persisted providers', { error });
		}
		return restored;
	}

	/**
	 * Asks every registered provider for its models.
	 *
	 * Failures are swallowed per provider — one unreachable server must not
	 * hide the others — and the tree is refreshed once at the end so each
	 * provider's descriptor reflects the outcome of its own call.
	 */
	async refreshModels(): Promise<void> {
		const providers: readonly Provider[] = this.providers.list();
		await Promise.all(
			providers.map(async (provider) => {
				try {
					await provider.listModels();
				} catch (error) {
					this.logger.warn(`Could not list models for "${provider.descriptor.id}"`, {
						error,
					});
				}
			}),
		);
		this.treeProvider.refresh();
	}

	/**
	 * Starts the application and hooks disposal into `context.subscriptions`
	 * so VS Code disposes everything on deactivation.
	 */
	static async start(context: vscode.ExtensionContext): Promise<ModelHubApplication> {
		const application = new ModelHubApplication(context);
		await application.services.initializeAll();
		const restored = application.restorePersistedProviders();
		context.subscriptions.push(application);
		application.logger.info('ModelHub activated', {
			version: application.version(context),
			services: application.services.size,
			restoredProviders: restored,
		});
		return application;
	}

	get providerRegistry(): ProviderRegistry {
		return this.providers;
	}

	/** How many providers this session is tracking for teardown. */
	get trackedProviderCount(): number {
		return this.providerUnregisters.length;
	}

	get log(): LoggingService {
		return this.logger;
	}

	private version(context: vscode.ExtensionContext): string {
		const raw: unknown = context.extension?.packageJSON?.version;
		return typeof raw === 'string' ? raw : '0.0.0';
	}

	/**
	 * Unregisters every provider this session registered, then disposes UI
	 * resources and shuts services down in reverse registration order.
	 */
	dispose(): void {
		this.logger.info('ModelHub deactivating');
		// Providers first: nothing should be able to reach a disposed registry.
		for (const unregister of this.providerUnregisters.splice(0)) {
			try {
				unregister();
			} catch (error) {
				this.logger.error('Failed to unregister a provider during teardown', { error });
			}
		}
		this.services.disposeAll();
		this.disposables.dispose();
	}
}
