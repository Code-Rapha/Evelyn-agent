/**
 * The desktop bridge contract.
 *
 * Two things are worth testing here and nothing else:
 *
 * 1. `parseCoreStatus` — it is the only code that decides whether a payload
 *    crossing a process boundary is trustworthy, so its refusals matter more
 *    than its happy path.
 * 2. `readBridge` — the renderer depends on it to survive running outside
 *    Electron, which is the difference between a clear message and a blank
 *    window.
 *
 * Both are pure functions over plain data, so they need neither Electron nor a
 * window. That is deliberate: this suite runs under plain mocha via
 * `npm run test:core`, outside the extension host, and importing `electron`
 * here would fail — the module only resolves inside the runtime.
 */
import * as assert from 'assert';

import {
	APP_NAME,
	BRIDGE_KEY,
	CHAT_EVENT_CHANNEL,
	CONVERSATION_CHANNEL,
	CORE_STATUS_CHANNEL,
	PROVIDER_CHANNEL,
	SEND_MESSAGE_CHANNEL,
	STOP_CHANNEL,
	MODEL_CHANNEL,
	OPEN_SETTINGS_CHANNEL,
	WINDOW_CHANNEL,
	WINDOW_STATE_CHANNEL,
	BridgePayloadError,
	parseChatStreamEvent,
	parseAvailableModels,
	parseCoordinate,
	parseResizeDirection,
	parseWindowState,
	parseConversationId,
	parseConversationListItem,
	parseConversationListItems,
	parseConversationTitle,
	parseConversationView,
	parseCoreStatus,
	parseCreateConversationInput,
	parseProviderId,
	parseProviderSummaries,
	parseProviderSummary,
	parseSaveProviderInput,
	parseSendMessageAck,
	parseSendMessageInput,
	parseSystemPrompt,
	readBridge,
	toDisplayMessage,
	type CoreStatus,
	type SeshyinaBridge,
} from '../desktop/contract';

/** A payload the main process would legitimately send. */
function validPayload(): Record<string, unknown> {
	return {
		appName: APP_NAME,
		version: '0.0.1',
		electronVersion: '44.5.1',
		platform: 'win32',
		services: ['logging', 'provider-registry'],
		providerCount: 0,
		dataDirectory: 'C:\\Users\\rapha\\.modelhub\\seshyina',
	};
}

suite('Desktop: bridge contract', () => {
	test('every channel is namespaced and the global key is explicit', () => {
		// A channel name is a wire contract; a collision with another package
		// would let a page call someone else's handler.
		for (const channel of [
			CORE_STATUS_CHANNEL,
			PROVIDER_CHANNEL,
			SEND_MESSAGE_CHANNEL,
			STOP_CHANNEL,
			CHAT_EVENT_CHANNEL,
		]) {
			assert.match(channel, /^seshyina:[a-z-]+$/);
		}
		assert.strictEqual(BRIDGE_KEY, 'seshyina');
		assert.strictEqual(APP_NAME, 'Seshyina');
	});

	test('a well-formed payload parses', () => {
		const status: CoreStatus = parseCoreStatus(validPayload());

		assert.strictEqual(status.appName, 'Seshyina');
		assert.strictEqual(status.version, '0.0.1');
		assert.deepStrictEqual(status.services, ['logging', 'provider-registry']);
	});

	test('the returned services array is a copy, not the input', () => {
		const payload = validPayload();
		const status = parseCoreStatus(payload);

		(status.services as string[]).push('injected');

		assert.deepStrictEqual(payload.services, ['logging', 'provider-registry']);
		assert.deepStrictEqual(status.services, ['logging', 'provider-registry', 'injected']);
	});

	// A missing field used to reach the UI as `undefined` and read as "the Core
	// is broken" with no explanation, which is worse than an explicit refusal.

	test('every field is required', () => {
		for (const field of [
			'appName',
			'version',
			'electronVersion',
			'platform',
			'services',
			'providerCount',
			'dataDirectory',
		]) {
			const payload = validPayload();
			delete payload[field];
			assert.throws(
				() => parseCoreStatus(payload),
				BridgePayloadError,
				`a payload without "${field}" must be refused`,
			);
		}
	});

	test('empty strings are refused, not passed through', () => {
		for (const field of ['appName', 'version', 'electronVersion', 'platform', 'dataDirectory']) {
			const payload = validPayload();
			payload[field] = '';
			assert.throws(() => parseCoreStatus(payload), BridgePayloadError, `"${field}" must not be blank`);
		}
	});

	test('a non-object payload is refused', () => {
		for (const value of [null, undefined, 42, 'ok', true, [], [1, 2]]) {
			assert.throws(() => parseCoreStatus(value), BridgePayloadError);
		}
	});

	test('services must be an array of strings', () => {
		for (const value of ['logging', {}, [1], [null], null]) {
			const payload = validPayload();
			payload.services = value;
			assert.throws(() => parseCoreStatus(payload), BridgePayloadError);
		}
	});

	test('providerCount must be a non-negative finite number', () => {
		for (const value of [-1, NaN, Infinity, '0', null, {}]) {
			const payload = validPayload();
			payload.providerCount = value;
			assert.throws(() => parseCoreStatus(payload), BridgePayloadError);
		}
	});

	test('an empty services list is valid: a Core with nothing registered is real', () => {
		const payload = validPayload();
		payload.services = [];

		assert.deepStrictEqual(parseCoreStatus(payload).services, []);
	});

	test('the error names the reason rather than failing opaquely', () => {
		const payload = validPayload();
		delete payload.providerCount;

		assert.throws(() => parseCoreStatus(payload), (error: unknown) => {
			assert.ok(error instanceof BridgePayloadError);
			assert.match(error.message, /providerCount/);
			return true;
		});
	});

	// ── readBridge ──────────────────────────────────────────────────────────

	/** A bridge shape with every method the contract declares. */
	function fullBridge(): SeshyinaBridge {
		return {
			getCoreStatus: async () => validPayload() as never,
			listProviders: async () => [],
			listProjects: async () => [],
			createProject: async () => ({}) as never,
			saveProvider: async () => ({}) as never,
			removeProvider: async () => false,
			listModels: async () => [],
			listAvailableModels: async () => [],
			openSettings: async () => true,
			createConversation: async () => ({}) as never,
			listConversations: async () => [],
			openConversation: async () => ({}) as never,
			renameConversation: async () => ({}) as never,
			setSystemPrompt: async () => ({}) as never,
			deleteConversation: async () => false,
			sendMessage: async () => ({ turnId: 't', accepted: true as const }),
			stop: async () => false,
			answerPermission: async () => true,
			onChatEvent: () => () => undefined,
			minimizeWindow: async () => true,
			toggleMaximizeWindow: async () => ({ maximized: false }),
			closeWindow: async () => true,
			startWindowResize: async () => true,
			moveWindowResize: async () => true,
			endWindowResize: async () => true,
			onWindowState: () => () => undefined,
		};
	}

	test('the bridge is found when the preload installed it', () => {
		const bridge = fullBridge();
		const scope = { [BRIDGE_KEY]: bridge };

		assert.strictEqual(readBridge(scope), bridge);
	});

	test('an absent bridge is undefined, so the page can say so', () => {
		assert.strictEqual(readBridge({}), undefined);
		assert.strictEqual(readBridge(undefined), undefined);
		assert.strictEqual(readBridge(null), undefined);
		assert.strictEqual(readBridge('window'), undefined);
	});

	test('a bridge missing a method is not treated as a bridge', () => {
		// A partial object is refused outright: the renderer would otherwise call
		// a method that is not there and get a TypeError with no explanation.
		assert.strictEqual(readBridge({ [BRIDGE_KEY]: {} }), undefined);
		assert.strictEqual(readBridge({ [BRIDGE_KEY]: { getCoreStatus: 'nope' } }), undefined);
		assert.strictEqual(readBridge({ [BRIDGE_KEY]: null }), undefined);

		const partial = fullBridge() as unknown as Record<string, unknown>;
		delete partial.sendMessage;
		assert.strictEqual(readBridge({ [BRIDGE_KEY]: partial }), undefined);
	});

	test('the bridge exposes exactly the declared capability', () => {
		// The security property of the preload: named methods only, no forwarded
		// ipcRenderer. A future capability has to be added here on purpose.
		assert.deepStrictEqual(Object.keys(fullBridge()), [
			'getCoreStatus',
			'listProviders',
			'listProjects',
			'createProject',
			'saveProvider',
			'removeProvider',
			'listModels',
			'listAvailableModels',
			'openSettings',
			'createConversation',
			'listConversations',
			'openConversation',
			'renameConversation',
			'setSystemPrompt',
			'deleteConversation',
			'sendMessage',
			'stop',
			'answerPermission',
			'onChatEvent',
			'minimizeWindow',
			'toggleMaximizeWindow',
			'closeWindow',
			'startWindowResize',
			'moveWindowResize',
			'endWindowResize',
			'onWindowState',
		]);
	});
});

suite('Desktop: inbound payloads', () => {
	test('a provider save needs a base URL', () => {
		assert.throws(() => parseSaveProviderInput({}), /baseUrl must be a non-empty string/);
		assert.throws(() => parseSaveProviderInput({ baseUrl: '   ' }), /baseUrl must be a non-empty string/);
		assert.throws(() => parseSaveProviderInput('nope'), /expects an object/);
	});

	test('a base URL is trimmed and optional fields are dropped when empty', () => {
		const parsed = parseSaveProviderInput({ baseUrl: '  http://x/v1  ', name: '' });

		assert.strictEqual(parsed.baseUrl, 'http://x/v1');
		assert.ok(!('name' in parsed), 'an empty name is omitted rather than stored blank');
		assert.ok(!('apiKey' in parsed), 'an omitted key stays omitted, which means "keep the stored one"');
	});

	test('an api key is accepted as a string and never inspected', () => {
		const parsed = parseSaveProviderInput({ baseUrl: 'http://x/v1', apiKey: '' });

		// Empty is meaningful: it clears the stored key.
		assert.strictEqual(parsed.apiKey, '');
		assert.throws(
			() => parseSaveProviderInput({ baseUrl: 'http://x/v1', apiKey: 42 }),
			/apiKey must be a string/,
		);
	});

	test('a send needs a provider, a conversation, a model and at least one message', () => {
		assert.throws(() => parseSendMessageInput({}), /providerId must be a non-empty string/);
		assert.throws(
			() => parseSendMessageInput({ providerId: 'p', messages: [] }),
			/conversationId must be a non-empty string/,
		);
		assert.throws(
			() => parseSendMessageInput({ providerId: 'p', conversationId: 'c', messages: [] }),
			/model must be a non-empty string/,
		);
		assert.throws(
			() =>
				parseSendMessageInput({ providerId: 'p', conversationId: 'c', model: 'm', messages: [] }),
			/messages must not be empty/,
		);
		assert.throws(
			() =>
				parseSendMessageInput({
					providerId: 'p',
					conversationId: 'c',
					model: 'm',
					messages: 'no',
				}),
			/messages must be an array/,
		);
	});

	test('every persisted role is accepted, system included', () => {
		// `system` used to be refused here, on the grounds that a prompt is
		// assembled per request rather than stored. It is stored now — it is the
		// first message of the conversation the user edits — so refusing it would
		// block the feature rather than protect anything.
		for (const role of ['developer', 'function', '', 42, null]) {
			assert.throws(
				() =>
					parseSendMessageInput({
						providerId: 'p',
						conversationId: 'c',
						model: 'm',
						messages: [{ role, content: 'x' }],
					}),
				/message role must be one of/,
				`role ${JSON.stringify(role)} must be refused`,
			);
		}
		for (const role of ['system', 'user', 'assistant', 'tool']) {
			const parsed = parseSendMessageInput({
				providerId: 'p',
				conversationId: 'c',
				model: 'm',
				messages: [{ role, content: 'x' }],
			});
			assert.strictEqual(parsed.messages[0].role, role);
		}
	});

	test('a message needs string content', () => {
		assert.throws(
			() =>
				parseSendMessageInput({
					providerId: 'p',
					conversationId: 'c',
					model: 'm',
					messages: [{ role: 'user', content: 42 }],
				}),
			/message content must be a string/,
		);
	});

	test('a conversation create needs a provider', () => {
		assert.throws(() => parseCreateConversationInput({}), /providerId must be a non-empty string/);
		assert.throws(
			() => parseCreateConversationInput({ providerId: 'p', title: 42 }),
			/title must be a string/,
		);
		assert.throws(
			() => parseCreateConversationInput({ providerId: 'p', systemPrompt: 42 }),
			/systemPrompt must be a string/,
		);
	});

	test('a project binding survives the bridge, and an invalid one is refused', () => {
		// The regression that cost a whole debugging session: `projectId` was
		// added to the input type without being added to this parser, so it was
		// dropped silently. The conversation then had no workspace and every
		// filesystem tool refused with "needs a workspace", while the type said
		// the field was optional — so nothing complained at compile time.
		const parsed = parseCreateConversationInput({ providerId: 'p', projectId: 'proj-1' });

		assert.strictEqual(parsed.projectId, 'proj-1');
		// Omitted when not sent, so an unbound conversation stays unbound rather
		// than defaulting to some directory.
		assert.ok(
			!('projectId' in parseCreateConversationInput({ providerId: 'p' })),
			'an absent projectId must stay absent',
		);
		for (const bad of ['', 42, null, {}]) {
			assert.throws(
				() => parseCreateConversationInput({ providerId: 'p', projectId: bad }),
				/projectId must be a non-empty string when present/,
				`projectId ${JSON.stringify(bad)} must be refused`,
			);
		}
	});

	test('a blank title is omitted rather than stored blank', () => {
		const parsed = parseCreateConversationInput({ providerId: 'p', title: '   ' });

		assert.ok(!('title' in parsed), 'the default title is the store\'s business');
	});

	test('a blank system prompt is kept, because it means "clear it"', () => {
		const parsed = parseCreateConversationInput({ providerId: 'p', systemPrompt: '' });

		assert.strictEqual(parsed.systemPrompt, '');
	});

	test('conversation ids and titles are validated', () => {
		assert.strictEqual(parseConversationId('c1'), 'c1');
		assert.throws(() => parseConversationId(''), /conversationId must be a non-empty string/);
		assert.throws(() => parseConversationId(42), /conversationId must be a non-empty string/);

		assert.strictEqual(parseConversationTitle('Renamed'), 'Renamed');
		assert.throws(() => parseConversationTitle('   '), /non-empty string/);
	});

	test('a system prompt accepts empty but not a non-string', () => {
		// Unlike a title, empty is meaningful: it removes the prompt.
		assert.strictEqual(parseSystemPrompt(''), '');
		assert.throws(() => parseSystemPrompt(42), /must be a string/);
		assert.throws(() => parseSystemPrompt(undefined), /must be a string/);
	});

	test('a conversation list item is validated field by field', () => {
		const valid = {
			id: 'c1',
			title: 'First',
			providerId: 'p1',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-02T00:00:00.000Z',
			messageCount: 4,
		};
		assert.deepStrictEqual(parseConversationListItem(valid), valid);

		for (const field of ['id', 'title', 'providerId', 'createdAt', 'updatedAt']) {
			assert.throws(
				() => parseConversationListItem({ ...valid, [field]: '' }),
				/non-empty string/,
				`a blank "${field}" must be refused`,
			);
		}
		assert.throws(
			() => parseConversationListItem({ ...valid, messageCount: -1 }),
			/non-negative number/,
		);
	});

	test('a conversation view needs a summary, messages and a prompt', () => {
		const summary = {
			id: 'c1',
			title: 'First',
			providerId: 'p1',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			messageCount: 1,
		};
		const view = parseConversationView({
			summary,
			messages: [{ role: 'system', content: 'be brief' }],
			systemPrompt: 'be brief',
		});

		assert.strictEqual(view.summary.id, 'c1');
		assert.deepStrictEqual(view.messages, [{ role: 'system', content: 'be brief' }]);

		assert.throws(
			() => parseConversationView({ summary, messages: [], systemPrompt: 42 }),
			/systemPrompt must be a string/,
		);
		assert.throws(
			() => parseConversationView({ summary, messages: 'no', systemPrompt: '' }),
			/messages must be an array/,
		);
		assert.throws(
			() => parseConversationView({ messages: [], systemPrompt: '' }),
			/expected a conversation/,
		);
	});
});

suite('Desktop: chat events across the bridge', () => {
	test('each event type round-trips with its own fields', () => {
		assert.deepStrictEqual(parseChatStreamEvent({ type: 'started', turnId: 't1' }), {
			type: 'started',
			turnId: 't1',
		});
		assert.deepStrictEqual(parseChatStreamEvent({ type: 'delta', turnId: 't1', text: 'hi' }), {
			type: 'delta',
			turnId: 't1',
			text: 'hi',
		});
		assert.deepStrictEqual(
			parseChatStreamEvent({
				type: 'done',
				turnId: 't1',
				content: 'hi',
				reason: 'answered',
				toolCalls: 0,
			}),
			{ type: 'done', turnId: 't1', content: 'hi', reason: 'answered', toolCalls: 0 },
		);
		assert.deepStrictEqual(parseChatStreamEvent({ type: 'error', turnId: 't1', message: 'boom' }), {
			type: 'error',
			turnId: 't1',
			message: 'boom',
		});
	});

	test('every event needs a turnId', () => {
		// Without it the renderer cannot tell which message a late delta belongs
		// to, and a stopped turn would write into the next one.
		for (const payload of [
			{ type: 'started' },
			{ type: 'delta', text: 'x' },
			{ type: 'done', content: 'x', reason: 'completed' },
			{ type: 'error', message: 'x' },
			{ type: 'started', turnId: '' },
		]) {
			assert.throws(() => parseChatStreamEvent(payload), /non-empty turnId/);
		}
	});

	test('an unknown event type is refused rather than half-accepted', () => {
		// `toolCall` and `permissionRequested` are real types now, so a *new*
		// unknown name is what must be refused — the point being that the
		// parser never guesses. `permissionRequest` is the near-miss on purpose:
		// a name that only looks plausible must fail like any other.
		assert.throws(
			() => parseChatStreamEvent({ type: 'permissionRequest', turnId: 't1' }),
			/unknown chat event type/,
		);
		assert.throws(() => parseChatStreamEvent({ turnId: 't1' }), /unknown chat event type/);
	});

	test('a delta without text is refused', () => {
		assert.throws(() => parseChatStreamEvent({ type: 'delta', turnId: 't1' }), /needs string text/);
		assert.throws(
			() => parseChatStreamEvent({ type: 'delta', turnId: 't1', text: 42 }),
			/needs string text/,
		);
	});

	test('a done without content or reason is refused', () => {
		assert.throws(
			() => parseChatStreamEvent({ type: 'done', turnId: 't1', reason: 'completed' }),
			/needs string content/,
		);
		assert.throws(
			() => parseChatStreamEvent({ type: 'done', turnId: 't1', content: 'x' }),
			/non-empty reason/,
		);
	});

	test('an error needs a message string, and empty text is still delivered', () => {
		assert.throws(() => parseChatStreamEvent({ type: 'error', turnId: 't1' }), /needs a message/);
		// Empty text parses rather than being dropped: a discarded terminal
		// event would leave the renderer busy forever.
		assert.deepStrictEqual(parseChatStreamEvent({ type: 'error', turnId: 't1', message: '' }), {
			type: 'error',
			turnId: 't1',
			message: '',
		});
	});

	test('an ack needs a turnId and must say it was accepted', () => {
		assert.deepStrictEqual(parseSendMessageAck({ turnId: 't1', accepted: true }), {
			turnId: 't1',
			accepted: true,
		});
		assert.throws(() => parseSendMessageAck({ accepted: true }), /turnId must be a non-empty string/);
		assert.throws(() => parseSendMessageAck({ turnId: 't1' }), /accepted must be true/);
		assert.throws(
			() => parseSendMessageAck({ turnId: 't1', accepted: false }),
			/accepted must be true/,
		);
	});
});

suite('Desktop: window controls across the bridge', () => {
	// The window channel is the one place the renderer can reach straight into
	// the window's geometry, so its inputs are checked as carefully as any other
	// inbound payload.

	test('every one of the eight resize directions is accepted', () => {
		for (const direction of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
			assert.strictEqual(parseResizeDirection(direction), direction);
		}
	});

	test('an unknown direction is refused rather than guessed at', () => {
		// The failure this guards: main hands the value straight to the geometry,
		// where a string that matched no branch would silently resize nothing —
		// or resize the wrong boundary if something treated it as truthy.
		for (const bad of ['northeast', 'N', '', 'nw ', 'dr', 7, null, undefined, {}]) {
			assert.throws(() => parseResizeDirection(bad), BridgePayloadError);
		}
	});

	test('a coordinate must be a finite number', () => {
		assert.strictEqual(parseCoordinate(0), 0);
		assert.strictEqual(parseCoordinate(-12.5), -12.5);

		// `NaN` in the geometry makes every bound `NaN`, and `setBounds` with a
		// `NaN` leaves the window with no usable size — the one failure in this
		// file with no way back.
		for (const bad of [Number.NaN, Infinity, -Infinity, '10', null, undefined, {}]) {
			assert.throws(() => parseCoordinate(bad), BridgePayloadError);
		}
	});

	test('window state needs a boolean maximized flag', () => {
		assert.deepStrictEqual(parseWindowState({ maximized: true }), { maximized: true });
		assert.deepStrictEqual(parseWindowState({ maximized: false }), { maximized: false });

		for (const bad of [{ maximized: 'yes' }, {}, { max: true }, null, undefined, 'true']) {
			assert.throws(() => parseWindowState(bad), BridgePayloadError);
		}
	});

	test('the window channels are distinct from every other channel', () => {
		// A collision would silently route one feature's traffic into another's
		// handler, and the failure would look like an unrelated bug entirely.
		const channels = [
			CORE_STATUS_CHANNEL,
			CHAT_EVENT_CHANNEL,
			CONVERSATION_CHANNEL,
			PROVIDER_CHANNEL,
			MODEL_CHANNEL,
			OPEN_SETTINGS_CHANNEL,
			SEND_MESSAGE_CHANNEL,
			STOP_CHANNEL,
			WINDOW_CHANNEL,
			WINDOW_STATE_CHANNEL,
		];
		assert.strictEqual(new Set(channels).size, channels.length);
	});
});

suite('Desktop: models from every provider', () => {
	test('well-formed entries survive, each keeping its provider', () => {
		const models = parseAvailableModels([
			{ providerId: 'openai', providerName: 'OpenAI', model: 'gpt-4o' },
			{ providerId: 'local', providerName: 'Ollama', model: 'gpt-4o' },
		]);

		// The pair is the point: the same model name from two providers has to
		// stay distinguishable, or the send cannot say which endpoint to use.
		assert.deepStrictEqual(models, [
			{ providerId: 'openai', providerName: 'OpenAI', model: 'gpt-4o' },
			{ providerId: 'local', providerName: 'Ollama', model: 'gpt-4o' },
		]);
	});

	test('a malformed entry is dropped rather than failing the list', () => {
		// These come from third-party `/models` responses. One provider returning
		// something odd must not cost the user every model the others offer.
		const models = parseAvailableModels([
			{ providerId: 'openai', providerName: 'OpenAI', model: 'gpt-4o' },
			{ providerId: '', providerName: 'Broken', model: 'x' },
			{ providerId: 'p', providerName: 'Broken', model: '' },
			{ providerId: 'p', model: 'x' },
			null,
			'nonsense',
			42,
		]);

		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].model, 'gpt-4o');
	});

	test('a non-array is an empty list, not a throw', () => {
		for (const bad of [undefined, null, {}, 'gpt-4o', 7]) {
			assert.deepStrictEqual(parseAvailableModels(bad), []);
		}
	});
});

suite('Desktop: error presentation', () => {
	test("Electron's IPC prefix is stripped so the UI shows the real reason", () => {
		const mangled = new Error(
			"Error invoking remote method 'seshyina:send-message': Error: could not reach the host",
		);

		assert.strictEqual(toDisplayMessage(mangled, 'fallback'), 'could not reach the host');
	});

	test('a plain error message is kept as is', () => {
		assert.strictEqual(toDisplayMessage(new Error('plain problem'), 'fallback'), 'plain problem');
	});

	test('a string error is used', () => {
		assert.strictEqual(toDisplayMessage('stringy problem', 'fallback'), 'stringy problem');
	});

	test("something unusable falls back rather than rendering '[object Object]'", () => {
		for (const value of [null, undefined, 42, {}, [], { message: 42 }, new Error('')]) {
			assert.strictEqual(toDisplayMessage(value, 'fallback'), 'fallback');
		}
	});
});