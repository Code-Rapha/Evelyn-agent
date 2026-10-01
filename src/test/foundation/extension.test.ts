import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	MODELHUB_OPEN_COMMAND,
	MODELHUB_REFRESH_COMMAND,
	MODELHUB_ADD_PROVIDER_COMMAND,
} from '../../host/vscode/ui/commands';

const EXTENSION_ID = 'modelhub-vscode.modelhub-vscode';

/**
 * Extension lifecycle, exercised through the real extension host.
 *
 * The suite activates the installed extension instead of calling `activate()`
 * with a hand-built `ExtensionContext`. That matters: `activationEvents`
 * declares `onCommand:modelhub.open`, so the host activates the extension the
 * first time a test executes that command. Calling `activate()` on top of that
 * registers every command twice and fails with "command already exists" —
 * which is exactly what this suite used to do, intermittently.
 */
suite('Foundation: extension lifecycle', () => {
	suiteSetup(async function () {
		(this as unknown as { timeout: (ms: number) => void }).timeout(15000);
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		if (extension !== undefined) {
			await extension.activate();
		}
	});

	test('activates and registers the ModelHub: Open command', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes(MODELHUB_OPEN_COMMAND));
	});

	test('command is executable without throwing (foundation is wired)', async () => {
		// The command focuses the view; in the test host there is no visible
		// activity bar, so we only verify execution resolves instead of
		// throwing. This call is also what triggers host-side activation.
		await vscode.commands.executeCommand(MODELHUB_OPEN_COMMAND);
	});

	test('registers the refresh command alongside open', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes(MODELHUB_REFRESH_COMMAND));
	});

	test('re-activating an already-active extension is a no-op', async () => {
		// The regression that made this suite flaky: a second activation used to
		// register the same commands twice.
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		if (extension !== undefined) {
			await assert.doesNotReject(async () => {
				await extension.activate();
			});
		}
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes(MODELHUB_ADD_PROVIDER_COMMAND));
	});
});