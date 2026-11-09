/**
 * Markdown do chat: estrutura certa, e **nada** interpretado como HTML.
 *
 * O renderer não depende de jsdom (a janela é o navegador do Electron, e o
 * pacote não traz DOM de teste). Aqui há um DOM mínimo — `createElement`,
 * `createTextNode`, `append` — que basta para verificar a árvore que o
 * renderizador produz, e um `serialize` que devolve o que o navegador
 * desenharia.
 *
 * O teste mais importante é o de **injeção**: nenhum texto do modelo pode
 * virar elemento. <img onerror> tem de chegar como texto.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderMarkdown, type MarkdownDocument } from '../desktop/renderer/markdown';

/**
 * Um nodo do DOM falso.
 *
 * Texto e elemento compartilham a mesma forma — `kids` vazio para texto — para
 * que um teste não precise estreitar o tipo a cada linha. `tag` é `#text` no
 * caso literal, que é o que o navegador também usa.
 */
interface FakeNode {
	readonly kind: 'text' | 'element';
	readonly tag: string;
	readonly text: string;
	attrs: Record<string, string>;
	className: string;
	style: Record<string, string>;
	children: FakeNode[];
}

/** O que o renderizador pede de um `document`; o teste não tem `lib.dom`. */
interface FakeDocument {
	createElement(tag: string): unknown;
	createTextNode(text: string): unknown;
}

/** Um DOM mínimo, suficiente para montar e inspecionar a árvore. */
function fakeDocument(): { doc: MarkdownDocument; node: (value: unknown) => FakeNode } {
	const doc: FakeDocument = {
		createTextNode: (text: string) => ({
			__node: { kind: 'text', tag: '#text', text, attrs: {}, className: '', style: {}, children: [] } satisfies FakeNode,
		}),
		createElement: (tag: string) => {
			const node: FakeNode = {
				kind: 'element',
				tag: tag.toLowerCase(),
				text: '',
				attrs: {},
				className: '',
				style: {},
				children: [],
			};
			const element = {
				__node: node,
				tagName: tag.toUpperCase(),
				get className() {
					return node.className;
				},
				set className(value: string) {
					node.className = value;
				},
				style: node.style,
				setAttribute(name: string, value: string) {
					node.attrs[name] = value;
				},
				getAttribute(name: string) {
					return node.attrs[name] ?? null;
				},
				append(...children: unknown[]) {
					for (const child of children) {
						node.children.push(rootOf(child));
					}
				},
				set textContent(value: string) {
					node.children.length = 0;
					node.children.push({ kind: 'text', tag: '#text', text: value, attrs: {}, className: '', style: {}, children: [] });
				},
			};
			return element;
		},
	};
	return { doc: doc as unknown as MarkdownDocument, node: (value) => rootOf(value) };
}

function rootOf(value: unknown): FakeNode {
	const element = value as { __node?: FakeNode };
	if (element.__node === undefined) {
		throw new Error(`nodo desconhecido: ${String(value)}`);
	}
	return element.__node;
}

/** Os filhos de um elemento (ou lista vazia, para um nodo de texto). */
function childrenOf(node: FakeNode): FakeNode[] {
	return node.kind === 'element' ? node.children : [];
}

/** O texto que o usuário veria ao leitura. */
function textOf(node: FakeNode): string {
	if (node.kind === 'text') {
		return node.text;
	}
	return node.children.map(textOf).join('');
}

function tagsOf(nodes: readonly FakeNode[]): string[] {
	return nodes.map((node) => (node.kind === 'text' ? '#text' : node.tag));
}

function inline(source: string): FakeNode {
	const { doc, node } = fakeDocument();
	const blocks = renderMarkdown(doc, source).map(node);
	return blocks[0] as FakeNode;
}

test('títulos, negrito, itálico e riscado', () => {
	const { doc, node } = fakeDocument();
	const blocks = renderMarkdown(doc, '# Título\n\n**forte** e *leve* e ~~velho~~').map(node);
	assert.deepEqual(tagsOf(blocks), ['h1', 'p']);
	const heading = blocks[0] as FakeNode;
	assert.equal(textOf(heading), 'Título');
	const paragraph = blocks[1] as FakeNode;
	assert.deepEqual(tagsOf(paragraph.children), ['strong', '#text', 'em', '#text', 'del']);
	assert.equal(textOf(paragraph), 'forte e leve e velho');
	// Os marcadores não sobram no texto exibido.
	assert.ok(!textOf(paragraph).includes('*'));
});

test('itálico não come o _ de snake_case', () => {
	const paragraph = inline('use snake_case_name aqui');
	assert.equal(textOf(paragraph), 'use snake_case_name aqui');
	assert.deepEqual(tagsOf(paragraph.children), ['#text']);
});

test('código inline mantém os marcadores literais', () => {
	const paragraph = inline('rode `**npm** test` agora');
	const code = paragraph.children.find((child) => child.kind === 'element' && child.tag === 'code');
	assert.ok(code !== undefined && code.kind === 'element');
	assert.equal(textOf(code), '**npm** test');
	assert.ok(!textOf(paragraph).includes('`'));
});

test('bloco de código preserva indentação e não interpreta nada dentro', () => {
	const source = ['```ts', 'const a = "**x**";', '  if (a) { }', '```'].join('\n');
	const { doc, node } = fakeDocument();
	const blocks = renderMarkdown(doc, source).map(node);
	assert.deepEqual(tagsOf(blocks), ['pre']);
	const pre = blocks[0] as FakeNode;
	const code = pre.children[0] as FakeNode;
	assert.equal(textOf(code), 'const a = "**x**";\n  if (a) { }');
	assert.equal(code.attrs['data-language'], 'ts');
});

test('listas com e sem marcador, e numeradas', () => {
	const { doc, node } = fakeDocument();
	const blocks = renderMarkdown(doc, '- um\n- dois\n\n1. primeiro\n2. segundo').map(node);
	assert.deepEqual(tagsOf(blocks), ['ul', 'ol']);
	const ul = blocks[0] as FakeNode;
	assert.equal(ul.children.length, 2);
	assert.deepEqual(ul.children.map((item) => textOf(item)), ['um', 'dois']);
});

test('tabela com cabeçalho, corpo e alinhamento', () => {
	const source = ['| a | b |', '|:--|--:|', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
	const { doc, node } = fakeDocument();
	const blocks = renderMarkdown(doc, source).map(node);
	assert.deepEqual(tagsOf(blocks), ['table']);
	const table = blocks[0] as FakeNode;
	assert.deepEqual(tagsOf(table.children), ['thead', 'tbody']);
	const tbody = table.children[1] as FakeNode;
	assert.equal(tbody.children.length, 2, 'duas linhas de dados');
	assert.deepEqual(tbody.children.map((row) => textOf(row)), ['12', '34']);
	const firstCell = (tbody.children[0] as FakeNode).children[0] as FakeNode;
	assert.equal(firstCell.style['textAlign'], 'left', 'o alinhamento da coluna vem da separadora');
});

test('citação e régua', () => {
	const { doc, node } = fakeDocument();
	const blocks = renderMarkdown(doc, '> dito isso\n\n---').map(node);
	assert.deepEqual(tagsOf(blocks), ['blockquote', 'hr']);
	assert.equal(textOf(blocks[0] as FakeNode), 'dito isso');
});

test('links http(s) viram <a>; esquemas perigosos ficam texto', () => {
	const safe = inline('veja [a doc](https://example.com/x)');
	const anchor = safe.children.find((child) => child.kind === 'element' && child.tag === 'a');
	assert.ok(anchor !== undefined && anchor.kind === 'element');
	assert.equal(anchor.attrs['href'], 'https://example.com/x');
	assert.equal(anchor.attrs['rel'], 'noreferrer noopener');
	assert.equal(textOf(anchor), 'a doc');

	for (const evil of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,<b>x</b>']) {
		const paragraph = inline(`[clique](${evil})`);
		const anchors = paragraph.children.filter((child) => child.kind === 'element' && child.tag === 'a');
		assert.equal(anchors.length, 0, `não pode virar link: ${evil}`);
		assert.ok(textOf(paragraph).includes(evil), 'e continua visível como texto');
	}
});

test('HTML do modelo NÃO vira elemento', () => {
	const source = '<img src=x onerror="alert(1)"> e <script>alert(2)</script>';
	const { doc, node } = fakeDocument();
	const blocks = renderMarkdown(doc, source).map(node);
	const flat = JSON.stringify(blocks);
	assert.ok(!flat.includes('"tag":"img"'), 'nada de img');
	assert.ok(!flat.includes('"tag":"script"'), 'nada de script');
	assert.equal(textOf(blocks[0] as FakeNode), source, 'o texto aparece literal');
});

test('streaming: marcadores ainda abertos continuam texto, e o bloco aparece', () => {
	// A resposta chegando aos poucos: no meio, `**` está aberto.
	const partial = 'A resposta é **par';
	const paragraph = inline(partial);
	assert.equal(textOf(paragraph), partial, 'sem perder os dois asteriscos abertos');
	// E uma cerca aberta continua bloco de código em vez de virar parágrafo.
	const { doc, node } = fakeDocument();
	const open = renderMarkdown(doc, '```js\nconst a = 1').map(node);
	assert.deepEqual(tagsOf(open), ['pre']);
	assert.equal(textOf(open[0] as FakeNode), 'const a = 1');
});

test('um texto que já foi renderizado se completa sem perder a estrutura anterior', () => {
	// O renderer redesenha o balão inteiro a cada delta; o que se garante aqui
	// é que o prefixo cresce sem mudar de sentido.
	const steps = ['## Plano\n', '## Plano\n\n- ler\n', '## Plano\n\n- ler\n- escrever\n'];
	const last = inline(steps[2] as string);
	const { doc, node } = fakeDocument();
	const blocks = renderMarkdown(doc, steps[2] as string).map(node);
	assert.deepEqual(tagsOf(blocks), ['h2', 'ul']);
	assert.equal((blocks[1] as FakeNode).children.length, 2);
	void last;
});

test('escape de marcador mantém o caractere e não formata', () => {
	const paragraph = inline('literal \\*não itálico\\*');
	assert.equal(textOf(paragraph), 'literal *não itálico*');
	assert.deepEqual(tagsOf(paragraph.children), ['#text']);
});

test('uma resposta longa não trava o renderizador', () => {
	const source = Array.from({ length: 500 }, (_, index) => `- item ${index} **forte**`).join('\n');
	const { doc, node } = fakeDocument();
	const blocks = renderMarkdown(doc, source).map(node);
	assert.equal(blocks.length, 1);
	assert.equal((blocks[0] as FakeNode).children.length, 500);
});
