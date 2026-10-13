/**
 * Proves the Core runs with no VS Code host.
 *
 * Two guards make this meaningful:
 *
 * 1. `assertNotLoadable('vscode')` — the `vscode` module does not exist outside
 *    an extension host. If anything in this file's import graph reached it, the
 *    require would throw and the suite would fail. That is a runtime check, not
 *    a grep.
 * 2. The flow below uses only `core/` modules and `adapters/local/`.
 *
 * IMPORTANT: this suite lives in `src/core-tests/`, not `src/test/`, and runs
 * under plain mocha via `npm run test:core`. It is deliberately outside the
 * `vscode-test` glob: inside an extension host the `vscode` module genuinely
 * resolves, so the first assertion would fail for the wrong reason. Keeping
 * it out of that glob is also what makes it prove anything — it is the only
 * way to show the Core working with no host at all.
 */
import * as assert from 'assert';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService, type PersistedProviderConfig } from '../core/providers/config';
import { ProviderRegistry } from '../core/providers/registry';
import { OpenAICompatibleProvider, type FetchLike } from '../core/providers/openaiCompatible';
import { providerApiKeyRef } from '../core/providers/secrets';
import { LoggingService } from '../core/logging';
import { StorageError } from '../core/errors';

import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';

const BASE_URL = 'https://core-only.example.test/v1';
const SECRET = 'sk-core-only-secret';

/** `vscode` is not resolvable outside an extension host; prove it. */
function assertNotLoadable(moduleName: string): void {
	try {
		require(moduleName);
	} catch (error) {
		const code = (error as { code?: string }).code;
		assert.strictEqual(
			code,
			'MODULE_NOT_FOUND',
			`expected "${moduleName}" to be unresolvable outside a host, got: ${String(error)}`,
		);
		return;
	}
	assert.fail(`"${moduleName}" resolved, so this suite is running inside an extension host`);
}

suite('Core: runs without VS Code', () => {
	let workDir: string;

	setup(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'seshyina-core-'));
	});

	teardown(async () => {
		await rm(workDir, { recursive: true, force: true });
	});

	test('the vscode module is not loadable in this environment', () => {
		assertNotLoadable('vscode');
	});

	test('a provider can be configured, listed and discovered with local adapters', async () => {
		const secrets = new FileSecretStore({ filePath: join(workDir, 'secrets.json') });
		const state = new FileStateStore({ filePath: join(workDir, 'state.json') });
		const config = new ProviderConfigService(state);
		const registry = new ProviderRegistry();

		// The API key goes to the secret store, by reference only.
		await secrets.store(providerApiKeyRef('test'), SECRET);

		const stored: PersistedProviderConfig = {
			id: 'test',
			name: 'Core Only',
			baseUrl: BASE_URL,
			apiKeyRef: providerApiKeyRef('test'),
			enabled: true,
		};
		await config.save(stored);

		// Config is readable back through the Core's own service.
		assert.strictEqual(config.get('test')?.baseUrl, BASE_URL);
		assert.strictEqual(config.list().length, 1);

		// The provider is built by the Core and registered.
		const provider = new OpenAICompatibleProvider({
			id: stored.id,
			name: stored.name,
			baseUrl: stored.baseUrl,
			apiKeyRef: stored.apiKeyRef,
			secrets,
			fetch: async () => ({
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ data: [{ id: 'model-a' }] }),
			}),
		});
		registry.register(provider);

		assert.strictEqual(registry.size, 1);
		const models = await provider.listModels();
		assert.deepStrictEqual(
			models.map((model) => model.id),
			['model-a'],
		);
		assert.strictEqual(provider.descriptor.status, 'available');
	});

	test('the API key never reaches the state file on disk', async () => {
		const secretsPath = join(workDir, 'secrets.json');
		const statePath = join(workDir, 'state.json');
		const secrets = new FileSecretStore({ filePath: secretsPath });
		const config = new ProviderConfigService(new FileStateStore({ filePath: statePath }));

		await secrets.store(providerApiKeyRef('test'), SECRET);
		await config.save({
			id: 'test',
			name: 'Core Only',
			baseUrl: BASE_URL,
			apiKeyRef: providerApiKeyRef('test'),
			enabled: true,
		});

		const stateContents = await readFile(statePath, 'utf8');
		assert.ok(!stateContents.includes(SECRET), 'the state file must not contain the key');
		// It does contain the reference, which is the whole point.
		assert.ok(stateContents.includes(providerApiKeyRef('test')));
	});

	test('config and secrets survive a restart: new instances read the same files', async () => {
		const secretsPath = join(workDir, 'secrets.json');
		const statePath = join(workDir, 'state.json');

		// First process.
		const firstSecrets = new FileSecretStore({ filePath: secretsPath });
		const firstConfig = new ProviderConfigService(new FileStateStore({ filePath: statePath }));
		await firstSecrets.store(providerApiKeyRef('test'), SECRET);
		await firstConfig.save({
			id: 'test',
			name: 'Core Only',
			baseUrl: BASE_URL,
			apiKeyRef: providerApiKeyRef('test'),
			enabled: true,
		});

		// Second process: fresh objects, same paths.
		const secondSecrets = new FileSecretStore({ filePath: secretsPath });
		const secondConfig = new ProviderConfigService(new FileStateStore({ filePath: statePath }));

		assert.strictEqual(await secondSecrets.get(providerApiKeyRef('test')), SECRET);
		assert.strictEqual(secondConfig.get('test')?.baseUrl, BASE_URL);
	});

	test('restoreAll rebuilds providers from the local state file', async () => {
		const statePath = join(workDir, 'state.json');
		const secretsPath = join(workDir, 'secrets.json');
		const config = new ProviderConfigService(new FileStateStore({ filePath: statePath }));
		const secrets = new FileSecretStore({ filePath: secretsPath });

		await config.save({
			id: 'test',
			name: 'Core Only',
			baseUrl: BASE_URL,
			apiKeyRef: providerApiKeyRef('test'),
			enabled: true,
		});

		// Fresh registry, same state file.
		const registry = new ProviderRegistry();
		const restored = config.restoreAll(secrets, (provider) => registry.register(provider));

		assert.strictEqual(restored.length, 1);
		assert.strictEqual(registry.size, 1);
		assert.strictEqual(
			registry.get('test')?.descriptor.configuration.baseUrl,
			BASE_URL,
		);
		// No key was stored, so the provider starts unconfigured.
		assert.strictEqual(registry.get('test')?.descriptor.status, 'unconfigured');
	});

	test('a keyless provider round-trips and sends no authorization header', async () => {
		const secretsPath = join(workDir, 'secrets.json');
		const statePath = join(workDir, 'state.json');
		const secrets = new FileSecretStore({ filePath: secretsPath });
		const config = new ProviderConfigService(new FileStateStore({ filePath: statePath }));

		await config.save({
			id: 'local',
			name: 'local',
			baseUrl: 'http://127.0.0.1:11434/v1',
			enabled: true,
		});

		const registry = new ProviderRegistry();
		const restored = config.restoreAll(secrets, (provider) => registry.register(provider));
		assert.strictEqual(restored.length, 1);

		const seen: Array<Record<string, string>> = [];
		const fetch: FetchLike = async (_url, init) => {
			seen.push(init?.headers ?? {});
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
		};
		const provider = new OpenAICompatibleProvider({
			id: 'local',
			name: 'local',
			baseUrl: 'http://127.0.0.1:11434/v1',
			secrets,
			fetch,
		});

		await provider.listModels();

		assert.strictEqual(seen.length, 1);
		assert.ok(!('authorization' in seen[0]));
	});

	test('concurrent state updates leave one complete, parseable file', async () => {
		const statePath = join(workDir, 'state.json');
		const state = new FileStateStore({ filePath: statePath });

		await Promise.all(
			Array.from({ length: 20 }, (_, index) => state.update(`k${index}`, index)),
		);
		// Its snapshot is taken after every concurrent update has mutated the
		// cache, so this write is the one guaranteed to carry all twenty keys —
		// and it can only be complete if no writer ever truncates the file
		// another one is writing into.
		await state.update('final', true);

		const parsed = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
		for (let index = 0; index < 20; index += 1) {
			assert.strictEqual(parsed[`k${index}`], index, `k${index} survived`);
		}
		assert.strictEqual(parsed.final, true);
		assert.deepStrictEqual(
			(await readdir(workDir)).filter((entry) => entry.endsWith('.tmp')),
			[],
		);
	});

	test('a failed swap leaves the destination untouched and no temp behind', async () => {
		const statePath = join(workDir, 'state.json');
		// A directory cannot be replaced by a file, so the final `rename` fails
		// after the temp has been written — the exact moment cleanup matters.
		await mkdir(statePath, { recursive: true });
		const state = new FileStateStore({ filePath: statePath });

		await assert.rejects(() => state.update('k', 1), StorageError);

		assert.strictEqual(
			(await stat(statePath)).isDirectory(),
			true,
			'the destination is untouched',
		);
		assert.deepStrictEqual(
			(await readdir(workDir)).filter((entry) => entry.endsWith('.tmp')),
			[],
			'the temp is cleaned up, not left on disk',
		);
	});

	test('concurrent secret writes serialize into one valid file', async () => {
		const secretsPath = join(workDir, 'secrets.json');
		const secrets = new FileSecretStore({ filePath: secretsPath });
		// Load the cache once, before racing: the test is about the writes.
		await secrets.store('seed', 'first');

		await Promise.all(
			Array.from({ length: 5 }, (_, index) => secrets.store(`ref${index}`, `value${index}`)),
		);

		const parsed = JSON.parse(await readFile(secretsPath, 'utf8')) as Record<string, string>;
		assert.strictEqual(Object.keys(parsed).length, 6, 'no write is lost');
		assert.strictEqual(parsed.ref3, 'value3');
		assert.deepStrictEqual(
			(await readdir(workDir)).filter((entry) => entry.endsWith('.tmp')),
			[],
		);
	});

	test('the secrets file is created with owner-only permissions', async function () {
		if (process.platform === 'win32') {
			// Windows maps the mode onto the user's ACL; assert it differently.
			this.skip();
			return;
		}
		const secretsPath = join(workDir, 'secrets.json');
		const secrets = new FileSecretStore({ filePath: secretsPath });
		await secrets.store(providerApiKeyRef('test'), SECRET);

		const { stat } = await import('node:fs/promises');
		const info = await stat(secretsPath);
		assert.strictEqual(info.mode & 0o777, 0o600);
	});

	test('a missing secrets file reads as an empty store, not an error', async () => {
		const secrets = new FileSecretStore({
			filePath: join(workDir, 'nested', 'does-not-exist.json'),
		});

		assert.strictEqual(await secrets.get('anything'), undefined);
		assert.strictEqual(await secrets.has('anything'), false);
	});

	test('the store creates missing parent directories on write', async () => {
		const secretsPath = join(workDir, 'deep', 'nested', 'secrets.json');
		const secrets = new FileSecretStore({ filePath: secretsPath });

		await secrets.store('ref', 'value');

		assert.ok(existsSync(secretsPath));
		assert.strictEqual(await secrets.get('ref'), 'value');
	});

	test('deleting an absent reference does not create the file', async () => {
		const secretsPath = join(workDir, 'secrets.json');
		const secrets = new FileSecretStore({ filePath: secretsPath });

		await secrets.delete('never-stored');

		assert.ok(!existsSync(secretsPath), 'a no-op delete must not write');
	});

	test('a corrupt secrets file raises a StorageError rather than silent data loss', async () => {
		const secretsPath = join(workDir, 'secrets.json');
		await mkdir(workDir, { recursive: true });
		await writeFile(secretsPath, '{ not json', 'utf8');

		const secrets = new FileSecretStore({ filePath: secretsPath });

		await assert.rejects(() => secrets.get('ref'), StorageError);
	});

	test('a corrupt state file degrades to empty rather than failing to start', async () => {
		const statePath = join(workDir, 'state.json');
		await writeFile(statePath, 'not json at all', 'utf8');

		const config = new ProviderConfigService(new FileStateStore({ filePath: statePath }));

		assert.deepStrictEqual(config.list(), []);
	});

	test('deleting a secret removes it from disk', async () => {
		const secretsPath = join(workDir, 'secrets.json');
		const secrets = new FileSecretStore({ filePath: secretsPath });
		await secrets.store(providerApiKeyRef('test'), SECRET);

		await secrets.delete(providerApiKeyRef('test'));

		assert.strictEqual(await secrets.get(providerApiKeyRef('test')), undefined);
		const contents = await readFile(secretsPath, 'utf8');
		assert.ok(!contents.includes(SECRET));
	});

	test('the console sink writes through LoggingService and redacts secrets', () => {
		const lines: string[] = [];
		const errors: string[] = [];
		const sink = new ConsoleLogSink({
			out: (line) => lines.push(line),
			err: (line) => errors.push(line),
		});
		const logger = new LoggingService(sink, { scope: 'seshyina.test' });

		logger.info('hello', { apiKey: 'sk-should-not-appear' });
		logger.error('boom');

		assert.strictEqual(lines.length, 1);
		assert.match(lines[0], /seshyina\.test/);
		assert.ok(!lines[0].includes('sk-should-not-appear'), 'the sink must not leak secrets');
		assert.ok(errors.some((line) => line.includes('boom')), 'errors go to stderr');
	});

	test('the console sink respects the log level set on the service', () => {
		const lines: string[] = [];
		const sink = new ConsoleLogSink({ out: (line) => lines.push(line), err: () => undefined });
		const logger = new LoggingService(sink);

		logger.setLevel('warn');
		logger.info('suppressed');
		logger.warn('kept');

		assert.strictEqual(lines.length, 0);
	});
});