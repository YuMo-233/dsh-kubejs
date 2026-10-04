/**
 * dsh-kubejs 配置覆写账本：cordis.patch.yml 管理区块维护。
 *
 * 实测真实 profile patch 条目结构（desktop/cordis.patch.yml）：
 *   - id: <插件实例 id>
 *     name: '<插件包名>'        # 可选；仅有 config 的 id 覆写可省 name
 *     config:
 *       <key>: <value>          # 任意嵌套
 *
 * 区块格式（幂等渲染，dsh-kubejs 独占；条目顶格 0 缩进，与文档其他顶层序列条目一致）：
 *   # --- dsh-kubejs managed BEGIN ---
 *   # script:<脚本名>
 *   - id: some-plugin
 *     config:
 *       key: value
 *   # script:<另一个脚本>
 *   - id: other-plugin
 *     config:
 *       nested:
 *         deep: true
 *   # --- dsh-kubejs managed END ---
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname as pathDirname } from 'node:path';
import { PATCH_BLOCK_BEGIN, PATCH_BLOCK_END, PATCH_ENTRY_COMMENT, findMarkerLine, markerLine, findBareYamlSeparator } from './shared.js';

/** 把 JS 值序列化为 YAML（块状风格，递归；对象/数组多行缩进）。 */
export function toYaml(value, indent = 0) {
	const pad = '  '.repeat(indent);
	if (value === null || value === undefined) return `${pad}null`;
	if (typeof value === 'boolean' || typeof value === 'number') return `${pad}${String(value)}`;
	if (typeof value === 'string') {
		const special = value === '' || /[:#\-?*&!|>'"%@`\n\r\t]/.test(value) || /^\s|\s$/.test(value)
			|| /^[-?:]/.test(value) || /^(true|false|null|~)$/i.test(value) || /^[\d.]+[eE]/.test(value)
			|| /^\d+\.\d+$/.test(value);
		return `${pad}${special ? JSON.stringify(value) : value}`;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return `${pad}[]`;
		return value.map((item) => {
			const rendered = toYaml(item, indent + 1);
			// 标量放 - 后同一行；对象/数组首键放 - 后，其余键换行对齐
			if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
				const keys = Object.keys(item);
				if (keys.length === 0) return `${pad}- {}`;
				const [firstKey, ...rest] = keys;
				const firstRendered = toYaml(item[firstKey], indent + 1);
				const lines = [`${pad}- ${firstKey}:${firstRendered.startsWith('\n') ? '' : ' '}${firstRendered.slice((indent + 1) * 2)}`];
				// 简化：对象作为数组元素时统一走 JSON 行内格式，避免复杂缩进拼装错误
				if (rest.length > 0) return `${pad}- ${JSON.stringify(item)}`;
				return lines[0];
			}
			return `${pad}- ${rendered.slice((indent + 1) * 2)}`;
		}).join('\n');
	}
	// 普通对象
	const keys = Object.keys(value);
	if (keys.length === 0) return `${pad}{}`;
	return keys.map((key) => {
		const child = value[key];
		if (child !== null && typeof child === 'object') {
			return `${pad}${key}:\n${toYaml(child, indent + 1)}`;
		}
		return `${pad}${key}: ${toYaml(child, 0).slice(0)}`;
	}).join('\n');
}

/** config 对象渲染为顶格 YAML 条目体（- id: xxx 后的多行）。 */
export function configToYamlBody(config) {
	const lines = [];
	const render = (obj, prefix) => {
		for (const [key, child] of Object.entries(obj)) {
			if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
				lines.push(`${prefix}${key}:`);
				render(child, `${prefix}  `);
			} else if (Array.isArray(child)) {
				lines.push(`${prefix}${key}: ${JSON.stringify(child)}`);
			} else {
				lines.push(`${prefix}${key}: ${scalarInline(child)}`);
			}
		}
	};
	const scalarInline = (v) => {
		if (v === null || v === undefined) return 'null';
		if (typeof v === 'boolean' || typeof v === 'number') return String(v);
		if (typeof v === 'string') {
			const special = v === '' || /[:#\-?*&!|>'"%@`\n\r\t]/.test(v) || /^\s|\s$/.test(v)
				|| /^[-?:]/.test(v) || /^(true|false|null|~)$/i.test(v);
			return special ? JSON.stringify(v) : v;
		}
		return JSON.stringify(v);
	};
	render(config ?? {}, '');
	return lines;
}

/**
 * 把 dotted path 'a.b.c' + value 展开为 { id, config }（首段=插件实例 id，其余嵌套 config）。
 * 也支持传 path 数组形态 {id, config} 直通（不展开）。
 */
export function overrideToEntry(path, value) {
	const parts = path.split('.');
	const id = parts[0];
	let config = value;
	for (let i = parts.length - 1; i > 0; i--) {
		config = { [parts[i]]: config };
	}
	return { id, config };
}

/** 解析 configToYamlBody 产出的标量子集（区块由本模块机器写入，无需通用 YAML）。 */
function parseScalarInline(text) {
	const t = text.trim();
	if (t === '' || t === 'null') return null;
	if (t === 'true') return true;
	if (t === 'false') return false;
	if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
	if (t.length > 1 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
	if (/^[[{"]/.test(t)) {
		try {
			return JSON.parse(t);
		} catch {
			return t;
		}
	}
	return t;
}

/** 缩进式键值块 → 对象（`key:` 单独成行即开子层，其余按标量解析）。 */
function parseYamlMapBody(lines) {
	const root = {};
	const stack = [{ indent: -1, node: root }];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		const m = /^([^:]+):\s*(.*)$/.exec(trimmed);
		if (!m) continue;
		const indent = line.length - line.trimStart().length;
		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}
		const parent = stack[stack.length - 1].node;
		if (m[2] === '') {
			const child = {};
			parent[m[1].trim()] = child;
			stack.push({ indent, node: child });
		} else {
			parent[m[1].trim()] = parseScalarInline(m[2]);
		}
	}
	return root;
}

/** 把一个脚本组（`# script:` 下的若干行）按 `- id:` 边界拆成条目。 */
export function parseEntryItems(entry) {
	const items = [];
	let cur = null;
	for (const line of entry.yaml) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		if (/^- *id:/.test(trimmed)) {
			if (cur) items.push(cur);
			cur = { id: String(parseScalarInline(trimmed.replace(/^- *id:\s*/, ''))), lines: [] };
		} else if (cur) {
			cur.lines.push(line);
		}
	}
	if (cur) items.push(cur);
	return items.map((item) => ({ id: item.id, fields: parseYamlMapBody(item.lines) }));
}

/** src 深合并进 target（数组与标量整体替换，纯对象逐层递归）。 */
function deepMerge(target, src) {
	for (const [key, child] of Object.entries(src ?? {})) {
		const isPlainObject = child !== null && typeof child === 'object' && !Array.isArray(child);
		if (isPlainObject && target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])) {
			deepMerge(target[key], child);
		} else {
			target[key] = child;
		}
	}
	return target;
}

/** 解析区块体：# script: 注释行 + 紧随的 YAML 条目（- id: 开头，直至下一个注释/区块尾），成组返回。 */
export function parseBlockEntries(blockBody) {
	const entries = [];
	const lines = blockBody.split(/\r?\n/);
	let current = null;
	for (const line of lines) {
		const s = line.trim();
		if (s.startsWith(PATCH_ENTRY_COMMENT)) {
			if (current) entries.push(current);
			current = { script: s.slice(PATCH_ENTRY_COMMENT.length).trim(), yaml: [] };
		} else if (current && s !== '') {
			current.yaml.push(line);
		}
	}
	if (current) entries.push(current);
	return entries.filter((e) => e.script !== '');
}

/** 从区块条目重建 (script → overrides) 账本视图：yaml 文本仅保留展示。 */
export function entriesToLedger(entries) {
	return entries.map((e) => ({ script: e.script, yaml: e.yaml.join('\n') }));
}

/**
 * 写盘闸门：待写入文本若含裸 YAML 文档分隔符（`---` / `...`），直接抛错，一个字节都不写。
 * 这是「dsh-kubejs 绝不能写出一个会让 DSH 起不来的 patch.yml」的最后一道硬保证：
 * 即使将来有人绕过 markerLine() 手写标记行，也会被这里拦下。
 *
 * 注意：检查的是**重建后的最终文本**。历史遗留的裸标记行已在上面被摘出区块、
 * 不会出现在最终文本里（下次写入即自愈），所以这里报出的一定是「区块之外」的他人残留。
 */
function assertNoBareYamlSeparator(text, patchPath) {
	const hit = findBareYamlSeparator(text);
	if (!hit) return;
	throw new Error(
		`拒绝写入 ${patchPath}：第 ${hit.line} 行是裸 YAML 文档分隔符「${hit.text.trim()}」，`
		+ '它会把文件劈成多个文档导致 DSH 无法启动。'
		+ '该行不在 dsh-kubejs 托管区块内（区块内标记已由 markerLine() 加 # 前缀），'
		+ '请手工给它加上 # 前缀后再重试。'
	);
}

/** 以空行分隔拼回 patch 文本；任一缺失段直接跳过，反复写回不会逐次堆叠空行。 */
function joinWithBlock(before, block, after) {
	const parts = [];
	const head = before.replace(/\n+$/, '');
	const tail = after.replace(/^\n+/, '');
	if (head !== '') parts.push(head);
	if (block !== '') parts.push(block);
	if (tail !== '') parts.push(tail);
	return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
}

/**
 * 账本核心：读 patch.yml，按 (包 id + 路径) 叠加某脚本名下的 override 条目，写回。
 * 幂等：同一路径重复写同值结果一致；本次未提及的旧键保留（累加），
 * 传 null/undefined 则删除该脚本全部条目。区块不存在则创建（追加到文件末尾）。
 *
 * @param {string} patchPath  cordis.patch.yml 绝对路径
 * @param {string} script     脚本名（账本归属键）
 * @param {Array<{path: string, value: any}> | null} overrides
 *        null/undefined = 删除该脚本全部条目
 */
export function writeScriptOverrides(patchPath, script, overrides) {
	mkdirSync(pathDirname(patchPath), { recursive: true });
	let text = '';
	if (existsSync(patchPath)) {
		text = readFileSync(patchPath, 'utf8');
	}

	// 摘出旧区块：区块内原有脚本组按文件顺序保留，本脚本的组解析后按包 id 归并
	let before = text;
	let after = '';
	let groups = [];
	const beginLine = findMarkerLine(text, PATCH_BLOCK_BEGIN);
	if (beginLine) {
		const endLine = findMarkerLine(text, PATCH_BLOCK_END, beginLine.end);
		if (endLine) {
			groups = parseBlockEntries(text.slice(beginLine.end, endLine.start));
			before = text.slice(0, beginLine.start);
			after = text.slice(endLine.end);
		}
	}

	// 以本脚本已落盘字段为底叠加新覆写：同一脚本分多次写不同路径时累加，
	// 而不是像旧实现那样整组替换、把上一次写入的键抹掉。
	// overrides 为 null/undefined 是「清空该脚本条目」的信号，此时不回填已有条目。
	const clearing = overrides === null || overrides === undefined;
	const byId = new Map();
	const touch = (id) => {
		if (!byId.has(id)) byId.set(id, {});
		return byId.get(id);
	};
	if (!clearing) {
		for (const group of groups) {
			if (group.script !== script) continue;
			for (const item of parseEntryItems(group)) {
				deepMerge(touch(item.id), item.fields);
			}
		}
		for (const o of overrides) {
			const { id, config } = overrideToEntry(o.path, o.value);
			if (config && typeof config === 'object' && !Array.isArray(config)) {
				deepMerge(touch(id), config);
			}
		}
	}
	const ownEntries = [...byId]
		.filter(([, fields]) => Object.keys(fields).length > 0)
		.map(([id, fields]) => ({
			script,
			yaml: [`- id: ${id}`, ...configToYamlBody(fields).map((l) => `  ${l}`)]
		}));

	// 重建区块：其他脚本条目文本原样，本脚本归并结果就地放回它原先首次出现的位置
	const allEntries = [];
	let ownPlaced = false;
	for (const group of groups) {
		if (group.script !== script) {
			allEntries.push(group);
		} else if (!ownPlaced && ownEntries.length > 0) {
			allEntries.push(...ownEntries);
			ownPlaced = true;
		}
	}
	if (!ownPlaced) allEntries.push(...ownEntries);

	if (allEntries.length > 0) {
		const lines = [markerLine(PATCH_BLOCK_BEGIN)];
		for (const e of allEntries) {
			lines.push(`${PATCH_ENTRY_COMMENT}${e.script}`);
			lines.push(...e.yaml);
		}
		lines.push(markerLine(PATCH_BLOCK_END));
		text = joinWithBlock(before, lines.join('\n'), after);
	} else {
		// 纯摘除且无其他条目：不留区块
		text = joinWithBlock(before, '', after);
	}

	assertNoBareYamlSeparator(text, patchPath);
	writeFileSync(patchPath, text, 'utf8');
	return true;
}

/** 读取账本：返回所有 (script, yaml) 条目。 */
export function readLedger(patchPath) {
	if (!existsSync(patchPath)) return [];
	const text = readFileSync(patchPath, 'utf8');
	const beginLine = findMarkerLine(text, PATCH_BLOCK_BEGIN);
	if (!beginLine) return [];
	const endLine = findMarkerLine(text, PATCH_BLOCK_END, beginLine.end);
	if (!endLine) return [];
	const kept = parseBlockEntries(text.slice(beginLine.end, endLine.start));
	return entriesToLedger(kept);
}

/** 摘除某脚本名下的全部条目（幂等）。 */
export function removeScriptEntries(patchPath, script) {
	return writeScriptOverrides(patchPath, script, null);
}
