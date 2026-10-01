/**
 * VS Code state store adapter.
 *
 * Lives under `host/vscode/` because it depends on `vscode.Memento`; the Core
 * only knows the `StateStore` port.
 */
import type * as vscode from 'vscode';
import type { StateStore } from '../../../core/providers/config';

/** `StateStore` over VS Code's `ExtensionContext.globalState`. */
export class VsCodeStateStore implements StateStore {
	constructor(private readonly memento: vscode.Memento) {}

	get<T>(key: string, defaultValue: T): T {
		return this.memento.get<T>(key, defaultValue);
	}

	async update(key: string, value: unknown): Promise<void> {
		await this.memento.update(key, value);
	}
}