import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export interface LogEntry {
	readonly level: LogLevel;
	readonly message: string;
	readonly data?: unknown;
}

export interface LogSink {
	log(entry: LogEntry): void;
}

export interface LoggingOptions {
	readonly scope?: string;
}

/**
 * Keys whose values must never be written to logs.
 */
const SECRET_KEY_PATTERN =
	/(api[-_]?key|apikey|token|secret|password|passwd|authorization|credential|cookie)/i;

const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;

function truncateString(value: string): string {
	return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

/**
 * Removes secrets and truncates large payloads so prompts/responses are not
 * dumped into logs by default.
 */
export function sanitizeLogData(value: unknown, depth = 0): unknown {
	if (value === null || typeof value !== 'object') {
		if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
			return truncateString(value);
		}
		return value;
	}
	if (depth >= MAX_DEPTH) {
		return '[max-depth]';
	}
	if (value instanceof Error) {
		return { name: value.name, message: value.message };
	}
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeLogData(item, depth + 1));
	}
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		result[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeLogData(child, depth + 1);
	}
	return result;
}

/**
 * Central logging service used by all ModelHub modules.
 *
 * - Supports debug/info/warn/error levels.
 * - Redacts secret-looking keys and truncates long values before logging.
 * - Integrates with VS Code through a `LogSink` (default: `LogOutputChannel`),
 *   which keeps the service unit-testable.
 */
export class LoggingService {
	readonly id = 'logging';

	private minLevel: LogLevel = 'info';

	constructor(
		private readonly sink: LogSink,
		private readonly options: LoggingOptions = {},
	) {}

	setLevel(level: LogLevel): void {
		this.minLevel = level;
	}

	get level(): LogLevel {
		return this.minLevel;
	}

	get scope(): string {
		return this.options.scope ?? 'modelhub';
	}

	/**
	 * Creates a namespaced child logger sharing the same sink and settings.
	 */
	child(scope: string): LoggingService {
		return new LoggingService(this.sink, { scope: `${this.scope}.${scope}` });
	}

	debug(message: string, data?: unknown): void {
		this.write('debug', message, data);
	}

	info(message: string, data?: unknown): void {
		this.write('info', message, data);
	}

	warn(message: string, data?: unknown): void {
		this.write('warn', message, data);
	}

	error(message: string, data?: unknown): void {
		this.write('error', message, data);
	}

	private write(level: LogLevel, message: string, data: unknown): void {
		if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
			return;
		}
		this.sink.log({
			level,
			message: `[${this.scope}] ${message}`,
			data: data === undefined ? undefined : sanitizeLogData(data),
		});
	}
}

/**
 * Default sink backed by a VS Code `LogOutputChannel` ("ModelHub" in the
 * Output view). Levels map 1:1 to the channel's built-in log levels.
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
			console.warn(`[modelhub] failed to write to output channel: ${String(error)}`);
			console.log(line);
		}
	}
}

// Kept as a standalone helper so sinks can format data consistently.
export function formatLogData(data: unknown): string {
	try {
		return JSON.stringify(sanitizeLogData(data));
	} catch {
		return '[unserializable]';
	}
}
