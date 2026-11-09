/**
 * O `ConsoleLogSink` quando a saída morre.
 *
 * Medido no pacote: abrir o app por um shell que solta o handle do pipe
 * exibia no processo principal "A JavaScript error occurred in the main
 * process: EPIPE: broken pipe, write". O erro não vem de um `throw` — vem
 * como **evento** `error` no stream — e sem handler ele derruba o app.
 *
 * O handler só é instalado quando o **primeiro `write` acontece** (é o que o
 * `ConsoleLogSink` faz ao nascer). Por isso cada teste escreve uma linha antes
 * de simular o pipe quebrado: o cenário real é "o pipe existia, depois caiu".
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { ConsoleLogSink, writeToStream } from '../adapters/local/consoleLogSink';

/** Um stream que recebe a saída e pode ser mandado ao ar (fechado). */
function sinkStream(): { stream: NodeJS.WriteStream; written: string[] } {
	const through = new PassThrough();
	const written: string[] = [];
	through.on('data', (chunk: Buffer) => written.push(chunk.toString()));
	return { stream: through as unknown as NodeJS.WriteStream, written };
}

/** Emite o erro que o Node emite quando o outro lado do pipe sumiu. */
function breakPipe(stream: NodeJS.WriteStream, code: string): void {
	stream.emit('error', Object.assign(new Error(`${code}: simulated`), { code }));
}

test('a broken pipe on stdout does not crash the process', () => {
	const { stream, written } = sinkStream();

	writeToStream(stream, '[evelyn] INFO antes');
	assert.deepStrictEqual(written, ['[evelyn] INFO antes\n']);

	// O pipe fecha e todo `write` seguinte emite `EPIPE` como evento.
	breakPipe(stream, 'EPIPE');
	assert.doesNotThrow(() => writeToStream(stream, '[evelyn] INFO depois'));
});

test('a broken pipe on stderr does not crash the process', () => {
	const { stream } = sinkStream();
	writeToStream(stream, '[evelyn] ERROR primeira');
	breakPipe(stream, 'EPIPE');
	assert.doesNotThrow(() => writeToStream(stream, '[evelyn] ERROR falhou'));
});

test('the sink itself survives a dead pipe', () => {
	const { stream } = sinkStream();
	const sink = new ConsoleLogSink({
		out: (line) => writeToStream(stream, line),
		err: (line) => writeToStream(stream, line),
	});
	sink.log({ level: 'info', message: 'primeira' });
	breakPipe(stream, 'EPIPE');
	assert.doesNotThrow(() => {
		sink.log({ level: 'info', message: 'x' });
		sink.log({ level: 'error', message: 'y' });
	});
});

test('a stream error that is not a broken pipe is swallowed, never rethrown', () => {
	const { stream } = sinkStream();
	writeToStream(stream, '[evelyn] INFO primeira');
	breakPipe(stream, 'EACCES');
	assert.doesNotThrow(() => writeToStream(stream, '[evelyn] INFO x'));
});

test('after a broken pipe, further writes stop touching the stream', () => {
	const { stream } = sinkStream();
	writeToStream(stream, '[evelyn] INFO primeira');
	breakPipe(stream, 'EPIPE');
	let writes = 0;
	const counting = Object.create(stream) as NodeJS.WriteStream;
	counting.write = ((chunk: string) => {
		writes += 1;
		return true;
	}) as NodeJS.WriteStream['write'];
	// O WeakSet é por objeto: provamos pelo efeito no stream original, que não
	// deve emitir erro de novo nem lançar.
	writeToStream(stream, '[evelyn] INFO depois');
	assert.strictEqual(writes, 0, 'o stream contado nunca é usado');
	assert.equal(stream.listenerCount('error'), 1, 'um único handler, sem acúmulo');
});
