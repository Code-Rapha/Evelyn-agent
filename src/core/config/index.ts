/**
 * Central configuration abstraction for ModelHub.
 *
 * Future modules must depend on `ConfigurationService`, never on
 * `vscode.workspace.getConfiguration` directly. The `ConfigurationReader`
 * interface keeps the service unit-testable and allows a different backend
 * later (e.g. remote settings sync).
 *
 * Secrets (API keys, tokens) must NEVER be stored here — they belong in
 * VS Code's `SecretStorage`.
 */
import { ConfigurationError } from '../errors';
import * as vscode from 'vscode';

export const CONFIG_SECTION = 'modelhub';

export const CONFIGURATION_NAMESPACES = [
	'general',
	'providers',
	'agent',
	'permissions',
	'memory',
	'backend',
	'terminal',
	'recovery',
] as const;

export type ConfigurationNamespace = (typeof CONFIGURATION_NAMESPACES)[number];

export function isConfigurationNamespace(value: string): value is ConfigurationNamespace {
	return (CONFIGURATION_NAMESPACES as readonly string[]).includes(value);
}

export interface ConfigurationReader {
	get<T>(namespace: ConfigurationNamespace, key: string, defaultValue?: T): T | undefined;
}

export class VsCodeConfigurationReader implements ConfigurationReader {
	get<T>(namespace: ConfigurationNamespace, key: string, defaultValue?: T): T | undefined {
		const configuration = vscode.workspace.getConfiguration(`${CONFIG_SECTION}.${namespace}`);
		return defaultValue === undefined
			? configuration.get<T>(key)
			: configuration.get<T>(key, defaultValue);
	}
}

export class ConfigurationService {
	readonly id = 'configuration';

	constructor(private readonly reader: ConfigurationReader) {}

	get<T>(namespace: ConfigurationNamespace, key: string, defaultValue: T): T;
	get<T>(namespace: ConfigurationNamespace, key: string): T | undefined;
	get<T>(namespace: ConfigurationNamespace, key: string, defaultValue?: T): T | undefined {
		if (!isConfigurationNamespace(namespace)) {
			throw new ConfigurationError(`Unknown configuration namespace "${namespace}"`, {
				details: { namespace, key, allowed: CONFIGURATION_NAMESPACES },
			});
		}
		return this.reader.get<T>(namespace, key, defaultValue);
	}

	section(namespace: ConfigurationNamespace): string {
		return `${CONFIG_SECTION}.${namespace}`;
	}
}
