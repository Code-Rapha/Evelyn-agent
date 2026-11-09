/**
 * Seshyina Agent identity tests.
 *
 * The agent's identity is a system message injected at the start of every turn.
 * These tests verify the message shape and the injection guard.
 */
import * as assert from 'assert';
import {
	SESHYINA_AGENT_IDENTITY,
	createSeshyinaAgentSystemMessage,
	hasSeshyinaIdentity,
} from '../core/agent/seshyinaAgent';

test('identity message has correct role and content', () => {
	const msg = createSeshyinaAgentSystemMessage();
	assert.strictEqual(msg.role, 'system');
	assert.strictEqual(msg.content, SESHYINA_AGENT_IDENTITY);
	assert.ok(msg.content.includes('Você é a Evelyn'));
	assert.ok(msg.content.includes('Português brasileiro'));
	assert.ok(msg.content.includes('Precisão técnica'));
});

test('hasSeshyinaIdentity returns true when identity present', () => {
	const messages = [
		{ role: 'system' as const, content: SESHYINA_AGENT_IDENTITY },
		{ role: 'user' as const, content: 'hello' },
	];
	assert.strictEqual(hasSeshyinaIdentity(messages), true);
});

test('hasSeshyinaIdentity returns false when only a different system prompt exists', () => {
	const messages = [
		{ role: 'system' as const, content: 'You are a helpful assistant' },
		{ role: 'user' as const, content: 'hello' },
	];
	assert.strictEqual(hasSeshyinaIdentity(messages), false);
});

test('hasSeshyinaIdentity returns false for empty history', () => {
	assert.strictEqual(hasSeshyinaIdentity([]), false);
});

test('hasSeshyinaIdentity ignores partial match in user message', () => {
	const messages = [
		{ role: 'user' as const, content: 'Você é a Seshyina?' },
	];
	assert.strictEqual(hasSeshyinaIdentity(messages), false);
});