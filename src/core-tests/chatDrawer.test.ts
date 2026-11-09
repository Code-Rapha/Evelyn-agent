/**
 * O drawer do chat: uma coluna, só Conversações, Modelo e System prompt.
 *
 * O defeito era a regra DEV-8 do CSS: `body[data-window='chat'] #settings:not([hidden]) .only-settings`
 * mostrava no drawer do chat todos os painéis de configuração, com o nav
 * servindo de seletor — uma segunda janela de configurações, incompleta e em
 * duas colunas.
 *
 * Os testes leem os arquivos de interface direto (HTML e CSS), porque o
 * defeito era de **estrutura** e de **regra**, não de lógica: um teste que só
 * chamasse funções não veria nada. É a mesma razão pela qual o painel DEV tem
 * teste de markup em outros arquivos.
 */
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const renderer = join(__dirname, '..', '..', 'src', 'desktop', 'renderer');
const html = readFileSync(join(renderer, 'index.html'), 'utf8');
const css = readFileSync(join(renderer, 'index.css'), 'utf8');

/** O conteúdo de um `<section>` que começa com a classe dada. */
function sectionOpening(selector: RegExp): string {
	const match = selector.exec(html);
	assert.ok(match !== null, `seção não encontrada: ${selector}`);
	return match[0];
}

test('a regra DEV-8 que forçava .only-settings no drawer foi removida', () => {
	assert.ok(
		!css.includes("body[data-window='chat'] #settings:not([hidden]) .only-settings"),
		'a regra que mostrava os painéis de configuração no chat não pode voltar',
	);
});

test('no chat, o nav e os painéis de configuração ficam ocultos', () => {
	assert.match(css, /body\[data-window='chat'\] \.drawer \.settings-nav\s*\{\s*display: none;/);
	assert.match(css, /body\[data-window='chat'\] \.drawer \.only-settings\s*\{\s*display: none;/);
});

test('o nav de configurações é `only-settings` (não aparece no chat)', () => {
	assert.match(html, /<nav class="settings-nav only-settings"/);
});

test('os painéis de configuração continuam existindo, marcados como only-settings', () => {
	for (const section of ['providers', 'project', 'models', 'router', 'budget', 'skills', 'dev']) {
		const opening = sectionOpening(new RegExp(`<section class="[^"]*" data-section="${section}">`));
		assert.match(opening, /only-settings/, `a seção "${section}" precisa ser only-settings`);
	}
});

test('a segunda coluna (Provider, Conexões, …) é only-settings', () => {
	assert.match(html, /<div class="drawer-col drawer-col-b only-settings">/);
});

test('o chat mantém Conversações com o botão Nova', () => {
	assert.match(html, /<details id="conversation-panel" open>/);
	assert.match(html, /id="conversation-new"/);
});

test('o chat mantém o painel Modelo', () => {
	assert.match(html, /<details id="model-panel" open>/);
});

test('o System prompt está no chat e recolhido por padrão', () => {
	const opening = /<details id="system-panel"[^>]*>/.exec(html);
	assert.ok(opening !== null, 'o painel do system prompt existe');
	assert.ok(!/\bopen\b/.test(opening[0]), `o system prompt abre recolhido: ${opening[0]}`);
});

test('o drawer do chat não tem navegação própria nas classes de painel', () => {
	// Os painéis do chat que sobram são só os três que ele deve mostrar.
	const chatPanels = [...html.matchAll(/<section class="([^"]*only-chat[^"]*)">/g)].map((match) => match[1]);
	assert.ok(chatPanels.length >= 2, 'há painéis de chat');
	for (const classes of chatPanels) {
		assert.ok(!/only-settings/.test(classes ?? ''), 'um painel não pode ser das duas janelas');
	}
});

test('o topbar continua com o botão que abre a janela de configurações', () => {
	assert.match(html, /id="open-settings"/);
});

test('a janela de configurações mantém nav e duas colunas', () => {
	// O nav existe (só escondido no chat) e a coluna B não ganhou `only-chat`.
	assert.match(html, /class="settings-nav only-settings"/);
	assert.ok(!/drawer-col-b[^"]*only-chat/.test(html), 'a coluna de configurações não é exclusiva do chat');
});
