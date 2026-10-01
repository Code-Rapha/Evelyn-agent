/**
 * VS Code log sink adapter.
 *
 * Lives under `host/vscode/` because it depends on `vscode.LogOutputChannel`;
 * the Core only knows the `LogSink` port and the formatting helper.
 */
import type * as vscode from 'vscode';
import { formatLogData, type LogEntry, type LogSink } from '../../../core/logging';

/**
 * Sink backed by a VS Code `LogOutputChannel` ("ModelHub" in the Output view).
 * Levels map 1:1 to the channel's built-in log levels.
 */
export class OutputChannelLogSink implements LogSink {
	constructor(private readonly channel: vscode.LogOutputChannel) {}

	log(entry: LogEntry): void {
		const line =
			entry.data === undefined
				? entry.message
				: `${entry.message} ${formatLogData(entry.data)}`;
		try {
			switch (entry.level) {
				case 'debug':
					this.channel.debug(line);
					break;
				case 'info':
					this.channel.info(line);
					break;
				case 'warn':
					this.channel.warn(line);
					break;
				case 'error':
					this.channel.error(line);
					break;
			}
		} catch (error) {
			// Logging must never break the extension: a channel can be closed
			// (e.g. disposed and recreated with the same name by tests or by the
			// workbench). Fall back to the console in that case.
			console.warn(`[seshyina] failed to write to output channel: ${String(error)}`);
			console.log(line);
		}
	}
}