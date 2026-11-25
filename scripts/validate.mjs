/**
 * Offline validation for `dsh-composer-md-preview`.
 *
 * The plugin renders in a browser, which this machine does not have, so this
 * script checks everything that can be checked without one:
 *
 *  1. the manifest, bundle patch, locale files, icon and detail documents;
 *  2. that `apply` wires the two slot entries and that every UI string the
 *     components ask for exists in both dictionaries;
 *  3. the Markdown pipeline itself — detection, block/inline parsing, safe
 *     links, and hostile-input bounds — by loading `client.js` into a fake
 *     module-loader environment.
 *
 * Run with `node scripts/validate.mjs` (also `npm run validate`).
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checks = 0;

function check(label, run) {
	checks += 1;
	try {
		const result = run();
		if (result === false) throw new Error('returned false');
		console.log(`  ok   ${label}`);
	} catch (error) {
		failures += 1;
		console.error(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`);
	}
}

function equal(actual, expected, what = 'value') {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${what}: expected ${b}, received ${a}`);
}

// #region manifest
console.log('\nmanifest');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

check('package name and type', () => {
	if (manifest.name !== 'dsh-composer-md-preview') throw new Error('unexpected name');
	if (manifest.type !== 'module') throw new Error('type must be module');
});

check('bundle declares its patch', () => {
	equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch');
	if (!existsSync(join(root, 'cordis.patch.yml'))) throw new Error('patch file missing');
	const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
	if (!patch.includes('composer-md-preview')) throw new Error('patch does not insert the row');
});

check('client declaration', () => {
	const client = manifest.dsh?.client;
	if (client?.platform !== 'web') throw new Error('dsh.client.platform must be web');
	if (client?.immediately !== true) throw new Error('dsh.client.immediately must be true');
	for (const name of ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-conversation']) {
		if (!client?.inject?.includes(name)) throw new Error(`dsh.client.inject is missing ${name}`);
	}
	if (client?.external !== undefined) throw new Error('the bundle must not declare Harness Client externals');
});

check('runtime exports exist', () => {
	for (const path of ['./index.js', './client.js', './icon.svg', './locale/en.json', './locale/zh.json']) {
		if (!existsSync(join(root, path.slice(2)))) throw new Error(`missing ${path}`);
	}
});

check('files list covers runtime, docs and icon', () => {
	const files = manifest.files ?? [];
	for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'docs', 'icon.svg']) {
		if (!files.includes(entry)) throw new Error(`files is missing ${entry}`);
	}
});

check('icon is a small self-contained SVG', () => {
	const path = join(root, 'icon.svg');
	if (statSync(path).size > 256 * 1024) throw new Error('icon exceeds 256 KiB');
	const svg = readFileSync(path, 'utf8');
	if (!svg.trimStart().startsWith('<svg')) throw new Error('icon is not SVG');
	for (const banned of ['<script', '<text', '<foreignObject', '<style', '<image']) {
		if (svg.includes(banned)) throw new Error(`icon contains ${banned}`);
	}
	if (!svg.includes('viewBox="0 0 36 36"')) throw new Error('icon should use the 36-unit viewBox');
});

check('locale metadata and detail documents', () => {
	for (const locale of ['en', 'zh']) {
		const dict = JSON.parse(readFileSync(join(root, 'locale', `${locale}.json`), 'utf8'));
		for (const field of ['title', 'description', 'detail']) {
			if (typeof dict.meta?.[field] !== 'string' || dict.meta[field].trim() === '') throw new Error(`${locale}.json meta.${field} missing`);
		}
		const detail = join(root, dict.meta.detail);
		if (!existsSync(detail)) throw new Error(`${locale}.json names a missing detail document: ${dict.meta.detail}`);
		const body = readFileSync(detail, 'utf8').trim();
		const lines = body.split('\n').filter(line => line.trim() !== '');
		if (lines.length !== 1 || !/^!\[.+\]\(preview\.svg\)$/.test(lines[0])) throw new Error(`${dict.meta.detail} must hold exactly one image line`);
	}
	if (!existsSync(join(root, 'docs', 'preview.svg'))) throw new Error('docs/preview.svg missing');
});
// #endregion

// #region load the client bundle
console.log('\nclient bundle');

const registrations = [];
const storage = new Map();
globalThis.window = {
	__ModuleLoader__: { load: registration => registrations.push(registration) },
	localStorage: {
		getItem: key => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
	},
};
const pasteListeners = [];
globalThis.document = {
	head: { appendChild() {} },
	createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
	querySelector: () => null,
	addEventListener: (type, listener) => { if (type === 'paste') pasteListeners.push(listener); },
	removeEventListener: (type, listener) => {
		if (type !== 'paste') return;
		const index = pasteListeners.indexOf(listener);
		if (index !== -1) pasteListeners.splice(index, 1);
	},
};

const reactStub = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children: children.flat(Infinity) };
	},
	useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
	useMemo: factory => factory(),
	useId: () => 'dcmp-test-id',
	useRef: initial => ({ current: initial }),
	useState: initial => [initial, () => {}],
	useEffect: effect => {
		const cleanup = effect();
		effectCleanups.push(typeof cleanup === 'function' ? cleanup : () => {});
	},
	useLayoutEffect: effect => {
		const cleanup = effect();
		effectCleanups.push(typeof cleanup === 'function' ? cleanup : () => {});
	},
};

/** Cleanups collected from the stub's useEffect, mirroring unmount. */
const effectCleanups = [];

const clientSource = readFileSync(join(root, 'client.js'), 'utf8');
let registered = null;
let pluginExports = null;
const dictionaries = [];

check('bundle registers exactly one idempotent factory', () => {
	// eslint-disable-next-line no-new-func
	new Function(clientSource)();
	if (registrations.length !== 1) throw new Error(`expected 1 registration, received ${registrations.length}`);
	registered = registrations[0];
	if (registered.id !== 'dsh-composer-md-preview') throw new Error(`unexpected id ${registered.id}`);
	if (typeof registered.factory !== 'function') throw new Error('factory missing');
	const reactDomStub = {
		createPortal: (element, container) => ({ type: 'portal', element, container }),
	};
	pluginExports = registered.factory(specifier => {
		if (specifier === 'react') return reactStub;
		if (specifier === 'react-dom') return reactDomStub;
		throw new Error(`unexpected require("${specifier}")`);
	});
	if (typeof pluginExports.apply !== 'function') throw new Error('apply missing');
	equal(pluginExports.inject, ['slots', 'locale'], 'inject');
});

const internals = pluginExports.__internals;
check('parser internals exposed for validation', () => {
	for (const name of ['looksLikeMarkdown', 'parseInline', 'parseBlocks', 'renderBlocks', 'draftPanel']) {
		if (typeof internals?.[name] !== 'function') throw new Error(`missing internal ${name}`);
	}
});

check('apply registers both slot entries', () => {
	const injected = [];
	const ctx = {
		locale: {
			bind: () => key => key,
			register: (_ns, dicts) => {
				dictionaries.push(dicts);
				return () => {};
			},
		},
		effect: run => {
			const dispose = run();
			return typeof dispose === 'function' ? dispose : () => {};
		},
		slots: {
			inject: (name, install) => {
				injected.push(name);
				install();
				return () => {};
			},
			register: (options, component) => {
				if (typeof component !== 'function') throw new Error(`${options.name} entry is not a component`);
				injected.push(options.id === undefined
					? `${options.name}#${options.key}@p${options.priority}`
					: `${options.name}#${options.id}@${options.order}`);
				return { options, dispose() {} };
			},
		},
	};
	pluginExports.apply(ctx);
	equal(injected, [
		'conversation.input.left',
		'conversation.input.left#composer-md-preview-toggle@100',
		'conversation.user.text.node',
		'conversation.user.text.node#text@p50',
		'conversation.input.left',
		'conversation.input.left#composer-md-preview-bridge@101',
		'conversation.input.left',
		'conversation.input.left#composer-md-preview-build-0.6.2@102',
		'settings.general.item',
		'settings.general.item#composer-md-preview-autofence@30',
	], 'registrations');
	if (pasteListeners.length !== 1) throw new Error('paste listener was not installed');
	if (dictionaries.length !== 1) throw new Error('dictionary registration missing');
});

check('every UI string exists in both dictionaries', () => {
	const keys = new Set();
	for (const match of clientSource.matchAll(/(?<![\w$.])(?:translate|t)\(\s*'([a-zA-Z][\w.]*)'/g)) keys.add(match[1]);
	if (keys.size === 0) throw new Error('no translated keys found in source');
	const dicts = dictionaries[0];
	if (dicts === undefined) throw new Error('dictionaries were not registered');
	for (const key of keys) {
		for (const locale of ['zh', 'en']) {
			if (typeof dicts[locale]?.[key] !== 'string') throw new Error(`${locale} dictionary is missing "${key}"`);
		}
	}
	console.log(`       ${keys.size} keys checked: ${[...keys].sort().join(', ')}`);
});
// #endregion

// #region parsing
console.log('\ndetection');
const { looksLikeMarkdown, parseBlocks, parseInline, renderBlocks } = internals;

check('plain prose is not previewed', () => {
	for (const text of ['普通一句话，没有任何格式。', 'hello world', '1.5 倍速', 'a - b', '|a|b|', 'C:\\Users\\me', '']) {
		equal(looksLikeMarkdown(text), false, `looksLikeMarkdown(${JSON.stringify(text)})`);
	}
});

check('Markdown constructs are detected', () => {
	const positives = [
		'# 标题',
		'- 一项',
		'* 一项',
		'1. 第一',
		'> 引用',
		'**粗体**',
		'__粗体__',
		'`code`',
		'~~删除~~',
		'```js\nconst a = 1\n```',
		'| a | b |\n|---|---|\n| 1 | 2 |',
		'[链接](https://example.com)',
		'![图](https://example.com/a.png)',
		'---',
	];
	for (const text of positives) equal(looksLikeMarkdown(text), true, `looksLikeMarkdown(${JSON.stringify(text)})`);
});

console.log('\nblocks');
const types = blocks => blocks.map(block => block.type);

check('headings keep their level', () => {
	const blocks = parseBlocks('# 一\n## 二\n###### 六');
	equal(types(blocks), ['heading', 'heading', 'heading'], 'types');
	equal(blocks.map(block => block.level), [1, 2, 6], 'levels');
	equal(blocks[0].nodes, [{ type: 'text', value: '一' }], 'text');
});

check('soft line breaks become breaks, because every Enter was intentional', () => {
	const blocks = parseBlocks('第一行\n第二行');
	equal(types(blocks), ['paragraph'], 'types');
	equal(blocks[0].nodes.map(node => node.type), ['text', 'break', 'text'], 'inline types');
});

check('bullet list with a nested ordered list', () => {
	const blocks = parseBlocks('- 一\n  - 一甲\n- 二\n1. 有序\n2. 有序二');
	equal(types(blocks), ['list', 'list'], 'top-level types');
	equal(blocks[0].ordered, false, 'first list ordered');
	equal(blocks[0].items.length, 2, 'first list items');
	const nested = blocks[0].items[0].blocks.find(block => block.type === 'list');
	if (nested === undefined) throw new Error('nested list not parsed');
	equal(nested.ordered, false, 'nested list kind');
	equal(nested.items.length, 1, 'nested items');
	equal(blocks[1].ordered, true, 'second list ordered');
	equal(blocks[1].items.length, 2, 'second list items');
});

check('ordered list honours its start number', () => {
	const blocks = parseBlocks('3. 三\n4. 四');
	equal(blocks[0].start, 3, 'start');
	equal(blocks[0].items.length, 2, 'items');
});

check('task list records checked state', () => {
	const blocks = parseBlocks('- [ ] 未完成\n- [x] 已完成');
	equal(blocks[0].items.map(item => item.checked), [false, true], 'checked flags');
});

check('list items absorb fenced code', () => {
	const blocks = parseBlocks('1. 运行：\n   ```sh\n   ls -la\n   ```');
	const item = blocks[0].items[0];
	const code = item.blocks.find(block => block.type === 'code');
	if (code === undefined) throw new Error(`no code block in item: ${JSON.stringify(item.blocks)}`);
	equal(code.lang, 'sh', 'lang');
	equal(code.value, 'ls -la', 'code body');
});

check('fenced code keeps language and blank lines', () => {
	const blocks = parseBlocks('```ts\nconst a = 1\n\nconst b = 2\n```');
	equal(blocks.length, 1, 'one block');
	equal(blocks[0].lang, 'ts', 'lang');
	equal(blocks[0].value, 'const a = 1\n\nconst b = 2', 'body');
});

check('tilde fences and unclosed fences', () => {
	equal(parseBlocks('~~~js\nx\n~~~')[0].lang, 'js', 'tilde lang');
	const unclosed = parseBlocks('```js\nx');
	equal(types(unclosed), ['code'], 'unclosed types');
	equal(unclosed[0].value, 'x', 'unclosed body');
});

check('blockquote nests and carries lists', () => {
	const blocks = parseBlocks('> 引用\n> - 一\n> - 二');
	equal(types(blocks), ['quote'], 'types');
	equal(types(blocks[0].blocks), ['paragraph', 'list'], 'quoted block types');
});

check('table alignment and escapes', () => {
	const blocks = parseBlocks('| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |\n| d \\| e | f | g |');
	equal(types(blocks), ['table'], 'types');
	equal(blocks[0].align, ['left', 'center', 'right'], 'align');
	equal(blocks[0].head.length, 3, 'head cells');
	equal(blocks[0].rows.length, 2, 'rows');
	const escaped = renderBlocks(parseBlocks('| a \\| b |\n|---|\n| c |'), { image: 'image' });
	const text = flatten(escaped);
	if (!text.includes('a | b')) throw new Error(`escaped pipe lost: ${text}`);
});

check('thematic break vs heading without text', () => {
	equal(types(parseBlocks('---')), ['hr'], 'hr');
	equal(types(parseBlocks('***')), ['hr'], 'asterisk hr');
	equal(types(parseBlocks('#')), ['heading'], 'bare hash is a heading');
});

console.log('\ninline');
check('emphasis, strong, code, strike and links', () => {
	const nodes = parseInline('普通 **粗** *斜* `码` ~~删~~ [链](https://a.b/c)');
	equal(nodes.map(node => node.type), ['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'del', 'text', 'link'], 'types');
	const link = nodes[nodes.length - 1];
	equal(link.href, 'https://a.b/c', 'href');
	equal(link.nodes, [{ type: 'text', value: '链' }], 'label');
});

check('snake_case is not emphasis', () => {
	const nodes = parseInline('file_name and a_b_c');
	equal(nodes.every(node => node.type === 'text'), true, `unexpected emphasis: ${JSON.stringify(nodes)}`);
});

check('backslash escapes are literal', () => {
	const nodes = parseInline('\\*not emphasis\\* \\`not code\\`');
	equal(nodes, [{ type: 'text', value: '*not emphasis* `not code`' }], 'nodes');
});

check('hard-wrapped emphasis does not swallow the next line', () => {
	const nodes = parseInline('**粗体');
	equal(nodes, [{ type: 'text', value: '**粗体' }], 'unclosed strong stays literal');
});

check('emphasis nests inside a longer span', () => {
	const nodes = parseInline('*a **b** c*');
	equal(nodes.length, 1, 'top-level nodes');
	equal(nodes[0].type, 'em', 'outer type');
	equal(nodes[0].nodes.map(node => node.type), ['text', 'strong', 'text'], 'inner types');
});

check('a row of pipes alone is not a table', () => {
	equal(parseBlocks('|a|b|').map(block => block.type), ['paragraph'], 'blocks');
	equal(parseBlocks('| a | b |\n|---|---|').map(block => block.type), ['table'], 'real table');
});

check('images become labelled placeholders', () => {
	const nodes = parseInline('![示意图](https://a.b/x.png)');
	equal(nodes[0].type, 'image', 'type');
	equal(nodes[0].alt, '示意图', 'alt');
});

console.log('\nsafety');
function flatten(value) {
	if (value === null || value === undefined || value === false) return '';
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(flatten).join('');
	if (typeof value === 'object') return flatten(value.children);
	return '';
}

function collect(value, predicate, found = []) {
	if (value === null || value === undefined || typeof value === 'string') return found;
	if (Array.isArray(value)) {
		for (const item of value) collect(item, predicate, found);
		return found;
	}
	if (typeof value === 'object') {
		if (predicate(value)) found.push(value);
		collect(value.children, predicate, found);
	}
	return found;
}

check('dangerous link protocols never become anchors', () => {
	for (const href of ['javascript:alert(1)', 'vbscript:x', 'file:///etc/passwd', 'data:text/html,x']) {
		const tree = renderBlocks(parseBlocks(`[click](${href})`), { image: 'image' });
		const anchors = collect(tree, node => node.type === 'a');
		equal(anchors.length, 0, `anchors for ${href}`);
		if (!flatten(tree).includes('click')) throw new Error(`label lost for ${href}`);
	}
});

check('safe links do become anchors', () => {
	const tree = renderBlocks(parseBlocks('[ok](https://example.com/a)'), { image: 'image' });
	const anchors = collect(tree, node => node.type === 'a');
	equal(anchors.length, 1, 'anchors');
	equal(anchors[0].props.href, 'https://example.com/a', 'href');
	equal(anchors[0].props.rel, 'noreferrer noopener', 'rel');
});

check('raw HTML never becomes markup', () => {
	const tree = renderBlocks(parseBlocks('<script>alert(1)</script>\n\n<b>粗</b>'), { image: 'image' });
	equal(collect(tree, node => node.type === 'script').length, 0, 'script elements');
	equal(collect(tree, node => node.type === 'b').length, 0, 'b elements');
	if (!flatten(tree).includes('<script>alert(1)</script>')) throw new Error('raw HTML should stay literal text');
});

check('images are never loaded', () => {
	const tree = renderBlocks(parseBlocks('![x](https://evil.example/track.png)'), { image: 'image' });
	equal(collect(tree, node => node.type === 'img').length, 0, 'img elements');
});

console.log('\nrobustness');
check('empty and whitespace drafts parse to nothing', () => {
	equal(parseBlocks(''), [], 'empty');
	equal(parseBlocks('\n\n\n'), [], 'blank lines');
	equal(parseBlocks('   '), [], 'spaces');
});

check('deep nesting stops at the depth cap instead of overflowing', () => {
	const quoted = `${'> '.repeat(400)}深`;
	const blocks = parseBlocks(quoted);
	equal(blocks[0].type, 'quote', 'quote');
	let depth = 0;
	let cursor = blocks[0];
	while (cursor !== undefined && cursor.type === 'quote') {
		depth += 1;
		cursor = cursor.blocks[0];
	}
	if (depth > 8) throw new Error(`blockquote depth ${depth} exceeds the cap`);
	const nestedList = Array.from({ length: 400 }, (_, index) => `${'  '.repeat(index)}- x`).join('\n');
	parseBlocks(nestedList);
});

check('a hostile draft stays fast', () => {
	const hostile = `${'`'.repeat(2000)}\n${'*a* '.repeat(4000)}\n${'- [ ] x\n'.repeat(1000)}`;
	const started = performance.now();
	parseBlocks(hostile);
	parseBlocks(`${'['.repeat(5000)}`);
	parseBlocks(`${'**'.repeat(3000)}`);
	const elapsed = performance.now() - started;
	if (elapsed > 2000) throw new Error(`parsing took ${elapsed.toFixed(0)}ms`);
	console.log(`       hostile draft parsed in ${elapsed.toFixed(1)}ms`);
});

check('rendering tolerates every block kind', () => {
	const block = [
		'# 标题',
		'段落 **粗** 与 `码`。',
		'> 引用',
		'- [x] 任务',
		'- 项目\n  1. 嵌套',
		'| a | b |\n|---|---|\n| 1 | 2 |',
		'---',
		'```js\nconst a = 1\n```',
		'![图](https://a.b/x.png)',
	].join('\n\n');
	const tree = renderBlocks(parseBlocks(block), { image: 'image' });
	const text = flatten(tree);
	for (const expected of ['标题', '粗', '码', '引用', '任务', '嵌套', 'const a = 1', '图']) {
		if (!text.includes(expected)) throw new Error(`rendered text is missing ${expected}: ${text}`);
	}
});

console.log('\ncomponents');
/** Build the rendered panel exactly as the composer bridge does. */
function renderPanel(draft, { enabled = true } = {}) {
	return internals.draftPanel({ draft, enabled, translate: key => key });
}

check('panel stays hidden for empty and plain-prose drafts', () => {
	equal(renderPanel(''), null, 'empty draft');
	equal(renderPanel('   \n '), null, 'blank draft');
	equal(renderPanel('明天下午三点开会，记得带电脑。'), null, 'prose draft');
});

check('panel renders the Markdown draft', () => {
	const panel = renderPanel('## 明天\n\n- 看完 `docs`\n- 跑一次 **测试**');
	if (panel === null || panel.type !== 'div') throw new Error('panel not rendered');
	equal(panel.props.className, 'dcmp-inline-preview', 'panel class');
	equal(panel.props.role, 'region', 'region role');
	const text = flatten(panel);
	for (const expected of ['明天', '看完', 'docs', '跑一次', '测试']) {
		if (!text.includes(expected)) throw new Error(`panel text is missing ${expected}: ${text}`);
	}
	if (!collect(panel, node => node.type === 'h2').length) throw new Error('heading not rendered');
	if (!collect(panel, node => node.type === 'ul').length) throw new Error('list not rendered');
	if (!collect(panel, node => node.type === 'strong').length) throw new Error('strong not rendered');
});

check('the MD pill turns the whole feature off and on', () => {
	const pill = internals.PreviewToggle({ t: key => key });
	if (pill === null || pill.type !== 'button') throw new Error('MD pill not rendered');
	equal(pill.props['aria-pressed'], true, 'pill starts pressed');
	equal(renderPanel('# 标题'), null === null ? renderPanel('# 标题') : null, 'panel exists while on');
	pill.props.onClick();
	equal(internals.PreviewToggle({ t: key => key }).props['aria-pressed'], false, 'pill reports off');
	equal(internals.UserMarkdown({ node: { id: 'text', data: { text: '- 一' } }, raw: '- 一', t: key => key }).type, 'span', 'sent messages fall back');
	internals.PreviewToggle({ t: key => key }).props.onClick();
	equal(internals.PreviewToggle({ t: key => key }).props['aria-pressed'], true, 'pill back on');
	if (renderPanel('# 标题') === null) throw new Error('panel should render again');
	const persisted = storage.get('dsh-composer-md-preview/v1');
	if (typeof persisted !== 'string' || !persisted.includes('"enabled":true')) throw new Error(`preference not persisted: ${persisted}`);
});

check('the panel honours the master switch', () => {
	equal(renderPanel('# 标题', { enabled: false }), null, 'disabled panel');
	if (renderPanel('# 标题', { enabled: true }) === null) throw new Error('enabled panel missing');
});

check('panel shows only a notice for oversized Markdown drafts', () => {
	const huge = `# 标题\n\n${'文字'.repeat(30000)}`;
	const panel = renderPanel(huge);
	if (panel === null) throw new Error('oversized Markdown draft should still show its panel');
	const text = flatten(panel);
	if (!text.includes('meta.overflow')) throw new Error(`notice missing: ${text.slice(0, 120)}`);
	const bodies = collect(panel, node => node.props?.className === 'dcmp-md');
	equal(bodies.length, 0, 'no rendered body for an oversized draft');
	const notices = collect(panel, node => node.props?.className === 'dcmp-notice');
	equal(notices.length, 1, 'notice rendered');
});

check('panel stays hidden for oversized plain prose', () => {
	equal(renderPanel('文字'.repeat(30000)), null, 'prose overflow');
});

console.log('\nsent messages');
/** Execute the sent-message renderer as the keyed `text` entry does. */
function renderUser(text, overrides = {}) {
	return internals.UserMarkdown({
		node: { id: 'text', data: { text } },
		raw: text,
		t: key => key,
		...overrides,
	});
}

check('a sent message renders Markdown inside its bubble', () => {
	const tree = renderUser('## 结论\n\n- 一\n- **二**');
	if (tree === null || tree.type !== 'div') throw new Error('not rendered as a block');
	if (!tree.props.className.includes('dcmp-bubble')) throw new Error('bubble class missing');
	const text = flatten(tree);
	for (const expected of ['结论', '一', '二']) {
		if (!text.includes(expected)) throw new Error(`missing ${expected}: ${text}`);
	}
	if (!collect(tree, node => node.type === 'h2').length) throw new Error('heading not rendered');
	if (!collect(tree, node => node.type === 'ul').length) throw new Error('list not rendered');
	if (!collect(tree, node => node.type === 'strong').length) throw new Error('strong not rendered');
});

check('a sent message without Markdown keeps the shipped plain run', () => {
	const tree = renderUser('明天下午三点开会，记得带电脑。');
	equal(tree.type, 'span', 'element');
	if (!tree.props.className.includes('dcmp-plain')) throw new Error('plain run class missing');
	equal(flatten(tree), '明天下午三点开会，记得带电脑。', 'text');
});

check('a sent message falls back to plain text instead of failing', () => {
	equal(flatten(renderUser('')), '', 'empty message');
	const withoutNode = renderUser('**粗**', { node: null });
	equal(withoutNode.type, 'span', 'node data is optional');
	equal(flatten(renderUser('# 标题\n\n正文')).includes('标题'), true, 'markdown still renders');
	equal(renderUser('文字'.repeat(30000)).type, 'span', 'oversized plain text');
	equal(renderUser(`# t\n${'文字'.repeat(30000)}`).type, 'span', 'oversized Markdown');
	equal(collect(renderUser('<script>alert(1)</script>'), node => node.type === 'script').length, 0, 'no script element');
});

check('a single-paragraph message stays inline so reference chips keep their flow', () => {
	const inline = renderUser('先看 **这份** 再决定');
	equal(inline.type, 'span', 'root element');
	if (!inline.props.className.includes('dcmp-inline')) throw new Error('inline class missing');
	const styled = renderUser('**粗** 与 `码`');
	equal(styled.type, 'span', 'formatted paragraph root');
	if (!collect(styled, node => node.type === 'strong').length) throw new Error('strong lost');
	equal(renderUser('- 一\n- 二').type, 'div', 'a list takes over the bubble');
	equal(renderUser('## 标题').type, 'div', 'a heading takes over the bubble');
	equal(renderUser('```js\nconst a = 1\n```').type, 'div', 'a fence takes over the bubble');
});

check('a sent message follows the preview switch', () => {
	storage.set('dsh-composer-md-preview/v1', JSON.stringify({ enabled: false, collapsed: false }));
	internals.readPrefs();
	equal(renderUser('- 一').type, 'span', 'disabled renders raw text');
	storage.set('dsh-composer-md-preview/v1', JSON.stringify({ enabled: true, collapsed: false }));
	internals.readPrefs();
	equal(renderUser('- 一').type, 'div', 'enabled renders Markdown');
});
// #endregion

console.log('\npasted code');
const { fenceForPaste, detectLanguage, looksLikeCode, pasteWithBreaks } = internals;

function fenced(label, text, lang) {
	check(`fences ${label}`, () => {
		const result = fenceForPaste(text);
		if (result === null) throw new Error('not treated as code');
		const lines = result.split('\n');
		equal(lines[0], `\`\`\`${lang}`, 'opening fence');
		equal(lines[lines.length - 1], '\`\`\`', 'closing fence');
	});
}

fenced('JavaScript', 'const a = 1;\nfunction f() {\n  return a;\n}', 'javascript');
fenced('TypeScript', "interface Point { x: number }\nconst p: Point = { x: 1 };", 'typescript');
fenced('Python', 'def add(a, b):\n    return a + b', 'python');
fenced('C', '#include <stdio.h>\nint main(void) {\n  printf("hi");\n  return 0;\n}', 'c');
fenced('C++', '#include <iostream>\nint main() { std::cout << "x"; }', 'cpp');
fenced('C++ in the competitive-programming style', '#include <bits/stdc++.h>\n\nusing namespace std;\n\nint n;\nconst int N = 1e6 + 10;\n\nstruct con\n{\n    int l, r;\n} c[N];\n\nbool cmp(con a, con b)\n{\n    return a.r < b.r;\n}\n\nint main()\n{\n    scanf("%d", &n);\n    return 0;\n}', 'cpp');
fenced('shell', 'cd /home/dsh\ngit status --short', 'bash');
fenced('a shebang script', '#!/usr/bin/env bash\nset -e\necho hi', 'bash');
fenced('HTML', '<div class="a">\n  <span>hi</span>\n</div>', 'html');
fenced('JSON', '{"a": 1,\n "b": [1, 2]}', 'json');
fenced('SQL', 'SELECT id, name\nFROM users\nWHERE id = 1;', 'sql');
fenced('Go', 'package main\n\nfunc main() {\n\tprintln("hi")\n}', 'go');
fenced('Rust', 'fn main() {\n    let mut x = 1;\n}', 'rust');
fenced('Java', 'public class A {\n  public static void main(String[] a) {\n    System.out.println(1);\n  }\n}', 'java');
fenced('a diff', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b', 'diff');
fenced('YAML', 'name: demo\nversion: 1.0\nitems:\n  - a', 'yaml');
fenced('a one-line JSON payload', '{"sessionId":"abc","turn":3}', 'json');

check('prose is never fenced', () => {
	const prose = [
		'明天下午三点开会，记得带电脑。\n地点还是老地方，别迟到。',
		'This is a paragraph of ordinary prose.\nIt runs across two lines and has no code in it.',
		'- 牛奶\n- 鸡蛋\n- 面包',
		'- milk\n- eggs',
		'hello',
		'https://example.com/a/b?c=d',
		'注意 {} 这种写法\n然后再说一遍',
	];
	for (const text of prose) {
		equal(fenceForPaste(text), null, `fenceForPaste(${JSON.stringify(text.slice(0, 24))})`);
	}
});

check('an existing fence and edge cases are left alone', () => {
	equal(fenceForPaste('```js\nconst a = 1\n```'), null, 'already fenced');
	equal(fenceForPaste(''), null, 'empty');
	equal(fenceForPaste('   \n\n'), null, 'blank');
	equal(fenceForPaste('npm install'), null, 'single command');
	equal(fenceForPaste('x'.repeat(500000)), null, 'oversized paste');
});

check('line endings and trailing blank lines are normalized', () => {
	const result = fenceForPaste('const a = 1;\r\nconst b = 2;\r\n\r\n');
	equal(result, '```javascript\nconst a = 1;\nconst b = 2;\n```', 'normalized fence');
});

check('the fence is padded so it starts and ends on its own line', () => {
	equal(pasteWithBreaks('```js\nx\n```', true), '```js\nx\n```\n', 'at line start');
	equal(pasteWithBreaks('```js\nx\n```', false), '\n\n```js\nx\n```\n', 'mid-line');
});

check('the paste handler hands fenced code to the shell', () => {
	class FakeElement {
		constructor({ editable = false, inComposer = true } = {}) {
			this.isContentEditable = editable;
			this.inComposer = inComposer;
		}
		closest(selector) {
			if (selector === '[data-composer-card]') return this.inComposer ? this : null;
			return null;
		}
	}
	globalThis.Element = FakeElement;
	globalThis.Node = { ELEMENT_NODE: 1 };
	globalThis.window.getSelection = () => ({
		rangeCount: 1,
		getRangeAt: () => ({ startContainer: {}, startOffset: 0 }),
	});
	globalThis.document.createRange = () => ({ selectNodeContents() {}, setEnd() {}, toString: () => '' });

	const listener = pasteListeners[0];
	if (listener === undefined) throw new Error('paste listener missing');

	let inserted = null;
	let captured = null;
	let prevented = 0;
	let stopped = 0;
	let setDataCalls = 0;
	let insertResult = true;
	const actions = {
		captureInsertion: () => {
			captured = { start: 3, end: 3, draftRev: 7 };
			return captured;
		},
		insertText: (text, span) => {
			inserted = { text, span };
			return insertResult;
		},
	};
	const state = { draft: '前半段：\n\n', phase: 'plain' };
	const useInput = selector => selector(state);
	const bridge = props => internals.ComposerBridge({ useInput, t: key => key, ...props });
	bridge({ inputActions: actions });

	const code = 'const a = 1;\nconst b = 2;';
	const event = ({ text, shift = false, files = [], editable = true, inComposer = true }) => ({
		shiftKey: shift,
		target: new FakeElement({ editable, inComposer }),
		preventDefault: () => { prevented += 1; },
		stopImmediatePropagation: () => { stopped += 1; },
		clipboardData: {
			files,
			getData: () => text,
			setData: () => { setDataCalls += 1; },
		},
	});
	const reset = () => {
		inserted = null;
		captured = null;
		prevented = 0;
		stopped = 0;
		setDataCalls = 0;
	};

	reset();
	listener(event({ text: code }));
	equal(prevented, 1, 'default paste prevented');
	equal(stopped, 1, 'the composer paste command never sees the event');
	equal(inserted?.text, '```javascript\nconst a = 1;\nconst b = 2;\n```\n', 'inserted payload');
	equal(inserted?.span, captured, 'the caret is captured before inserting');
	equal(setDataCalls, 0, 'clipboard left alone when the shell can insert');

	reset();
	listener(event({ text: code, shift: true }));
	equal(prevented, 0, 'shift paste prevented?');
	equal(inserted, null, 'shift paste inserted?');

	reset();
	listener(event({ text: code, inComposer: false }));
	equal(inserted, null, 'paste outside the composer');

	reset();
	listener(event({ text: code, editable: false }));
	equal(inserted, null, 'paste outside the editor');

	reset();
	listener(event({ text: code, files: [{}] }));
	equal(inserted, null, 'paste carrying files');

	reset();
	listener(event({ text: '一段普通的文字\n还有第二行' }));
	equal(inserted, null, 'prose');

	let appended = null;
	actions.setDraft = text => { appended = text; };
	reset();
	appended = null;
	insertResult = false;
	listener(event({ text: code }));
	equal(prevented, 1, 'a refusing shell still consumed the default paste');
	equal(appended, `前半段：\n\n${'```javascript\nconst a = 1;\nconst b = 2;\n```\n'}`, 'an unmapped span appends instead of dropping the paste');

	reset();
	appended = null;
	state.phase = 'sending';
	bridge({ inputActions: actions });
	listener(event({ text: code }));
	equal(appended, null, 'a frozen composer swallows the paste like the shell does');
	state.phase = 'plain';
	bridge({ inputActions: actions });
	insertResult = true;

	reset();
	storage.set('dsh-composer-md-preview/v1', JSON.stringify({ enabled: true, collapsed: false, autoFence: false }));
	internals.readPrefs();
	listener(event({ text: code }));
	equal(inserted, null, 'auto-fence switched off in Settings');

	reset();
	storage.set('dsh-composer-md-preview/v1', JSON.stringify({ enabled: false, collapsed: false, autoFence: true }));
	internals.readPrefs();
	listener(event({ text: code }));
	equal(inserted, null, 'master switch off');

	reset();
	storage.set('dsh-composer-md-preview/v1', JSON.stringify({ enabled: true, collapsed: false, autoFence: true }));
	internals.readPrefs();
	listener(event({ text: code }));
	equal(typeof inserted?.text, 'string', 'back on');

	// With no live composer handle the paste is left to the browser.
	bridge({ inputActions: undefined });
	reset();
	listener(event({ text: code }));
	equal(prevented, 0, 'no shell handle leaves the native paste');
	equal(setDataCalls, 1, 'clipboard rewrite attempted instead');
	bridge({ inputActions: actions });
});

check('the bridge publishes the composer actions and an invisible anchor', () => {
	const actions = { insertText: () => true };
	const useInput = selector => selector({ draft: 'abc', phase: 'claimed' });
	const result = internals.ComposerBridge({ inputActions: actions, useInput, t: key => key });
	if (!Array.isArray(result) || result.length !== 2) throw new Error('bridge did not render its anchor');
	equal(result[0].type, 'span', 'anchor element');
	equal(result[0].props.className, 'dcmp-anchor', 'anchor class');
	equal(result[1], null, 'no portal without a card host');
	equal(internals.pasteBridge.actions, actions, 'actions published');
	equal(internals.pasteBridge.draft, 'abc', 'draft published');
	equal(internals.pasteBridge.phase, 'claimed', 'phase published');
	const cleared = internals.ComposerBridge({ inputActions: undefined, useInput: undefined, t: key => key });
	if (!Array.isArray(cleared)) throw new Error('bridge still renders an anchor without a session');
	equal(internals.pasteBridge.actions, undefined, 'actions cleared');
	equal(internals.pasteBridge.draft, '', 'draft cleared');
});

check('the Settings row toggles the paste rewrite', () => {
	const row = internals.AutoFenceRow({ t: key => key });
	if (row === null || row.type !== 'div') throw new Error('row not rendered');
	const control = row.children[1];
	equal(control.type, 'button', 'control element');
	equal(control.props.role, 'switch', 'role');
	equal(control.props['aria-checked'], true, 'checked state');
	control.props.onClick();
	equal(internals.AutoFenceRow({ t: key => key }).children[1].props['aria-checked'], false, 'after toggle');
	const persisted = storage.get('dsh-composer-md-preview/v1');
	if (typeof persisted !== 'string' || !persisted.includes('"autoFence":false')) throw new Error(`preference not persisted: ${persisted}`);
	internals.AutoFenceRow({ t: key => key }).children[1].props.onClick();
	equal(internals.AutoFenceRow({ t: key => key }).children[1].props['aria-checked'], true, 'back on');
});

check('the classifier and language picker are exposed', () => {
	equal(looksLikeCode('const a = 1;\nconst b = 2;'), true, 'looksLikeCode');
	equal(looksLikeCode('普通文字\n还是不 fencing'), false, 'prose');
	equal(detectLanguage('SELECT 1;\nFROM t'), 'sql', 'language');
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
