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
	MODEL_CATALOG_CHANNEL,
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
	parseModelCatalogEntryView,
	parseModelCatalogEntryViews,
	parseModelCatalogKey,
	parseProviderId,
	parseProviderSummaries,
	parseProviderSummary,
	parseSaveProviderInput,
	parseSaveModelCatalogInput,
	parseSendMessageAck,
	parseSendMessageInput,
	parseSystemPrompt,
	parseSkillProposalView,
	parseSkillProposalViews,
	parseSkillProposalId,
	parseSkillProposalStatus,
	parseSkillContentDiffView,
	parseSkillEvolutionResultView,
	parseSkillVersionViews,
	parseDecisionReason,
	parseRollbackTarget,
	parseSkillScanView,
	parseSaveSkillImprovementInput,
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
		assert.strictEqual(APP_NAME, 'Evelyn');
	});

	test('a well-formed payload parses', () => {
		const status: CoreStatus = parseCoreStatus(validPayload());

		assert.strictEqual(status.appName, 'Evelyn');
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
			// R4A: leitura do serviço local. Estes canais não mudam o contrato
			// de conversa; existem para a interface informar o estado dele.
			getServiceStatus: async () => ({ state: 'inactive', detail: 'sem serviço' }),
			getServiceCatalog: async () => ({ ok: false, code: 'inactive', message: 'sem serviço' }),
			// DEV-4: o estado de abertura da janela e a conversa atual.
			getUiBootState: async () => ({}),
			setUiSession: async () => undefined,
			// DEV-6: o painel do modo DEV. A forma completa, não um atalho: a
			// página precisa do estado inteiro para renderizar.
			getDevState: async () => ({
				repo: { available: false, reason: 'sem repositório DEV' },
				session: 'inactive',
				authorization: 'unavailable',
				canActivate: false,
				canAct: false,
				localCredential: { kind: 'not-configured', message: 'sem credencial' },
				credentialActions: { canConfigure: false, canReset: false },
				checkpoints: [],
			}),
			activateDev: async () => {
				throw new Error('sem repositório DEV');
			},
			deactivateDev: async () => {
				throw new Error('sem repositório DEV');
			},
			lockDev: async () => {
				throw new Error('sem desbloqueio persistente');
			},
			revokeDevUnlock: async () => {
				throw new Error('sem desbloqueio persistente');
			},
			applyDevOperation: async () => ({ outcome: 'refused', detail: 'sem sessão' }),
			restoreDevCheckpoint: async () => ({ outcome: 'refused', detail: 'sem sessão' }),
			onDevChange: () => () => undefined,
			// DEV-7: a autorização local. Configurar/recuperar exigem o host;
			// responder ao prompt só faz sentido com um aberto.
			configureDevAuthorization: async () => {
				throw new Error('sem credencial local');
			},
			recoverDevAuthorization: async () => {
				throw new Error('sem credencial local');
			},
			onDevOwnerPrompt: () => () => undefined,
			answerDevOwnerPrompt: async () => ({ accepted: false, reason: 'não há pergunta aberta' }),
			// R4C: conversa pelo serviço. Só transporte; o turno roda nele.
			sendToService: async () => ({ accepted: false, error: 'sem serviço' }),
			stopServiceTurn: async () => ({ stopped: false }),
			answerServicePermission: async () => ({ answered: false }),
			// R4D: o histórico do serviço.
			listServiceConversations: async () => ({ ok: true, conversations: [] }),
			openServiceConversation: async () => ({ ok: false, code: 'rejected', message: 'sem conversa' }),
			// R4E: criar no serviço.
			createServiceConversation: async () => ({ ok: false, code: 'inactive', message: 'sem serviço' }),
			// R4F: renomear e excluir.
			renameServiceConversation: async () => ({ ok: false, code: 'inactive', message: 'sem serviço' }),
			deleteServiceConversation: async () => ({ ok: false, code: 'inactive', message: 'sem serviço' }),
			// R4H: o estado dos turnos.
			listServiceTurnStates: async () => ({ ok: true, turns: [] }),
			openServicePanel: async () => ({ ok: false, code: 'inactive', message: 'sem serviço' }),
			readServiceControl: async () => ({ state: 'inactive' }),
			setServiceRunning: async () => ({ ok: true, state: { state: 'inactive' } }),
			onServiceState: () => () => undefined,
			restartInLocalMode: async () => ({ ok: false, message: 'sem serviço' }),
			getDevRunHistory: async () => [],
			listProviders: async () => [],
			listProjects: async () => [],
			createProject: async () => ({}) as never,
			saveProvider: async () => ({}) as never,
			removeProvider: async () => false,
			setProviderRole: async () => ({ id: 'p', name: 'P', baseUrl: 'http://x/v1', status: 'configured', hasApiKeyRef: false, models: [] }),
			setProviderEnabled: async () => ({ id: 'p', name: 'P', baseUrl: 'http://x/v1', status: 'configured', hasApiKeyRef: false, models: [] }),
			listModels: async () => [],
			listAvailableModels: async () => [],
			listModelCatalog: async () => [],
			getModelCatalogEntry: async () => undefined,
			saveModelCatalogEntry: async () => ({}) as never,
			removeModelCatalogEntry: async () => false,
			listSpendingLimits: async () => [],
			saveSpendingLimit: async () => ({}) as never,
			removeSpendingLimit: async () => false,
			readBudget: async () => ({}) as never,
			forecastCall: async () => ({}) as never,
			listBudgetAlerts: async () => [],
			listDiscoveredModels: async () => [],
			discoverModels: async () => ({ models: [] }),
			listDiscoveredQuotas: async () => [],
			listUsableModels: async () => [],
			getAccessPolicy: async () => ({ policy: 'any', priceSource: 'user', limitsSource: 'user', capabilitiesSource: 'user', updatedAt: '', changedBy: 'user', hint: '' }),
			setAccessPolicy: async () => ({ policy: 'any', priceSource: 'user', limitsSource: 'user', capabilitiesSource: 'user', updatedAt: '', changedBy: 'user', hint: '' }),
			listMergedCatalog: async () => ({ policy: { policy: 'any', priceSource: 'user', limitsSource: 'user', capabilitiesSource: 'user', updatedAt: '', changedBy: 'user', hint: '' }, models: [] }),
			listDecisionReports: async () => [],
			listExecutionHistory: async () => [],
			compareExecutions: async () => ({ status: 'refused', reason: 'unknown_execution', detail: 'x' }),
			getRouterConfig: async () => ({ mode: 'native', enabled: true, updatedAt: '', configured: false }),
			setRouterConfig: async () => ({ mode: 'native', enabled: true, updatedAt: '', configured: true }),
			openSettings: async () => true,
			scanSkillHistory: async () => ({}) as never,
			proposeSkillImprovement: async () => ({}) as never,
			listSkillEvolutionProposals: async () => [],
			getSkillEvolutionProposal: async () => ({}) as never,
			compareSkillEvolutionProposal: async () => ({}) as never,
			approveSkillEvolutionProposal: async () => ({}) as never,
			rejectSkillEvolutionProposal: async () => ({}) as never,
			activateSkillEvolutionProposal: async () => ({ ok: true }),
			listSkillVersions: async () => [],
			rollbackSkillVersion: async () => ({ ok: true }),
			createConversation: async () => ({}) as never,
			listConversations: async () => [],
			openConversation: async () => ({}) as never,
			renameConversation: async () => ({}) as never,
			setSystemPrompt: async () => ({}) as never,
			deleteConversation: async () => 'absent',
			pinConversation: async () => ({}) as never,
			readModelGuidance: async () => [],
			recordModelGuidance: async () => undefined,
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
			onRouterState: () => () => undefined,
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
			// R4A: leitura do serviço local. Acrescentados de propósito — são
			// os únicos canais novos, e ambos só leem.
			'getServiceStatus',
			'getServiceCatalog',
			// DEV-4: o boot state e a conversa atual. O primeiro só lê; o
			// segundo grava dois campos conhecidos, nunca caminho ou conteúdo.
			'getUiBootState',
			'setUiSession',
			// DEV-6: o painel do modo DEV. Duas leituras do mesmo estado e
			// quatro ações de vocabulário fixo (ativar, encerrar, aplicar por
			// id, restaurar por id) mais um aviso de mudança. Nenhuma recebe
			// caminho, comando ou token; só ids que o host já conhece.
			'getDevState',
			'activateDev',
			'deactivateDev',
			'lockDev',
			'revokeDevUnlock',
			'applyDevOperation',
			'restoreDevCheckpoint',
			'onDevChange',
			// DEV-7: a autorização local do proprietário. Configurar e recuperar
			// não aceitam argumento (a senha é pedida pelo `main`); responder ao
			// prompt envia só o que foi digitado, com o id recebido.
			'configureDevAuthorization',
			'recoverDevAuthorization',
			'onDevOwnerPrompt',
			'answerDevOwnerPrompt',
			// R4C: a conversa pelo serviço. Transporte: o turno roda no motor
			// do serviço, não aqui.
			'sendToService',
			'stopServiceTurn',
			'answerServicePermission',
			// R4D: o histórico do serviço.
			'listServiceConversations',
			'openServiceConversation',
			// R4E: criar conversa no serviço.
			'createServiceConversation',
			// R4F: renomear e excluir.
			'renameServiceConversation',
			'deleteServiceConversation',
			// R4H: o estado dos turnos.
			'listServiceTurnStates',
			// R4R: abrir o painel do serviço no navegador.
			'openServicePanel',
			'readServiceControl',
			'setServiceRunning',
			'onServiceState',
			'restartInLocalMode',
			'getDevRunHistory',
			'listProviders',
			'listProjects',
			'createProject',
			'saveProvider',
			'removeProvider',
			'setProviderRole',
			'setProviderEnabled',
			'listModels',
			'listAvailableModels',
			'listModelCatalog',
			'getModelCatalogEntry',
			'saveModelCatalogEntry',
			'removeModelCatalogEntry',
			'listSpendingLimits',
			'saveSpendingLimit',
			'removeSpendingLimit',
			'readBudget',
			'forecastCall',
			'listBudgetAlerts',
			'listDiscoveredModels',
			'discoverModels',
			'listDiscoveredQuotas',
			'listUsableModels',
			'getAccessPolicy',
			'setAccessPolicy',
			'listMergedCatalog',
			'listDecisionReports',
			'listExecutionHistory',
			'compareExecutions',
			'getRouterConfig',
			'setRouterConfig',
			'openSettings',
			'scanSkillHistory',
			'proposeSkillImprovement',
			'listSkillEvolutionProposals',
			'getSkillEvolutionProposal',
			'compareSkillEvolutionProposal',
			'approveSkillEvolutionProposal',
			'rejectSkillEvolutionProposal',
			'activateSkillEvolutionProposal',
			'listSkillVersions',
			'rollbackSkillVersion',
			'createConversation',
			'listConversations',
			'openConversation',
			'renameConversation',
			'setSystemPrompt',
			'deleteConversation',
			'pinConversation',
			'readModelGuidance',
			'recordModelGuidance',
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
			'onRouterState',
		]);
	});
});

/**
 * Skill evolution across the bridge.
 *
 * The payload that crosses here carries model-authored skill content, so it is
 * narrowed rather than cast: a proposal with an unexpected shape must become an
 * error the UI can show, not a card with holes in it that somebody then
 * approves. The inbound side matters just as much, because these payloads carry
 * the decisions that end up rewriting a live skill.
 */
suite('Desktop: skill evolution payloads', () => {
	/** A scan result main would legitimately send. */
	function validScan(): Record<string, unknown> {
		return {
			ok: true,
			runsRead: 7,
			usableRuns: 4,
			unverifiedRuns: 3,
			skipped: [{ refId: 'exp-9', reason: 'nunca foi executado' }],
			errors: [],
			opportunities: [
				{
					fingerprint: 'recurring-failure:code-review:c1@coding',
					kind: 'recurring-failure',
					skillId: 'code-review',
					title: 'Falha recorrente: c1',
					problem: 'O critério c1 falhou em 4 execuções.',
					strength: 'hypothesis',
					sampleSize: 4,
					supportingRuns: ['exp-1', 'exp-2', 'exp-3', 'exp-4'],
					domains: ['coding'],
					untestedCases: ['Nenhum domínio além de "coding" foi testado.'],
					generalizesBeyondSample: false,
				},
			],
			modelObservations: [
				{
					providerId: '9router',
					modelId: 'space-bunny-alpha',
					key: '9router:space-bunny-alpha',
					runs: 5,
					verifiedPasses: 3,
					verifiedFailures: 1,
					unverifiedRuns: 1,
					medianDurationMs: { kind: 'derived', value: 4200, note: 'mediana de 4 medições' },
					tokensUsed: { kind: 'unknown', note: 'o provedor não reportou contagem de tokens' },
					hasMeasurements: true,
					canCompare: false,
					caveat: 'só um modelo tem execuções verificadas; com uma única amostra não há comparação possível',
				},
			],
			summary: '4 de 7 execuções verificadas contra critérios; 1 oportunidade(s).',
		};
	}

	/** A proposal the renderer would legitimately send. */
	function validImprovement(): Record<string, unknown> {
		return {
			fingerprint: 'recurring-failure:code-review:c1@coding',
			skillId: 'code-review',
			title: 'Code Review',
			description: 'Revisa código',
			instructions: '# Code Review\n\n1. Leia os arquivos.',
			proposedVersion: '1.0.1',
			tags: ['review'],
			requiredTools: ['fs.read'],
			riskLevel: 'moderate',
			constraints: ['Somente leitura'],
			expectedBenefits: ['Menos falsos positivos'],
			risks: ['Um passo extra'],
			validationCriteria: [
				{ id: 'vc-1', description: 'Achados citam o arquivo', observableAs: 'Contagem cai a zero' },
			],
		};
	}

	/** A proposal main would legitimately send. */
	function validProposal(): Record<string, unknown> {
		return {
			id: 'prop-1',
			status: 'pending',
			skillId: 'code-review',
			createsNewSkill: false,
			problem: 'O critério X falhou 5 vezes no domínio coding.',
			currentVersion: '1.0.0',
			currentInstructions: '# Code Review\n\n1. Leia os arquivos.',
			proposedVersion: '1.0.1',
			proposed: {
				title: 'Code Review',
				description: 'Revisa código',
				instructions: '# Code Review\n\n1. Leia os arquivos.\n2. Confirme.',
				tags: ['review'],
				requiredTools: ['fs.read'],
				riskLevel: 'moderate',
				constraints: ['Somente leitura'],
			},
			rationale: 'Padrão sustentado por 5 execuções.',
			evidence: {
				sampleSize: 5,
				supportingRuns: ['eval-1', 'eval-2'],
				domains: ['coding'],
			},
			expectedBenefits: ['Menos falsos positivos'],
			risks: ['Um passo extra'],
			untestedCases: ['Nenhum domínio além de coding'],
			validationCriteria: [
				{ id: 'vc-1', description: 'Achados citam o arquivo', observableAs: 'Contagem cai a zero' },
			],
			strength: 'sustained-pattern',
			createdAt: '2024-06-01T12:00:00.000Z',
		};
	}

	test('a well-formed proposal survives the bridge with every field', () => {
		const parsed = parseSkillProposalView(validProposal());

		assert.strictEqual(parsed.id, 'prop-1');
		assert.strictEqual(parsed.status, 'pending');
		assert.strictEqual(parsed.skillId, 'code-review');
		assert.strictEqual(parsed.currentInstructions.length > 0, true);
		assert.strictEqual(parsed.proposed.riskLevel, 'moderate');
		assert.strictEqual(parsed.evidence.sampleSize, 5);
		assert.strictEqual(parsed.strength, 'sustained-pattern');
		assert.strictEqual(parsed.decision, undefined);
	});

	test('a recorded decision is carried across', () => {
		const parsed = parseSkillProposalView({
			...validProposal(),
			status: 'approved',
			decision: { decidedBy: 'the user', reason: 'faz sentido', decidedAt: '2024-06-01T12:05:00.000Z' },
		});

		assert.strictEqual(parsed.status, 'approved');
		assert.strictEqual(parsed.decision!.decidedBy, 'the user');
	});

	test('an unknown status is refused rather than passed through', () => {
		assert.throws(
			() => parseSkillProposalView({ ...validProposal(), status: 'applied' }),
			/unknown proposal status/,
		);
	});

	test('proposed instructions that are not a string are refused', () => {
		const broken = validProposal();
		broken['proposed'] = { ...(broken['proposed'] as Record<string, unknown>), instructions: 42 };
		assert.throws(() => parseSkillProposalView(broken), /string title, description and instructions/);
	});

	test('an unknown proposed risk level is refused', () => {
		const broken = validProposal();
		broken['proposed'] = { ...(broken['proposed'] as Record<string, unknown>), riskLevel: 'critical' };
		assert.throws(() => parseSkillProposalView(broken), /unknown proposed riskLevel/);
	});

	test('an unknown strength is refused', () => {
		assert.throws(
			() => parseSkillProposalView({ ...validProposal(), strength: 'certain' }),
			/unknown strength/,
		);
	});

	test('one malformed proposal does not empty the review queue', () => {
		const parsed = parseSkillProposalViews([
			validProposal(),
			{ ...validProposal(), id: 'prop-2' },
			{ nonsense: true },
			{ ...validProposal(), id: 'prop-3' },
		]);

		assert.deepStrictEqual(
			parsed.map((proposal) => proposal.id),
			['prop-1', 'prop-2', 'prop-3'],
		);
	});

	test('a content diff round-trips', () => {
		const parsed = parseSkillContentDiffView({
			fieldsChanged: ['instructions'],
			instructionsChanged: true,
			currentLength: 10,
			proposedLength: 20,
			instructionsDiff: ['- antigo', '+ novo'],
			identical: false,
		});

		assert.deepStrictEqual([...parsed.instructionsDiff], ['- antigo', '+ novo']);
		assert.strictEqual(parsed.identical, false);
	});

	test('a diff with non-boolean flags is refused', () => {
		assert.throws(
			() => parseSkillContentDiffView({ instructionsChanged: 'yes', identical: 'no' }),
			/boolean instructionsChanged and identical/,
		);
	});

	test('a version list round-trips', () => {
		const parsed = parseSkillVersionViews([
			{
				versionId: 'v-1',
				skillId: 'code-review',
				version: '1.0.0',
				content: {
					title: 'Code Review',
					description: 'Revisa código',
					instructions: '1. Leia',
					tags: [],
					requiredTools: [],
					riskLevel: 'moderate',
					constraints: [],
				},
				archivedAt: '2024-06-01T12:00:00.000Z',
				reason: 'activation',
			},
		]);

		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0]!.reason, 'activation');
	});

	test('a version with an unknown reason is refused', () => {
		assert.throws(
			() =>
				parseSkillVersionViews([
					{
						versionId: 'v-1',
						skillId: 'code-review',
						version: '1.0.0',
						content: {
							title: 't',
							description: 'd',
							instructions: 'i',
							tags: [],
							requiredTools: [],
							riskLevel: 'safe',
							constraints: [],
						},
						archivedAt: '2024-06-01T12:00:00.000Z',
						reason: 'because',
					},
				]),
			/unknown version reason/,
		);
	});

	test('an activation outcome round-trips, including a refusal', () => {
		assert.strictEqual(parseSkillEvolutionResultView({ ok: true, skillId: 's', version: '1.0.1' }).ok, true);
		assert.strictEqual(
			parseSkillEvolutionResultView({ ok: false, error: 'ainda pendente' }).error,
			'ainda pendente',
		);
		assert.throws(() => parseSkillEvolutionResultView({ ok: 'yes' }), /boolean ok/);
	});

	test('a status the renderer invents is refused', () => {
		assert.strictEqual(parseSkillProposalStatus('pending'), 'pending');
		assert.throws(() => parseSkillProposalStatus('applied'), /unknown proposal status/);
	});

	test('a blank or missing proposal id is refused', () => {
		assert.throws(() => parseSkillProposalId(''), /non-empty string/);
		assert.throws(() => parseSkillProposalId(undefined), /non-empty string/);
	});

	test('a decision without a reason is refused, because it would be unauditable', () => {
		assert.throws(() => parseDecisionReason('   '), /non-empty reason/);
		assert.throws(() => parseDecisionReason(undefined), /non-empty reason/);
		assert.strictEqual(parseDecisionReason('  porque  '), 'porque');
	});

	test('a rollback target needs both halves', () => {
		assert.deepStrictEqual(parseRollbackTarget({ skillId: 's', versionId: 'v-1' }), {
			skillId: 's',
			versionId: 'v-1',
		});
		assert.throws(() => parseRollbackTarget({ skillId: 's' }), /non-empty versionId/);
		assert.throws(() => parseRollbackTarget('v-1'), /expected a rollback target/);
	});

	// ── the learning pipeline across the bridge ─────────────────────────────

	test('a scan result survives the bridge with its counts and its caveats', () => {
		const parsed = parseSkillScanView(validScan());

		assert.strictEqual(parsed.ok, true);
		assert.strictEqual(parsed.runsRead, 7);
		assert.strictEqual(parsed.usableRuns, 4);
		assert.strictEqual(parsed.unverifiedRuns, 3);
		assert.strictEqual(parsed.opportunities.length, 1);
		assert.strictEqual(parsed.modelObservations.length, 1);
		assert.strictEqual(parsed.skipped.length, 1);
	});

	test('a scan result with a non-numeric count is refused', () => {
		assert.throws(
			() => parseSkillScanView({ ...validScan(), usableRuns: 'three' }),
			/usableRuns must be a non-negative number/,
		);
	});

	test('a scan result with a negative count is refused', () => {
		assert.throws(
			() => parseSkillScanView({ ...validScan(), runsRead: -1 }),
			/runsRead must be a non-negative number/,
		);
	});

	test('a scan opportunity with an unknown strength is refused', () => {
		const scan = validScan();
		scan['opportunities'] = [{ ...(scan['opportunities'] as Record<string, unknown>[])[0], strength: 'certain' }];
		assert.throws(() => parseSkillScanView(scan), /unknown strength/);
	});

	test('an opportunity missing its evidence runs is refused', () => {
		const scan = validScan();
		const opportunity = { ...(scan['opportunities'] as Record<string, unknown>[])[0] };
		delete opportunity['supportingRuns'];
		scan['opportunities'] = [opportunity];
		assert.throws(() => parseSkillScanView(scan), /supportingRuns must be an array of strings/);
	});

	test('a model observation with no caveat is refused', () => {
		// The one field that cannot be optional: an observation that does not say
		// what it cannot support is the thing this shape exists to prevent.
		const scan = validScan();
		const observation = { ...(scan['modelObservations'] as Record<string, unknown>[])[0] };
		delete observation['caveat'];
		scan['modelObservations'] = [observation];
		assert.throws(() => parseSkillScanView(scan), /must carry a caveat/);
	});

	test('a measurement with an unknown kind is refused', () => {
		const scan = validScan();
		const observation = { ...(scan['modelObservations'] as Record<string, unknown>[])[0] };
		observation['medianDurationMs'] = { kind: 'estimated', value: 10, note: 'chute' };
		scan['modelObservations'] = [observation];
		assert.throws(() => parseSkillScanView(scan), /unknown kind/);
	});

	test('a measurement with no note is refused', () => {
		const scan = validScan();
		const observation = { ...(scan['modelObservations'] as Record<string, unknown>[])[0] };
		observation['tokensUsed'] = { kind: 'unknown', value: undefined };
		scan['modelObservations'] = [observation];
		assert.throws(() => parseSkillScanView(scan), /needs a note saying where it came from/);
	});

	test('an absent measurement crosses as unknown rather than zero', () => {
		const scan = validScan();
		const observation = { ...(scan['modelObservations'] as Record<string, unknown>[])[0] };
		observation['medianDurationMs'] = { kind: 'unknown', note: 'nenhuma execução verificada registrou duração' };
		scan['modelObservations'] = [observation];

		const parsed = parseSkillScanView(scan);
		assert.strictEqual(parsed.modelObservations[0]!.medianDurationMs.kind, 'unknown');
		assert.strictEqual(parsed.modelObservations[0]!.medianDurationMs.value, undefined);
	});

	test('a proposal cannot be filed without a fingerprint to anchor it', () => {
		const payload = {
			title: 'Validação',
			description: 'Valida entradas',
			instructions: '1. Leia\n2. Valide',
			tags: [],
			requiredTools: [],
			riskLevel: 'moderate',
			constraints: [],
			expectedBenefits: [],
			risks: [],
			validationCriteria: [],
		};
		assert.throws(
			() => parseSaveSkillImprovementInput(payload),
			/an improvement needs a non-empty fingerprint/,
		);
	});

	test('a proposal with empty instructions is refused at the boundary', () => {
		const payload = { ...validImprovement(), instructions: '   ' };
		assert.throws(
			() => parseSaveSkillImprovementInput(payload),
			/needs non-empty instructions/,
		);
	});

	test('a proposal with no validation criteria crosses, and the Core is what refuses it', () => {
		// Deliberately lenient here. An empty array is a *present* empty array, and
		// the rule that a proposal needs something to be judged by belongs to
		// `validateEvolutionProposal`, which refuses it before storage. Duplicating
		// that rule at the bridge would mean two places to keep in step and a
		// message that names the bridge rather than the proposal.
		const parsed = parseSaveSkillImprovementInput({ ...validImprovement(), validationCriteria: [] });
		assert.deepStrictEqual([...parsed.validationCriteria], []);
	});

	test('a proposal with an unknown risk level is refused', () => {
		const payload = { ...validImprovement(), riskLevel: 'critical' };
		assert.throws(() => parseSaveSkillImprovementInput(payload), /unknown riskLevel/);
	});

	test('a well-formed proposal crosses intact', () => {
		const parsed = parseSaveSkillImprovementInput(validImprovement());

		assert.strictEqual(parsed.fingerprint, 'recurring-failure:code-review:c1@coding');
		assert.strictEqual(parsed.skillId, 'code-review');
		assert.strictEqual(parsed.riskLevel, 'moderate');
		assert.strictEqual(parsed.validationCriteria.length, 1);
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

	test('a send needs a provider, a conversation, a model and an array of messages', () => {
		assert.throws(() => parseSendMessageInput({}), /providerId must be a non-empty string/);
		assert.throws(
			() => parseSendMessageInput({ providerId: 'p', messages: [] }),
			/conversationId must be a non-empty string/,
		);
		assert.throws(
			() => parseSendMessageInput({ providerId: 'p', conversationId: 'c', messages: [] }),
			/model must be a non-empty string/,
		);
		// An empty array is a retry: the user's message is already in the
		// persisted transcript and the turn runs again without appending it.
		assert.deepStrictEqual(
			parseSendMessageInput({ providerId: 'p', conversationId: 'c', model: 'm', messages: [] })
				.messages,
			[],
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

suite('Desktop: model catalog payloads', () => {
	/** A record main would send for a model the user has partly described. */
	function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			providerId: 'atria',
			modelId: 'Atria-Dawn-Preview',
			capabilities: 'code, translation',
			access: 'paid',
			observations: 3,
			medianTotalMs: 1500,
			updatedAt: '2026-01-01T00:00:00.000Z',
			...overrides,
		};
	}

	test('a well-formed record survives with every field', () => {
		const parsed = parseModelCatalogEntryView(
			entry({
				pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '3', output: '15' },
				limits: { contextTokens: '200000' },
				notes: 'a note',
				medianFirstByteMs: 420,
			}),
		);

		assert.strictEqual(parsed.providerId, 'atria');
		assert.strictEqual(parsed.modelId, 'Atria-Dawn-Preview');
		assert.strictEqual(parsed.access, 'paid');
		assert.deepStrictEqual(parsed.pricing, {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: '3',
			output: '15',
		});
		assert.deepStrictEqual(parsed.limits, { contextTokens: '200000' });
		assert.strictEqual(parsed.notes, 'a note');
		assert.strictEqual(parsed.medianFirstByteMs, 420);
		assert.strictEqual(parsed.medianTotalMs, 1500);
	});

	test('a record with nothing declared still parses', () => {
		// The state a model is in before anybody has typed anything, and the one
		// after a run that measured only latency. Absent must survive absent.
		const parsed = parseModelCatalogEntryView({
			providerId: 'atria',
			modelId: 'Atria-Dawn-Preview',
			capabilities: '',
			access: 'unknown',
			observations: 0,
			medianFirstByteMs: undefined,
			medianTotalMs: undefined,
			updatedAt: '2026-01-01T00:00:00.000Z',
		});
		assert.strictEqual(parsed.pricing, undefined);
		assert.strictEqual(parsed.limits, undefined);
		assert.strictEqual(parsed.notes, undefined);
		assert.strictEqual(parsed.medianFirstByteMs, undefined);
		assert.strictEqual(parsed.medianTotalMs, undefined);
	});

	test('a record with no identity is refused', () => {
		for (const bad of [entry({ providerId: '' }), entry({ modelId: '' }), entry({ access: 'guess' })]) {
			assert.throws(() => parseModelCatalogEntryView(bad), BridgePayloadError);
		}
	});

	test('a median that is not a non-negative number is refused', () => {
		for (const bad of [-1, Number.NaN, '420', null]) {
			assert.throws(
				() => parseModelCatalogEntryView(entry({ medianTotalMs: bad })),
				BridgePayloadError,
				`expected ${String(bad)} to be refused`,
			);
		}
	});

	test('a malformed record is dropped from a list rather than failing it', () => {
		const list = parseModelCatalogEntryViews([
			entry(),
			entry({ providerId: '' }),
			'nonsense',
			entry({ modelId: 'other' }),
		]);

		assert.strictEqual(list.length, 2);
		assert.deepStrictEqual(
			list.map((item) => item.modelId),
			['Atria-Dawn-Preview', 'other'],
		);
	});

	test('a non-array is refused, so a broken reply is not read as an empty catalog', () => {
		// The opposite of `parseAvailableModels`, deliberately: a list that
		// silently reads as empty would make the settings window show a clean
		// form over a reply main never managed to send.
		assert.throws(() => parseModelCatalogEntryViews({}), BridgePayloadError);
	});

	test('an empty capabilities string is kept as an empty string', () => {
		// The user typed nothing into the box. That is a classification of "none
		// of the above", and folding it to absent would make it unexpressible.
		const parsed = parseSaveModelCatalogInput({
			providerId: 'p',
			modelId: 'm',
			capabilities: '',
		});
		assert.strictEqual(parsed.capabilities, '');
	});

	test('a blank price box arrives as null, not as an empty price', () => {
		const parsed = parseSaveModelCatalogInput({
			providerId: 'p',
			modelId: 'm',
			pricing: null,
			limits: null,
			notes: null,
		});
		assert.strictEqual(parsed.pricing, null);
		assert.strictEqual(parsed.limits, null);
		assert.strictEqual(parsed.notes, null);
	});

	test('an omitted field is omitted, so the Core can tell it from a clear', () => {
		const parsed = parseSaveModelCatalogInput({ providerId: 'p', modelId: 'm' });
		assert.strictEqual('capabilities' in parsed, false);
		assert.strictEqual('pricing' in parsed, false);
		assert.strictEqual('limits' in parsed, false);
		assert.strictEqual('notes' in parsed, false);
	});

	test('a price with no currency or an unknown unit is refused', () => {
		assert.throws(
			() =>
				parseSaveModelCatalogInput({
					providerId: 'p',
					modelId: 'm',
					pricing: { currency: '  ', unit: 'per_1k_tokens' },
				}),
			BridgePayloadError,
		);
		assert.throws(
			() =>
				parseSaveModelCatalogInput({
					providerId: 'p',
					modelId: 'm',
					pricing: { currency: 'USD', unit: 'per_dozen' },
				}),
			BridgePayloadError,
		);
	});

	test('the price numbers stay strings all the way across the bridge', () => {
		// A `0` and a blank box are different requests, and the conversion is
		// where that is decided. Converting here would let the bridge decide.
		const parsed = parseSaveModelCatalogInput({
			providerId: 'p',
			modelId: 'm',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '0', output: '' },
		});
		assert.strictEqual(parsed.pricing?.input, '0');
		assert.strictEqual(parsed.pricing?.output, '');
	});

	test('a non-string price number is refused rather than coerced', () => {
		assert.throws(
			() =>
				parseSaveModelCatalogInput({
					providerId: 'p',
					modelId: 'm',
					pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 3 },
				}),
			BridgePayloadError,
		);
	});

	test('an identity the renderer sent is narrowed, not cast', () => {
		assert.deepStrictEqual(parseModelCatalogKey({ providerId: 'p', modelId: 'm' }), {
			providerId: 'p',
			modelId: 'm',
		});
		for (const bad of [{ providerId: '', modelId: 'm' }, { providerId: 'p' }, 'p/m', null]) {
			assert.throws(() => parseModelCatalogKey(bad), BridgePayloadError);
		}
	});

	test('an unknown access is refused on the way in', () => {
		assert.throws(
			() => parseSaveModelCatalogInput({ providerId: 'p', modelId: 'm', access: 'cheap' }),
			BridgePayloadError,
		);
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
