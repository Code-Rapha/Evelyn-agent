import * as assert from 'assert';
import {
	DEFAULT_PERMISSION_LEVEL_BY_RISK,
	type PermissionDecision,
	type PermissionRequest,
	type PermissionService,
} from '../../core/permissions/types';
import type { AgentTool, ToolExecutionContext, ToolResult } from '../../core/agent/types';
import { LOCAL_ONLY_SYNC_POLICY } from '../../core/backend/types';
import { STORAGE_ROOT_NAME, type StorageService } from '../../core/storage/types';

suite('Foundation: permission boundary', () => {
	test('maps risk levels to permission levels', () => {
		assert.deepStrictEqual(DEFAULT_PERMISSION_LEVEL_BY_RISK, {
			safe: 'automatic',
			moderate: 'ask',
			dangerous: 'deny',
		});
	});

	test('permission service contract: deny wins and decisions carry the level', async () => {
		const requests: PermissionRequest[] = [];
		const permissionService: PermissionService = {
			evaluate: async (request) => {
				requests.push(request);
				const decision: PermissionDecision =
					request.riskLevel === 'safe'
						? { outcome: 'granted', level: 'automatic' }
						: { outcome: 'denied', level: DEFAULT_PERMISSION_LEVEL_BY_RISK[request.riskLevel] };
				return decision;
			},
		};

		const safe = await permissionService.evaluate({
			toolId: 'fs.read',
			action: 'read',
			riskLevel: 'safe',
			summary: 'Read a file',
		});
		const dangerous = await permissionService.evaluate({
			toolId: 'terminal.execute',
			action: 'executeCommand',
			riskLevel: 'dangerous',
			summary: 'Run a shell command',
		});

		assert.strictEqual(safe.outcome, 'granted');
		assert.strictEqual(dangerous.outcome, 'denied');
		assert.strictEqual(dangerous.level, 'deny');
		assert.strictEqual(requests.length, 2);
	});
});

suite('Foundation: agent boundary', () => {
	test('tools are only executed through the declared contract', async () => {
		const context: ToolExecutionContext = { sessionId: 'session-1' };
		const tool: AgentTool<{ path: string }, string> = {
			descriptor: {
				id: 'fs.read',
				name: 'Read File',
				category: 'filesystem',
				riskLevel: 'safe',
			},
			execute: async (input) => {
				const result: ToolResult<string> = { ok: true, output: `content of ${input.path}` };
				return result;
			},
		};

		const result = await tool.execute({ path: 'a.txt' }, context);
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.output, 'content of a.txt');
		assert.strictEqual(tool.descriptor.riskLevel, 'safe');
	});
});

suite('Foundation: storage & backend boundaries', () => {
	test('storage contract exposes the required operations', () => {
		const calls: string[] = [];
		const storage: StorageService = {
			read: async (path) => {
				calls.push(`read:${path}`);
				return undefined;
			},
			write: async (path) => {
				calls.push(`write:${path}`);
			},
			exists: async () => false,
			list: async () => [],
			createDirectory: async (path) => {
				calls.push(`mkdir:${path}`);
			},
			delete: async () => undefined,
		};

		void storage.read('memory/personal/notes.md');
		void storage.write('rules/main.md', 'content');
		void storage.createDirectory('skills');

		assert.deepStrictEqual(calls, [
			'read:memory/personal/notes.md',
			'write:rules/main.md',
			'mkdir:skills',
		]);
	});

	test('storage root is ~/.modelhub', () => {
		assert.strictEqual(STORAGE_ROOT_NAME, '.modelhub');
	});

	test('personal memory is architecturally excluded from synchronization', () => {
		assert.strictEqual(LOCAL_ONLY_SYNC_POLICY.includePersonalMemory, false);
	});
});
