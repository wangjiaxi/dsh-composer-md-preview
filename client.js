/* eslint-disable */
/**
 * Client half of `dsh-composer-md-preview`.
 *
 * Three slot entries, one idea: your own text reads as Markdown, not as
 * markers.
 *
 *  - `conversation.input.left` (`composer-md-preview-bridge`, order 101) — the
 *    seat inside the composer card: it renders nothing, portals the rendered
 *    draft into the card so the input box itself shows it, and publishes the
 *    session's action face for the document-level paste listener.
 *  - `conversation.input.left` (`composer-md-preview-toggle`, order 100) — the
 *    MD pill in the composer tool row: the master switch for both halves.
 *  - `conversation.user.text.node` (`key: 'text'`, priority 50) — renders a sent
 *    message as Markdown inside its existing bubble, shadowing the shipped
 *    plain-text run for that key (keyed dispatch renders the lowest priority).
 *
 * The Markdown pipeline is local: a small GFM-subset block/inline parser that
 * produces plain data, and a React renderer that turns that data into themed
 * elements. Nothing is imported from Harness Client packages, so a renamed
 * internal primitive cannot blank the slot entry or a transcript; only theme
 * tokens are used for color, type and elevation.
 *
 * Authored as a lazy CommonJS factory for the Web module loader: running the
 * bundle only registers the factory, and `apply` holds every side effect
 * (dictionary, stylesheet, slot registrations) inside `ctx.effect`.
 */
window.__ModuleLoader__.load({
	id: "dsh-composer-md-preview",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		/** Locale namespace owned by this plugin. */
		const NS = 'dsh-composer-md-preview';
		/** localStorage key holding the two persisted preferences. */
		const STORAGE_KEY = 'dsh-composer-md-preview/v1';
		/** Text longer than this is not rendered: this is a reading aid, not a document viewer. */
		const MAX_RENDER_CHARS = 50000;

		// #region preferences
		/**
		 * Persisted preferences, shared by both slot entries.
		 *
		 * `enabled` is the master switch (the MD pill writes it). `autoFence` wraps
		 * a pasted code chunk in a fenced block; its own row lives in Settings >
		 * General.
		 */
		let prefs = { enabled: true, autoFence: true };
		let prefsSnapshot = prefs;
		const prefsListeners = new Set();

		function readPrefs() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				if (raw === null) return;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== 'object') return;
				if (typeof parsed.enabled === 'boolean') prefs.enabled = parsed.enabled;
				if (typeof parsed.autoFence === 'boolean') prefs.autoFence = parsed.autoFence;
				prefsSnapshot = { ...prefs };
			} catch (error) {
				console.warn('[composer-md-preview] could not read preferences', error);
			}
		}

		function writePrefs() {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
			} catch (error) {
				console.warn('[composer-md-preview] could not persist preferences', error);
			}
		}

		/** Merge one patch into the snapshot, persist it, and wake both entries. */
		function commitPrefs(patch) {
			prefsSnapshot = { ...prefsSnapshot, ...patch };
			prefs = { ...prefsSnapshot };
			writePrefs();
			for (const listener of [...prefsListeners]) {
				try {
					listener();
				} catch (error) {
					console.error('[composer-md-preview] preference listener failed', error);
				}
			}
		}

		function subscribePrefs(listener) {
			prefsListeners.add(listener);
			return () => {
				prefsListeners.delete(listener);
			};
		}

		function getPrefs() {
			return prefsSnapshot;
		}

		function usePrefs() {
			return React.useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
		}
		// #endregion

		// #region detection
		/**
		 * Conservative Markdown fingerprints. The card shows only after one of
		 * these matches, so ordinary prose never duplicates itself above the
		 * composer; a false negative is silent, while a false positive would be
		 * pure noise.
		 */
		const MARKDOWN_HINTS = [
			/(^|\n) {0,3}#{1,6}([ \t]|$)/, // ATX heading
			/(^|\n) {0,3}>[ \t]?/, // blockquote
			/(^|\n) {0,3}(`{3,}|~{3,})/, // fenced code
			/(^|\n) {0,3}([-*+]|\d{1,9}[.)])[ \t]+\S/, // list item
			/(^|\n) {0,3}([-*_])[ \t]*(?:\2[ \t]*){2,}$/, // thematic break
			/(^|\n) {0,3}\|?[ \t]*:?-{2,}:?[ \t]*\|/, // table separator row
			/`[^`\n]+`/, // inline code
			/\*\*[^*\n]+\*\*/, // strong
			/(^|[^\w])__[^_\n]+__/, // strong (underscore)
			/(^|[^*\w])\*[^*\s][^*\n]*\*/, // emphasis
			/\b_[^_\n]+_\b/, // emphasis (underscore)
			/~~[^~\n]+~~/, // strikethrough
			/!?\[[^\]\n]*\]\([^)\n]+\)/, // link or image
			/(^|\n) {0,3}<(?:https?|mailto):[^>\s]+>/, // autolink
		];

		/** @returns whether the draft carries any Markdown syntax worth previewing. */
		function looksLikeMarkdown(text) {
			if (typeof text !== 'string' || text.trim() === '') return false;
			for (const hint of MARKDOWN_HINTS) if (hint.test(text)) return true;
			return false;
		}
		// #endregion

		// #region inline parser
		/** Characters that a backslash may escape. */
		const ESCAPABLE = '\\`*_{}[]()#+-.!>~|';
		const WORD = /[0-9A-Za-z\u00C0-\uFFFF]/;

		/**
		 * Read `[label](destination "title")` starting at the `[`.
		 * @param text - source string.
		 * @param at - index of `[`.
		 * @returns label, destination, title, and the index after `)`, or null.
		 */
		function readLinkLike(text, at) {
			let depth = 0;
			let cursor = at;
			for (; cursor < text.length; cursor += 1) {
				const ch = text[cursor];
				if (ch === '\\') {
					cursor += 1;
					continue;
				}
				if (ch === '[') depth += 1;
				else if (ch === ']') {
					depth -= 1;
					if (depth === 0) break;
				}
			}
			if (cursor >= text.length || text[cursor] !== ']' || text[cursor + 1] !== '(') return null;
			const label = text.slice(at + 1, cursor);
			let parens = 0;
			let end = cursor + 2;
			for (; end < text.length; end += 1) {
				const ch = text[end];
				if (ch === '\\') {
					end += 1;
					continue;
				}
				if (ch === '(') parens += 1;
				else if (ch === ')') {
					if (parens === 0) break;
					parens -= 1;
				}
			}
			if (end >= text.length) return null;
			let raw = text.slice(cursor + 2, end).trim();
			if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1).trim();
			const parts = raw.split(/\s+/);
			const destination = parts.shift() ?? '';
			let title = parts.join(' ').trim();
			if (title.startsWith('"') || title.startsWith("'") || title.startsWith('(')) title = title.slice(1);
			if (title.endsWith('"') || title.endsWith("'") || title.endsWith(')')) title = title.slice(0, -1);
			return { label, destination, title, end: end + 1 };
		}

		/**
		 * Find the closing marker of an emphasis span.
		 * A single-character marker must not close inside a longer run, so
		 * `*a **b** c*` closes on the last `*` and keeps the strong span inside.
		 * @param text - source string.
		 * @param from - index just after the opening marker.
		 * @param marker - the opening marker, one or two characters.
		 * @returns the closing index, or -1.
		 */
		function findEmphasisClose(text, from, marker) {
			let index = text.indexOf(marker, from);
			while (index !== -1) {
				if (marker.length > 1) return index;
				// A single marker never closes inside a run (`**`, `~~`, ...): the
				// run belongs to the inner span or stays literal.
				if (text[index - 1] !== marker && text[index + 1] !== marker) return index;
				index = text.indexOf(marker, index + 1);
			}
			return -1;
		}

		/**
		 * Read emphasis, strong, or strikethrough starting at a marker character.
		 * @returns tag, inner source, and the index after the closing marker, or null.
		 */
		function readEmphasis(text, at) {
			const ch = text[at];
			const candidates = ch === '~'
				? [['~~', 'del']]
				: ch === '*'
					? [['**', 'strong'], ['*', 'em']]
					: [['__', 'strong'], ['_', 'em']];
			for (const [marker, tag] of candidates) {
				if (!text.startsWith(marker, at)) continue;
				// A run of three or more markers is left literal: half-parsed
				// bold+italic reads worse than the raw text a user typed.
				if (text[at + marker.length] === marker[0]) continue;
				// Snake_case and intraword underscores are not emphasis in GFM.
				if (marker[0] === '_' && at > 0 && WORD.test(text[at - 1])) continue;
				const from = at + marker.length;
				const close = findEmphasisClose(text, from, marker);
				if (close <= from) continue;
				const inner = text.slice(from, close);
				if (inner.trim() === '') continue;
				if (marker[0] === '_' && close + marker.length < text.length && WORD.test(text[close + marker.length])) continue;
				return { tag, inner, end: close + marker.length };
			}
			return null;
		}

		/** Nesting cap for both parsers: a hostile draft must not overflow the stack. */
		const MAX_DEPTH = 8;

		/**
		 * Split inline Markdown into plain data nodes.
		 * @param text - one line or span of source.
		 * @param depth - nesting level; beyond {@link MAX_DEPTH} the span stays literal.
		 * @returns nodes for {@link renderInline}.
		 */
		function parseInline(text, depth = 0) {
			if (depth >= MAX_DEPTH) return [{ type: 'text', value: text }];
			const nodes = [];
			let buffer = '';
			let index = 0;
			const flush = () => {
				if (buffer !== '') {
					nodes.push({ type: 'text', value: buffer });
					buffer = '';
				}
			};
			while (index < text.length) {
				const ch = text[index];
				if (ch === '\\' && index + 1 < text.length && ESCAPABLE.includes(text[index + 1])) {
					buffer += text[index + 1];
					index += 2;
					continue;
				}
				if (ch === '`') {
					const close = text.indexOf('`', index + 1);
					if (close > index + 1) {
						flush();
						nodes.push({ type: 'code', value: text.slice(index + 1, close).replace(/^ (.*) $/, '$1') });
						index = close + 1;
						continue;
					}
				}
				if (ch === '!' && text[index + 1] === '[') {
					const image = readLinkLike(text, index + 1);
					if (image !== null) {
						flush();
						nodes.push({ type: 'image', alt: image.label, src: image.destination });
						index = image.end;
						continue;
					}
				}
				if (ch === '[') {
					const link = readLinkLike(text, index);
					if (link !== null) {
						flush();
						nodes.push({ type: 'link', href: link.destination, title: link.title, nodes: parseInline(link.label, depth + 1) });
						index = link.end;
						continue;
					}
				}
				if (ch === '<') {
					const autolink = /^<((?:https?|mailto):[^\s<>]+)>/.exec(text.slice(index));
					if (autolink !== null) {
						flush();
						nodes.push({ type: 'link', href: autolink[1], title: '', nodes: [{ type: 'text', value: autolink[1] }] });
						index += autolink[0].length;
						continue;
					}
				}
				if (ch === '*' || ch === '_' || ch === '~') {
					const emphasis = readEmphasis(text, index);
					if (emphasis !== null) {
						flush();
						nodes.push({ type: emphasis.tag, nodes: parseInline(emphasis.inner, depth + 1) });
						index = emphasis.end;
						continue;
					}
				}
				buffer += ch;
				index += 1;
			}
			flush();
			return nodes;
		}
		// #endregion

		// #region block parser
		const LIST_MARKER = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+|$)/;
		const TASK_MARKER = /^\[([ xX])\][ \t]+(.*)$/;

		/** Count leading indentation in columns, treating a tab as four spaces. */
		function indentOf(line) {
			let width = 0;
			for (const ch of line) {
				if (ch === ' ') width += 1;
				else if (ch === '\t') width += 4;
				else break;
			}
			return width;
		}

		/** Remove at most `count` leading spaces (tabs count as four). */
		function dedent(line, count) {
			let removed = 0;
			let index = 0;
			while (index < line.length && removed < count) {
				if (line[index] === ' ') {
					removed += 1;
					index += 1;
					continue;
				}
				if (line[index] === '\t' && removed + 4 <= count + 3) {
					removed += 4;
					index += 1;
					continue;
				}
				break;
			}
			return line.slice(index);
		}

		function matchListMarker(line) {
			const match = LIST_MARKER.exec(line);
			if (match === null) return null;
			const ordered = match[3] !== undefined;
			return {
				indent: indentOf(match[1]),
				ordered,
				number: ordered ? Number(match[3]) : 1,
				/** Content column: where this item's own text begins. */
				column: match[0].length,
				rest: line.slice(match[0].length),
			};
		}

		function isBlockStart(line) {
			if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return true;
			if (/^ {0,3}#{1,6}([ \t]|$)/.test(line)) return true;
			if (/^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) return true;
			if (/^ {0,3}>/.test(line)) return true;
			return matchListMarker(line) !== null;
		}

		/** Split one table row into trimmed cell sources, honoring `\|` escapes. */
		function splitTableRow(line) {
			let body = line.trim();
			if (body.startsWith('|')) body = body.slice(1);
			if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
			const cells = [];
			let cell = '';
			for (let index = 0; index < body.length; index += 1) {
				const ch = body[index];
				if (ch === '\\' && body[index + 1] === '|') {
					cell += '|';
					index += 1;
					continue;
				}
				if (ch === '|') {
					cells.push(cell);
					cell = '';
					continue;
				}
				cell += ch;
			}
			cells.push(cell);
			return cells;
		}

		/** Read a GFM table starting at `start`, or null when the shape does not hold. */
		function readTable(lines, start) {
			const head = lines[start];
			if (!head.includes('|')) return null;
			const separator = lines[start + 1];
			if (separator === undefined || !separator.includes('|')) return null;
			const headCells = splitTableRow(head);
			const separatorCells = splitTableRow(separator);
			if (separatorCells.length !== headCells.length) return null;
			if (!separatorCells.every(cell => /^:?-+:?$/.test(cell.trim()))) return null;
			const align = separatorCells.map(cell => {
				const value = cell.trim();
				const left = value.startsWith(':');
				const right = value.endsWith(':');
				if (left && right) return 'center';
				if (right) return 'right';
				if (left) return 'left';
				return '';
			});
			const rows = [];
			let index = start + 2;
			while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|')) {
				rows.push(splitTableRow(lines[index]).map(cell => parseInline(cell.trim())));
				index += 1;
			}
			return {
				node: {
					type: 'table',
					align,
					head: headCells.map(cell => parseInline(cell.trim())),
					rows,
				},
				next: index,
			};
		}

		/** Read one list (and its nested lists) starting at `start`. */
		function readList(lines, start, depth) {
			const first = matchListMarker(lines[start]);
			const base = first.indent;
			const ordered = first.ordered;
			const items = [];
			let index = start;
			while (index < lines.length) {
				const marker = matchListMarker(lines[index]);
				if (marker === null || marker.indent !== base || marker.ordered !== ordered) break;
				let rest = marker.rest;
				let checked;
				const task = TASK_MARKER.exec(rest);
				if (task !== null) {
					checked = task[1] !== ' ';
					rest = task[2];
				}
				const content = [rest];
				const column = marker.column;
				index += 1;
				while (index < lines.length) {
					const line = lines[index];
					if (line.trim() === '') {
						// A blank line continues the item only when indented content follows.
						let probe = index;
						while (probe < lines.length && lines[probe].trim() === '') probe += 1;
						if (probe >= lines.length) {
							index = probe;
							break;
						}
						const nextMarker = matchListMarker(lines[probe]);
						const keeps = nextMarker !== null ? nextMarker.indent >= base : indentOf(lines[probe]) > base;
						if (!keeps) break;
						content.push('');
						index = probe;
						continue;
					}
					const nested = matchListMarker(line);
					const indent = indentOf(line);
					if (nested !== null && nested.indent > base) {
						// Absorption: take following lines deeper than the item's own
						// marker, dedented so the nested list parses at column zero.
						content.push('');
						while (index < lines.length) {
							const deeper = lines[index];
							if (deeper.trim() === '') {
								content.push('');
								index += 1;
								continue;
							}
							if (indentOf(deeper) > base) {
								content.push(dedent(deeper, column));
								index += 1;
								continue;
							}
							break;
						}
						continue;
					}
					if (nested !== null && nested.indent === base) break;
					if (indent > base) {
						content.push(dedent(line, column));
						index += 1;
						continue;
					}
					if (indent <= base && nested === null) {
						// Lazy continuation: an unindented line still belongs to the item.
						content.push(line.trim());
						index += 1;
						continue;
					}
					break;
				}
				items.push({ checked, blocks: parseBlocks(content.join('\n'), depth + 1) });
			}
			return { node: { type: 'list', ordered, start: first.number, items }, next: index };
		}

		/**
		 * Parse Markdown source into block data.
		 * @param source - the whole draft.
		 * @param depth - nesting level; beyond {@link MAX_DEPTH} the source stays a paragraph.
		 * @returns block nodes consumed by {@link renderBlocks}.
		 */
		function parseBlocks(source, depth = 0) {
			if (depth >= MAX_DEPTH) return [{ type: 'paragraph', nodes: parseInline(String(source)) }];
			const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
			const blocks = [];
			let index = 0;
			while (index < lines.length) {
				const line = lines[index];
				if (line.trim() === '') {
					index += 1;
					continue;
				}
				const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
				if (fence !== null) {
					const marker = fence[1];
					const lang = (fence[2].trim().split(/\s+/)[0] ?? '').replace(/[`~]/g, '');
					const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
					const body = [];
					index += 1;
					while (index < lines.length && !closing.test(lines[index])) {
						body.push(lines[index]);
						index += 1;
					}
					if (index < lines.length) index += 1;
					blocks.push({ type: 'code', lang, value: body.join('\n') });
					continue;
				}
				const heading = /^ {0,3}(#{1,6})[ \t]*(.*)$/.exec(line);
				if (heading !== null) {
					const text = heading[2].replace(/\s+#+\s*$/, '');
					blocks.push({ type: 'heading', level: heading[1].length, nodes: parseInline(text) });
					index += 1;
					continue;
				}
				if (/^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) {
					blocks.push({ type: 'hr' });
					index += 1;
					continue;
				}
				if (/^ {0,3}>/.test(line)) {
					const quoted = [];
					while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
						quoted.push(lines[index].replace(/^ {0,3}>[ \t]?/, ''));
						index += 1;
					}
					blocks.push({ type: 'quote', blocks: parseBlocks(quoted.join('\n'), depth + 1) });
					continue;
				}
				const table = readTable(lines, index);
				if (table !== null) {
					blocks.push(table.node);
					index = table.next;
					continue;
				}
				const marker = matchListMarker(line);
				if (marker !== null) {
					const list = readList(lines, index, depth);
					blocks.push(list.node);
					index = list.next;
					continue;
				}
				// Paragraph: soft line breaks are kept as breaks, because every
				// newline in a composer is a key the user pressed on purpose.
				const nodes = [];
				let first = true;
				while (index < lines.length && lines[index].trim() !== '' && (first || !isBlockStart(lines[index]))) {
					if (!first) nodes.push({ type: 'break' });
					nodes.push(...parseInline(lines[index].trim()));
					first = false;
					index += 1;
				}
				blocks.push({ type: 'paragraph', nodes });
			}
			return blocks;
		}
		// #endregion

		// #region renderer
		const SAFE_PROTOCOL = /^(?:https?|mailto):/i;

		/**
		 * Render inline nodes.
		 * @param nodes - data from {@link parseInline}.
		 * @param labels - localized chrome (`image` placeholder text).
		 * @returns React children.
		 */
		function renderInline(nodes, labels) {
			return (nodes ?? []).map((node, index) => {
				const key = `i${index}`;
				switch (node.type) {
					case 'text':
						return node.value;
					case 'break':
						return h('br', { key });
					case 'code':
						return h('code', { key, className: 'dcmp-inline-code' }, node.value);
					case 'strong':
						return h('strong', { key }, renderInline(node.nodes, labels));
					case 'em':
						return h('em', { key }, renderInline(node.nodes, labels));
					case 'del':
						return h('del', { key }, renderInline(node.nodes, labels));
					case 'link': {
						// Only http(s) and mailto become anchors; a local path or an
						// unknown protocol keeps its label as plain text.
						if (!SAFE_PROTOCOL.test(node.href)) return h('span', { key }, renderInline(node.nodes, labels));
						return h(
							'a',
							{ key, className: 'dcmp-link', href: node.href, title: node.title || undefined, target: '_blank', rel: 'noreferrer noopener' },
							renderInline(node.nodes, labels),
						);
					}
					case 'image':
						return h(
							'span',
							{ key, className: 'dcmp-image', title: node.src },
							h('span', { className: 'dcmp-image-mark', 'aria-hidden': 'true' }),
							node.alt || labels.image,
						);
					default:
						return typeof node.value === 'string' ? node.value : null;
				}
			});
		}

		/**
		 * Render block nodes.
		 * @param blocks - data from {@link parseBlocks}.
		 * @param labels - localized chrome.
		 * @returns a React child list.
		 */
		function renderBlocks(blocks, labels) {
			return (blocks ?? []).map((block, index) => renderBlock(block, `b${index}`, labels));
		}

		function renderBlock(block, key, labels) {
			switch (block.type) {
				case 'paragraph':
					return h('p', { key }, renderInline(block.nodes, labels));
				case 'heading': {
					const tag = `h${Math.min(6, Math.max(1, block.level))}`;
					return h(tag, { key, className: 'dcmp-heading' }, renderInline(block.nodes, labels));
				}
				case 'hr':
					return h('hr', { key, className: 'dcmp-rule' });
				case 'code':
					return h(
						'div',
						{ key, className: 'dcmp-code' },
						block.lang === '' ? null : h('span', { className: 'dcmp-code-lang' }, block.lang),
						h('pre', null, h('code', null, block.value)),
					);
				case 'quote':
					return h('blockquote', { key, className: 'dcmp-quote' }, renderBlocks(block.blocks, labels));
				case 'list': {
					const tag = block.ordered ? 'ol' : 'ul';
					return h(
						tag,
						{ key, className: 'dcmp-list', start: block.ordered && block.start !== 1 ? block.start : undefined },
						block.items.map((item, itemIndex) => {
							const onlyParagraph = item.blocks.length === 1 && item.blocks[0].type === 'paragraph';
							const body = onlyParagraph
								? renderInline(item.blocks[0].nodes, labels)
								: renderBlocks(item.blocks, labels);
							const task = item.checked === undefined;
							return h(
								'li',
								{ key: `${key}-${itemIndex}`, className: task ? 'dcmp-item' : 'dcmp-item dcmp-task' },
								task ? null : h('input', {
									type: 'checkbox',
									className: 'dcmp-check',
									checked: item.checked === true,
									readOnly: true,
									disabled: true,
									tabIndex: -1,
									'aria-label': item.checked ? labels.checked : labels.unchecked,
								}),
								body,
							);
						}),
					);
				}
				case 'table':
					return h(
						'div',
						{ key, className: 'dcmp-tablewrap' },
						h(
							'table',
							{ className: 'dcmp-table' },
							h('thead', null, h('tr', null, block.head.map((cell, cellIndex) => h(
								'th',
								{ key: `h${cellIndex}`, style: block.align[cellIndex] ? { textAlign: block.align[cellIndex] } : undefined },
								renderInline(cell, labels),
							)))),
							h('tbody', null, block.rows.map((row, rowIndex) => h(
								'tr',
								{ key: `r${rowIndex}` },
								row.map((cell, cellIndex) => h(
									'td',
									{ key: `c${cellIndex}`, style: block.align[cellIndex] ? { textAlign: block.align[cellIndex] } : undefined },
									renderInline(cell, labels),
								)),
							))),
						),
					);
				default:
					return null;
			}
		}
		// #endregion

		// #region paste
		/**
		 * Pasted code arrives as a fenced block.
		 *
		 * The composer's editor reads only `text/plain` from the paste event and
		 * inserts it; a capture-phase listener can therefore rewrite what it is
		 * about to read, and the editor inserts the fenced source with its own
		 * history entry, caret and undo intact. No DOM is written, and when the
		 * rewrite does not take (files in the clipboard, a platform that refuses
		 * `setData` on a paste handler) the raw text lands and nothing is lost.
		 */
		/**
		 * Live composer handle for the document-level paste listener.
		 *
		 * The listener runs outside React, so it cannot read a prop. The composer
		 * bridge publishes the session's stable action face here on every render.
		 */
		const pasteBridge = { actions: undefined, draft: '', phase: 'plain' };

		/**
		 * The one seat inside the composer card a plugin can take.
		 *
		 * It does three things from there: publish the session's action face for the
		 * document-level paste listener, portal the rendered draft into a container
		 * appended to the card (ordered first, so it becomes the top of the input
		 * box itself rather than a panel outside it), and keep that container alive
		 * across re-renders.
		 * @param props - slot props: input actions, the input hook, locale seat.
		 */
		function ComposerBridge({ inputActions, useInput, t }) {
			const translate = typeof t === 'function' ? t : key => key;
			const prefsNow = usePrefs();
			const anchorRef = React.useRef(null);
			const [host, setHost] = React.useState(null);
			const state = typeof useInput === 'function' ? useInput(snapshot => snapshot) : undefined;
			const draft = typeof state?.draft === 'string' ? state.draft : '';
			pasteBridge.actions = inputActions !== null && typeof inputActions === 'object' ? inputActions : undefined;
			pasteBridge.draft = draft;
			pasteBridge.phase = typeof state?.phase === 'string' ? state.phase : 'plain';

			React.useEffect(() => {
				const anchor = anchorRef.current;
				const card = anchor === null || anchor === undefined ? null : anchor.closest('[data-composer-card]');
				if (card === null) return undefined;
				const container = document.createElement('div');
				container.className = 'dcmp-host';
				card.appendChild(container);
				setHost(container);
				return () => {
					container.remove();
				};
			}, []);

			const panel = React.useMemo(
				() => draftPanel({ draft, enabled: prefsNow.enabled, translate }),
				[draft, prefsNow.enabled, translate],
			);
			return [
				h('span', { key: 'anchor', ref: anchorRef, className: 'dcmp-anchor', 'aria-hidden': 'true' }),
				host === null || panel === null ? null : ReactDOM.createPortal(panel, host),
			];
		}

		/** A paste that already carries a fence is left alone. */
		const FENCED = /^ {0,3}(`{3,}|~{3,})/m;
		/** Pastes above this size skip classification entirely. */
		const MAX_PASTE_CHARS = 400000;
		/** CJK ranges: a line carrying them is prose unless it also carries source. */
		const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
		/** One line that reads as source rather than prose. */
		const STRONG_LINE = /[{}]|;\s*$|(?:=>|::|->|\+\+|===|!==|&&|\|\||\+=|-=|\*=|\/=)|^@@|^[-+]{3}\s|^(?:#!|#include|#define|<\?php|<!doctype|<html|<\/?[a-z][a-z0-9-]*[\s>])|^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b|^\s*(?:sudo\s+)?(?:git|npm|pnpm|yarn|npx|node|python3?|pip3?|cargo|go|docker|kubectl|systemctl|journalctl|cd|ls|cat|echo|curl|wget|rm|cp|mv|mkdir|chmod|chown|tar|unzip|ssh|scp|dsh|make|gcc|g\+\+|clang|find|grep|sed|awk|export|source)\b/i;
		/** Source-shaped line that also occurs in prose (`key: value`). */
		const WEAK_LINE = /^\s*[\w.$-]+\s*[:=]\s*\S|^\s*["'].*["'],?\s*$/;
		/** A command line (no language tells a script apart from prose other than this). */
		const SHELL_LINE = /^(?:sudo\s+)?(?:(?:git|npm|pnpm|yarn|npx|node|python3?|pip3?|cargo|go|docker|kubectl|systemctl|journalctl|cd|ls|cat|echo|curl|wget|rm|cp|mv|mkdir|chmod|chown|tar|unzip|ssh|scp|dsh|make|gcc|g\+\+|clang|find|grep|sed|awk|export|source)\b|\.\/\S)/;
		/** Keyword-led line that is only ever source. */
		const KEYWORD_LINE = /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|import|from|const|let|var|return|if|for|while|switch|try|catch|pub|fn|impl|use|mod|package|func|struct|enum|interface|type|namespace|public|private|protected|static|void|int|char|float|double|template)\b/;

		/** @returns whether `text` parses as JSON. */
		function isJsonText(text) {
			try {
				JSON.parse(text);
				return true;
			} catch {
				return false;
			}
		}

		/**
		 * Decide whether a pasted chunk reads as source rather than prose.
		 *
		 * Deliberately conservative: a false positive would fence a paragraph,
		 * while a false negative only leaves the text raw, which the user can fix
		 * by typing three backticks.
		 * @param text - pasted text, already newline-normalized.
		 * @returns whether the chunk should be fenced.
		 */
		function looksLikeCode(text) {
			const filled = text.split('\n').map(line => line.replace(/\s+$/, '')).filter(line => line.trim() !== '');
			if (filled.length === 0) return false;
			const trimmed = text.trim();
			if (filled.length === 1) return trimmed.length >= 20 && isJsonText(trimmed);
			if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && isJsonText(trimmed)) return true;

			let strong = 0;
			let weak = 0;
			let prose = 0;
			for (const line of filled) {
				if (STRONG_LINE.test(line) || KEYWORD_LINE.test(line) || /^[\t ]{2,}\S/.test(line)) strong += 1;
				else if (WEAK_LINE.test(line)) weak += 1;
				else if (CJK.test(line)) prose += 1;
			}
			// A mostly-Chinese paste with a couple of braces is a sentence, not code.
			if (prose > strong) return false;
			const score = strong + weak * 0.5;
			if (score < Math.max(2, filled.length * 0.3)) return false;
			return strong >= 2 || (strong >= 1 && weak >= 2);
		}

		/**
		 * Name the language of a fenced block, best effort.
		 * @param text - the code chunk.
		 * @returns a fence info string, or '' when the language is unknown.
		 */
		function detectLanguage(text) {
			const head = text.trimStart();
			if (/^#!.*\b(?:bash|sh|zsh)\b/.test(head)) return 'bash';
			if (/^#!.*\bnode\b/.test(head)) return 'javascript';
			if (/^#!.*\bpython/.test(head)) return 'python';
			if (/^<\?php/.test(head)) return 'php';
			if (/^(?:<!doctype html|<html[\s>])/i.test(head)) return 'html';
			if (/^<[a-z][a-z0-9-]*[\s>]/i.test(head) && /<\/[a-z]/i.test(text)) return 'html';
			const trimmed = text.trim();
			if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && isJsonText(trimmed)) return 'json';
			if (/^\s*(?:\+\+\+|---)\s+[ab]\//m.test(text)) return 'diff';
			if (/#include\s*[<"]/.test(text)) {
				return /std::|#include\s*<(?:iostream|bits\/)|using\s+namespace\s+std|std::cout|std::cin/.test(text) ? 'cpp' : 'c';
			}
			if (/\bpackage\s+main\b/.test(text) && /\bfunc\s+\w+\s*\(/.test(text)) return 'go';
			if (/\bfn\s+\w+\s*\(|\blet\s+mut\s|\bimpl\s+\w+|\bpub\s+fn\b/.test(text)) return 'rust';
			if (/\bpublic\s+class\b|\bSystem\.out\.println|\bpublic\s+static\s+void\s+main\b/.test(text)) return 'java';
			if (/\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(text)) return 'sql';
			if (/^\s*(?:async\s+)?def\s+\w+\s*\(|^\s*from\s+[\w.]+\s+import\s+\w|^\s*import\s+[\w.]+(?:\s+as\s+\w+)?\s*$/m.test(text)) return 'python';
			if (/=>|\bconsole\.log\b|^\s*(?:const|let)\s+[\w{[]|^\s*(?:async\s+)?function\s+\w+/m.test(text)) {
				return /:\s*(?:string|number|boolean|void|unknown|any|never)\b|\binterface\s+\w+|\btype\s+\w+\s*=|:\s*[A-Z]\w*\[?/.test(text)
					? 'typescript'
					: 'javascript';
			}
			if (/^[.#]?[\w-]+[^{}]*\{[^{}]*:[^{}]*\}/m.test(text)) return 'css';
			const commands = text.split('\n').map(line => line.trim()).filter(line => line !== '');
			if (commands.length >= 2 && commands.every(line => SHELL_LINE.test(line))) return 'bash';
			if (/^\s*[\w.-]+\s*:\s+\S/m.test(text) && !/[{};=]/.test(text)) return 'yaml';
			return '';
		}

		/**
		 * Build the clipboard replacement for one paste, if any.
		 * @param raw - the pasted `text/plain`.
		 * @returns fenced source, or null to leave the paste untouched.
		 */
		function fenceForPaste(raw) {
			if (typeof raw !== 'string' || raw.trim() === '') return null;
			const text = raw.replace(/\r\n?/g, '\n');
			if (text.length > MAX_PASTE_CHARS) return null;
			if (FENCED.test(text)) return null;
			if (!looksLikeCode(text)) return null;
			const language = detectLanguage(text);
			return '```' + language + '\n' + text.replace(/\n+$/, '') + '\n```';
		}

		/**
		 * Pad a fenced block so it starts and ends on its own lines.
		 * @param fenced - the fenced source.
		 * @param atLineStart - whether the caret already sits at its line start.
		 * @returns the text to paste.
		 */
		function pasteWithBreaks(fenced, atLineStart) {
			return (atLineStart ? '' : '\n\n') + fenced + '\n';
		}

		/**
		 * Whether the caret sits at the start of its paragraph.
		 * @param fallback - answer when the selection cannot be read.
		 * @returns whether the text before the caret in its block is blank.
		 */
		function caretAtLineStart(fallback) {
			const selection = window.getSelection();
			if (selection === null || selection.rangeCount === 0) return fallback;
			const range = selection.getRangeAt(0);
			const start = range.startContainer;
			const element = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
			if (element === null || element === undefined) return fallback;
			const block = element.closest('p, li, h1, h2, h3, h4, h5, h6, div');
			if (block === null) return fallback;
			const probe = document.createRange();
			probe.selectNodeContents(block);
			try {
				probe.setEnd(range.startContainer, range.startOffset);
			} catch {
				return fallback;
			}
			return probe.toString().trim() === '';
		}

		/** Install the paste rewrite; returns its disposer. */
		function installPasteFence() {
			const onPaste = event => {
				if (!prefsSnapshot.enabled || !prefsSnapshot.autoFence) return;
				// An explicit "paste as plain text" gesture asks for the text as is.
				if (event.shiftKey) return;
				const target = event.target;
				if (!(target instanceof Element) || target.isContentEditable !== true) return;
				if (target.closest('[data-composer-card]') === null) return;
				const data = event.clipboardData;
				if (data === null) return;
				if (data.files !== null && data.files !== undefined && data.files.length > 0) return;
				const fenced = fenceForPaste(data.getData('text/plain'));
				if (fenced === null) return;
				const payload = pasteWithBreaks(fenced, caretAtLineStart(true));
				const actions = pasteBridge.actions;
				if (actions === undefined || typeof actions.insertText !== 'function' || typeof actions.captureInsertion !== 'function') {
					// No live composer handle: hand the fenced text to the platform and
					// let its own paste run. Harmless where the write is refused.
					try {
						data.setData('text/plain', payload);
					} catch (error) {
						console.warn('[composer-md-preview] could not rewrite the pasted text', error);
					}
					return;
				}
				// Chromium keeps the paste store read-only, so own the insertion: the
				// shell's `insertText` writes at the captured caret in one undo step,
				// and refuses exactly when the editor would have refused the paste.
				const span = actions.captureInsertion();
				event.preventDefault();
				// The composer's own paste command reads the clipboard and inserts the
				// raw text without looking at `defaultPrevented`, so the event must not
				// reach it: only this handler's insert may land.
				event.stopImmediatePropagation();
				if (actions.insertText(payload, span) !== true) {
					// False means a frozen composer (which would have dropped the paste
					// too) or a span that no longer maps. Never lose the text on the
					// second case; the caret moves to the end, and nothing is written
					// while the composer is frozen.
					const phase = pasteBridge.phase;
					if ((phase === 'plain' || phase === 'claimed') && typeof actions.setDraft === 'function') {
						actions.setDraft(pasteBridge.draft + payload);
						console.warn('[composer-md-preview] inserted the code block at the end of the draft');
					}
					return;
				}
			};
			document.addEventListener('paste', onPaste, true);
			return () => document.removeEventListener('paste', onPaste, true);
		}
		// #endregion

		// #region components
		/** Fallback hook keeps the render hook order stable when no input seat exists. */
		function useNoInput() {
			return '';
		}

		function selectDraft(state) {
			return state !== null && typeof state === 'object' && typeof state.draft === 'string' ? state.draft : '';
		}

		/**
		 * Build the rendered draft panel, or null when there is nothing to show.
		 *
		 * Pure: the panel is portalled into the composer card, and this function
		 * only decides whether it exists and what it contains.
		 * @param input - the draft, the master switch, and the translate seat.
		 * @returns the panel element, or null.
		 */
		function draftPanel({ draft, enabled, translate }) {
			const say = typeof translate === 'function' ? translate : key => key;
			const overflow = draft.length > MAX_RENDER_CHARS;
			const text = overflow ? draft.slice(0, MAX_RENDER_CHARS) : draft;
			if (!enabled || text.trim() === '' || !looksLikeMarkdown(draft)) return null;
			const labels = {
				image: say('image'),
				checked: say('checked'),
				unchecked: say('unchecked'),
			};
			return h(
				'div',
				{
					className: 'dcmp-inline-preview',
					'data-dsh-md-preview': '',
					role: 'region',
					'aria-label': say('title'),
				},
				overflow
					? h('p', { className: 'dcmp-notice' }, say('meta.overflow', { chars: draft.length }))
					: h('div', { className: 'dcmp-md' }, renderBlocks(parseBlocks(text), labels)),
			);
		}

		/**
		 * The MD pill in the composer tool row.
		 * @param props - slot props: `t` locale seat.
		 */
		function PreviewToggle({ t }) {
			const translate = typeof t === 'function' ? t : key => key;
			const prefsNow = usePrefs();
			const on = prefsNow.enabled;
			return h(
				'button',
				{
					type: 'button',
					className: 'dcmp-toggle',
					'aria-pressed': on,
					'aria-label': translate('toggle.label'),
					title: on ? translate('toggle.on') : translate('toggle.off'),
					onMouseDown: event => event.preventDefault(),
					onClick: () => commitPrefs({ enabled: !on }),
				},
				h('span', { className: 'dcmp-toggle-mark', 'aria-hidden': 'true' }, 'MD'),
				h('span', { className: 'dcmp-dot', 'data-on': on ? 'true' : 'false', 'aria-hidden': 'true' }),
			);
		}


		/**
		 * Settings > General row for the paste rewrite.
		 * @param props - slot props: `t` locale seat.
		 */
		function AutoFenceRow({ t }) {
			const translate = typeof t === 'function' ? t : key => key;
			const prefsNow = usePrefs();
			return h(
				'div',
				{ className: 'dcmp-setting' },
				h(
					'div',
					{ className: 'dcmp-setting-text' },
					h('div', { className: 'dcmp-setting-title' }, translate('setting.autoFence.title')),
					h('div', { className: 'dcmp-setting-desc' }, translate('setting.autoFence.desc')),
				),
				h(
					'button',
					{
						type: 'button',
						role: 'switch',
						className: 'dcmp-switch',
						'aria-checked': prefsNow.autoFence,
						'aria-label': translate('setting.autoFence.title'),
						onClick: () => commitPrefs({ autoFence: !prefsNow.autoFence }),
					},
					h('span', { className: 'dcmp-thumb' }),
				),
			);
		}

		/**
		 * Render one sent user message as Markdown inside its existing bubble.
		 *
		 * The transcript ships a plain-text renderer for the `text` node of
		 * `conversation.user.text.node`; this entry shadows it at a lower priority
		 * so a message reads the way the composer preview showed it. Anything the
		 * renderer declines (no Markdown, a parse failure, an oversized message)
		 * falls back to the plain run, so a message can never disappear or crash
		 * with the rest of the transcript.
		 * @param props - node data, the raw slice, and the locale seat.
		 */
		function UserMarkdown({ node, raw, t }) {
			const translate = typeof t === 'function' ? t : key => key;
			const prefsNow = usePrefs();
			const data = node !== null && typeof node === 'object' ? node.data : undefined;
			const display = data !== null && typeof data === 'object' ? data.display : undefined;
			const text = typeof display === 'string' ? display : (typeof raw === 'string' ? raw : '');
			const markdown = prefsNow.enabled && text.length <= MAX_RENDER_CHARS && looksLikeMarkdown(text);
			// Memoized per (text, switch): a transcript re-renders often while the
			// assistant streams, and a message's parse never changes underneath it.
			const blocks = React.useMemo(() => {
				if (!markdown) return null;
				try {
					return parseBlocks(text);
				} catch (error) {
					console.error('[composer-md-preview] could not render a sent message', error);
					return null;
				}
			}, [markdown, text]);
			if (blocks === null || blocks.length === 0) return h('span', { className: 'dcmp-plain' }, text);
			const labels = {
				image: translate('image'),
				checked: translate('checked'),
				unchecked: translate('unchecked'),
			};
			// A message carrying reference chips is dispatched one text fragment at a
			// time, so a fragment must stay inline or the chip would be pushed onto a
			// line of its own. Only real block structure takes over the bubble.
			if (blocks.length === 1 && blocks[0].type === 'paragraph') {
				return h('span', { className: 'dcmp-md dcmp-inline' }, renderInline(blocks[0].nodes, labels));
			}
			return h('div', { className: 'dcmp-md dcmp-bubble' }, renderBlocks(blocks, labels));
		}
		// #endregion

		// #region styles
		const STYLE_TAG = 'dsh-composer-md-preview/style';
		const CSS = `
.dcmp-anchor{display:none}
.dcmp-host{order:-1;display:block;flex:none;min-width:0}
.dcmp-host:empty{display:none}
.dcmp-inline-preview{box-sizing:border-box;min-width:0;max-height:min(40vh,320px);overflow:hidden auto;padding:4px 14px 0;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary,inherit);cursor:text;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgb(0 0 0/16%));--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2,rgb(0 0 0/28%));animation:dcmp-fade 160ms ease-out}
@keyframes dcmp-fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.dcmp-inline-preview{animation:none}}
.dcmp-inline-preview a{pointer-events:none}
.dcmp-notice{margin:0;color:var(--dsw-alias-label-tertiary,inherit);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}
.dcmp-inline-preview .dcmp-md{font-size:inherit;line-height:inherit}
.dcmp-md{min-width:0;overflow-wrap:anywhere;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-primary,inherit)}
.dcmp-md>*:first-child{margin-top:0}
.dcmp-md>*:last-child{margin-bottom:0}
.dcmp-md p{margin:6px 0}
.dcmp-plain{white-space:pre-wrap}
.dcmp-inline{font-size:inherit;line-height:inherit;color:inherit}
.dcmp-bubble{font-size:inherit;line-height:inherit;color:inherit;white-space:normal;text-align:left}
.dcmp-bubble.dcmp-md p{margin:0 0 8px}
.dcmp-bubble.dcmp-md p:last-child{margin-bottom:0}
.dcmp-bubble.dcmp-md :where(ul,ol){margin:6px 0}
.dcmp-bubble.dcmp-md .dcmp-heading{margin:10px 0 4px}
.dcmp-bubble .dcmp-code,.dcmp-bubble .dcmp-quote,.dcmp-bubble .dcmp-tablewrap{margin:6px 0}
.dcmp-md strong{font-weight:600}
.dcmp-heading{margin:12px 0 4px;font:inherit;font-weight:600;line-height:1.35}
h1.dcmp-heading{font-size:1.35em}
h2.dcmp-heading{font-size:1.2em}
h3.dcmp-heading{font-size:1.08em}
.dcmp-md :where(ul,ol){margin:6px 0;padding-left:20px}
.dcmp-md li>:where(ul,ol){margin-top:2px;margin-bottom:2px}
.dcmp-item::marker{color:var(--dsw-alias-label-tertiary,inherit)}
.dcmp-item:not(:first-child){margin-top:2px}
.dcmp-item>p{margin:0}
.dcmp-task{list-style:none}
.dcmp-check{flex:none;width:13px;height:13px;margin:0 7px 0 -20px;vertical-align:-2px;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:default;pointer-events:none}
.dcmp-quote{margin:6px 0;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2,rgb(0 0 0/18%));color:var(--dsw-alias-label-secondary,inherit)}
.dcmp-quote>*:first-child{margin-top:0}
.dcmp-quote>*:last-child{margin-bottom:0}
.dcmp-rule{height:.5px;margin:10px 0;border:0;background:var(--dsw-alias-border-l2,rgb(0 0 0/18%))}
.dcmp-inline-code{display:inline;padding:0 4px;border:.5px solid var(--dsw-alias-border-l1,rgb(0 0 0/8%));border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-markdown-inline-code,rgb(0 0 0/5%));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.9em;box-decoration-break:clone}
.dcmp-code{position:relative;margin:8px 0;border:.5px solid var(--dsw-alias-border-l1,rgb(0 0 0/8%));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2,rgb(0 0 0/3%)));overflow:hidden}
.dcmp-code-lang{position:absolute;top:4px;right:8px;z-index:1;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary,inherit));font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10px;line-height:14px;letter-spacing:.02em;opacity:.9;pointer-events:none}
.dcmp-code pre{max-height:264px;margin:0;padding:8px 10px;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.92em;line-height:1.55;tab-size:2}
.dcmp-code pre code{font:inherit;white-space:pre}
.dcmp-tablewrap{margin:8px 0;overflow-x:auto}
.dcmp-table{min-width:100%;border-collapse:collapse;font-size:.96em}
.dcmp-table th,.dcmp-table td{padding:4px 8px;border:.5px solid var(--dsw-alias-border-l2,rgb(0 0 0/18%));text-align:left;vertical-align:top}
.dcmp-table th{font-weight:600;background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/3%))}
.dcmp-link{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary,#4d6bfe));font-weight:500;text-decoration:none;border-bottom:.5px dotted var(--dsw-alias-link,var(--dsw-alias-brand-primary,#4d6bfe))}
.dcmp-image{display:inline-flex;align-items:center;gap:5px;padding:0 5px;border:.5px dashed var(--dsw-alias-border-l2,rgb(0 0 0/18%));border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-label-secondary,inherit);font-size:.95em}
.dcmp-image-mark{display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--dsw-alias-label-tertiary,rgb(0 0 0/30%))}
.dcmp-toggle{display:inline-flex;align-items:center;gap:6px;height:28px;margin:0;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;font-weight:600;letter-spacing:.02em;cursor:pointer;transition:background-color 100ms,color 100ms}
.dcmp-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0/6%));color:var(--dsw-alias-label-primary,inherit)}
.dcmp-toggle:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px}
.dcmp-toggle[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0/6%));color:var(--dsw-alias-label-primary,inherit)}
.dcmp-toggle[aria-pressed="false"]{color:var(--dsw-alias-label-tertiary,inherit)}
.dcmp-toggle-mark{pointer-events:none}
.dcmp-toggle[aria-pressed="false"] .dcmp-toggle-mark{text-decoration:line-through}
.dcmp-dot{box-sizing:border-box;width:6px;height:6px;border:1px solid var(--dsw-alias-label-tertiary,rgb(0 0 0/30%));border-radius:50%;background:transparent;transition:background-color 120ms,border-color 120ms}
.dcmp-dot[data-on="true"]{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dcmp-setting{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgb(0 0 0/18%))}
.dcmp-setting-text{min-width:0;display:flex;flex-direction:column;gap:4px}
.dcmp-setting-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}
.dcmp-setting-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}
.dcmp-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;margin:0;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,rgb(0 0 0/20%));cursor:pointer}
.dcmp-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4d6bfe)}
.dcmp-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:2px}
.dcmp-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform 120ms ease}
.dcmp-switch[aria-checked="true"] .dcmp-thumb{transform:translate(16px)}
`;

		function installStyles() {
			const tag = document.createElement('style');
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = STYLE_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return tag;
		}
		// #endregion

		// #region dictionaries
		const zh = {
			title: 'Markdown 预览',
			'meta.overflow': '草稿过长（{chars} 字符），未预览',
			image: '图片',
			checked: '已完成',
			unchecked: '未完成',
			'toggle.label': 'Markdown 预览开关',
			'toggle.on': 'Markdown 预览已开启：草稿出现 Markdown 语法时显示，已发送的消息也按 Markdown 显示',
			'toggle.off': 'Markdown 预览已关闭：草稿不渲染，已发送的消息按原文显示',
			'setting.autoFence.title': '粘贴代码自动加代码块',
			'setting.autoFence.desc': '把代码粘进输入框时自动包成 ``` 代码块，并尽量标上语言（JavaScript、TypeScript、Python、C/C++、Go、Rust、Java、SQL、HTML、JSON、Shell 等）；按住 Shift 粘贴则保持原文，普通文字不会被改动。',
		};
		const en = {
			title: 'Markdown preview',
			'meta.overflow': 'Draft too long to preview ({chars} chars)',
			image: 'image',
			checked: 'done',
			unchecked: 'not done',
			'toggle.label': 'Markdown preview switch',
			'toggle.on': 'Markdown preview is on: the draft renders once it contains Markdown, and sent messages render too',
			'toggle.off': 'Markdown preview is off: no draft card, and sent messages show their raw text',
			'setting.autoFence.title': 'Fence pasted code',
			'setting.autoFence.desc': 'Wraps code pasted into the composer in a ``` block and names the language when it can (JavaScript, TypeScript, Python, C/C++, Go, Rust, Java, SQL, HTML, JSON, Shell). Hold Shift while pasting to keep the text as is; ordinary prose is never rewritten.',
		};
		// #endregion

		// #region plugin
		/** Required client services. */
		const inject = ['slots', 'locale'];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-composer-md-preview: dictionaries');
			ctx.effect(() => {
				const tag = installStyles();
				return () => {
					tag.remove();
				};
			}, 'dsh-composer-md-preview: stylesheet');
			readPrefs();
			ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
				{ name: 'conversation.input.left', id: 'composer-md-preview-toggle', order: 100, locale: NS },
				PreviewToggle,
			));
			// Shadows the shipped plain-text renderer for the `text` node of a sent
			// user message. Keyed dispatch renders the LOWEST priority.
			ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register(
				{ name: 'conversation.user.text.node', key: 'text', priority: 50, locale: NS },
				UserMarkdown,
			));
			ctx.effect(() => installPasteFence(), 'dsh-composer-md-preview: code paste');
			ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
				{ name: 'conversation.input.left', id: 'composer-md-preview-bridge', order: 101, locale: NS },
				ComposerBridge,
			));
			ctx.slots.inject('settings.general.item', () => ctx.slots.register(
				{ name: 'settings.general.item', id: 'composer-md-preview-autofence', order: 30, locale: NS },
				AutoFenceRow,
			));
			console.info(`[${NS}] ready — ${t('title')}`);
		}
		// #endregion

		exports.apply = apply;
		exports.inject = inject;
		/** Internal surface for scripts/validate.mjs; not part of the plugin API. */
		exports.__internals = {
			looksLikeMarkdown, parseInline, parseBlocks, renderBlocks,
			draftPanel, PreviewToggle, UserMarkdown, AutoFenceRow, readPrefs,
			looksLikeCode, detectLanguage, fenceForPaste, pasteWithBreaks, ComposerBridge, pasteBridge,
		};
		return module.exports;
	},
});
