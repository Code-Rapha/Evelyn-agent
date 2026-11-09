/*
 * The Evelyn web interface.
 *
 * ## What it does
 *
 * One area of the router at a time, chosen by the hash. Each area asks a
 * read-only endpoint and renders **what came back**: providers, models,
 * the router configuration, the spend. Nothing is computed into a shape the
 * Core did not send, and a fact that did not arrive is shown as unknown.
 *
 * ## What it does not do
 *
 * No writes, no chat, no Combos. An area without an endpoint says so — it
 * does not show a form that would not work, or numbers nobody measured.
 *
 * ## The session
 *
 * The token arrives once in the URL and becomes an `HttpOnly` cookie; this
 * script never sees it. It only removes it from the address bar.
 */

/** The areas, in the order they appear. */
const AREAS = ['overview', 'providers', 'models', 'chat', 'combos', 'routing', 'usage', 'turns', 'settings'];

/** Every text of an area that has no endpoint yet, and why. */
const PENDING = {
	combos: {
		title: 'Combos ainda não têm endpoint',
		text:
			'Um combo é um conjunto nomeado de alvos com uma política de rota. O Core ainda não os persiste, e esta API não os lê — então esta área não mostra nenhum. Ela chega numa fase seguinte.',
	},
};

/** Escapes text for HTML. Everything from the API goes through this. */
function escapeHtml(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/** A tag, with an optional tone or origin. */
function tag(text, attribute, value) {
	const extra = attribute === undefined ? '' : ` data-${attribute}="${escapeHtml(value)}"`;
	return `<span class="tag"${extra}>${escapeHtml(text)}</span>`;
}

/** A fact: a label and a value, the value marked unknown when it is absent. */
function fact(label, value, options = {}) {
	const missing = value === undefined || value === null || value === '';
	const shown = missing ? (options.unknown ?? 'desconhecido') : String(value);
	const tone = missing ? 'class="fact-value unknown"' : 'class="fact-value"';
	return `<div class="fact"><span class="fact-label">${escapeHtml(label)}</span><span ${tone}>${escapeHtml(shown)}</span></div>`;
}

/** The loading state of an area. */
function loading() {
	return `<div class="loading"><span class="loading-dots" aria-hidden="true"><span></span><span></span><span></span></span>carregando…</div>`;
}

/** The empty state of a list. */
function empty(text) {
	return `<div class="empty">${escapeHtml(text)}</div>`;
}

/** The error of an area, with the status and what the API said. */
function errorBox(message, status) {
	const statusText = status === undefined ? '' : ` (HTTP ${status})`;
	return `<p class="error" role="alert">${escapeHtml(message)}${escapeHtml(statusText)}</p>`;
}

/** The pending block: an area with no endpoint. */
function pendingBlock(title, text) {
	return `<div class="pending"><div><div class="pending-title">${escapeHtml(sentence(title))}</div><p class="pending-text">${escapeHtml(sentence(text))}</p></div></div>`;
}

/** Writes a title the way the desktop does: first letter up, the rest as is. */
function sentence(text) {
	return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/** The pending block: an area with no endpoint. */
function pending(title, text) {
	return `<div class="pending"><div><div class="pending-title">${escapeHtml(sentence(title))}</div><p class="pending-text">${escapeHtml(sentence(text))}</p></div></div>`;
}

/** A page header. */
function head(title, subtitle) {
	return `<header class="page-head"><h1>${escapeHtml(title)}</h1></header><p class="page-sub">${escapeHtml(subtitle)}</p>`;
}

/** The name of a router mode. */
function modeName(mode) {
	return mode === 'external' ? 'Externo' : mode === 'direct' ? 'Direto' : 'Nativo';
}

/** The name of a provider role. */
function roleName(role) {
	return role === 'router' ? 'Roteador' : 'Provedor';
}

/**
 * The price, as the Core described it.
 *
 * `MergedPriceView.effective` is what counts, and it carries its own side
 * and origin. An absent price is said to be absent; a zero is a price.
 */
function priceText(model) {
	const price = model.price;
	if (price === undefined) {
		return { value: 'desconhecido', origin: 'unknown' };
	}
	if (price.effective !== undefined) {
		return {
			value: amountsText(price.effective),
			origin: price.effective.side === 'user' ? 'ours' : 'theirs',
		};
	}
	if (price.user !== undefined) {
		return { value: amountsText(price.user), origin: 'ours' };
	}
	if (price.discovered !== undefined) {
		return { value: amountsText(price.discovered), origin: 'theirs' };
	}
	return { value: 'desconhecido', origin: 'unknown' };
}

function amountsText(amounts) {
	const parts = [];
	if (amounts.input !== undefined) {
		parts.push(`entrada ${amounts.input}`);
	}
	if (amounts.output !== undefined) {
		parts.push(`saída ${amounts.output}`);
	}
	const unit = amounts.unit === 'per_1m_tokens' ? 'por 1M tokens' : 'por 1k tokens';
	return parts.length === 0 ? `${amounts.currency} (sem valores)` : `${parts.join(', ')} ${amounts.currency} ${unit}`;
}

/** The access, with what it came from. */
function accessText(model) {
	if (model.access !== undefined) {
		return { value: model.access.access, origin: 'theirs', note: model.access.source };
	}
	if (model.declaredAccess !== undefined && model.declaredAccess !== 'unknown') {
		return { value: model.declaredAccess, origin: 'ours' };
	}
	return { value: 'desconhecido', origin: 'unknown' };
}

/** The origin label of a price/access side. */
function originLabel(origin) {
	return origin === 'ours' ? 'nosso' : origin === 'theirs' ? 'do provedor' : 'desconhecido';
}

/** One model row: name, price, access, and the policy verdict when it applies. */
function modelRow(model) {
	const price = priceText(model);
	const access = accessText(model);
	const policy =
		model.policyStatus === undefined || model.policyStatus.eligible
			? ''
			: ` · ${tag(`excluído: ${model.policyStatus.reason ?? 'política'}`, 'tone', 'warning')}`;
	const listed = model.listed === false ? ` · ${tag('fora da listagem', 'tone', 'warning')}` : '';
	return `<li class="model-row">
		<span class="model-name">${escapeHtml(model.modelId)}</span>
		<span class="model-facts">
			<span class="model-fact"><span class="fact-label">preço</span> ${escapeHtml(price.value)} ${tag(originLabel(price.origin), 'origin', price.origin)}</span>
			<span class="model-fact"><span class="fact-label">acesso</span> ${escapeHtml(access.value)} ${tag(originLabel(access.origin), 'origin', access.origin)}${policy}${listed}</span>
		</span>
	</li>`;
}

/* ── the areas ─────────────────────────────────────────────────────────────── */

/** Visão geral: the state of the router and what is configured. */
/**
 * Chat: a conversa com o OpenCode, com o modelo que o usuário escolheu.
 *
 * ## O que esta área é
 *
 * Uma conversa de verdade: a mensagem vai ao servidor OpenCode pela rota da
 * Evelyn, o stream volta enquanto o modelo responde e o texto aparece aos
 * poucos. O modelo é **um do catálogo**, do backend OpenCode — não é um
 * provedor OpenAI-compatible da Evelyn, e não entra no roteador dela.
 *
 * ## O que a página não decide
 *
 * Ela escolhe o modelo (por id), o texto e o momento de parar. O endereço, a
 * autenticação e a rota são do servidor. Nada de URL, cabeçalho ou comando
 * viaja no corpo do envio.
 *
 * ## Catálogo desatualizado
 *
 * Escolher um modelo exige catálogo atual: com "desatualizado", a lista fica
 * visível mas **não selecionável** até "Atualizar catálogo". Um modelo que o
 * servidor não publica mais não pode ser escolhido por engano.
 */
function renderChat(data) {
	const opencode = data.opencode;
	const catalog = data.opencodeCatalog;
	const conversation = state.conversation;
	const connected = opencode !== undefined && opencode.state === 'connected';
	const catalogLoaded = catalog !== undefined && (catalog.state === 'ok' || catalog.state === 'stale');
	const catalogCurrent = catalog !== undefined && catalog.state === 'ok';
	const models = catalogLoaded ? catalog.catalog?.models ?? [] : [];
	const providers = catalogLoaded ? catalog.catalog?.providers ?? [] : [];
	const withCredential = new Set(
		providers.filter((provider) => provider.connected).map((provider) => provider.id),
	);

	let status = '';
	if (!connected) {
		status = pendingBlock(
			'OpenCode não conectado',
			'Conecte um servidor OpenCode na área Providers. A conversa usa a conexão e o catálogo validados ali.',
		);
	} else if (catalog === undefined || catalog.state === 'never') {
		status = pendingBlock(
			'Catálogo ainda não lido',
			'Atualize o catálogo na área Providers para escolher um modelo.',
		);
	} else if (catalog.state === 'stale') {
		status = pendingBlock(
			'Catálogo desatualizado',
			`A última leitura falhou: ${catalog.reason ?? 'motivo não informado'}. Atualize o catálogo na área Providers para escolher um modelo — a seleção fica bloqueada para não escolher um modelo que o servidor pode não ter mais.`,
		);
	} else if (catalog.state === 'failed') {
		status = pendingBlock('Catálogo com erro', catalog.reason ?? 'a leitura do catálogo falhou');
	}

	const selectable = catalogCurrent && connected;
	const selected = conversation?.model ?? '';
	// Os modelos são muitos (centenas), e o que importa é o que dá para usar:
	// agrupados por provedor, com o provedor sem credencial no próprio rótulo.
	const usableModel = (model) => withCredential.has(model.providerId) && model.status !== 'deprecated';
	const usableModels = models.filter(usableModel);
	// Sem nada escolhido, a seleção começa num modelo utilizável — nunca num
	// desabilitado, que o navegador mostraria mas não deixaria enviar.
	const effective = selected.length > 0 ? selected : usableModels[0] === undefined ? '' : `${usableModels[0].providerId}/${usableModels[0].modelId}`;
	const byProvider = new Map();
	for (const model of models) {
		if (model.status === 'deprecated') {
			continue;
		}
		const list = byProvider.get(model.providerId) ?? [];
		list.push(model);
		byProvider.set(model.providerId, list);
	}
	const options =
		models.length === 0
			? '<option value="">nenhum modelo no catálogo</option>'
			: [...byProvider.entries()]
					.map(([providerId, list]) => {
						const usable = withCredential.has(providerId);
						const label = `${providerId}${usable ? '' : ' (sem credencial)'}`;
						const items = list
							.map((model) => {
								const id = `${model.providerId}/${model.modelId}`;
								const chosen = id === effective ? ' selected' : '';
								const blocked = usableModel(model) ? '' : ' disabled';
								return `<option value="${escapeHtml(id)}"${chosen}${blocked}>${escapeHtml(model.name ?? model.modelId)}</option>`;
							})
							.join('');
						return `<optgroup label="${escapeHtml(label)}">${items}</optgroup>`;
					})
					.join('');

	const picker = `<div class="connection-actions" style="align-items: center; gap: 0.5rem; flex-wrap: wrap">
		<label class="field" style="min-width: 18rem">
			<span class="field-label">Modelo do catálogo OpenCode</span>
			<select id="chat-model" data-selected="${escapeHtml(effective)}"${selectable ? '' : ' disabled'} aria-label="Modelo do catálogo OpenCode">${options}</select>
		</label>
		<button type="button" class="button secondary" data-action="chat-new"${selectable ? '' : ' disabled'}>Nova conversa</button>
		${conversation === undefined ? '' : '<button type="button" class="button danger" data-action="chat-discard">Descartar conversa</button>'}
	</div>
	<p class="muted small">O OpenCode decide internamente qual requisição faz; a Evelyn escolhe o modelo do catálogo e mostra o que o servidor respondeu. Estes modelos não passam pelo roteador da Evelyn.</p>`;

	// O histórico é desenhado depois, por `renderConversation`, a partir do
	// estado — para o texto das mensagens nunca entrar por HTML.
	const history =
		conversation === undefined
			? `<div data-role="chat-history"></div>${empty('Nenhuma conversa ainda. Escolha um modelo e escreva abaixo.')}`
			: `<div class="stack" data-role="chat-history" data-conversation="${escapeHtml(conversation.id)}">${conversation.messages
					.map(
						(message) =>
							`<article class="connection-card"><div class="connection-head"><span class="connection-name">${message.role === 'user' ? 'Você' : 'OpenCode'}</span>${message.model === undefined ? '' : tag(message.model, 'origin', 'external')}</div><p class="chat-text" data-role="chat-text"></p></article>`,
					)
					.join('')}</div>`;

	// A sessão do OpenCode: a mesma dos turnos anteriores, ou uma nova. Nunca
	// se diz "o modelo tem o contexto" sem a sessão viva — e uma sessão
	// perdida é dita sem apagar o histórico.
	const session = conversation?.session;
	const sessionNote =
		session === undefined || session.status === 'none'
			? ''
			: session.status === 'active'
				? '<p class="muted small" data-role="chat-session">Sessão do OpenCode ativa neste servidor: os próximos turnos continuam esta conversa nele.</p>'
				: `<p class="error" data-role="chat-session" role="status">A sessão anterior foi perdida: ${escapeHtml(session.reason ?? 'o servidor não a reconhece mais')}. O histórico abaixo continua aqui, mas o modelo <strong>não</strong> recebeu as mensagens em diante — o próximo turno começa uma sessão nova.</p>`;

	const streaming =
		conversation?.busy === true
			? `<div class="connection-head"><span class="connection-name">OpenCode</span>${tag('respondendo', 'tone', 'accent')}</div><p class="chat-text" data-role="chat-stream"></p>`
			: '<p class="chat-text" data-role="chat-stream" hidden></p>';

	const composer = `<form id="chat-form" class="toolbar" style="gap: 0.5rem; align-items: flex-end; margin-top: 1rem">
		<label class="field" style="flex: 1">
			<span class="field-label">Mensagem</span>
			<textarea id="chat-input" rows="3" placeholder="${connected ? 'escreva sua mensagem' : 'conecte o OpenCode primeiro'}"${connected && selectable ? '' : ' disabled'}></textarea>
		</label>
		<button type="submit" class="button" id="chat-send"${connected && selectable ? '' : ' disabled'}>Enviar</button>
		<button type="button" class="button danger" data-action="chat-stop"${conversation?.busy === true ? '' : ' disabled'}>Parar</button>
	</form>
	<p class="error" data-role="chat-error" role="alert" hidden></p>`;

	return `${head('Chat', 'Conversa com o OpenCode usando um modelo do catálogo dele.')}
		${status}
		<section class="block">${picker}</section>
		<section class="block"><h2>Conversa</h2>${sessionNote}${history}${streaming}</section>
		${composer}`;
}

function renderOverview(data) {
	const router = data.router ?? {};
	const providers = data.providers ?? {};
	const models = data.models ?? {};
	const stateTag = router.enabled
		? tag('ligado', 'tone', 'ok')
		: tag('desligado', 'tone', 'failed');
	const target =
		router.mode === 'external'
			? router.externalRouterProviderId
			: router.mode === 'direct'
				? router.directProviderId
				: undefined;

	return `${head('Visão geral', 'O estado do roteador e o que está configurado. Estas contagens vêm das listas reais do Core.')}
		<section class="block"><div class="card">
			<h2>Roteador</h2>
			<dl class="facts">
				<div class="fact"><dt>Estado</dt><dd>${stateTag}</dd></div>
				<div class="fact"><dt>Modo</dt><dd>${escapeHtml(modeName(router.mode))}</dd></div>
				<div class="fact"><dt>Destino</dt><dd class="${target === undefined ? 'unknown' : ''}">${escapeHtml(
					target ?? (router.mode === 'native' ? 'a Evelyn escolhe entre os provedores' : 'nenhum escolhido'),
				)}</dd></div>
			</dl>
		</div></section>
		<section class="block"><div class="card">
			<h2>Inventário</h2>
			<dl class="facts">
				${fact('provedores', providers.total)}
				${fact('habilitados', providers.enabled)}
				${fact('roteadores', providers.routers)}
				${fact('modelos conhecidos', models.total)}
			</dl>
		</div></section>
		<section class="block">${pending(
			'Chat e decisões ainda não têm endpoint',
			'A conversa e o histórico de decisões de rota chegam numa fase seguinte. Esta página mostra apenas o que já é lido da API.',
		)}</section>`;
}
/**
 * O estado que a interface guarda entre renders.
 *
 * Hoje só a galeria: a ação "Conectar" precisa da entrada da galeria que o
 * cartão representa, e o cartão é HTML — o dado tem de vir daqui.
 */
const state = { gallery: [], opencode: undefined, opencodeCatalog: undefined, conversation: undefined };


/**
 * Providers: a galeria de integrações, e as conexões que já existem.
 *
 * ## O que a galeria é
 *
 * Um catálogo de **metadados** que vem da API: nome, descrição, método de
 * conexão, categoria e situação do suporte. Ela não afirma que um serviço
 * está no ar — "disponível para conectar" é o app dizendo que tem como tentar.
 *
 * ## Metadado não é conexão
 *
 * Um cartão só aparece como **conectado** quando a API trouxe um provedor
 * real com o mesmo endereço. As conexões são listadas à parte, em "Suas
 * conexões", e são gerenciadas ali.
 */
/**
 * The OpenCode card's own block: the real server state and its actions.
 *
 * ## Why it is not the "connect" button of the gallery
 *
 * The others connect through an OpenAI-compatible endpoint with a key. The
 * OpenCode server has its own routes (`/api/opencode/*`), and its state is
 * what the health check said — not what the gallery catalog assumes. So the
 * block renders the state the API reports, and nothing else: "conectado" only
 * appears when the server answered the health check.
 *
 * The password is typed here and never rendered back: the automatic mode
 * generates its own and does not show it, and the manual one goes with the
 * request only.
 */
function opencodeBlock(entry, opencode) {
	const current = opencode ?? { state: 'not-configured' };
	const label = (current) => {
		switch (current.state) {
			case 'cli-missing':
				return { badge: tag('CLI não encontrada', 'tone', 'failed'), note: 'O CLI `opencode` não foi encontrado no PATH. Instale-o e reabra o app.' };
			case 'disconnected':
				return {
					badge: tag('desconectado', 'tone', 'warning'),
					note: current.reason ?? 'O servidor foi configurado antes, mas não está conectado agora.',
				};
			case 'starting':
				return { badge: tag('iniciando', 'tone', 'accent'), note: 'Aguardando o servidor responder ao health.' };
			case 'connected':
				return {
					badge: tag('conectado', 'tone', 'ok'),
					note: `Health respondido agora. Modo ${current.mode === 'managed' ? 'automático (processo do app)' : 'manual (servidor seu)'}.${current.version === undefined ? '' : ` Versão do servidor: ${current.version}.`}`,
				};
			case 'auth-invalid':
				return { badge: tag('autenticação inválida', 'tone', 'failed'), note: 'O servidor respondeu, mas recusou a senha.' };
			case 'unavailable':
				return { badge: tag('servidor indisponível', 'tone', 'failed'), note: current.reason };
			case 'start-failed':
				return { badge: tag('erro de inicialização', 'tone', 'failed'), note: current.reason };
			default:
				return { badge: tag('desconectado', 'tone', 'warning'), note: 'Nenhum servidor configurado.' };
		}
	};
	const shown = label(current);
	const connected = current.state === 'connected';
	const busy = current.state === 'starting';
	const cliMissing = current.state === 'cli-missing';
	const baseUrl = current.baseUrl ?? '';

	const actions = connected
		? `<button type="button" class="button secondary" data-action="opencode-check">Verificar</button>
			<button type="button" class="button danger" data-action="opencode-disconnect">Desconectar</button>`
		: busy
			? ''
			: `<button type="button" class="button" data-action="opencode-connect-managed"${cliMissing ? ' disabled' : ''}>Conectar (automático)</button>`;

	const manual = connected || busy
		? ''
		: `<div class="toolbar" style="gap: 0.5rem; flex-wrap: wrap">
			<input id="opencode-base-url" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:4096" value="${escapeHtml(baseUrl)}" aria-label="Endereço do servidor OpenCode" />
			<input id="opencode-password" type="password" autocomplete="new-password" spellcheck="false" placeholder="senha do servidor" aria-label="Senha do servidor OpenCode" />
			<button type="button" class="button secondary" data-action="opencode-connect-manual">Conectar (manual)</button>
		</div>
		<p class="muted small" data-role="opencode-manual-note" hidden></p>`;

	return `<div class="block" data-role="opencode">
		<div class="connection-head">
			<span class="connection-name">Servidor OpenCode</span>
			${shown.badge}
		</div>
		<p class="muted small">${escapeHtml(shown.note)}</p>
		${baseUrl === '' ? '' : `<p class="mono">${escapeHtml(baseUrl)}</p>`}
		${manual}
		<div class="connection-actions">${actions}</div>
		${opencodeCatalogBlock(connected)}
	</div>`;
}

/**
 * O catálogo de modelos do OpenCode: o que se leu, quando, e se está atual.
 *
 * ## O que a tela diz, e o que ela não diz
 *
 * Diz a data da descoberta, quantos provedores e modelos o servidor
 * publicou, quais provedores têm credencial (quando o CLI conseguiu
 * confirmar) e, se a última tentativa falhou, o motivo — mantendo os
 * resultados anteriores **marcados como desatualizados**.
 *
 * Não diz preço, limite, capacidade nem disponibilidade gratuita: o servidor
 * os publica, mas a Evelyn não os adotou (não os verifica, e a semântica do
 * OpenCode não é a dela). Não mostra corpo de resposta nem credencial.
 *
 * ## Por que não é o catálogo de Models
 *
 * O OpenCode decide internamente qual provedor/modelo usar. Um modelo dele
 * não é um provedor OpenAI-compatible e **não** é selecionável para
 * execução: o adaptador de conversa não existe. Por isso este bloco aparece
 * aqui, separado, e a tabela de Models não o inclui.
 */
function opencodeCatalogBlock(connected) {
	const current = state.opencodeCatalog ?? { state: 'never' };
	const date = (iso) => {
		if (typeof iso !== 'string') {
			return 'desconhecida';
		}
		const parsed = new Date(iso);
		return Number.isNaN(parsed.getTime()) ? 'desconhecida' : parsed.toLocaleString('pt-BR');
	};

	const update = `<button type="button" class="button secondary" data-action="opencode-refresh-catalog"${connected ? '' : ' disabled'}>Atualizar catálogo</button>`;

	if (current.state === 'never') {
		return `<div class="block" data-role="opencode-catalog" style="margin-top: 1rem">
			<div class="connection-head">
				<span class="connection-name">Catálogo de modelos</span>
				${tag('nunca atualizado', 'tone', 'warning')}
			</div>
			<p class="muted small">${connected ? 'Nenhuma descoberta ainda. O catálogo é lido do próprio servidor, só com a conexão autenticada.' : 'Conecte um servidor para ler o catálogo.'}</p>
			<div class="connection-actions">${update}</div>
		</div>`;
	}

	if (current.state === 'failed') {
		return `<div class="block" data-role="opencode-catalog" style="margin-top: 1rem">
			<div class="connection-head">
				<span class="connection-name">Catálogo de modelos</span>
				${tag('falhou', 'tone', 'failed')}
			</div>
			<p class="error" role="alert">${escapeHtml(current.reason)}</p>
			<p class="muted small">Nenhum catálogo anterior para manter. Tentativa em ${escapeHtml(date(current.failedAt))}.</p>
			<div class="connection-actions">${update}</div>
		</div>`;
	}

	const catalog = current.catalog ?? { providers: [], models: [] };
	const stale = current.state === 'stale';
	const providers = catalog.providers ?? [];
	const models = catalog.models ?? [];
	const connectedProviders = providers.filter((provider) => provider.connected);
	const unknown = current.connectionsUnknown === true;

	const rows = providers
		.map((provider) => {
			const providerModels = models.filter((model) => model.providerId === provider.id);
			const active = providerModels.filter((model) => model.status === 'active').length;
			const inactive = provider.modelCount - active;
			return `<tr>
				<td><strong>${escapeHtml(provider.name ?? provider.id)}</strong><br /><span class="muted small mono">${escapeHtml(provider.id)}</span></td>
				<td>${provider.connected ? tag('com credencial', 'tone', 'ok') : tag('sem credencial', 'tone', unknown ? 'warning' : 'failed')}</td>
				<td class="num">${provider.modelCount}</td>
				<td class="num">${active}${inactive === 0 ? '' : `<br /><span class="muted small">${inactive} sem status ativo</span>`}</td>
			</tr>`;
		})
		.join('');

	return `<div class="block" data-role="opencode-catalog" style="margin-top: 1rem">
		<div class="connection-head">
			<span class="connection-name">Catálogo de modelos</span>
			${stale ? tag('desatualizado', 'tone', 'warning') : tag('atualizado', 'tone', 'ok')}
		</div>
		${stale ? `<p class="error" role="alert">A última atualização falhou: ${escapeHtml(current.reason)}. Os resultados abaixo são de ${escapeHtml(date(catalog.discoveredAt))} e continuam válidos como leitura anterior.</p>` : ''}
		<dl class="facts">
			${fact('última descoberta', date(catalog.discoveredAt))}
			${fact('provedores', String(providers.length))}
			${fact('modelos', String(models.length))}
			${fact('com credencial', unknown ? 'não confirmado' : String(connectedProviders.length), { unknown: 'não confirmado' })}
		</dl>
		<p class="muted small">${unknown ? 'O CLI do OpenCode não respondeu à consulta de credenciais; por isso nenhum provedor é marcado como conectado.' : 'Os modelos são identificados pelo par provedor/modelo, como o servidor os publica.'}</p>
		<p class="muted small">O OpenCode decide internamente qual provedor e modelo usar. Nesta etapa o app só lê e mostra o catálogo: estes modelos <strong>não podem ser escolhidos para conversas</strong> — o adaptador de conversa ainda não existe.</p>
		${providers.length === 0 ? empty('O catálogo não tem provedores.') : `<div class="card"><table class="table"><thead><tr><th>provedor</th><th>credencial</th><th>modelos</th><th>ativos</th></tr></thead><tbody>${rows}</tbody></table></div>`}
		<div class="connection-actions">${update}</div>
	</div>`;
}

function renderProviders(data) {
	const providers = data.providers ?? [];
	const gallery = data.gallery ?? [];
	state.gallery = gallery;
	state.opencode = data.opencode;
	state.opencodeCatalog = data.opencodeCatalog;
	const models = data.models ?? [];

	const toolbar = `<div class="toolbar"><button type="button" class="button" data-action="add-provider">Adicionar provedor personalizado</button></div>`;

	if (providers.length === 0 && gallery.length === 0) {
		return `${head('Providers', 'Conecte um provedor de modelos.')}
			${toolbar}
			${empty('Nenhuma integração disponível nesta instalação.')}`;
	}

	// As conexões reais, em cartões próprios e gerenciáveis.
	const own = providers
		.map((provider) => {
			const discovered = models.filter((model) => model.providerId === provider.id);
			return `<article class="connection-card" data-role="${escapeHtml(provider.role === 'router' ? 'router' : 'provider')}">
				<div class="connection-head">
					<span class="connection-name">${escapeHtml(provider.name)}</span>
					${tag(provider.role === 'router' ? 'Roteador' : 'Provedor', 'tone', provider.role === 'router' ? 'accent' : undefined)}
					${tag(provider.status === 'disabled' ? 'desabilitado' : 'habilitado', 'tone', provider.status === 'disabled' ? 'failed' : 'ok')}
					${tag(provider.hasApiKeyRef ? 'chave configurada' : 'sem chave', 'origin', provider.hasApiKeyRef ? 'ours' : 'unknown')}
				</div>
				<p class="mono">${escapeHtml(provider.baseUrl)}</p>
				<p class="muted small">${discovered.length === 0 ? 'nenhum modelo descoberto' : `${discovered.length} modelo(s) descoberto(s)`}</p>
				<div class="connection-actions">
					<button type="button" class="button secondary" data-action="edit-provider" data-provider="${escapeHtml(provider.id)}">Editar</button>
					<button type="button" class="button secondary" data-action="test-provider" data-provider="${escapeHtml(provider.id)}">Testar conexão</button>
					<button type="button" class="button secondary" data-action="discover-provider" data-provider="${escapeHtml(provider.id)}" data-name="${escapeHtml(provider.name)}">Descobrir modelos</button>
					<button type="button" class="button secondary" data-action="toggle-provider" data-provider="${escapeHtml(provider.id)}" data-enabled="${provider.status === 'disabled' ? 'true' : 'false'}">${provider.status === 'disabled' ? 'Habilitar' : 'Desabilitar'}</button>
					<button type="button" class="button danger" data-action="remove-provider" data-provider="${escapeHtml(provider.id)}" data-name="${escapeHtml(provider.name)}">Remover</button>
				</div>
			</article>`;
		})
		.join('');

	/** O estado de um cartão, como etiqueta e o que ela significa. */
	const stateOf = (entry) => {
		switch (entry.state) {
			case 'connected':
				return { badge: tag('conectado', 'tone', 'ok'), note: 'Esta conexão existe no app.' };
			case 'available':
				return { badge: tag('disponível', 'tone', 'accent'), note: 'O app suporta conectar por chave de API.' };
			case 'needs-auth':
				return { badge: tag('autenticação necessária', 'tone', 'warning'), note: 'Exige login numa ferramenta externa, que o app não executa.' };
			case 'experimental':
				return { badge: tag('experimental', 'tone', 'warning'), note: 'Funciona, mas o endereço e o suporte são seus.' };
			default:
				return { badge: tag('indisponível', 'tone', 'failed'), note: 'O app não tem método para conectar esta integração.' };
		}
	};

	const card = (entry) => {
		const badges = stateOf(entry);
		const action = entry.managedServer === true
			? ''
			: entry.state === 'connected'
				? `<button type="button" class="button secondary" data-action="edit-provider" data-provider="${escapeHtml(entry.providerId)}">Gerenciar conexão</button>`
				: entry.state === 'available' || entry.state === 'experimental'
					? `<button type="button" class="button" data-action="connect-integration" data-integration="${escapeHtml(entry.id)}">Conectar</button>`
					: '';
		// A integração com servidor próprio mostra o estado dela, e não o
		// veredito do catálogo: quem sabe se o servidor respondeu é o health.
		const serverBlock = entry.managedServer === true ? opencodeBlock(entry, state.opencode) : '';
		return `<article class="gallery-card">
			<div class="connection-head">
				<span class="connection-name">${escapeHtml(entry.name)}</span>
				${entry.managedServer === true ? '' : badges.badge}
			</div>
			<p class="muted small">${escapeHtml(entry.description)}</p>
			<dl class="facts">
				${fact('método', entry.connection === 'api-key' ? 'chave de API' : entry.connection === 'cli-or-oauth' ? 'login externo (CLI/OAuth)' : 'configuração manual')}
				${fact('categoria', entry.categoryLabel)}
				${fact('suporte', entry.support === 'supported' ? 'suportado' : entry.support === 'experimental' ? 'experimental' : 'não suportado')}
			</dl>
			<p class="muted small">${escapeHtml(badges.note)}</p>
			${entry.baseUrl === undefined ? '' : `<p class="mono">${escapeHtml(entry.baseUrl)}</p>`}
			${entry.requires?.length ? `<p class="muted small">Precisa de: ${escapeHtml(entry.requires.join(', '))}.</p>` : ''}
			${entry.limitation === undefined ? '' : `<p class="muted small">${escapeHtml(entry.limitation)}</p>`}
			${entry.instructions === undefined ? '' : `<p class="muted small">${escapeHtml(entry.instructions)}</p>`}
			${serverBlock}
			${action === '' ? '' : `<div class="connection-actions">${action}</div>`}
		</article>`;
	};

	const categoryOrder = ['official', 'free-via-tools', 'experimental'];
	const categories = categoryOrder
		.map((category) => {
			const entries = gallery.filter((entry) => entry.category === category);
			if (entries.length === 0) {
				return '';
			}
			return `<section class="block"><h2>${escapeHtml(entries[0].categoryLabel)}</h2><div class="grid">${entries.map(card).join('')}</div></section>`;
		})
		.join('');

	return `${head('Providers', 'Descubra um provedor para conectar, ou gerencie as conexões que já existem. “Conectado” só aparece quando a conexão existe de verdade no app.')}
		${toolbar}
		${own === '' ? '' : `<section class="block"><h2>Suas conexões</h2><div class="stack">${own}</div></section>`}
		${gallery.length === 0 ? empty('A galeria está vazia.') : categories}`;
}

/**
 * Models: o catálogo, com a origem de cada lado.
 *
 * Três colunas de fato, e nenhuma inventada: **publicado** é o que o
 * endpoint listou (com a data da verificação), **declarado** é o que o
 * usuário gravou, e o **fundido** é o que vale hoje — com o lado que o
 * sustenta. Um modelo sem preço não ganha um; um modelo fora da última
 * listagem continua aqui, marcado.
 */
function renderModels(data) {
	const models = data.models ?? [];
	const discovered = data.discovered ?? [];
	const declared = data.declared ?? [];

	const pending = `<section class="block">${pendingBlock(
		'Editar preço, acesso e capacidades',
		'Esta página lê o catálogo. Declarar preço ou limites de um modelo chega numa fase seguinte; nada aqui é gravado.',
	)}</section>`;

	if (models.length === 0) {
		return `${head('Models', 'Os modelos que o Core conhece, com preço, acesso e a origem de cada um.')}
			${empty('Nenhum modelo conhecido ainda. Abra Providers e use “Descobrir modelos” numa conexão.')}
			${pending}`;
	}

	const rows = models
		.map((model) => {
			const price = priceText(model);
			const access = accessText(model);
			const found = discovered.find(
				(entry) => entry.providerId === model.providerId && entry.modelId === model.modelId,
			);
			const isDeclared = declared.some(
				(entry) => entry.providerId === model.providerId && entry.modelId === model.modelId,
			);
			return `<tr>
				<td><strong>${escapeHtml(model.modelId)}</strong><br /><span class="muted small">${escapeHtml(model.providerId)}</span></td>
				<td>${escapeHtml(price.value)}<br />${tag(originLabel(price.origin), 'origin', price.origin)}</td>
				<td>${escapeHtml(access.value)}<br />${tag(originLabel(access.origin), 'origin', access.origin)}</td>
				<td>${found === undefined ? tag('não publicado', 'origin', 'unknown') : tag(found.listed === false ? 'fora da listagem' : 'publicado', 'tone', found.listed === false ? 'warning' : 'ok')}${found?.listedAt === undefined ? '' : `<br /><span class="muted small">em ${escapeHtml(found.listedAt)}</span>`}</td>
				<td>${isDeclared ? tag('declarado', 'origin', 'ours') : tag('não declarado', 'origin', 'unknown')}</td>
			</tr>`;
		})
		.join('');

	return `${head('Models', 'Os modelos que o Core conhece, com preço, acesso e a origem de cada um. Desconhecido é desconhecido: não há valor inventado.')}
		<div class="card"><table class="table"><thead><tr><th>modelo</th><th>preço</th><th>acesso</th><th>publicado</th><th>declarado</th></tr></thead><tbody>${rows}</tbody></table></div>
		${pending}`;
}

/**
 * O estado da configuração do roteador, a partir do que a API devolveu.
 *
 * A API manda os fatos (`configured`, `unreadable`, `recoveredFromBackup`);
 * os quatro estados são derivados aqui pela mesma regra que o Core documenta,
 * para a página nunca dizer "configurado" de um padrão que está no lugar de
 * um arquivo ilegível.
 */
function routerStatusOf(config) {
	if (typeof config.unreadable === 'string' && config.unreadable.length > 0) {
		return 'unreadable';
	}
	if (config.recoveredFromBackup === true) {
		return 'recovered';
	}
	return config.configured === true ? 'normal' : 'unset';
}

/** A faixa que diz o estado da configuração no topo da página Routing. */
function routerStatusBanner(config) {
	const status = routerStatusOf(config);
	if (status === 'normal') {
		return `<p class="test-result" data-ok="true" role="status">Configuração normal: lida do arquivo do roteador.</p>`;
	}
	if (status === 'recovered') {
		return `<div class="pending"><div><div class="pending-title">Configuração recuperada</div><p class="pending-text">O arquivo do roteador estava ausente ou inválido, e a última escolha válida foi recuperada da cópia de segurança. Confira o modo e o destino abaixo e salve para gravar a configuração de novo.</p></div></div>`;
	}
	if (status === 'unreadable') {
		return `<p class="error" role="alert">A configuração do roteador não pôde ser lida e não há cópia de segurança válida. As requisições estão usando os valores padrão — este NÃO é o estado configurado. Repare o arquivo do roteador antes de salvar: o botão Salvar está desabilitado para não sobrescrever a configuração que ainda pode existir.</p>`;
	}
	return `<div class="pending"><div><div class="pending-title">Configuração ainda não definida</div><p class="pending-text">Nenhum roteador foi escolhido ainda. Enquanto isso, a Evelyn usa o modo nativo.</p></div></div>`;
}

/**
 * Routing: o que está gravado, e o que pode ser mudado.
 *
 * Quatro opções, e só elas: ligado/desligado, modo, destino do modo externo,
 * destino do modo direto. Não há estratégia, peso nem ordem de fallback —
 * o motor de rota não tem esses campos, e uma tela não os inventa.
 *
 * Um destino que não pode ser usado agora aparece com o motivo em vez de
 * sumir: o usuário precisa saber que o provedor existe e está desabilitado,
 * não achar que ele nunca foi criado.
 */
function renderRouting(data) {
	const config = data.config ?? {};
	const targets = data.targets ?? [];
	const usable = targets.filter((target) => target.usable);
	const current =
		config.mode === 'external' ? config.externalRouterProviderId : config.directProviderId;

	const option = (target, selected) =>
		`<option value="${escapeHtml(target.id)}"${target.id === selected ? ' selected' : ''}${target.usable ? '' : ' disabled'}>
			${escapeHtml(target.name)}${target.usable ? '' : ' — desabilitado'}
		</option>`;

	const targetsSection =
		targets.length === 0
			? `${empty('Nenhum provedor configurado. Adicione uma conexão em Providers para ter destinos.')}`
			: `<ul class="model-list">${targets
					.map(
						(target) => `<li class="model-row">
							<span class="model-name">${escapeHtml(target.name)}</span>
							<span class="model-facts">
								${tag(target.role === 'router' ? 'Roteador' : 'Provedor', 'tone', target.role === 'router' ? 'accent' : undefined)}
								${target.usable ? tag('elegível', 'tone', 'ok') : tag('não elegível', 'tone', 'failed')}
								${target.usable ? '' : `<span class="muted small">${escapeHtml(target.reason ?? '')}</span>`}
								<span class="muted small mono">${escapeHtml(target.baseUrl)}</span>
							</span>
						</li>`,
					)
					.join('')}</ul>`;

	const status = routerStatusOf(config);
	const canSave = status !== 'unreadable';
	const statusText = `gravado: ${modeName(config.mode)} · ${config.enabled ? 'ligado' : 'desligado'}${current === undefined ? '' : ` · destino ${current}`}`;

	return `${head('Routing', 'Onde a requisição vai, e se ela vai. As opções abaixo são as que o motor de rota já obedece — e nada além delas.')}
		${routerStatusBanner(config)}
		<section class="block"><div class="card">
			<h2>Configuração</h2>
			<div class="grid">
				<label class="field">
					<span class="field-label">Estado</span>
					<select id="routing-enabled">
						<option value="true"${config.enabled ? ' selected' : ''}>Ligado</option>
						<option value="false"${config.enabled ? '' : ' selected'}>Desligado</option>
					</select>
					<span class="field-hint">Desligado, nenhuma requisição começa.</span>
				</label>

				<label class="field">
					<span class="field-label">Modo</span>
					<select id="routing-mode">
						<option value="native"${config.mode === 'native' ? ' selected' : ''}>Nativo — a Evelyn escolhe</option>
						<option value="external"${config.mode === 'external' ? ' selected' : ''}>Externo — um roteador escolhe</option>
						<option value="direct"${config.mode === 'direct' ? ' selected' : ''}>Direto — o provedor atende</option>
					</select>
					<span class="field-hint">Quem escolhe o modelo.</span>
				</label>
			</div>

			<div class="grid" style="margin-top: 12px;">
				<label class="field">
					<span class="field-label">Roteador externo</span>
					<select id="routing-external">
						<option value="">escolha um endpoint</option>
						${usable.map((target) => option(target, config.externalRouterProviderId)).join('')}
					</select>
					<span class="field-hint">O endpoint que decide o modelo no modo externo.</span>
				</label>

				<label class="field">
					<span class="field-label">Provedor direto</span>
					<select id="routing-direct">
						<option value="">escolha um endpoint</option>
						${usable.map((target) => option(target, config.directProviderId)).join('')}
					</select>
					<span class="field-hint">O endpoint que atende no modo direto.</span>
				</label>
			</div>

			<p class="error" id="routing-form-error" role="alert" hidden></p>

			<div class="actions" style="margin-top: 14px;">
				<button type="button" class="button" id="routing-save"${canSave ? '' : ' disabled'}>Salvar</button>
				${status === 'unreadable' ? '<button type="button" class="button danger" id="routing-reset">Redefinir para o padrão</button>' : ''}
				<button type="button" class="button secondary" id="routing-reload">Recarregar</button>
				<span class="muted small" id="routing-current">${escapeHtml(
					status === 'unreadable'
						? 'gravado: nenhum — o arquivo não pôde ser lido'
						: status === 'unset'
							? 'gravado: nenhum — ainda não definido'
							: statusText,
				)}</span>
			</div>
		</div></section>

		<section class="block"><div class="card">
			<h2>Destinos</h2>
			${targetsSection}
		</div></section>

		<section class="block">${pendingBlock(
			'Histórico de decisões',
			'A última decisão de rota e o motivo de cada escolha chegam numa fase seguinte.',
		)}</section>`;
}

/** Usage: the spend and the limits. */
function renderUsage(data) {
	const month = data.month;
	const day = data.day;
	const limits = data.limits ?? [];
	const alerts = data.alerts ?? [];
	const cost = month?.total?.cost;
	const costText =
		cost === undefined
			? { value: 'desconhecido', unknown: true }
			: cost.status === 'estimated'
				? { value: `${cost.total} ${cost.currency}`, unknown: false }
				: { value: `desconhecido`, unknown: true };

	const limitsRows =
		limits.length === 0
			? empty('Nenhum limite de gasto configurado.')
			: `<table class="table"><thead><tr><th>escopo</th><th>valor</th></tr></thead><tbody>${limits
					.map(
						(limit) =>
							`<tr><td>${escapeHtml(limit.scope ?? '—')}</td><td>${escapeHtml(limit.limit ?? '—')}</td></tr>`,
					)
					.join('')}</tbody></table>`;

	return `${head('Usage', 'O consumo do período, como o registro de consumo do Core o contabiliza.')}
		<section class="block"><div class="card">
			<dl class="facts">
				${fact('execuções no mês', month?.total?.usage?.executions)}
				${fact('tentativas', month?.total?.usage?.attempts)}
				${fact('execuções hoje', day?.total?.usage?.executions)}
				<div class="fact"><span class="fact-label">custo do mês</span><span class="fact-value ${costText.unknown ? 'unknown' : ''}">${escapeHtml(costText.value)}</span></div>
			</dl>
		</div></section>
		<section class="block"><div class="card"><h2>Limites</h2>${limitsRows}</div></section>
		<section class="block"><div class="card"><h2>Avisos</h2>${
			alerts.length === 0 ? empty('Nenhum aviso no período.') : `<p class="small muted">${alerts.length} aviso(s).</p>`
		}</div></section>`;
}

/** Settings: the access policy and the projects. */
function renderSettings(data) {
	const policy = data.policy ?? {};
	const projects = data.projects ?? [];
	const policyText =
		policy.policy === 'free_only'
			? 'Somente gratuitos confirmados'
			: policy.policy === 'free_preferred'
				? 'Gratuitos primeiro, demais permitidos'
				: 'Sem filtro de acesso';
	const projectsText =
		projects.length === 0 ? empty('Nenhum projeto configurado.') : `<p class="small">${projects.length} projeto(s).</p>`;
	return `${head('Settings', 'A política de acesso e as fontes de preço, limites e capacidades. Alterá-las chega numa fase seguinte.')}
		<section class="block"><div class="card">
			<h2>Política de acesso</h2>
			<dl class="facts">
				${fact('política', policyText)}
				${fact('preço usado', policy.priceSource === 'user' ? 'o declarado' : 'o do provedor')}
				${fact('limites usados', policy.limitsSource === 'user' ? 'os declarados' : 'os do provedor')}
				${fact('capacidades usadas', policy.capabilitiesSource === 'user' ? 'as declaradas' : 'as do provedor')}
			</dl>
		</div></section>
		<section class="block"><div class="card"><h2>Projetos</h2>${projectsText}</div></section>
		<section class="block">${pending(
			'Edição da política e dos provedores',
			'A escrita chega numa fase seguinte. Esta página mostra o que está gravado e não oferece controle que ainda não grava nada.',
		)}</section>`;
}

/* ── diagnóstico de turnos (R4J) ──────────────────────────────────────────── */

/**
 * O estado dos filtros do diagnóstico.
 *
 * Fica fora do DOM para a consulta não depender de o formulário estar
 * montado — a área é redesenhada a cada página, e reler os campos depois
 * disso leria campos que já não existem.
 */
const TURN_FILTERS = {
	status: 'all',
	since: '',
	until: '',
	limit: '50',
	offset: 0,
};

/** Os estados, como a interface os chama. */
const TURN_STATUS_LABEL = {
	running: 'em curso',
	completed: 'concluído',
	failed: 'falhou',
	cancelled: 'cancelado',
	interrupted: 'interrompido',
};

/**
 * A cor da etiqueta de um estado.
 *
 * Reaproveita as tonalidades do painel. `interrupted` tem a sua própria
 * (amarelo de aviso): não é falha do modelo nem cancelamento do usuário —
 * é a resposta que o serviço não chegou a terminar.
 */
function turnTone(status) {
	if (status === 'completed') {
		return 'ok';
	}
	if (status === 'failed') {
		return 'failed';
	}
	if (status === 'running') {
		return 'accent';
	}
	if (status === 'interrupted') {
		return 'warning';
	}
	return 'unknown';
}

/** O nome do estado, ou o valor cru quando o serviço mandar outro. */
function turnStatusName(status) {
	return TURN_STATUS_LABEL[status] ?? String(status);
}

/**
 * Uma data ISO, em horário local.
 *
 * O valor persistido não muda: ele é mostrado como veio no `title`, e a
 * leitura local é só o que o usuário vê. Uma data ilegível é mostrada como
 * veio, nunca inventada.
 */
function localTime(iso) {
	if (typeof iso !== 'string' || iso.length === 0) {
		return { text: '—', iso: undefined };
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return { text: iso, iso: undefined };
	}
	return { text: date.toLocaleString('pt-BR'), iso };
}

/** A célula de uma data: local à vista, ISO no `title`. */
function timeCell(iso) {
	const shown = localTime(iso);
	return shown.iso === undefined
		? `<td>${escapeHtml(shown.text)}</td>`
		: `<td title="${escapeHtml(shown.iso)}">${escapeHtml(shown.text)}</td>`;
}

/** A consulta, a partir dos filtros. */
function turnQuery(offset) {
	const query = new URLSearchParams();
	if (TURN_FILTERS.status !== 'all') {
		query.set('status', TURN_FILTERS.status);
	}
	if (TURN_FILTERS.since.length > 0) {
		query.set('since', new Date(TURN_FILTERS.since).toISOString());
	}
	if (TURN_FILTERS.until.length > 0) {
		query.set('until', new Date(TURN_FILTERS.until).toISOString());
	}
	query.set('limit', TURN_FILTERS.limit);
	query.set('offset', String(offset));
	return `/api/turns?${query.toString()}`;
}

/** O formulário de filtros. */
function turnFilterForm() {
	const options = [
		['all', 'todos'],
		['running', TURN_STATUS_LABEL.running],
		['completed', TURN_STATUS_LABEL.completed],
		['failed', TURN_STATUS_LABEL.failed],
		['cancelled', TURN_STATUS_LABEL.cancelled],
		['interrupted', TURN_STATUS_LABEL.interrupted],
	]
		.map(
			([value, label]) =>
				`<option value="${value}"${TURN_FILTERS.status === value ? ' selected' : ''}>${escapeHtml(label)}</option>`,
		)
		.join('');
	return `<form class="toolbar turn-filters" data-role="turn-filters">
		<label class="field"><span class="field-label">estado</span>
			<select name="status" data-role="turn-status">${options}</select>
		</label>
		<label class="field"><span class="field-label">de</span>
			<input type="datetime-local" name="since" value="${escapeHtml(TURN_FILTERS.since)}">
		</label>
		<label class="field"><span class="field-label">até</span>
			<input type="datetime-local" name="until" value="${escapeHtml(TURN_FILTERS.until)}">
		</label>
		<label class="field"><span class="field-label">por página</span>
			<select name="limit" data-role="turn-limit">
				${['25', '50', '100', '200']
					.map((value) => `<option value="${value}"${TURN_FILTERS.limit === value ? ' selected' : ''}>${value}</option>`)
					.join('')}
			</select>
		</label>
		<button type="submit" class="button">Aplicar</button>
	</form>`;
}

/**
 * A área de turnos.
 *
 * É diagnóstico: mostra o que o registro gravou e não oferece ação nenhuma
 * sobre o turno. Um `running` aparece como `running` — a recuperação é quem
 * o converte, na inicialização do serviço, e afirmar um desfecho aqui seria
 * dizer o que ninguém observou.
 */
function renderTurns(data) {
	const turns = data.turns ?? [];
	const total = typeof data.total === 'number' ? data.total : turns.length;
	const limit = typeof data.limit === 'number' ? data.limit : turns.length;
	const offset = typeof data.offset === 'number' ? data.offset : 0;

	const rows = turns
		.map(
			(turn) => `<tr${turn.status === 'interrupted' ? ' class="interrupted"' : ''}>
				<td><code>${escapeHtml(turn.turnId ?? '—')}</code></td>
				<td><code>${escapeHtml(turn.conversationId ?? '—')}</code></td>
				<td><span class="tag" data-tone="${turnTone(turn.status)}">${escapeHtml(turnStatusName(turn.status))}</span></td>
				${timeCell(turn.startedAt)}
				${timeCell(turn.finishedAt ?? '')}
				<td>${turn.reason === undefined ? '—' : escapeHtml(turn.reason)}</td>
			</tr>`,
		)
		.join('');

	const table =
		turns.length === 0
			? empty(
					TURN_FILTERS.status === 'all'
						? 'Nenhum turno registrado ainda.'
						: `Nenhum turno com o estado "${turnStatusName(TURN_FILTERS.status)}".`,
				)
			: `<div class="card"><table class="table turns"><thead><tr><th>turno</th><th>conversa</th><th>estado</th><th>início</th><th>término</th><th>motivo</th></tr></thead><tbody>${rows}</tbody></table></div>`;

	const firstShown = total === 0 ? 0 : offset + 1;
	const lastShown = Math.min(offset + turns.length, total);
	const previous = offset > 0 ? Math.max(0, offset - limit) : undefined;
	const next = offset + limit < total ? offset + limit : undefined;
	const pager = `<div class="toolbar pager">
		<span class="muted small">${firstShown}–${lastShown} de ${total}</span>
		${previous === undefined ? '' : `<button type="button" class="button secondary" data-action="turns-page" data-offset="${previous}">Anterior</button>`}
		${next === undefined ? '' : `<button type="button" class="button secondary" data-action="turns-page" data-offset="${next}">Próxima</button>`}
	</div>`;

	return `${head('Turnos', 'O registro de ciclo de vida dos turnos: estado, datas e motivo. Não mostra o conteúdo das mensagens.')}
		<section class="block">${turnFilterForm()}${table}${pager}</section>
		<section class="block"><div class="card">
			<p class="muted small">Um turno <strong>interrompido</strong> é um turno que o serviço encerrou antes de terminar — ele aparece assim depois que o serviço reinicia. Um turno <strong>em curso</strong> aqui é o último estado gravado; se o serviço estiver no ar e ele não estiver rodando, a resposta foi interrompida e o registro ainda não passou pela recuperação.</p>
			<p class="muted small">Datas em horário local; o valor gravado aparece ao manter o ponteiro sobre a data. Turnos antigos podem não aparecer: o registro é limitado por idade e quantidade.</p>
		</div></section>`;
}

/** Recarrega a área de turnos com os filtros atuais. */
async function loadTurns(offset) {
	main.innerHTML = loading();
	try {
		const data = await getJson(turnQuery(offset));
		setSession(true, 'sessão ativa');
		main.innerHTML = renderTurns(data);
		bindTurnFilters();
	} catch (error) {
		setSession(error?.status !== 401, error?.status === 401 ? 'sem sessão' : 'sessão ativa');
		// R4K: um registro corrompido **não** é um erro genérico. A tela
		// precisa dizer que o diagnóstico está indisponível por isso, e
		// oferecer as duas ações — sem elas, o operador não tinha como
		// recuperar pela interface.
		if (error?.status === 503 && error?.code === 'turns_corrupt') {
			main.innerHTML = renderTurnsCorrupt(error.reason);
			return;
		}
		main.innerHTML = `${head('Turnos', '')}${errorBox(
			error instanceof Error ? error.message : String(error),
			error?.status,
		)}`;
	}
}

/**
 * A área de turnos com o registro corrompido (R4K).
 *
 * Três coisas, nesta ordem: o que aconteceu, o que ainda dá para preservar, e
 * o que é destrutivo. O texto não inventa o conteúdo perdido — "os estados
 * anteriores podem ter se perdido" é tudo o que se sabe — e a
 * reinicialização avisa o mesmo antes de acontecer.
 */
function renderTurnsCorrupt(reason) {
	const detail =
		typeof reason === 'string' && reason.length > 0
			? `<p class="muted small">Motivo: ${escapeHtml(reason)}.</p>`
			: '';
	return `${head('Turnos', 'O registro de ciclo de vida dos turnos: estado, datas e motivo. Não mostra o conteúdo das mensagens.')}
		<section class="block">
			<p class="error" role="alert">O diagnóstico dos turnos está indisponível: o registro de turnos está corrompido e não pode ser lido.</p>
			${detail}
		</section>
		<section class="block"><div class="card">
			<p>O arquivo do registro não foi alterado. As conversas continuam abrindo normalmente; apenas a lista de turnos e a nota de turno interrompido ficam indisponíveis.</p>
			<p class="muted small">Quando o registro está corrompido, novos turnos não são iniciados: sem poder registrar o começo e o fim, a próxima inicialização não saberia que eles existiram. As conversas continuam utilizáveis — o registro vale para o diagnóstico.</p>
			<p class="muted small"><strong>Copiar</strong> guarda uma cópia do arquivo como está, sem alterá-lo, e não sobrescreve cópias anteriores. <strong>Reiniciar o registro</strong> começa um novo, vazio: os estados anteriores não podem ser comprovados a partir de um arquivo ilegível, e <strong>podem ter se perdido</strong>. Faça a cópia antes.</p>
			<div class="toolbar">
				<button type="button" class="button secondary" id="turns-backup">Copiar o registro</button>
				<button type="button" class="button danger" id="turns-reset">Reiniciar o registro</button>
			</div>
			<p class="muted small" id="turns-recovery-result" role="status" hidden></p>
		</div></section>`;
}

/** Copia o registro corrompido, para o operador decidir depois (R4K). */
async function backupTurns() {
	const button = document.querySelector('#turns-backup');
	const result = document.querySelector('#turns-recovery-result');
	button.disabled = true;
	button.textContent = 'copiando…';
	try {
		const data = await postJson('/api/turns/recover/backup', {});
		result.hidden = false;
		result.dataset.ok = 'true';
		result.textContent = `Cópia guardada como ${data.backup} (${data.bytes} bytes). O registro original não foi alterado; reiniciar o registro não apaga esta cópia.`;
		button.textContent = 'Copiar o registro';
	} catch (error) {
		result.hidden = false;
		result.dataset.ok = 'false';
		result.textContent = error instanceof Error ? error.message : String(error);
		button.textContent = 'Copiar o registro';
	} finally {
		button.disabled = false;
	}
}

/**
 * Começa um registro novo, vazio (R4K).
 *
 * A confirmação é explícita porque a ação é destrutiva e irreversível no
 * serviço: o que não foi copiado antes deixa de estar disponível ali. Se o
 * servidor recusar (registro válido, sessão expirada), o aviso fica na tela.
 */
async function resetTurns() {
	const confirmed = window.confirm(
		'Reiniciar o registro de turnos?\n\n' +
			'O arquivo atual será substituído por um registro vazio. Os estados anteriores não podem ser recuperados a partir de um arquivo ilegível e podem ter se perdido.\n\n' +
			'Para guardar uma cópia do arquivo antes, cancele e use "Copiar o registro".',
	);
	if (!confirmed) {
		return;
	}
	const button = document.querySelector('#turns-reset');
	const result = document.querySelector('#turns-recovery-result');
	button.disabled = true;
	button.textContent = 'reiniciando…';
	try {
		await postJson('/api/turns/recover/reset', {});
		TURN_FILTERS.offset = 0;
		await loadTurns(0);
	} catch (error) {
		result.hidden = false;
		result.dataset.ok = 'false';
		result.textContent = error instanceof Error ? error.message : String(error);
		button.disabled = false;
		button.textContent = 'Reiniciar o registro';
	}
}

/** Liga o formulário de filtros da área redesenhada. */
function bindTurnFilters() {
	const form = main.querySelector('[data-role="turn-filters"]');
	if (form === null) {
		return;
	}
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		const fields = new FormData(form);
		const status = fields.get('status');
		const since = fields.get('since');
		const until = fields.get('until');
		const limit = fields.get('limit');
		TURN_FILTERS.status = typeof status === 'string' && status.length > 0 ? status : 'all';
		TURN_FILTERS.since = typeof since === 'string' ? since : '';
		TURN_FILTERS.until = typeof until === 'string' ? until : '';
		TURN_FILTERS.limit = typeof limit === 'string' && limit.length > 0 ? limit : '50';
		// Um filtro novo começa da primeira página: manter o deslocamento
		// antigo mostraria "página 3" de um conjunto que acabou de mudar.
		void loadTurns(0);
	});
}

/** The renderer of each area. */
const RENDERERS = {
	overview: renderOverview,
	providers: renderProviders,
	models: renderModels,
	chat: renderChat,
	routing: renderRouting,
	usage: renderUsage,
	turns: renderTurns,
	settings: renderSettings,
};

/** The name of each area, as it appears in the page header. */
const TITLES = {
	overview: 'Visão geral',
	providers: 'Providers',
	models: 'Models',
	combos: 'Combos',
	routing: 'Routing',
	usage: 'Usage',
	turns: 'Turnos',
	settings: 'Settings',
};

/** Which endpoint each area asks. Combos has none, on purpose. */
/** The current gallery, kept for the connect action. */
const ENDPOINTS = {
	overview: '/api/overview',
	providers: '/api/integrations',
	models: '/api/models/catalog',
	chat: '/api/integrations',
	routing: '/api/routing',
	usage: '/api/usage',
	settings: '/api/settings',
};

/* ── the shell ─────────────────────────────────────────────────────────────── */

const main = document.querySelector('#main');

/** The session state in the sidebar. */
function setSession(ok, label) {
	const dot = document.querySelector('#session-dot');
	const text = document.querySelector('#session-label');
	if (dot !== null) {
		dot.classList.toggle('ok', ok);
		dot.classList.toggle('failed', !ok);
	}
	if (text !== null) {
		text.textContent = label;
	}
}

/** Marks the current area in the sidebar. */
function markActive(area) {
	for (const link of document.querySelectorAll('.nav-link')) {
		const current = link.dataset.area === area;
		if (current) {
			link.setAttribute('aria-current', 'page');
		} else {
			link.removeAttribute('aria-current');
		}
	}
}

/** Reads the area from the hash, defaulting to the overview. */
function currentArea() {
	const area = window.location.hash.replace(/^#/, '');
	return AREAS.includes(area) ? area : 'overview';
}

/** Removes the token from the address bar: it does not belong in history. */
function stripTokenFromUrl() {
	const url = new URL(window.location.href);
	if (!url.searchParams.has('t')) {
		return;
	}
	url.searchParams.delete('t');
	window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Asks an endpoint with the session cookie. */
async function getJson(path) {
	const response = await fetch(path, { credentials: 'same-origin' });
	if (response.status === 401) {
		throw Object.assign(new Error('A sessão expirou: abra a página de novo pelo endereço do terminal.'), {
			status: 401,
		});
	}
	if (!response.ok) {
		let reason = `A API respondeu ${response.status}.`;
		let code;
		let detail;
		try {
			const body = await response.json();
			if (typeof body.error === 'string') {
				reason = body.error;
			} else if (body.error !== null && typeof body.error === 'object' && typeof body.error.message === 'string') {
				// A forma `{ error: { message, code } }` das rotas novas.
				reason = body.error.message;
				if (typeof body.error.code === 'string') {
					code = body.error.code;
				}
			}
			// R4K: o motivo de classe do registro corrompido, para a tela.
			if (typeof body.reason === 'string') {
				detail = body.reason;
			}
		} catch {
			// Um erro sem corpo JSON continua sendo o status.
		}
		throw Object.assign(new Error(reason), {
			status: response.status,
			...(code !== undefined ? { code } : {}),
			...(detail !== undefined ? { reason: detail } : {}),
		});
	}
	return await response.json();
}

/**
 * Shows an area: sets the sidebar state, renders immediately, and replaces
 * the loading state with the data — or with the error.
 */
async function show(area) {
	markActive(area);

	if (area === 'combos') {
		const info = PENDING.combos;
		main.innerHTML = `${head('Combos', 'Conjuntos nomeados de alvos com uma política de rota.')}${pending(info.title, info.text)}`;
		return;
	}

	// R4J: o diagnóstico tem filtros, então a consulta é dinâmica — `loadTurns`
	// cuida do carregamento, do erro e de religar o formulário.
	if (area === 'turns') {
		await loadTurns(TURN_FILTERS.offset);
		return;
	}

	main.innerHTML = loading();
	const endpoint = ENDPOINTS[area];
	try {
		const data = await getJson(endpoint);
		setSession(true, 'sessão ativa');
		main.innerHTML = RENDERERS[area](data);
		if (area === 'chat') {
			paintConversation();
		}
	} catch (error) {
		// A sessão só "cai" quando o servidor a recusa. Um 404 de "sem Core"
		// é outra coisa: a sessão está de pé, e o que falta são os dados.
		setSession(error?.status !== 401, error?.status === 401 ? 'sem sessão' : 'sessão ativa');
		main.innerHTML = `${head(TITLES[area] ?? area, '')}${errorBox(
			error instanceof Error ? error.message : String(error),
			error?.status,
		)}`;
	}
}

/** The health, for the footer: what this server is. */
async function loadServerInfo() {
	try {
		const health = await getJson('/api/health');
		const info = document.querySelector('#server-info');
		if (info !== null) {
			info.textContent = `${health.listening ?? '—'} · ${health.coreMounted ? 'raiz montada' : 'sem raiz'}`;
		}
	} catch {
		// O rodapé é informativo: a falha já aparece na área.
	}
}

/** The capabilities, for the pending badges. */
async function loadCapabilities() {
	try {
		const capabilities = await getJson('/api/capabilities');
		const pending = new Set(capabilities.pending ?? []);
		for (const link of document.querySelectorAll('.nav-link')) {
			const area = link.dataset.area;
			const badge = link.querySelector('[data-pending-badge]');
			if (badge !== null) {
				badge.hidden = !pending.has(area);
			}
		}
	} catch {
		// Sem o mapa, nenhum selo: a área continua dizendo o que é.
	}
}

/* ── provider actions ──────────────────────────────────────────────────────── */

/** The form, once. */
const dialog = document.querySelector('#provider-dialog');

/** Whether the form is editing an existing provider, and which. */
let editingId = null;

/** Writes a message into the form, or clears it. */
function setFormError(message) {
	const box = document.querySelector('#provider-form-error');
	box.textContent = message ?? '';
	box.hidden = message === null || message === undefined;
}

/** Opens the form: empty for a new provider, filled for an edit. */
function openProviderForm(provider, preset) {
	editingId = provider?.id ?? null;
	document.querySelector('#provider-dialog-title').textContent = provider === undefined ? 'Nova conexão' : 'Editar conexão';
	document.querySelector('#provider-name').value = provider?.name ?? preset?.name ?? '';
	document.querySelector('#provider-base-url').value = provider?.baseUrl ?? preset?.baseUrl ?? '';
	// Um provedor com chave guardada: o campo fica vazio, e o que se mantém é
	// o que está no SecretStore. Sem chave, a autenticação começa em "sem chave".
	const hasKey = provider?.hasApiKeyRef === true;
	document.querySelector('#provider-auth').value = provider === undefined || hasKey ? 'bearer' : 'none';
	document.querySelector('#provider-key').value = '';
	document.querySelector('#provider-key-hint').textContent = hasKey
		? 'A chave já está guardada. Deixe em branco para manter; digite outra para substituir.'
		: 'Enviada uma vez para o armazenamento seguro desta máquina.';
	syncAuthField();
	setFormError(null);
	const result = document.querySelector('#provider-test-result');
	if (result !== null) {
		result.remove();
	}
	dialog.showModal();
	document.querySelector('#provider-name').focus();
}

/** Shows the key field only when the chosen authentication uses one. */
function syncAuthField() {
	const usesKey = document.querySelector('#provider-auth').value === 'bearer';
	document.querySelector('#provider-key-field').hidden = !usesKey;
}

/** The values of the form, as the API expects them. */
function formValues() {
	const name = document.querySelector('#provider-name').value.trim();
	const baseUrl = document.querySelector('#provider-base-url').value.trim();
	const usesKey = document.querySelector('#provider-auth').value === 'bearer';
	const key = document.querySelector('#provider-key').value;
	return {
		baseUrl,
		...(name.length > 0 ? { name } : {}),
		// Uma chave digitada vai; uma em branco é omitida — e omitida é como a
		// API diz "mantenha a guardada". "Sem chave" apaga a que houver.
		...(usesKey && key.length > 0 ? { apiKey: key } : {}),
		...(!usesKey ? { apiKey: '' } : {}),
	};
}

/** A POST to a write endpoint, with the JSON body. */
async function postJson(path, body) {
	const response = await fetch(path, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (response.status === 401) {
		throw Object.assign(new Error('A sessão expirou: abra a página de novo pelo endereço do terminal.'), {
			status: 401,
		});
	}
	let payload = null;
	try {
		payload = await response.json();
	} catch {
		// Um corpo vazio continua sendo o status.
	}
	if (!response.ok) {
		let reason =
			payload !== null && typeof payload.error === 'string'
				? payload.error
				: `A API respondeu ${response.status}.`;
		// A forma `{ error: { message, code } }` usada pelas rotas mais novas.
		if (
			payload !== null &&
			typeof payload.error === 'object' &&
			payload.error !== null &&
			typeof payload.error.message === 'string'
		) {
			reason = payload.error.message;
		}
		throw Object.assign(new Error(reason), { status: response.status });
	}
	return payload;
}

/** Saves the form and reloads the list, or keeps the form open with the error. */
async function submitProviderForm() {
	const submit = document.querySelector('#provider-submit');
	const values = formValues();
	if (values.baseUrl.length === 0) {
		setFormError('Informe o endpoint (base URL) da conexão.');
		return;
	}
	submit.disabled = true;
	setFormError(null);
	try {
		await postJson('/api/providers/save', {
			...values,
			...(editingId !== null ? { id: editingId } : {}),
		});
		dialog.close();
		await show('providers');
	} catch (error) {
		setFormError(error instanceof Error ? error.message : String(error));
	} finally {
		submit.disabled = false;
	}
}

/** Tests the connection of what is in the form, and says what happened. */
async function testProviderForm() {
	const button = document.querySelector('#provider-test');
	const values = formValues();
	const box = document.querySelector('#provider-test-result');
	if (values.baseUrl.length === 0) {
		setFormError('Informe o endpoint (base URL) antes de testar.');
		return;
	}
	// Uma conexão já gravada e sem chave nova: testa a que está guardada.
	const body =
		editingId !== null && values.apiKey === undefined
			? { providerId: editingId }
			: values;
	button.disabled = true;
	setFormError(null);
	if (box !== null) {
		box.textContent = 'testando…';
		box.dataset.ok = '';
	}
	const target = box ?? document.createElement('p');
	if (box === null) {
		target.className = 'test-result';
		target.id = 'provider-test-result';
		document.querySelector('#provider-form').insertBefore(target, document.querySelector('.dialog-actions'));
	}
	try {
		const result = await postJson('/api/providers/test', body);
		target.dataset.ok = String(result.ok);
		target.textContent = result.ok
			? `Conexão respondeu: ${result.modelCount} modelo(s) publicado(s)${result.models?.length ? ` — ${result.models.join(', ')}` : ''}.`
			: `A conexão falhou: ${result.error}`;
	} catch (error) {
		target.dataset.ok = 'false';
		target.textContent = error instanceof Error ? error.message : String(error);
	} finally {
		button.disabled = false;
	}
}

/**
 * Discovers models for one provider and shows what happened.
 *
 * The state is real: the button says "descobrindo…" while the request is in
 * flight, the result says how many the endpoint published now, and a
 * failure says why — the models the previous list had are still there.
 */
async function discoverProviderModels(button) {
	const providerId = button.dataset.provider;
	const name = button.dataset.name ?? providerId;
	const label = button.textContent;
	button.disabled = true;
	button.textContent = 'descobrindo…';
	main.querySelector('.error')?.remove();
	try {
		const result = await postJson('/api/models/discover', { providerId });
		const outcome = result.outcomes.find((entry) => entry.providerId === providerId);
		await show('providers');
		const box = document.createElement('p');
		box.className = outcome?.status === 'ok' ? 'test-result' : 'error';
		box.setAttribute('role', 'status');
		box.dataset.ok = String(outcome?.status === 'ok');
		box.textContent =
			outcome === undefined
				? 'A descoberta não devolveu resultado.'
				: outcome.status === 'ok'
					? `${name}: o endpoint publicou ${outcome.modelCount} modelo(s) agora.`
					: `${name}: ${outcome.error ?? 'a descoberta falhou'}`;
		main.prepend(box);
	} catch (error) {
		button.textContent = label;
		button.disabled = false;
		const box = document.createElement('p');
		box.className = 'error';
		box.setAttribute('role', 'alert');
		box.textContent = error instanceof Error ? error.message : String(error);
		main.prepend(box);
	}
}

/**
 * Redefine a configuração do roteador para o padrão.
 *
 * Só existe no estado ilegível, e só depois de uma confirmação que diz o que
 * é — e o que não é — redefinido: um arquivo, o do roteador. Provedores,
 * chaves e modelos ficam onde estão.
 *
 * A resposta é o que ficou gravado: em erro, os botões e o aviso continuam na
 * tela para tentar de novo; em sucesso, a área recarrega do servidor.
 */
async function resetRouting() {
	const confirmed = window.confirm(
		'Redefinir a configuração do roteador para o padrão?\n\n' +
			'Somente a configuração do ROTEADOR será redefinida. ' +
			'Provedores, chaves de API, modelos descobertos e conversas não são tocados.\n\n' +
			'O arquivo ilegível será guardado ao lado, com o nome terminando em .unreadable-*.',
	);
	if (!confirmed) {
		return;
	}
	const button = document.querySelector('#routing-reset');
	const error = document.querySelector('#routing-form-error');
	button.disabled = true;
	button.textContent = 'redefinindo…';
	error.hidden = true;
	try {
		const result = await postJson('/api/routing/reset', {});
		await show('routing');
		const box = document.createElement('p');
		box.className = 'test-result';
		box.dataset.ok = 'true';
		box.setAttribute('role', 'status');
		box.textContent = `Configuração redefinida para o padrão e lida de volta do disco. O arquivo anterior foi guardado como ${result.preservedAs}.`;
		main.prepend(box);
	} catch (failure) {
		// A falha fica visível e o botão volta: tentar de novo é possível.
		error.textContent = failure instanceof Error ? failure.message : String(failure);
		error.hidden = false;
		button.disabled = false;
		button.textContent = 'Redefinir para o padrão';
	}
}

/** Lê o formulário do roteador e devolve só o que foi escolhido. */
function routingFormValues() {
	const mode = document.querySelector('#routing-mode').value;
	const external = document.querySelector('#routing-external').value;
	const direct = document.querySelector('#routing-direct').value;
	return {
		mode,
		enabled: document.querySelector('#routing-enabled').value === 'true',
		// O destino só vai no corpo quando é o modo escolhido: enviar um
		// destino que o modo não usa seria gravar algo que ninguém escolheu.
		...(mode === 'external' && external.length > 0 ? { externalRouterProviderId: external } : {}),
		...(mode === 'direct' && direct.length > 0 ? { directProviderId: direct } : {}),
	};
}

/**
 * Grava a configuração do roteador.
 *
 * O corpo é o do modo escolhido; o servidor valida com a mesma regra do
 * desktop e recusa com o motivo. Em erro, o formulário continua como estava
 * e a mensagem fica ao lado — a configuração gravada não muda.
 */
async function saveRouting() {
	const button = document.querySelector('#routing-save');
	const error = document.querySelector('#routing-form-error');
	if (button.disabled) {
		// O formulário mostra os valores padrão: gravar por cima apagaria a
		// configuração que ainda existe no disco.
		return;
	}
	error.hidden = true;
	button.disabled = true;
	button.textContent = 'salvando…';
	try {
		const result = await postJson('/api/routing/save', routingFormValues());
		// Recarrega do servidor: o formulário passa a mostrar o que ficou
		// gravado, não o que foi pedido.
		await show('routing');
		const box = document.createElement('p');
		box.className = 'test-result';
		box.dataset.ok = 'true';
		box.setAttribute('role', 'status');
		box.textContent = `Configuração salva: ${modeName(result.config?.mode)} · ${result.config?.enabled ? 'ligado' : 'desligado'}.`;
		main.prepend(box);
	} catch (failure) {
		error.textContent = failure instanceof Error ? failure.message : String(failure);
		error.hidden = false;
		button.disabled = false;
		button.textContent = 'Salvar';
	}
}

/**
 * O comportamento da área Chat: enviar, receber o stream, parar.
 *
 * ## Por que não usa `postJson`
 *
 * O envio responde `text/event-stream`, e o navegador não entrega esse corpo
 * ao `fetch(...).json()`. Aqui o corpo é lido por partes; cada `data:` é um
 * evento. `delta` vira texto na tela, `done` fecha, `error` vira a mensagem
 * de erro — e nada além disso é interpretado.
 *
 * ## O texto na tela
 *
 * As mensagens são preenchidas por `textContent`, nunca por HTML: o texto
 * veio do modelo, e a página não transforma resposta de modelo em marcação.
 */

/** A mensagem de erro da área, se houver. */
function setChatError(message) {
	const box = document.querySelector('[data-role="chat-error"]');
	if (box === null) {
		return;
	}
	box.textContent = message ?? '';
	box.hidden = message === null;
}

/** O texto do histórico, preenchido depois de montar o HTML. */
function paintConversation() {
	const conversation = state.conversation;
	if (conversation === undefined) {
		return;
	}
	const cards = document.querySelectorAll('[data-role="chat-history"] article');
	cards.forEach((card, index) => {
		const message = conversation.messages[index];
		const cell = card.querySelector('[data-role="chat-text"]');
		if (message !== undefined && cell !== null) {
			cell.textContent = message.text;
		}
	});
	const stream = document.querySelector('[data-role="chat-stream"]');
	if (stream !== null && conversation.partial !== undefined) {
		stream.textContent = conversation.partial;
		stream.hidden = false;
	}
}

/** O estado da conversa como a área o desenha. */
function conversationView(conversation) {
	if (conversation === undefined) {
		return undefined;
	}
	return {
		id: conversation.id,
		model: conversation.model,
		messages: conversation.messages,
		busy: conversation.busy,
		session: conversation.session,
	};
}

/** Abre (ou reabre) a conversa e redesenha a área. */
async function showChat(conversation) {
	state.conversation = conversationView(conversation);
	await show('chat');
}

/** Carrega uma conversa do servidor pelo id (o histórico vive lá enquanto o host vive). */
async function loadConversation(conversationId) {
	try {
		const data = await getJson(`/api/opencode/chat/${encodeURIComponent(conversationId)}`);
		await showChat({ ...data, partial: undefined });
	} catch (error) {
		setChatError(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Envia a mensagem e lê o stream.
 *
 * O turno é único por conversa: o botão fica desabilitado até o fim (ou o
 * "Parar"). A cada `delta`, o texto aparece; o fim atualiza o histórico a
 * partir do servidor, para a fonte continuar sendo uma só.
 */
async function sendChatMessage() {
	const input = document.querySelector('#chat-input');
	const model = document.querySelector('#chat-model')?.value ?? '';
	const text = input === null ? '' : input.value;
	if (text.trim().length === 0) {
		setChatError('escreva uma mensagem');
		return;
	}
	if (model.length === 0) {
		setChatError('escolha um modelo do catálogo');
		return;
	}
	const button = document.querySelector('#chat-send');
	if (button !== null) {
		button.disabled = true;
	}
	const stop = document.querySelector('[data-action="chat-stop"]');
	if (stop !== null) {
		stop.disabled = false;
	}
	setChatError(null);
	// A mensagem do usuário aparece na hora; a resposta cresce no stream.
	const conversation = state.conversation ?? { id: '', model, messages: [], busy: true };
	state.conversation = {
		...conversation,
		model,
		busy: true,
		partial: '',
		messages: [...conversation.messages, { role: 'user', text, at: new Date().toISOString() }],
	};
	await show('chat');
	if (input !== null) {
		input.value = '';
	}

	let conversationId = conversation.id;
	let failed = null;
	try {
		const response = await fetch('/api/opencode/chat/send', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ...(conversationId.length > 0 ? { conversationId } : {}), model, text }),
		});
		if (!response.ok) {
			const reason = await response
				.json()
				.then((body) => (typeof body.error === 'string' ? body.error : `a API respondeu ${response.status}`))
				.catch(() => `a API respondeu ${response.status}`);
			throw new Error(reason);
		}
		if (response.body === null) {
			throw new Error('a resposta veio sem corpo');
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let index;
			while ((index = buffer.indexOf('\n\n')) >= 0) {
				const frame = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				const data = frame
					.split('\n')
					.filter((line) => line.startsWith('data:'))
					.map((line) => line.slice(5).trim())
					.join('');
				if (data.length === 0) {
					continue;
				}
				let event;
				try {
					event = JSON.parse(data);
				} catch {
					continue;
				}
				if (event.type === 'started' && typeof event.conversationId === 'string') {
					conversationId = event.conversationId;
					if (event.session !== undefined && state.conversation !== undefined) {
						state.conversation = { ...state.conversation, session: event.session };
					}
				}
				if (event.type === 'session' && event.session !== undefined && state.conversation !== undefined) {
					state.conversation = { ...state.conversation, session: event.session };
				}
				if (event.type === 'delta' && typeof event.text === 'string') {
					const partial = `${state.conversation?.partial ?? ''}${event.text}`;
					state.conversation = { ...state.conversation, partial };
					const stream = document.querySelector('[data-role="chat-stream"]');
					if (stream !== null) {
						stream.textContent = partial;
						stream.hidden = false;
					}
				}
				if (event.type === 'error' && typeof event.error === 'string') {
					failed = event.error;
				}
				if (event.type === 'done' && typeof event.note === 'string') {
					failed = event.note;
				}
			}
		}
	} catch (error) {
		failed = error instanceof Error ? error.message : String(error);
	} finally {
		if (conversationId.length > 0) {
			// O histórico oficial vem do servidor: o texto da tela não vira a
			// fonte, e uma resposta incompleta não se disfarça de completa.
			await loadConversation(conversationId);
		} else {
			await show('chat');
		}
		if (failed !== null) {
			setChatError(failed);
		}
	}
}

/** Para o turno em curso. */
async function stopChatTurn() {
	const conversationId = state.conversation?.id ?? '';
	if (conversationId.length === 0) {
		return;
	}
	try {
		await postJson('/api/opencode/chat/stop', { conversationId });
	} catch (error) {
		setChatError(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Descarta a conversa: as mensagens e a sessão do OpenCode.
 *
 * O servidor encerra a sessão; a página volta ao começo, sem histórico.
 */
async function discardChat() {
	const conversationId = state.conversation?.id ?? '';
	if (conversationId.length === 0) {
		state.conversation = undefined;
		await show('chat');
		return;
	}
	if (!window.confirm('Descartar esta conversa? As mensagens e a sessão do OpenCode nesta conversa serão encerradas.')) {
		return;
	}
	try {
		await postJson('/api/opencode/chat/discard', { conversationId });
		state.conversation = undefined;
		await show('chat');
	} catch (error) {
		setChatError(error instanceof Error ? error.message : String(error));
	}
}

/** Começa uma conversa nova, com o modelo escolhido. */
async function newChat() {
	state.conversation = undefined;
	await show('chat');
	setChatError(null);
}

/** Troca o modelo de uma conversa parada. */
async function changeChatModel(model) {
	const conversationId = state.conversation?.id ?? '';
	if (conversationId.length === 0) {
		state.conversation = state.conversation === undefined ? undefined : { ...state.conversation, model };
		return;
	}
	try {
		await postJson('/api/opencode/chat/model', { conversationId, model });
		state.conversation = { ...state.conversation, model };
	} catch (error) {
		setChatError(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Runs one action of the OpenCode block.
 *
 * The POST waits for the outcome — starting a process and waiting for its
 * health takes seconds. To not look hung, the block switches to "iniciando"
 * right away and asks the status endpoint on a short interval until the POST
 * answers. Nothing is invented: the final state is the one the API returned.
 */
async function runOpencodeAction(action, button, trigger) {
	const container = trigger.closest('[data-role="opencode"]');
	const note = container?.querySelector('[data-role="opencode-manual-note"]');
	const showNote = (text) => {
		if (note !== null && note !== undefined) {
			note.textContent = text;
			note.hidden = false;
		}
	};
	if (action === 'opencode-connect-manual') {
		const baseUrl = document.querySelector('#opencode-base-url')?.value.trim() ?? '';
		const password = document.querySelector('#opencode-password')?.value ?? '';
		if (baseUrl.length === 0) {
			showNote('Informe o endereço do servidor OpenCode.');
			return;
		}
		if (password.length === 0) {
			showNote('Informe a senha do servidor (o OPENCODE_SERVER_PASSWORD dele).');
			return;
		}
		button.disabled = true;
		showNote('Conectando…');
		try {
			await postJson('/api/opencode/connect-manual', { baseUrl, password });
		} catch (error) {
			showNote(error instanceof Error ? error.message : String(error));
		} finally {
			button.disabled = false;
			// A senha não fica no campo: ela já foi usada, ou recusada.
			const field = document.querySelector('#opencode-password');
			if (field !== null) {
				field.value = '';
			}
			await show('providers');
		}
		return;
	}

	button.disabled = true;
	const path = {
		'opencode-connect-managed': '/api/opencode/connect-managed',
		'opencode-disconnect': '/api/opencode/disconnect',
		'opencode-check': '/api/opencode/check',
		'opencode-refresh-catalog': '/api/opencode/catalog/refresh',
	}[action];
	if (path === undefined) {
		button.disabled = false;
		return;
	}
	let polling = action === 'opencode-connect-managed';
	const timer = polling
		? setInterval(() => {
				void show('providers');
			}, 700)
		: undefined;
	try {
		if (action === 'opencode-connect-managed' && container !== null) {
			// O estado local só antecipa a espera; o resultado real vem do POST.
			const badge = container.querySelector('.connection-head .tag');
			if (badge !== null) {
				badge.textContent = 'iniciando';
				badge.dataset.tone = 'accent';
			}
		}
		if (action === 'opencode-refresh-catalog') {
			// A leitura pode levar segundos: o botão diz que está lendo. O
			// resultado — e a falha, se houver — vem do POST e é desenhado.
			const catalogBlock = document.querySelector('[data-role="opencode-catalog"]');
			const note = catalogBlock?.querySelector('.muted.small');
			if (note !== null && note !== undefined) {
				note.textContent = 'Lendo o catálogo do servidor…';
			}
		}
		await postJson(path, {});
	} catch (error) {
		main.querySelector('.error')?.remove();
		const box = document.createElement('p');
		box.className = 'error';
		box.setAttribute('role', 'alert');
		box.textContent = error instanceof Error ? error.message : String(error);
		main.prepend(box);
	} finally {
		if (timer !== undefined) {
			clearInterval(timer);
			polling = false;
		}
		await show('providers');
	}
}

/** Runs one action of a provider card. */
async function runProviderAction(action, button, trigger = button) {
	const providerId = button.dataset.provider;
	if (action === 'add-provider') {
		openProviderForm(undefined);
		return;
	}
	if (action.startsWith('opencode-')) {
		await runOpencodeAction(action, button, trigger);
		return;
	}
	if (action === 'connect-integration') {
		// A galeria não tem um segundo formulário: ela abre o existente,
		// com o que a própria integração declara.
		const entry = (state.gallery ?? []).find((item) => item.id === button.dataset.integration);
		if (entry !== undefined) {
			openProviderForm(undefined, { name: entry.name, baseUrl: entry.baseUrl });
		}
		return;
	}
	if (providerId === undefined) {
		return;
	}
	button.disabled = true;
	try {
		if (action === 'edit-provider') {
			// A edição precisa do que está gravado: a lista é a fonte.
			const data = await getJson('/api/providers');
			const provider = data.providers.find((entry) => entry.id === providerId);
			if (provider !== undefined) {
				openProviderForm(provider);
			}
		} else if (action === 'toggle-provider') {
			await postJson('/api/providers/enabled', {
				providerId,
				enabled: button.dataset.enabled === 'true',
			});
			await show('providers');
		} else if (action === 'remove-provider') {
			const name = button.dataset.name ?? providerId;
			if (!window.confirm(`Remover a conexão "${name}"? A chave guardada também será apagada.`)) {
				return;
			}
			await postJson('/api/providers/remove', { providerId });
			await show('providers');
		} else if (action === 'discover-provider') {
			await discoverProviderModels(button);
			return;
		} else if (action === 'test-provider') {
			const result = await postJson('/api/providers/test', { providerId });
			window.alert(
				result.ok
					? `Conexão respondeu: ${result.modelCount} modelo(s) publicado(s).`
					: `A conexão falhou: ${result.error}`,
			);
		}
	} catch (error) {
		main.querySelector('.error')?.remove();
		const box = document.createElement('p');
		box.className = 'error';
		box.setAttribute('role', 'alert');
		box.textContent = error instanceof Error ? error.message : String(error);
		main.prepend(box);
	} finally {
		button.disabled = false;
	}
}

function start() {
	stripTokenFromUrl();
	main.addEventListener('click', (event) => {
		const button = event.target.closest('[data-action]');
		if (button !== null) {
			// R4J: a paginação do diagnóstico. Fica antes da ação de provider
			// porque não é uma ação de provider — `runProviderAction` recusaria.
			if (button.dataset.action === 'turns-page') {
				const offset = Number(button.dataset.offset ?? '0');
				TURN_FILTERS.offset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
				void loadTurns(TURN_FILTERS.offset);
				return;
			}
			// R4K: a recuperação do registro corrompido. Como a paginação,
			// não é ação de provider.
			if (button.id === 'turns-backup') {
				void backupTurns();
				return;
			}
			if (button.id === 'turns-reset') {
				void resetTurns();
				return;
			}
			void runProviderAction(button.dataset.action, button, button);
		}
	});
	document.querySelector('#provider-form').addEventListener('submit', (event) => {
		event.preventDefault();
		void submitProviderForm();
	});
	document.querySelector('#provider-auth').addEventListener('change', syncAuthField);
	// O formulario de Routing so existe depois que a area e desenhada: a
	// delegacao no main evita religar a cada render.
	main.addEventListener('click', (event) => {
		if (event.target.id === 'routing-save') {
			void saveRouting();
		}
		if (event.target.id === 'routing-reset') {
			void resetRouting();
		}
		if (event.target.id === 'routing-reload') {
			void show('routing');
		}
		if (event.target.dataset.action === 'chat-new') {
			void newChat();
		}
		if (event.target.dataset.action === 'chat-stop') {
			void stopChatTurn();
		}
		if (event.target.dataset.action === 'chat-discard') {
			void discardChat();
		}
	});
	// O formulário da conversa vive na área Chat, desenhada depois: a
	// delegação no main evita religar os ouvintes a cada desenho.
	main.addEventListener('submit', (event) => {
		if (event.target.id === 'chat-form') {
			event.preventDefault();
			void sendChatMessage();
		}
	});
	main.addEventListener('change', (event) => {
		if (event.target.id === 'chat-model') {
			void changeChatModel(event.target.value);
		}
	});
	main.addEventListener('keydown', (event) => {
		if (event.target.id === 'chat-input' && event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void sendChatMessage();
		}
	});
	document.querySelector('#provider-test').addEventListener('click', () => {
		void testProviderForm();
	});
	document.querySelector('#provider-cancel').addEventListener('click', () => {
		dialog.close();
	});
	window.addEventListener('hashchange', () => {
		void show(currentArea());
	});
	const area = currentArea();
	void show(area);
	void loadServerInfo();
	void loadCapabilities();
}

start();
