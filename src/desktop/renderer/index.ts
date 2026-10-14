/**
 * The renderer: provider setup, conversations and the chat.
 *
 * Plain DOM, no framework. The state is small — selected provider, selected
 * model, selected conversation, the transcript, and whether a turn is running —
 * and a framework would add more code than it removes at this size.
 *
 * The renderer has no Node and no Electron. Everything it knows about the Core
 * arrives through the preload bridge, and when that bridge is missing it says so
 * instead of failing silently, which is what keeps the page usable when opened
 * in a plain browser.
 *
 * Three rules shape the rest:
 *
 * - Text goes in as `textContent`, never `innerHTML`. Every value arrives from
 *   another process, and text is the only way to put it on screen without giving
 *   it a chance to become markup.
 * - The turn id decides what a stream event may touch. A delta from a turn the
 *   user already stopped is ignored rather than appended to whatever is on
 *   screen now.
 * - Switching conversations is refused while a turn is running. The alternative
 *   is a delta landing in a transcript the user has already left.
 */
import {
	readBridge,
	toDisplayMessage,
	type ChatRole,
	type ChatStreamEvent,
	type AvailableModel,
	type ConversationListItem,
	type ConversationView,
	type PermissionPrompt,
	type ProjectListItem,
	type ProviderSummary,
	type ResizeDirection,
	type SeshyinaBridge,
} from '../contract';

/**
 * A message as the UI holds it while the turn is running.
 *
 * `tool` and `toolError` are display-only roles: both are real stored `tool`
 * messages, but the UI shows a failure differently from a success, and losing
 * that distinction would make a denied or failed tool look like a success.
 */
interface UiMessage {
	role: ChatRole | 'error' | 'toolError';
	content: string;
	/** The tool's name, for a `tool` bubble's label. */
	toolName?: string;
	/**
	 * The call this bubble belongs to. Matched against `toolResult.callId` so
	 * two calls of the same tool in one round land on their own bubbles instead
	 * of both collapsing onto the last one named.
	 */
	toolCallId?: string;
}

function byId<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (element === null) {
		throw new Error(`The page is missing #${id}`);
	}
	return element as T;
}

/** The state a re-render reads. Kept in one place so no update is half-applied. */
interface State {
	bridge: SeshyinaBridge | undefined;
	/** The configured providers. Kept for the settings window and the labels. */
	providers: readonly ProviderSummary[];
	/**
	 * Every model from every enabled provider, each tagged with its provider.
	 *
	 * Cross-provider on purpose: the sidebar picks a model, not a provider, and
	 * the provider follows from the choice rather than being made first.
	 */
	availableModels: readonly AvailableModel[];
	selectedProviderId: string;
	selectedModel: string;
	conversations: readonly ConversationListItem[];
	projects: readonly ProjectListItem[];
	/** The project new conversations are bound to, and the tools' workspace. */
	selectedProjectId: string;
	selectedConversationId: string;
	/** The transcript on screen, minus the streaming bubble. */
	messages: UiMessage[];
	/** The turn currently streaming, if any. */
	activeTurnId: string | undefined;
	/**
	 * The permission request waiting for an answer, if any.
	 *
	 * Kept in the state rather than read back out of the card: the answer
	 * needs the prompt's id, and the card only holds what is displayed.
	 */
	openPermission: PermissionPrompt | undefined;
	/** Whether a provider has been chosen, so the panel folds only on the change. */
	hadProvider: boolean;
	/** Whether a project has been chosen, so the panel folds only on the change. */
	hadProject: boolean;
	/**
	 * The reasoning text of the turn in flight.
	 *
	 * Separate from `messages` because it is never part of the transcript: a
	 * reasoning model thinks for a while before its first visible token, and
	 * without somewhere to put that, a healthy turn renders as an empty screen.
	 */
	reasoning: string;
}

const state: State = {
	bridge: undefined,
	providers: [],
	selectedProviderId: '',
	availableModels: [],
	selectedModel: '',
	conversations: [],
	projects: [],
	selectedProjectId: '',
	selectedConversationId: '',
	messages: [],
	activeTurnId: undefined,
	openPermission: undefined,
	hadProvider: false,
	hadProject: false,
	reasoning: '',
};

// ── small view helpers ──────────────────────────────────────────────────────

function setHidden(element: HTMLElement, hidden: boolean): void {
	element.hidden = hidden;
}

function showError(element: HTMLElement, message: string): void {
	element.textContent = message;
	setHidden(element, false);
}

function clearError(element: HTMLElement): void {
	element.textContent = '';
	setHidden(element, true);
}

/** Reports an error the user can act on, without losing what they typed. */
function report(error: unknown, element: HTMLElement, fallback: string): void {
	showError(element, toDisplayMessage(error, fallback));
}

function currentProvider(): ProviderSummary | undefined {
	return state.providers.find((provider) => provider.id === state.selectedProviderId);
}

function currentConversation(): ConversationListItem | undefined {
	return state.conversations.find((item) => item.id === state.selectedConversationId);
}

/** True when the composer has everything it needs to send. */
function canSend(): boolean {
	return (
		state.bridge !== undefined &&
		state.activeTurnId === undefined &&
		state.selectedConversationId.length > 0 &&
		state.selectedModel.length > 0
	);
}

/** True while a turn is streaming, which blocks conversation switching. */
function isBusy(): boolean {
	return state.activeTurnId !== undefined;
}

// ── rendering ───────────────────────────────────────────────────────────────

function renderProviderList(): void {
	const select = byId<HTMLSelectElement>('provider-select');
	// Locked while a turn streams: switching providers mid-turn zeroes the
	// models and transcript while the old turn's events keep arriving, and
	// they would land on whatever conversation the new provider opens.
	select.disabled = isBusy();
	select.textContent = '';

	if (state.providers.length === 0) {
		const option = document.createElement('option');
		option.value = '';
		option.textContent = 'no provider yet';
		select.append(option);
	} else {
		for (const provider of state.providers) {
			const option = document.createElement('option');
			option.value = provider.id;
			// The key is never readable from here, only whether one exists.
			const key = provider.hasApiKeyRef ? ' · key stored' : '';
			option.textContent = `${provider.name} (${provider.status})${key}`;
			select.append(option);
		}
	}
	select.value = state.selectedProviderId;
}

function renderProviderForm(): void {
	const provider = currentProvider();
	const key = byId<HTMLInputElement>('provider-api-key');

	byId<HTMLInputElement>('provider-base-url').value = provider?.baseUrl ?? '';
	byId<HTMLInputElement>('provider-name').value = provider?.name ?? '';
	// Never pre-filled: the renderer cannot read a key, and a masked placeholder
	// that looks like one would suggest it can.
	key.value = '';
	key.placeholder = provider?.hasApiKeyRef
		? 'a key is stored — blank keeps it'
		: 'no key stored yet';

	// Locked while a turn streams, for the same reason as the select: saving
	// or removing the provider under a running turn would swap the endpoint
	// its events are arriving from.
	byId<HTMLButtonElement>('provider-remove').disabled =
		provider === undefined || isBusy();
	byId<HTMLButtonElement>('provider-save').disabled = isBusy();

	// The collapsed summary has to name the provider, or a collapsed panel would
	// hide which one is in use.
	const current = byId('provider-current');
	current.textContent =
		provider === undefined
			? 'none configured'
			: `${provider.name}${provider.hasApiKeyRef ? ' · key stored' : ''}`;

	// The panel opens itself while there is nothing configured — that is when
	// it has to be used — and folds away once the first provider appears, which
	// is what gives the conversation list the room.
	//
	// After that it is left alone on purpose: `render` runs on every stream
	// delta, and forcing `open` here would collapse the form under the user's
	// fingers while they were typing in it.
	const panel = byId<HTMLDetailsElement>('provider-panel');
	if (state.hadProvider !== (provider !== undefined)) {
		state.hadProvider = provider !== undefined;
		panel.open = provider === undefined;
	}
}

/**
 * The model picker, drawn from every provider at once.
 *
 * Each option is valued by its index rather than by an encoded
 * `providerId model` pair. `state.availableModels` is right here and is the
 * same list these options were built from, so an index identifies an entry
 * exactly. A joined string would need a delimiter that neither side can be
 * trusted to avoid: a provider id is derived from a base URL, and a model
 * name is whatever the server chose to call it.
 *
 * The provider name is in the label because the pair has to be readable, not
 * just recoverable: two providers can both serve `gpt-4o`, and without the
 * label the user cannot tell which entry would answer.
 */
function renderModelList(): void {
	const select = byId<HTMLSelectElement>('model-select');
	// (`model-refresh` is deliberately not touched here: `loadModels` owns its
	// disabled state while a request is in flight, and a render during that
	// window would re-enable it for a second click.)
	select.disabled = isBusy();
	select.textContent = '';

	if (state.availableModels.length === 0) {
		const option = document.createElement('option');
		option.value = '';
		option.textContent = 'no models loaded';
		select.append(option);
	} else {
		state.availableModels.forEach((entry, index) => {
			const option = document.createElement('option');
			option.value = String(index);
			option.textContent = `${entry.model} · ${entry.providerName}`;
			select.append(option);
		});
	}
	select.value = String(
		state.availableModels.findIndex(
			(entry) =>
				entry.model === state.selectedModel &&
				entry.providerId === state.selectedProviderId,
		),
	);

	// The collapsed summary names the model, so the choice is readable without
	// opening the panel. With the provider too, since the label is what makes
	// two same-named models tellable apart.
	const current = byId<HTMLElement>('model-current');
	const chosen = state.availableModels.find(
		(entry) =>
			entry.model === state.selectedModel && entry.providerId === state.selectedProviderId,
	);
	current.textContent = chosen === undefined ? 'none' : chosen.providerName;
}

function renderProjectPanel(): void {
	const select = byId<HTMLSelectElement>('project-select');
	select.textContent = '';

	if (state.projects.length === 0) {
		const option = document.createElement('option');
		option.value = '';
		option.textContent = 'no project yet';
		select.append(option);
	} else {
		for (const project of state.projects) {
			const option = document.createElement('option');
			option.value = project.id;
			option.textContent = `${project.name} — ${project.rootPath}`;
			select.append(option);
		}
	}
	select.value = state.selectedProjectId;

	const selected = state.projects.find((project) => project.id === state.selectedProjectId);
	byId('project-current').textContent =
		selected === undefined ? 'none — tools have no workspace' : selected.name;
	byId<HTMLInputElement>('project-root').value = selected?.rootPath ?? '';
	byId<HTMLInputElement>('project-name').value = selected?.name ?? '';

	// Open while there is nothing configured, and fold once a project exists, on
	// the same reasoning as the provider panel.
	const panel = byId<HTMLDetailsElement>('project-panel');
	if (state.hadProject !== (selected !== undefined)) {
		state.hadProject = selected !== undefined;
		panel.open = selected === undefined;
	}
}

function renderConversationList(): void {
	const list = byId('conversation-list');
	list.textContent = '';

	for (const item of state.conversations) {
		const row = document.createElement('li');

		const button = document.createElement('button');
		button.type = 'button';
		button.className =
			item.id === state.selectedConversationId ? 'conversation selected' : 'conversation';
		button.dataset.conversationId = item.id;
		button.disabled = isBusy();

		const name = document.createElement('span');
		name.className = 'name';
		name.textContent = item.title;

		const meta = document.createElement('span');
		meta.className = 'meta';
		// A conversation with only a system prompt has one message, not zero.
		meta.textContent = item.messageCount === 1 ? '1 message' : `${item.messageCount} messages`;

		button.append(name, meta);
		row.append(button);
		list.append(row);
	}

	setHidden(byId('conversation-empty'), state.conversations.length > 0);
	byId<HTMLButtonElement>('conversation-new').disabled =
		state.selectedProviderId.length === 0 || isBusy();
}

function renderConversationHeader(): void {
	const item = currentConversation();
	const title = byId<HTMLInputElement>('conversation-title');

	title.value = item?.title ?? '';
	// Readable while nothing is open or while a turn runs (a rename would
	// write over the list the turn is using); editable otherwise. It was
	// unconditionally read-only, which made renaming unreachable entirely —
	// Enter and blur both saw an unchanged title and returned.
	title.readOnly = item === undefined || isBusy();
	byId<HTMLButtonElement>('conversation-rename').disabled = item === undefined || isBusy();
	byId<HTMLButtonElement>('conversation-delete').disabled = item === undefined || isBusy();

	byId('conversation-meta').textContent =
		item === undefined ? '' : `${item.messageCount} messages · ${item.updatedAt.slice(0, 19).replace('T', ' ')}`;
}

/** Draws the whole transcript. Cheap, and it cannot drift out of sync. */
function renderMessages(): void {
	const container = byId('messages');
	container.textContent = '';

	if (state.messages.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'empty';
		empty.textContent =
			state.selectedConversationId.length === 0
				? 'Pick or create a conversation, then say something.'
				: 'This conversation is empty. Say something to start.';
		container.append(empty);
		return;
	}

	for (const [index, message] of state.messages.entries()) {
		const wrapper = document.createElement('div');
		const isLast = index === state.messages.length - 1;
		wrapper.className = `message ${message.role}`;
		if (isLast && message.role === 'assistant' && isBusy()) {
			wrapper.classList.add('streaming');
		}

		const role = document.createElement('span');
		role.className = 'role';
		role.textContent =
			message.role === 'user'
				? 'You'
				: message.role === 'system'
					? 'System'
					: message.role === 'tool'
						? `Tool · ${message.toolName ?? 'result'}`
						: message.role === 'toolError'
							? `Tool failed · ${message.toolName ?? 'result'}`
							: message.role === 'error'
								? 'Error'
								: 'Assistant';

		const bubble = document.createElement('div');
		bubble.className = 'bubble';
		bubble.textContent = message.content;

		wrapper.append(role, bubble);
		container.append(wrapper);
	}

	container.scrollTop = container.scrollHeight;
}

function renderComposerState(): void {
	const send = byId<HTMLButtonElement>('send');
	const stop = byId<HTMLButtonElement>('stop');
	const input = byId<HTMLTextAreaElement>('input');
	const busy = isBusy();

	send.disabled = !canSend();
	send.textContent = busy ? 'Sending…' : 'Send';
	// A greyed Send with no explanation is the single most confusing state this
	// window has: `canSend` depends on four things, two of which are chosen
	// elsewhere in the sidebar, and nothing on screen says which one is missing.
	// As a tooltip it is invisible on a disabled button, so the reason also goes
	// on the button's accessible name and is drawn under the composer.
	const reason = sendBlockedReason();
	send.title = reason ?? '';
	setHidden(byId<HTMLElement>('send-hint'), reason === null);
	if (reason !== null) {
		byId<HTMLElement>('send-hint').textContent = reason;
	}
	setHidden(stop, !busy);
	// Disabled with no conversation open, so the box cannot accept a message
	// that has nowhere to go.
	input.disabled = state.selectedConversationId.length === 0;
}

/** Why Send is disabled, or `null` when it is not. */
function sendBlockedReason(): string | null {
	if (state.bridge === undefined) {
		return 'The app is still starting.';
	}
	if (state.activeTurnId !== undefined) {
		return 'This turn is still running.';
	}
	if (state.providers.length === 0) {
		return 'Add a provider first.';
	}
	if (state.availableModels.length === 0) {
		return 'No models available. Check that a provider is reachable, then press Refresh.';
	}
	if (state.selectedModel.length === 0) {
		return 'Pick a model.';
	}
	if (state.selectedConversationId.length === 0) {
		return 'Open or create a conversation first.';
	}
	return null;
}

/**
 * The thinking indicator.
 *
 * Shown only while the model is reasoning and has *not* started answering. Once
 * the first text delta creates the assistant's message, the indicator is gone:
 * the streaming caret in that bubble already says the answer is arriving, and a
 * "thinking" line next to a half-written answer would claim the opposite.
 *
 * `state.reasoning` is still accumulated by the events but nothing renders it
 * now — it is the signal that the model is thinking at all, and on a reasoning
 * model there is a long pause before any other event arrives.
 */
function renderThinking(): void {
	const panel = byId<HTMLElement>('thinking');
	const busy = isBusy();
	const last = state.messages[state.messages.length - 1];
	const answering = last !== undefined && last.role === 'assistant';

	setHidden(panel, !(busy && state.reasoning.length > 0 && !answering));
}

function renderSystemPrompt(prompt: string): void {
	const field = byId<HTMLTextAreaElement>('system-prompt');
	field.value = prompt;
	const enabled = state.selectedConversationId.length > 0 && !isBusy();
	field.disabled = !enabled;
	byId<HTMLButtonElement>('system-save').disabled = !enabled;
	byId<HTMLButtonElement>('system-clear').disabled = !enabled;
}

function render(): void {
	renderProviderList();
	renderProviderForm();
	renderProjectPanel();
	renderModelList();
	renderConversationList();
	renderConversationHeader();
	renderMessages();
	renderThinking();
	renderComposerState();
	renderSystemPrompt(byId<HTMLTextAreaElement>('system-prompt').value);
}

// ── core status ─────────────────────────────────────────────────────────────

async function loadCoreStatus(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		const status = await bridge.getCoreStatus();
		byId('app-name').textContent = status.appName;
		byId('version').textContent = `v${status.version}`;
		byId('data-directory').textContent = status.dataDirectory;
		byId('status-dot').classList.add('ok');
		byId('status-label').textContent = 'Core running';
		clearError(byId('core-error'));
	} catch (error) {
		byId('status-dot').classList.remove('ok');
		byId('status-dot').classList.add('failed');
		byId('status-label').textContent = 'Core unavailable';
		report(error, byId('core-error'), 'Could not read the Core status.');
	}
}

// ── providers ───────────────────────────────────────────────────────────────

async function refreshProviders(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		state.providers = await bridge.listProviders();
		// Keep the selection if it survived; otherwise take the first, so a
		// configured app lands on something usable without a click.
		if (!state.providers.some((provider) => provider.id === state.selectedProviderId)) {
			state.selectedProviderId = state.providers[0]?.id ?? '';
			// The model list is global now, so it is not discarded here; the
			// selection is, because it named a provider that no longer exists.
			state.selectedModel = '';
			// A different provider means different conversations.
			state.conversations = [];
			state.selectedConversationId = '';
			state.messages = [];
		}
	} catch (error) {
		report(error, byId('provider-error'), 'Could not list providers.');
		return;
	}
	await refreshConversations();
}

/** Loads the conversation list for the selected provider. */
async function refreshConversations(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined || state.selectedProviderId.length === 0) {
		state.conversations = [];
		render();
		return;
	}
	try {
		state.conversations = await bridge.listConversations(state.selectedProviderId);
		clearError(byId('conversation-error'));
	} catch (error) {
		state.conversations = [];
		report(error, byId('conversation-error'), 'Could not list conversations.');
	}
	// `refreshProviders` hands rendering to this function rather than doing it
	// itself, so this has to redraw on *every* path. Without it the provider
	// list never appeared after a save, because the success path fell through
	// without painting — the bug a real run caught and a type check could not.
	render();
}

async function saveProvider(event: Event): Promise<void> {
	event.preventDefault();
	const bridge = state.bridge;
	if (bridge === undefined || isBusy()) {
		return;
	}

	const baseUrl = byId<HTMLInputElement>('provider-base-url').value.trim();
	const name = byId<HTMLInputElement>('provider-name').value.trim();
	const key = byId<HTMLInputElement>('provider-api-key').value;
	const previousId = state.selectedProviderId;
	const previousUrl = currentProvider()?.baseUrl;

	clearError(byId('provider-error'));

	try {
		// An untouched key field is omitted entirely, which the session reads as
		// "leave the stored key alone" rather than "replace it with blank".
		const saved = await bridge.saveProvider({
			baseUrl,
			...(name.length > 0 ? { name } : {}),
			...(key.length > 0 ? { apiKey: key } : {}),
		});
		if (saved.id !== previousId) {
			// The id derives from the URL, so a changed URL produced a
			// *different* provider. The conversation list and the transcript on
			// screen belong to the previous one — carrying them over left Send
			// pairing the new endpoint with the old conversation.
			state.selectedModel = '';
			state.conversations = [];
			state.selectedConversationId = '';
			state.messages = [];
		} else if (previousUrl !== undefined && previousUrl !== saved.baseUrl) {
			// Same provider, edited endpoint: whatever models it offered came
			// from the old URL, and the list is not rebuilt until the refresh.
			state.selectedModel = '';
		}
		state.selectedProviderId = saved.id;
		await refreshProviders();
		// Fetch the model list here instead of waiting for a click on `Models`.
		// Nothing else repopulates it, and Send is disabled while `selectedModel`
		// is empty — so saving a provider left the app in a state where the only
		// way forward was a button in a panel the user had just closed, with no
		// indication that Send was greyed for that reason.
		await loadModels();
	} catch (error) {
		report(error, byId('provider-error'), 'Could not save the provider.');
	}
}

/**
 * Fetches every model from every enabled provider.
 *
 * No longer takes a provider: the sidebar picks a model and the provider comes
 * with it, so the list is global by construction. A provider that is down is
 * skipped inside `ChatSession`, so an empty result here means every provider
 * failed or none is configured — which are different problems and are reported
 * differently below.
 */
async function loadModels(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined || state.providers.length === 0 || isBusy()) {
		return;
	}
	// One load at a time. This list costs one request per provider, so anything
	// that triggers it while a load is already in flight waits for that one
	// rather than starting a second identical round of HTTP calls.
	if (modelsLoading !== undefined) {
		await modelsLoading;
		return;
	}
	const button = byId<HTMLButtonElement>('model-refresh');
	button.disabled = true;
	clearError(byId('model-error'));

	modelsLoading = (async () => {
		const previous = state.selectedModel;
		try {
			const models = await bridge.listAvailableModels();
			state.availableModels = models;
			// The previous selection survives only if that exact model is still
			// offered. Comparing the name alone would silently move the
			// conversation onto a different provider's model of the same name.
			const stillThere = models.find(
				(entry) => entry.model === previous && entry.providerId === state.selectedProviderId,
			);
			if (stillThere !== undefined) {
				state.selectedModel = previous;
			} else {
				const first = models[0];
				// Preselected because sending with nothing selected only produces a
				// server-side error about a missing model name.
				state.selectedModel = first?.model ?? '';
				// The provider follows the model: conversations belong to a
				// provider, so choosing a model from another one has to move the
				// list with it or the transcript on screen would belong to an
				// endpoint that cannot see it.
				state.selectedProviderId = first?.providerId ?? state.selectedProviderId;
			}
			if (models.length === 0) {
				showError(
					byId('model-error'),
					'No models yet. Check that a provider is reachable, then press Refresh.',
				);
			}
		} catch (error) {
			state.availableModels = [];
			state.selectedModel = '';
			report(error, byId('model-error'), 'Could not load the model list.');
		} finally {
			button.disabled = false;
			render();
		}
	})();

	try {
		await modelsLoading;
	} finally {
		modelsLoading = undefined;
	}
}

async function removeProvider(): Promise<void> {
	const bridge = state.bridge;
	const provider = currentProvider();
	if (bridge === undefined || provider === undefined || isBusy()) {
		return;
	}
	clearError(byId('provider-error'));

	try {
		await bridge.removeProvider(provider.id);
		state.selectedProviderId = '';
		state.selectedModel = '';
		state.conversations = [];
		state.selectedConversationId = '';
		state.messages = [];
		await refreshProviders();
	} catch (error) {
		report(error, byId('provider-error'), 'Could not remove the provider.');
	}
}

// ── projects ───────────────────────────────────────────────────────────────

/** Loads the projects that give the tools a workspace. */
async function refreshProjects(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		state.projects = await bridge.listProjects();
		if (!state.projects.some((project) => project.id === state.selectedProjectId)) {
			state.selectedProjectId = state.projects[0]?.id ?? '';
		}
		clearError(byId('project-error'));
	} catch (error) {
		state.projects = [];
		report(error, byId('project-error'), 'Could not list projects.');
	}
	// Redraw on every path. Forgetting this is what left the picker reading
	// "no project yet" after a successful save — the Core had the project, the
	// list just never repainted, and a conversation was then created with no
	// workspace because nothing was selected.
	render();
}

async function saveProject(event: Event): Promise<void> {
	event.preventDefault();
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}

	const rootPath = byId<HTMLInputElement>('project-root').value.trim();
	const name = byId<HTMLInputElement>('project-name').value.trim();
	if (rootPath.length === 0) {
		showError(byId('project-error'), 'A project needs a folder.');
		return;
	}
	clearError(byId('project-error'));

	try {
		const created = await bridge.createProject({
			rootPath,
			// A blank name falls back to the folder name in the session, so the
			// picker is never full of "New project".
			...(name.length > 0 ? { name } : {}),
		});
		state.selectedProjectId = created.id;
		await refreshProjects();
	} catch (error) {
		report(error, byId('project-error'), 'Could not save the project.');
	}
}

// ── conversations ───────────────────────────────────────────────────────────

async function newConversation(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined || state.selectedProviderId.length === 0) {
		return;
	}
	clearError(byId('conversation-error'));

	try {
		const created = await bridge.createConversation({
			providerId: state.selectedProviderId,
			// Bound to the selected project, so the tools get a workspace to
			// confine themselves to. Absent when none is chosen, and the
			// filesystem tools then refuse rather than running anywhere.
			...(state.selectedProjectId.length > 0 ? { projectId: state.selectedProjectId } : {}),
		});
		await refreshConversations();
		await openConversation(created.summary.id);
	} catch (error) {
		report(error, byId('conversation-error'), 'Could not create the conversation.');
	}
}

/** Loads a conversation's transcript into the view. */
async function openConversation(conversationId: string): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	// Declared outside the try so the prompt can be applied after it succeeds;
	// declaring it inside would put it out of reach on the success path.
	let opened: ConversationView | undefined;
	try {
		opened = await bridge.openConversation(conversationId);
		state.selectedConversationId = opened.summary.id;
		// The transcript is rebuilt from the Core's copy, never from what the UI
		// happened to be holding — that is what keeps a reload honest.
		state.messages = opened.messages.map((message) => ({
			role: message.role,
			content: message.content,
		}));
		clearError(byId('chat-error'));
		clearError(byId('conversation-error'));
	} catch (error) {
		report(error, byId('conversation-error'), 'Could not open that conversation.');
		return;
	}
	renderSystemPrompt(opened.systemPrompt);
	render();
}

async function renameConversation(): Promise<void> {
	const bridge = state.bridge;
	const item = currentConversation();
	if (bridge === undefined || item === undefined) {
		return;
	}

	const title = byId<HTMLInputElement>('conversation-title').value.trim();
	if (title.length === 0 || title === item.title) {
		// Nothing to do; leaving the box read-only avoids a pointless write.
		renderConversationHeader();
		return;
	}
	clearError(byId('conversation-error'));

	try {
		await bridge.renameConversation(item.id, title);
		await refreshConversations();
	} catch (error) {
		report(error, byId('conversation-error'), 'Could not rename the conversation.');
		renderConversationHeader();
	}
}

async function saveSystemPrompt(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined || state.selectedConversationId.length === 0) {
		return;
	}
	clearError(byId('system-error'));

	try {
		const content = byId<HTMLTextAreaElement>('system-prompt').value;
		await bridge.setSystemPrompt(state.selectedConversationId, content);
		// Reopened so the transcript shows exactly what was stored, including
		// the case where an empty box removed the prompt.
		await openConversation(state.selectedConversationId);
		await refreshConversations();
	} catch (error) {
		report(error, byId('system-error'), 'Could not save the system prompt.');
	}
}

async function deleteConversation(): Promise<void> {
	const bridge = state.bridge;
	const item = currentConversation();
	if (bridge === undefined || item === undefined) {
		return;
	}
	clearError(byId('conversation-error'));

	try {
		await bridge.deleteConversation(item.id);
		state.selectedConversationId = '';
		state.messages = [];
		await refreshConversations();
		// Open whatever is left, so the chat pane is never stranded empty with
		// no selection.
		const next = state.conversations[0];
		if (next !== undefined) {
			await openConversation(next.id);
		} else {
			render();
		}
	} catch (error) {
		report(error, byId('conversation-error'), 'Could not delete the conversation.');
	}
}

// ── permission prompt ──────────────────────────────────────────────────────

/**
 * Fills the card with an open request and shows it.
 *
 * Everything is written as `textContent`: the arguments and the workspace path
 * are tool output, and they must never be given a chance to become markup.
 *
 * The card lives outside `#messages`, so the full redraw of the transcript
 * never touches it — it is shown here and closed by `hidePermission`, and no
 * `render()` in between can wipe it.
 */
function showPermission(prompt: PermissionPrompt): void {
	state.openPermission = prompt;

	byId('permission-tool').textContent = prompt.toolName;
	byId('permission-risk').textContent = prompt.riskLevel;
	byId('permission-action').textContent = prompt.action;
	byId('permission-detail').textContent = prompt.description;

	const list = byId('permission-args');
	list.textContent = '';
	for (const entry of prompt.arguments) {
		const name = document.createElement('dt');
		name.textContent = entry.name;
		const value = document.createElement('dd');
		value.textContent = entry.value;
		list.append(name, value);
	}

	// A conversation with no project runs in no directory, and saying that is
	// better than leaving a label with nothing after it.
	const workspace = byId('permission-workspace');
	workspace.textContent = prompt.workspace ?? '';
	setHidden(workspace, prompt.workspace === undefined);

	// The border follows the risk, which is what the decision turns on.
	const card = byId('permission');
	card.className = `permission risk-${prompt.riskLevel}`;
	setHidden(card, false);

	// Focus lands on Deny: an alertdialog that puts "Allow once" under the
	// next Enter press is a dialog that approves by accident.
	byId<HTMLButtonElement>('permission-deny').focus();
}

/**
 * Closes the card belonging to a settled request.
 *
 * Idempotent, and only for the request named: a resolution that arrives after
 * another prompt has opened must not take the new one off the screen. Called
 * from two places on purpose — from the resolution, and from the click — so
 * either path alone is enough to close it.
 */
function hidePermission(id: string): void {
	if (state.openPermission !== undefined && state.openPermission.id !== id) {
		return;
	}
	state.openPermission = undefined;
	byId('permission-args').textContent = '';
	byId('permission-workspace').textContent = '';
	setHidden(byId('permission'), true);
}

/**
 * Sends the user's decision for the open request.
 *
 * The card is closed whether main accepted the answer or refused it: a `false`
 * means the request is already settled (a timeout, a stop, a second click) and
 * nothing further will arrive for it, so leaving the card up would be a dialog
 * nobody can answer.
 */
async function answerPermission(decision: 'allow' | 'deny'): Promise<void> {
	const bridge = state.bridge;
	const prompt = state.openPermission;
	if (bridge === undefined || prompt === undefined) {
		return;
	}

	try {
		await bridge.answerPermission({ id: prompt.id, decision });
	} catch (error) {
		// The card stays open: the request is still waiting, and the user can
		// try again rather than losing a decision that never left this page.
		report(error, byId('chat-error'), 'Could not answer the permission request.');
		return;
	}
	hidePermission(prompt.id);
}

// ── chat ────────────────────────────────────────────────────────────────────

async function send(): Promise<void> {
	const bridge = state.bridge;
	const provider = currentProvider();
	const input = byId<HTMLTextAreaElement>('input');
	if (bridge === undefined || provider === undefined || !canSend()) {
		return;
	}

	const text = input.value.trim();
	if (text.length === 0) {
		return;
	}

	clearError(byId('chat-error'));

	// The history is NOT sent from here. The Core reads the persisted transcript
	// and appends the user's message itself, so the renderer passing its own
	// copy would be a second source of truth for what the model was told — and
	// the two would disagree as soon as a turn stored tool results.
	//
	// What the user typed still goes on screen now, so the send feels immediate
	// while the turn is only being accepted.
	state.messages.push({ role: 'user', content: text });
	input.value = '';
	// Shrunk back too, or the HUD keeps the height of the message just sent.
	autoGrow(input);
	// Stale reasoning from a finished turn would otherwise stay on screen and be
	// read as the thinking behind this new question.
	state.reasoning = '';
	render();

	try {
		const ack = await bridge.sendMessage({
			providerId: provider.id,
			conversationId: state.selectedConversationId,
			model: state.selectedModel,
			messages: [{ role: 'user', content: text }],
		});
		// Only now is the turn really running: `sendMessage` resolves on accept,
		// not on an answer. Marking it busy earlier would strand the composer if
		// the request was refused.
		state.activeTurnId = ack.turnId;
		render();
	} catch (error) {
		// Nothing will arrive on this turn, so the user's message is left alone
		// and no empty bubble is left looking like an answer.
		state.activeTurnId = undefined;
		report(error, byId('chat-error'), 'Could not send the message.');
		render();
	}
}

async function stop(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		await bridge.stop();
	} catch (error) {
		report(error, byId('chat-error'), 'Could not stop the turn.');
	}
}

/**
 * Folds one stream event into the transcript.
 *
 * Events for another turn are dropped: the user stopped and started again, and
 * the old turn's remaining deltas belong to a message nobody is watching.
 */
function onChatEvent(event: ChatStreamEvent): void {
	if (state.activeTurnId !== undefined && event.turnId !== state.activeTurnId) {
		return;
	}

	switch (event.type) {
		case 'started':
			// The turn has been accepted; anything left from a previous one is no
			// longer about this turn.
			state.reasoning = '';
			return;
		case 'reasoning':
			// Accumulated separately from the transcript and never pushed as a
			// message: it is the model's scratchpad, not an answer, and the next
			// turn replays the transcript back to the model.
			state.reasoning += event.text;
			render();
			return;
		case 'permissionRequested':
			showPermission(event.prompt);
			return;
		case 'permissionResolved':
			// Closed here too, so a decision settles the card whether the button
			// was pressed here or the turn was stopped from the header. The card
			// is hidden on both paths and only the transcript records what
			// happened — a card that lingered after its resolution would read as a
			// request still waiting.
			hidePermission(event.id);
			if (event.decision === 'allow') {
				state.messages.push({
					role: 'tool',
					content: `you allowed ${event.toolName}`,
				});
			} else {
				state.messages.push({
					role: 'tool',
					content:
						event.source === 'cancelled'
							? `${event.toolName} was cancelled before it ran`
							: `you denied ${event.toolName}`,
				});
			}
			render();
			return;
		case 'delta': {
			// The assistant bubble is created here rather than before the turn,
			// because a turn that calls a tool produces tool bubbles first, and a
			// pre-created placeholder would sit above them looking like the model
			// had spoken before it had.
			const last = state.messages[state.messages.length - 1];
			if (last !== undefined && last.role === 'assistant') {
				last.content += event.text;
			} else {
				state.messages.push({ role: 'assistant', content: event.text });
			}
			render();
			return;
		}
		case 'toolCall':
			// Shown as its own bubble rather than a note in the header: the user
			// asked a question and the model went off to read a file, and that
			// step is part of the answer they are waiting for.
			state.messages.push({
				role: 'tool',
				toolName: event.call.name,
				toolCallId: event.call.id,
				content: event.call.malformed
					? `could not parse the arguments: ${event.call.rawArguments}`
					: `calling ${event.call.name}(${event.call.rawArguments})`,
			});
			render();
			return;

		case 'toolResult': {
			// The "calling" bubble is replaced by the result rather than joined
			// by one, so a long tool output cannot leave a stale pending line
			// above the answer. Matched by call id: two calls of the same tool
			// in one round would otherwise both find the newest bubble by name
			// and leave the other reading "calling…" forever.
			const pending = state.messages.findLast(
				(message) => message.role === 'tool' && message.toolCallId === event.callId,
			);
			if (pending !== undefined) {
				pending.role = event.ok ? 'tool' : 'toolError';
				pending.content = event.output.length > 0 ? event.output : '(no output)';
			} else {
				// A result with no matching call: the call bubble was never seen,
				// which should not happen, but dropping the result would hide
				// what the tool actually did.
				state.messages.push({
					role: event.ok ? 'tool' : 'toolError',
					toolName: event.name,
					content: event.output.length > 0 ? event.output : '(no output)',
				});
			}
			render();
			return;
		}

		case 'done': {
			const last = state.messages[state.messages.length - 1];
			if (last === undefined && event.content.length > 0) {
				// Nothing accumulated on screen — deltas never arrived — so the
				// turn's own copy is the only one there is.
				state.messages.push({ role: 'assistant', content: event.content });
			}
			// When a bubble already exists it is left alone: `event.content`
			// spans *every* round of the turn, and overwriting the last bubble
			// with it reprinted the earlier rounds' text inside the final one.
			state.activeTurnId = undefined;
			// The answer is in; the thinking is not part of it, so it leaves the
			// screen with the turn.
			state.reasoning = '';
			render();
			// An aborted turn is a normal outcome, so it is reported as a note
			// rather than as an error the user has to dismiss.
			if (event.reason === 'aborted') {
				showError(byId('chat-error'), 'Stopped.');
			}
			// The list carries a message count, and a turn just changed it.
			void refreshConversations();
			return;
		}
		case 'error': {
			const last = state.messages[state.messages.length - 1];
			if (last !== undefined && last.role === 'assistant' && last.content.length === 0) {
				// Nothing was said, so there is no empty bubble to keep.
				state.messages.pop();
			}
			state.messages.push({
				role: 'error',
				// An error with no text still has to read as something: the
				// event is delivered (the contract no longer drops it), and an
				// empty bubble would look like no failure at all.
				content: event.message.length > 0 ? event.message : 'The turn failed.',
			});
			state.activeTurnId = undefined;
			state.reasoning = '';
			// A turn can die with its permission dialog open. The card would
			// outlive the turn and read as a request still waiting for an
			// answer that can no longer arrive.
			if (state.openPermission !== undefined) {
				hidePermission(state.openPermission.id);
			}
			render();
			// The turn changed the transcript even though it failed, so the
			// list's message count is stale — same as on `done`.
			void refreshConversations();
			return;
		}
	}
}

// ── wiring ──────────────────────────────────────────────────────────────────

function bindEvents(bridge: SeshyinaBridge): void {
	byId('provider-form').addEventListener('submit', (event) => void saveProvider(event));
	byId<HTMLButtonElement>('provider-models').addEventListener('click', () => void loadModels());
	byId<HTMLButtonElement>('model-refresh').addEventListener('click', () => void loadModels());
	byId<HTMLButtonElement>('provider-remove').addEventListener('click', () => void removeProvider());

	byId('project-form').addEventListener('submit', (event) => void saveProject(event));
	byId<HTMLSelectElement>('project-select').addEventListener('change', (event) => {
		// Only affects conversations created from now on: an existing
		// conversation's workspace is fixed, because changing it mid-conversation
		// would silently move what the tools may touch under a transcript that
		// already recorded results from the old directory.
		state.selectedProjectId = (event.target as HTMLSelectElement).value;
		render();
	});

	byId<HTMLButtonElement>('conversation-new').addEventListener('click', () => void newConversation());
	byId<HTMLButtonElement>('conversation-rename').addEventListener('click', () => void renameConversation());
	byId<HTMLButtonElement>('conversation-delete').addEventListener('click', () => void deleteConversation());
	byId<HTMLButtonElement>('system-save').addEventListener('click', () => void saveSystemPrompt());
	byId<HTMLButtonElement>('system-clear').addEventListener('click', () => {
		byId<HTMLTextAreaElement>('system-prompt').value = '';
		void saveSystemPrompt();
	});

	// One delegated listener for the list: the buttons are rebuilt on every
	// render, so binding each one would have to be redone every time.
	byId('conversation-list').addEventListener('click', (event) => {
		const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-conversation-id]');
		const id = target?.dataset.conversationId;
		if (id !== undefined && !isBusy()) {
			void openConversation(id);
		}
	});

	byId<HTMLButtonElement>('send').addEventListener('click', () => void send());
	byId<HTMLButtonElement>('stop').addEventListener('click', () => void stop());

	// The answers. Bound once, here: the card is never rebuilt — only
	// filled by `showPermission` and cleared by `hidePermission` — so these
	// listeners survive every render.
	byId<HTMLButtonElement>('permission-allow').addEventListener('click', () =>
		void answerPermission('allow'),
	);
	byId<HTMLButtonElement>('permission-deny').addEventListener('click', () =>
		void answerPermission('deny'),
	);

	// Closing or cancelling is a refusal, never a dismissal. Both paths send
	// `deny` through `answerPermission` — the same route as the Deny button —
	// so a dialog the user swept away still releases the tool: silence must
	// not read as consent, and a prompt left hanging would block the turn on
	// an answer nobody can see anymore. Guarded on `openPermission` so Escape
	// while the card is closed leaves the rest of the page (a focused input,
	// a select) alone.
	byId<HTMLButtonElement>('permission-close').addEventListener('click', () =>
		void answerPermission('deny'),
	);
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && state.openPermission !== undefined) {
			event.preventDefault();
			void answerPermission('deny');
		}
	});

	byId<HTMLSelectElement>('provider-select').addEventListener('change', (event) => {
		// Belt for the disabled select: a switch mid-turn would zero the state
		// the running turn's events are being folded into.
		if (isBusy()) {
			return;
		}
		state.selectedProviderId = (event.target as HTMLSelectElement).value;
		// The model list is global and is not rebuilt here; only the selection is
		// dropped, because it named the provider the user just left.
		state.selectedModel = '';
		// Conversations belong to a provider; carrying them over would show a
		// transcript the new provider never saw.
		state.conversations = [];
		state.selectedConversationId = '';
		state.messages = [];
		clearError(byId('provider-error'));
		void (async () => {
			// Same reason as after a save: an empty `selectedModel` disables Send,
			// and switching provider is exactly when it empties.
			await refreshConversations();
			const first = state.conversations[0];
			if (first !== undefined) {
				await openConversation(first.id);
			} else {
				render();
			}
		})();
	});

	byId<HTMLSelectElement>('model-select').addEventListener('change', (event) => {
		if (isBusy()) {
			return;
		}
		// The option value is an index into `availableModels`, so the provider
		// comes back with the choice rather than having to be matched afterwards.
		const index = Number.parseInt((event.target as HTMLSelectElement).value, 10);
		const entry = Number.isNaN(index) ? undefined : state.availableModels[index];
		if (entry === undefined) {
			return;
		}
		state.selectedModel = entry.model;

		// A model from a different provider moves the conversation list with it.
		// Conversations are bound to one provider, so leaving the list on the old
		// provider would show a transcript the chosen endpoint has never seen.
		if (entry.providerId !== state.selectedProviderId) {
			state.selectedProviderId = entry.providerId;
			state.conversations = [];
			state.selectedConversationId = '';
			state.messages = [];
			void (async () => {
				await refreshConversations();
				const first = state.conversations[0];
				if (first !== undefined) {
					await openConversation(first.id);
				} else {
					render();
				}
			})();
			return;
		}
		render();
	});

	const title = byId<HTMLInputElement>('conversation-title');
	title.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			title.blur();
			void renameConversation();
		}
	});
	// Clicking away is the other way a rename is committed.
	title.addEventListener('blur', () => void renameConversation());

	const input = byId<HTMLTextAreaElement>('input');
	input.addEventListener('keydown', (event) => {
		const keyboard = event as KeyboardEvent;
		// Enter sends; Shift+Enter is a newline. Anything else is left alone so
		// shortcuts and IME composition keep working.
		if (keyboard.key === 'Enter' && !keyboard.shiftKey && !keyboard.isComposing) {
			keyboard.preventDefault();
			void send();
		}
	});
	// Grows with what is typed, up to the `max-height` in the stylesheet. Without
	// this the box is one row tall and a long message scrolls inside itself.
	input.addEventListener('input', () => autoGrow(input));

	// Esc closes the drawer. The permission dialog has its own Esc handling, and
	// it is inside the transcript rather than the drawer, so the two do not
	// collide — but the drawer check keeps Esc from closing both at once.
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && !byId<HTMLElement>('settings').hidden) {
			event.preventDefault();
			closeSettings();
		}
	});

	bindEdgeHandle();
	bindWindowControls(bridge);
	bindDrawerClose(bridge);
	bindResizeHandles(bridge);
	bindSettingsMenu(bridge);

	bridge.onChatEvent(onChatEvent);
}

/**
 * Wires the title bar's three buttons.
 *
 * These exist because `frame: false` removed the OS ones. The drag itself needs
 * no code — `-webkit-app-region: drag` on the title bar does it — but the
 * buttons cannot be, since a drag region swallows clicks in everything nested
 * inside it, which is why each carries `no-drag` in the stylesheet.
 *
 * The title bar here belongs to whichever window loaded this page, so the three
 * buttons always act on that window. Only the drawer's own × is different, and
 * that is handled in `bindDrawerClose`.
 */
function bindWindowControls(bridge: SeshyinaBridge): void {
	byId<HTMLButtonElement>('window-minimize').addEventListener('click', () => {
		void bridge.minimizeWindow();
	});

	byId<HTMLButtonElement>('window-maximize').addEventListener('click', () => {
		void bridge.toggleMaximizeWindow();
	});

	byId<HTMLButtonElement>('window-close').addEventListener('click', () => {
		void bridge.closeWindow();
	});

	// The glyph follows the window, not the click: a restore triggered by the OS
	// rather than by the button has to update it too, and only main knows.
	bridge.onWindowState((state) => {
		document.body.dataset.maximized = String(state.maximized);
		const button = byId<HTMLButtonElement>('window-maximize');
		button.setAttribute('aria-label', state.maximized ? 'Restore' : 'Maximise');
	});
}

/**
 * Wires the drawer's own ×, which means different things in the two windows.
 *
 * In the chat window it closes the drawer. In the settings window the drawer
 * *is* the window, so closing it would hide every panel and leave a window with
 * nothing in it but a title bar — it has to close the window instead.
 */
function bindDrawerClose(bridge: SeshyinaBridge): void {
	byId<HTMLButtonElement>('settings-close').addEventListener('click', () => {
		if (document.body.dataset.window === 'settings') {
			void bridge.closeWindow();
			return;
		}
		closeSettings();
	});
}

/**
 * Which window this is, from the URL main loaded it with.
 *
 * Read here and written to `<body>` because the stylesheet is what acts on it:
 * one document, two layouts, and the panels that differ are hidden by CSS
 * rather than by a second copy of the markup the renderer would then have to
 * look ids up in twice.
 *
 * Defaults to `chat` when the parameter is absent, so opening the page outside
 * the desktop app still renders something usable rather than an empty document.
 */
function windowRole(): 'chat' | 'settings' {
	return new URLSearchParams(window.location.search).get('window') === 'settings'
		? 'settings'
		: 'chat';
}

/** Wires the menu button that opens the settings window. */
function bindSettingsMenu(bridge: SeshyinaBridge): void {
	byId<HTMLButtonElement>('open-settings').addEventListener('click', () => {
		// False here would mean a new window was created, which is the normal
		// path; only a throw would be a problem, and the bridge rewraps that.
		void bridge.openSettings();
	});
}

/**
 * Wires the eight resize strips to main's geometry.
 *
 * The pointer is captured on `mousedown` so the drag keeps tracking after it
 * leaves the strip — a 6px target would otherwise end the drag the moment the
 * pointer moved, which is one pixel after it started. Every move is then
 * forwarded to main, which owns the bounds and applies them against a snapshot
 * taken once at the start.
 *
 * `mousemove` on the document rather than on the handle, for the same reason.
 * The `mouseup` is registered once, globally, so a release anywhere ends the
 * drag: a drag ended by the pointer leaving the window, or by the button never
 * arriving, would otherwise leave main resizing on every later move.
 */
function bindResizeHandles(bridge: SeshyinaBridge): void {
	let dragging: ResizeDirection | undefined;

	for (const handle of document.querySelectorAll<HTMLElement>('.resize-handle')) {
		handle.addEventListener('mousedown', (event) => {
			const direction = handle.dataset['dir'] as ResizeDirection | undefined;
			if (direction === undefined || event.button !== 0) {
				return;
			}
			event.preventDefault();
			dragging = direction;
			void bridge.startWindowResize(direction);
		});
	}

	document.addEventListener('mousemove', (event) => {
		if (dragging === undefined) {
			return;
		}
		// Screen coordinates, not page ones: main's window is positioned on the
		// desktop, so it has to be told where the pointer is in that space.
		void bridge.moveWindowResize(event.screenX, event.screenY);
	});

	document.addEventListener('mouseup', () => {
		if (dragging === undefined) {
			return;
		}
		dragging = undefined;
		void bridge.endWindowResize();
	});
}

/**
 * True when the drawer was opened deliberately and should stay open.
 *
 * A peeked drawer closes itself when the pointer leaves; a pinned one waits to
 * be closed. Without this distinction, moving the pointer away from a menu the
 * user opened by accident would leave it covering the conversation they moved
 * to read, and clicking one open deliberately would have it vanish under the
 * same gesture.
 */
let isSettingsPinned = false;

/** Pending close of a peeked drawer, cancelled if the pointer gets there first. */
let peekCloseTimer: number | undefined;

/**
 * The model list load in flight, if any.
 *
 * Kept out of `state` because it is not something a render reads: it exists so
 * `loadModels` can make a second caller wait rather than start a second round of
 * per-provider HTTP requests.
 */
let modelsLoading: Promise<void> | undefined;

/**
 * Wires the left edge to the drawer.
 *
 * Two ways in. Hovering the edge peeks the drawer; clicking or activating it
 * with the keyboard pins it. Hover alone would be unreachable by keyboard and
 * inert on touch, which is why the handle is a real `<button>` and hover is an
 * addition over that rather than the mechanism.
 *
 * Enter and Space on a button fire `click`, so one handler covers pointer and
 * keyboard together — and there is deliberately no `focus` handler: focusing the
 * handle fires before the click, so opening on focus would flip the drawer
 * twice and leave it shut on a single activation.
 */
function bindEdgeHandle(): void {
	const handle = byId<HTMLButtonElement>('settings-toggle');
	const drawer = byId<HTMLElement>('settings');

	const peek = (open: boolean): void => {
		if (isSettingsPinned) {
			return;
		}
		window.clearTimeout(peekCloseTimer);
		if (open) {
			setSettingsOpen(true, { moveFocus: false });
			return;
		}
		// Deferred, because crossing from the 20px handle into the drawer fires
		// `mouseleave` on the handle on the way — with an immediate close the
		// drawer would shut in the gap and the pointer would arrive at a
		// slide-out, which reads as the menu being broken.
		peekCloseTimer = window.setTimeout(() => {
			if (!isSettingsPinned) {
				setSettingsOpen(false, { moveFocus: false });
			}
		}, 140);
	};

	handle.addEventListener('mouseenter', () => peek(true));
	handle.addEventListener('mouseleave', () => peek(false));
	drawer.addEventListener('mouseenter', () => peek(true));
	drawer.addEventListener('mouseleave', () => peek(false));

	handle.addEventListener('click', () => {
		const open = !isSettingsPinned;
		isSettingsPinned = open;
		setSettingsOpen(open);
	});

	byId<HTMLElement>('settings-scrim').addEventListener('click', closeSettings);
}

/** Closes the drawer and unpins it, however it was opened. */
function closeSettings(): void {
	isSettingsPinned = false;
	window.clearTimeout(peekCloseTimer);
	setSettingsOpen(false);
}

/**
 * Opens or closes the settings drawer.
 *
 * `hidden` rather than a class, because the stylesheet slides the drawer out
 * from `[hidden]` and the slide needs the attribute to flip.
 *
 * `moveFocus` is opt-out because a hover-opened menu must not steal it: the
 * pointer can brush the edge while the user is halfway through a sentence, and
 * yanking focus into the drawer would dump the rest of it into the wrong field.
 */
function setSettingsOpen(open: boolean, options: { moveFocus?: boolean } = {}): void {
	const drawer = byId<HTMLElement>('settings');
	const scrim = byId<HTMLElement>('settings-scrim');
	const handle = byId<HTMLButtonElement>('settings-toggle');

	drawer.hidden = !open;
	setHidden(scrim, !open);
	handle.setAttribute('aria-expanded', String(open));

	if (options.moveFocus === false) {
		return;
	}
	if (open) {
		byId<HTMLButtonElement>('settings-close').focus();
	} else {
		handle.focus();
	}
}

/** Sizes a textarea to its content, up to the stylesheet's `max-height`. */
function autoGrow(textarea: HTMLTextAreaElement): void {
	textarea.style.height = 'auto';
	textarea.style.height = `${textarea.scrollHeight}px`;
}

async function main(): Promise<void> {
	// Set before anything renders: the stylesheet keys the whole layout off it,
	// and a first paint in the wrong layout would flash the chat into the
	// settings window.
	const role = windowRole();
	document.body.dataset.window = role;

	state.bridge = readBridge(window);
	if (state.bridge === undefined) {
		byId('status-dot').classList.add('failed');
		byId('status-label').textContent = 'Bridge unavailable';
		showError(
			byId('core-error'),
			'The preload bridge is not available, so this page is running outside the desktop app.',
		);
		return;
	}

	bindEvents(state.bridge);
	render();
	// Projects first: a new conversation binds to the selected one, so the
	// picker has to be populated before anything else runs.
	await refreshProjects();
	await Promise.all([loadCoreStatus(), refreshProviders()]);

	if (document.body.dataset.window === 'settings') {
		// The model panel is `.only-chat`, so this window never renders it — and
		// the list costs one request per provider. Loading it here meant the
		// settings window asked every endpoint for a list it then threw away,
		// which is one round of HTTP per provider every time it was opened.
		await openFirstConversation();
		return;
	}

	// Restored from `state.json` on boot, and `selectedModel` starts empty, so
	// without this the app opens with Send greyed out on the provider the user
	// left configured last.
	await loadModels();

	// Land on something usable: the newest conversation of the selected
	// provider, so reopening the app shows the work in progress.
	await openFirstConversation();
}

/**
 * Opens the most recent conversation of the selected provider.
 *
 * Shared by both windows because the settings one needs it too: the system
 * prompt belongs to a conversation, so the window that edits it has to know
 * which conversation is current.
 */
async function openFirstConversation(): Promise<void> {
	const first = state.conversations[0];
	if (first !== undefined) {
		await openConversation(first.id);
	}
}

void main();