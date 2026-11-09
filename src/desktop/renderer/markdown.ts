/**
 * Markdown do chat, renderizado em **nodos do DOM**, nunca em HTML.
 *
 * ## Por que nÃ£o existe um `innerHTML` neste arquivo
 *
 * O texto vem do modelo, e o modelo nÃ£o Ã© uma fonte confiÃ¡vel: uma resposta
 * pode conter `<img src=x onerror=â€¦>` de propÃ³sito ou por acidente de um
 * provedor intermediÃ¡rio. A janela tem CSP sem `script-src` inline, mas isso
 * protege contra execuÃ§Ã£o, nÃ£o contra um `<iframe>` ou um formulÃ¡rio que
 * capture o que a pessoa digita. Escrever nodos elimina a classe inteira de
 * problema: nÃ£o hÃ¡ *parsing* de HTML em ponto nenhum.
 *
 * O que este mÃ³dulo produz Ã© uma Ã¡rvore de `Node` feita com `createElement` e
 * `textContent`. Todo texto que veio do modelo passa por `textContent`, que Ã©
 * literal por definiÃ§Ã£o.
 *
 * ## O subconjunto suportado
 *
 * TÃ­tulos (`#` a `######`), parÃ¡grafos, negrito, itÃ¡lico, riscado, cÃ³digo
 * inline, blocos de cÃ³digo com cerca, listas com e sem marcador, listas
 * numeradas, citaÃ§Ãµes, tabelas, rÃ©gua e links `http(s)`.
 *
 * O que **nÃ£o** Ã© interpretado â€” de propÃ³sito:
 *
 * - HTML bruto (`<b>x</b>` aparece como texto);
 * - links que nÃ£o sejam `http`/`https` (`javascript:`, `file:`, `data:`);
 * - imagens (`![]()` Ã© texto): buscar imagem remota Ã© uma requisiÃ§Ã£o de rede
 *   que o conteÃºdo decide sozinho.
 *
 * ## Streaming
 *
 * O texto chega aos poucos. Uma cerca de bloco ou um `**` ainda abertos nÃ£o
 * podem sumir do meio da frase: a linha que nÃ£o casa com nada continua sendo
 * texto literal, com os marcadores como vieram. Ã‰ o que faz o streaming
 * parecer digitaÃ§Ã£o em vez de "formatou e desformatou".
 */

/**
 * O mÃ­nimo que este mÃ³dulo pede do DOM.
 *
 * Declarado aqui, e nÃ£o tirado de `lib.dom`, porque o mÃ³dulo Ã© compilado
 * tambÃ©m pela configuraÃ§Ã£o do Core (sem DOM): um tipo estrutural basta e
 * mantÃ©m o renderizador testÃ¡vel com um DOM falso, sem jsdom.
 */
export interface MarkdownElement extends MarkdownNode {
	readonly nodeType?: number;
	readonly __markdownNode?: true;
	textContent: string;
	className: string;
	style: { textAlign: string };
	setAttribute(name: string, value: string): void;
	append(...nodes: MarkdownNode[]): void;
	readonly lastElementChild: MarkdownElement | null;
}

export interface MarkdownNode {
	readonly nodeType?: number;
	readonly __markdownNode?: true;
	cloneNode(deep: boolean): MarkdownNode;
}

export interface MarkdownDocument {
	createElement(tag: string): MarkdownElement;
	createTextNode(text: string): MarkdownNode;
}

/**
 * Renderiza o texto e devolve os nodos, na ordem.
 *
 * O chamador anexa o resultado ao balÃ£o. Devolver uma lista (e nÃ£o um nodo
 * Ãºnico) evita um `<div>` extra em volta de uma resposta de uma linha sÃ³.
 */
export function renderMarkdown(doc: MarkdownDocument, source: string): MarkdownNode[] {
	const lines = source.replace(/\r\n?/g, '\n').split('\n');
	const out: MarkdownNode[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] as string;

		// Linha em branco: separa blocos, nÃ£o produz nodo.
		if (line.trim().length === 0) {
			index += 1;
			continue;
		}

		// Cerca de bloco de cÃ³digo.
		const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence !== null) {
			const marker = fence[2] as string;
			const char = marker[0] as string;
			const size = marker.length;
			const language = (fence[3] ?? '').trim();
			const body: string[] = [];
			let cursor = index + 1;
			let closed = false;
			while (cursor < lines.length) {
				const candidate = lines[cursor] as string;
				const closing = new RegExp(`^\\s*${char === '`' ? '`' : '~'}{${size},}\\s*$`);
				if (closing.test(candidate)) {
					closed = true;
					cursor += 1;
					break;
				}
				body.push(candidate);
				cursor += 1;
			}
			// Sem fechamento durante o streaming: mostra o que hÃ¡, ainda como
			// bloco â€” a alternativa seria o cÃ³digo virar parÃ¡grafo a cada delta.
			const pre = doc.createElement('pre');
			const code = doc.createElement('code');
			if (language.length > 0) {
				code.setAttribute('data-language', language);
				code.className = `language-${language.replace(/[^\w+-]/g, '')}`;
			}
			code.textContent = body.join('\n');
			pre.append(code);
			out.push(pre);
			index = closed ? cursor : lines.length;
			continue;
		}

		// TÃ­tulo ATX.
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading !== null) {
			const level = (heading[1] as string).length;
			const element = doc.createElement(`h${level}`);
			appendInline(doc, element, (heading[2] as string).trim());
			out.push(element);
			index += 1;
			continue;
		}

		// RÃ©gua.
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			out.push(doc.createElement('hr'));
			index += 1;
			continue;
		}

		// CitaÃ§Ã£o: linhas seguidas comeÃ§ando com `>`.
		if (/^\s*>/.test(line)) {
			const body: string[] = [];
			let cursor = index;
			while (cursor < lines.length && /^\s*>/.test(lines[cursor] as string)) {
				body.push((lines[cursor] as string).replace(/^\s*>\s?/, ''));
				cursor += 1;
			}
			const quote = doc.createElement('blockquote');
			for (const child of renderMarkdown(doc, body.join('\n'))) {
				quote.append(child);
			}
			out.push(quote);
			index = cursor;
			continue;
		}

		// Tabela: linha com `|` seguida de linha separadora.
		if (isTableStart(lines, index)) {
			const consumed = renderTable(doc, lines, index, out);
			index = consumed;
			continue;
		}

		// Listas: marcador ou numeraÃ§Ã£o.
		const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
		const numbered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
		if (bullet !== null || numbered !== null) {
			const ordered = numbered !== null && bullet === null;
			const element = doc.createElement(ordered ? 'ol' : 'ul');
			let cursor = index;
			while (cursor < lines.length) {
				const current = lines[cursor] as string;
				const match = ordered
					? /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(current)
					: /^(\s*)([-*+])\s+(.*)$/.exec(current);
				if (match === null) {
					// Uma linha indentada pertence ao item anterior (continuaÃ§Ã£o
					// de parÃ¡grafo). Sem isso, uma frase quebrada no meio de um
					// item virava outro parÃ¡grafo solto.
					if (/^\s{2,}\S/.test(current) && cursor > index) {
						const lastItem = element.lastElementChild;
						if (lastItem !== null) {
							lastItem.append(doc.createTextNode(' '));
							appendInline(doc, lastItem as MarkdownElement, current.trim());
							cursor += 1;
							continue;
						}
					}
					break;
				}
				const item = doc.createElement('li');
				// Tarefa (`- [x] feito`): o estado Ã© leitura, entÃ£o vem como marca.
				const task = /^\[( |x|X)\]\s+(.*)$/.exec(match[3] as string);
				if (task !== null) {
					const mark = doc.createElement('span');
					mark.className = 'md-task';
					mark.textContent = (task[1] as string).trim().length === 0 ? 'â˜ ' : 'â˜‘ ';
					item.append(mark);
					appendInline(doc, item, task[2] as string);
				} else {
					appendInline(doc, item, match[3] as string);
				}
				element.append(item);
				cursor += 1;
			}
			out.push(element);
			index = cursor;
			continue;
		}

		// ParÃ¡grafo: linhas seguidas que nÃ£o iniciam outro bloco.
		const paragraph: string[] = [];
		let cursor = index;
		while (cursor < lines.length) {
			const current = lines[cursor] as string;
			if (current.trim().length === 0 || startsBlock(lines, cursor)) {
				break;
			}
			paragraph.push(current);
			cursor += 1;
		}
		const element = doc.createElement('p');
		appendInline(doc, element, paragraph.join('\n'));
		out.push(element);
		index = cursor;
	}

	return out;
}

/** Verdadeiro quando a linha comeÃ§a um bloco que fecha o parÃ¡grafo. */
function startsBlock(lines: readonly string[], index: number): boolean {
	const line = lines[index] as string;
	if (/^(\s*)(`{3,}|~{3,})/.test(line)) {
		return true;
	}
	if (/^(#{1,6})\s+/.test(line)) {
		return true;
	}
	if (/^\s*>/.test(line)) {
		return true;
	}
	if (/^(\s*)([-*+])\s+/.test(line) || /^(\s*)(\d{1,9})[.)]\s+/.test(line)) {
		return true;
	}
	if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
		return true;
	}
	return isTableStart(lines, index);
}

function isTableStart(lines: readonly string[], index: number): boolean {
	const header = lines[index] as string;
	const separator = lines[index + 1];
	if (separator === undefined) {
		return false;
	}
	if (!header.includes('|') || !separator.includes('|')) {
		return false;
	}
	// A linha separadora Ã© feita de `-`, `:` e `|` â€” o que a distingue de
	// uma segunda linha de conteÃºdo.
	return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(separator);
}

function splitRow(line: string): string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith('|')) {
		trimmed = trimmed.slice(1);
	}
	if (trimmed.endsWith('|')) {
		trimmed = trimmed.slice(0, -1);
	}
	return trimmed.split('|').map((cell) => cell.trim());
}

function renderTable(doc: MarkdownDocument, lines: readonly string[], start: number, out: MarkdownNode[]): number {
	const table = doc.createElement('table');
	const thead = doc.createElement('thead');
	const headerRow = doc.createElement('tr');
	const headers = splitRow(lines[start] as string);
	const alignments = splitRow(lines[start + 1] as string).map((cell) => {
		const left = cell.startsWith(':');
		const right = cell.endsWith(':');
		return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
	});
	for (const [column, text] of headers.entries()) {
		const th = doc.createElement('th');
		appendInline(doc, th, text);
		const align = alignments[column];
		if (align !== undefined && align.length > 0) {
			th.style.textAlign = align;
		}
		headerRow.append(th);
	}
	thead.append(headerRow);
	table.append(thead);

	const tbody = doc.createElement('tbody');
	let cursor = start + 2;
	while (cursor < lines.length) {
		const line = lines[cursor] as string;
		if (line.trim().length === 0 || !line.includes('|')) {
			break;
		}
		const row = doc.createElement('tr');
		const cells = splitRow(line);
		for (let column = 0; column < headers.length; column += 1) {
			const td = doc.createElement('td');
			appendInline(doc, td, cells[column] ?? '');
			const align = alignments[column];
			if (align !== undefined && align.length > 0) {
				td.style.textAlign = align;
			}
			row.append(td);
		}
		tbody.append(row);
		cursor += 1;
	}
	table.append(tbody);
	out.push(table);
	return cursor;
}

/**
 * Marcadores inline, na ordem em que precisam ser tentados.
 *
 * CÃ³digo vem **primeiro**, porque dentro de uma crase nada mais Ã©
 * interpretado: `` `**x**` `` Ã© o texto literal, nÃ£o negrito.
 *
 * `inner` diz qual grupo Ã© o conteÃºdo do marcador â€” cada padrÃ£o tem o seu,
 * e um link precisa do par (texto, destino) separado.
 */
const INLINE_PATTERNS: readonly {
	readonly pattern: RegExp;
	readonly tag: string;
	/** Ãndices dos grupos que formam o conteÃºdo. */
	readonly inner: readonly number[];
}[] = [
	// CÃ³digo inline: uma ou mais crases, sem cruzar linha.
	{ pattern: /(`+)([^`]+?)\1(?!`)/, tag: 'code', inner: [2] },
	// Link `[texto](url)` â€” o esquema Ã© validado abaixo.
	{ pattern: /\[([^\]]+)\]\(([^)\s]+)\)/, tag: 'a', inner: [1, 2] },
	// Negrito: `**` ou `__`. Antes do itÃ¡lico, senÃ£o `**x**` vira `*` + negrito.
	{ pattern: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/, tag: 'strong', inner: [2] },
	// Riscado.
	{ pattern: /~~(?=\S)([\s\S]*?\S)~~/, tag: 'del', inner: [1] },
	// ItÃ¡lico: `*` ou `_`, com cuidado para nÃ£o casar o `_` de `snake_case`.
	{ pattern: /(?<![\w*])\*(?=\S)([\s\S]*?\S)\*(?![\w*])/, tag: 'em', inner: [1] },
	{ pattern: /(?<![\w_])_(?=\S)([\s\S]*?\S)_(?![\w_])/, tag: 'em', inner: [1] },
];

/** O que um link pode ser. Qualquer outro esquema continua texto. */
const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * Escreve o texto de um bloco, com a formataÃ§Ã£o inline aplicada.
 *
 * Percorre em ordem de posiÃ§Ã£o, nÃ£o por tipo: o primeiro marcador que aparece
 * no texto decide o que vem antes dele. Isso mantÃ©m a ordem natural de
 * `**a** e *b*` em vez de agrupar por formato.
 */
export function appendInline(doc: MarkdownDocument, parent: MarkdownElement, text: string): void {
	let remaining = text;
	let guard = 0;
	while (remaining.length > 0 && guard < 2_000) {
		guard += 1;
		let earliest:
			| { index: number; length: number; tag: string; groups: readonly (string | undefined)[] }
			| undefined;
		for (const { pattern, tag, inner } of INLINE_PATTERNS) {
			const match = pattern.exec(remaining);
			if (match === null) {
				continue;
			}
			// Um marcador imediatamente precedido por `\` Ã© literal.
			if (remaining.slice(0, match.index).endsWith('\\')) {
				continue;
			}
			if (earliest === undefined || match.index < earliest.index) {
				earliest = {
					index: match.index,
					length: match[0].length,
					tag,
					groups: inner.map((group) => match[group]),
				};
			}
		}
		if (earliest === undefined) {
			parent.append(doc.createTextNode(unescapeBackslashes(remaining)));
			return;
		}
		const before = remaining.slice(0, earliest.index);
		if (before.length > 0) {
			parent.append(doc.createTextNode(unescapeBackslashes(before)));
		}
		const node = doc.createElement(earliest.tag);
		if (earliest.tag === 'a') {
			const [label, target] = earliest.groups;
			if (target === undefined || !SAFE_LINK.test(target)) {
				// Esquema nÃ£o permitido: fica texto, sem `<a>`.
				parent.append(doc.createTextNode(remaining.slice(earliest.index, earliest.index + earliest.length)));
				remaining = remaining.slice(earliest.index + earliest.length);
				continue;
			}
			node.setAttribute('href', target);
			node.setAttribute('rel', 'noreferrer noopener');
			node.setAttribute('target', '_blank');
			node.textContent = unescapeBackslashes(label ?? target);
		} else if (earliest.tag === 'code') {
			// Dentro de cÃ³digo inline, nada mais Ã© interpretado.
			node.textContent = earliest.groups[0] ?? '';
		} else {
			appendInline(doc, node, earliest.groups[0] ?? '');
		}
		parent.append(node);
		remaining = remaining.slice(earliest.index + earliest.length);
	}
	if (remaining.length > 0 && guard >= 2_000) {
		parent.append(doc.createTextNode(remaining));
	}
}

/** `\*` Ã© o asterisco literal; o escape sumiu, o caractere fica. */
function unescapeBackslashes(text: string): string {
	return text.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1');
}

