/**
 * Console adapter for the `LogSink` port.
 *
 * The default logging sink for a local installation: writes to stdout/stderr
 * with no host involved. `warn` and `error` go to stderr so a shell can
 * separate them.
 *
 * Formatting is delegated to `formatLogData`, the Core's own helper, so a
 * local run and a VS Code run redact secrets the same way.
 */
import {
	formatLogData,
	type LogEntry,
	type LogLevel,
	type LogSink,
} from '../../core/logging';

/** Where each level is written. */
const STREAMS: Readonly<Record<LogLevel, 'out' | 'err'>> = {
	debug: 'err',
	info: 'out',
	warn: 'err',
	error: 'err',
};

export interface ConsoleLogSinkOptions {
	/** Prefix added to every line. Defaults to the app name. */
	readonly prefix?: string;
	/** Overrides the destination, mainly so tests can capture output. */
	readonly out?: (line: string) => void;
	readonly err?: (line: string) => void;
}

export class ConsoleLogSink implements LogSink {
	private readonly prefix: string;
	private readonly out: (line: string) => void;
	private readonly err: (line: string) => void;

	constructor(options: ConsoleLogSinkOptions = {}) {
		this.prefix = options.prefix ?? '[seshyina]';
		this.out = options.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
		this.err = options.err ?? ((line: string) => void process.stderr.write(`${line}\n`));
	}

	log(entry: LogEntry): void {
		const data =
			entry.data === undefined ? '' : ` ${formatLogData(entry.data)}`;
		const line = `${this.prefix} ${entry.level.toUpperCase()} ${entry.message}${data}`;
		if (STREAMS[entry.level] === 'out') {
			this.out(line);
		} else {
			this.err(line);
		}
	}
}