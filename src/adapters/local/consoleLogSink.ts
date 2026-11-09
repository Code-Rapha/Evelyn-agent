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

/** Um destino já morto, por stream. O erro de pipe é permanente. */
const deadStreams = new WeakSet<object>();

/**
 * Escreve uma linha sem derrubar o app quando a saída não existe mais.
 *
 * O `write` de um stream de processo entrega a falha como **evento** `error`,
 * não como exceção — e sem handler o Node a lança e derruba o processo
 * principal. Foi o que exibiu "A JavaScript error occurred in the main
 * process: EPIPE" ao abrir o app por um shell que soltou o handle do pipe.
 *
 * Perder uma linha de log é aceitável; perder o processo inteiro por causa
 * dela não é. O handler é instalado uma vez, silencia qualquer erro do
 * stream (não há a quem reportá-lo) e marca o destino como morto para não
 * tentar de novo a cada linha.
 */
export function writeToStream(stream: NodeJS.WriteStream, line: string): void {
	if (deadStreams.has(stream)) {
		return;
	}
	if (stream.listenerCount('error') === 0) {
		stream.on('error', () => {
			deadStreams.add(stream);
		});
	}
	try {
		stream.write(`${line}\n`);
	} catch {
		deadStreams.add(stream);
	}
}

export class ConsoleLogSink implements LogSink {
	private readonly prefix: string;
	private readonly out: (line: string) => void;
	private readonly err: (line: string) => void;

	constructor(options: ConsoleLogSinkOptions = {}) {
		this.prefix = options.prefix ?? '[evelyn]';
		this.out = options.out ?? ((line: string) => writeToStream(process.stdout, line));
		this.err = options.err ?? ((line: string) => writeToStream(process.stderr, line));
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
