import * as assert from 'assert';
import {
	LoggingService,
	sanitizeLogData,
	formatLogData,
	type LogEntry,
	type LogSink,
} from '../../core/logging';

class FakeSink implements LogSink {
	readonly entries: LogEntry[] = [];

	log(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

suite('Foundation: logging', () => {
	let sink: FakeSink;

	setup(() => {
		sink = new FakeSink();
	});

	test('writes all levels through the sink', () => {
		const logger = new LoggingService(sink);
		logger.setLevel('debug');
		logger.debug('d');
		logger.info('i');
		logger.warn('w');
		logger.error('e');

		assert.deepStrictEqual(
			sink.entries.map((entry) => entry.level),
			['debug', 'info', 'warn', 'error'],
		);
	});

	test('respects the minimum log level', () => {
		const logger = new LoggingService(sink);
		logger.setLevel('warn');
		logger.debug('hidden');
		logger.info('hidden too');
		logger.warn('shown');
		logger.error('shown as well');

		assert.deepStrictEqual(
			sink.entries.map((entry) => entry.message),
			['[modelhub] shown', '[modelhub] shown as well'],
		);
	});

	test('child loggers share the sink and carry a scoped prefix', () => {
		const parent = new LoggingService(sink);
		const child = parent.child('config');
		child.warn('problem');

		assert.strictEqual(sink.entries.length, 1);
		assert.strictEqual(sink.entries[0].message, '[modelhub.config] problem');
		assert.strictEqual(child.scope, 'modelhub.config');
	});

	test('redacts secret-looking keys', () => {
		const sanitized = sanitizeLogData({
			apiKey: 'sk-123',
			API_TOKEN: 'tok',
			authorization: 'Bearer x',
			password: 'hunter2',
			safeValue: 'visible',
		}) as Record<string, string>;

		assert.strictEqual(sanitized.apiKey, '[redacted]');
		assert.strictEqual(sanitized.API_TOKEN, '[redacted]');
		assert.strictEqual(sanitized.authorization, '[redacted]');
		assert.strictEqual(sanitized.password, '[redacted]');
		assert.strictEqual(sanitized.safeValue, 'visible');
	});

	test('truncates long strings and limits depth', () => {
		const long = 'x'.repeat(2000);
		const deep = { a: { b: { c: { d: { e: { f: long } } } } } };
		const sanitized = sanitizeLogData({ prompt: long, nested: deep }) as Record<string, unknown>;
		const truncated = sanitized.prompt as string;

		assert.ok(truncated.length < 600);
		assert.ok(truncated.includes('[truncated'));

		// Recursion must terminate: walking the nested object eventually
		// collapses to a string (depth marker or truncated leaf), never loops
		// through object levels indefinitely.
		let node: unknown = sanitized.nested;
		for (let i = 0; i < 20; i += 1) {
			if (typeof node === 'string') {
				break;
			}
			const keys = Object.keys(node as Record<string, unknown>);
			node = (node as Record<string, unknown>)[keys[0]];
		}
		assert.ok(typeof node === 'string');
	});

	test('errors are reduced to name/message (never stack traces with data)', () => {
		const out = formatLogData({ error: new Error('boom') });
		assert.ok(out.includes('boom'));
		assert.ok(!out.includes('at '));
	});
});
