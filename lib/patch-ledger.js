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
import { PATCH_BLOCK_BEGIN, PATCH_BLOCK_END, PATCH_ENTRY_COMMENT } from './shared.js';

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
 * 账本核心：读 patch.yml，替换/新增/删除某脚本名下的 override 条目，写回。
 * 幂等：多次调用结果一致。区块不存在则创建（追加到文件末尾）。
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

	// 摘出旧区块并保留其他脚本的条目（区块外内容原样保留）
	let before = text;
	let after = '';
	let kept = [];
	const beginIdx = text.indexOf(PATCH_BLOCK_BEGIN);
	if (beginIdx !== -1) {
		const endIdx = text.indexOf(PATCH_BLOCK_END, beginIdx);
		if (endIdx !== -1) {
			const blockBody = text.slice(beginIdx, endIdx);
			kept = parseBlockEntries(blockBody).filter((e) => e.script !== script);
			before = text.slice(0, beginIdx);
			after = text.slice(endIdx + PATCH_BLOCK_END.length);
			if (before !== '' && !before.endsWith('\n')) {
				before = `${before}\n`;
			}
		}
	}

	// 重建区块：其他脚本条目 + 当前脚本新条目，全部留在区块内
	const allEntries = [
		...kept,
		...(overrides ?? []).map((o) => {
			const { id, config } = overrideToEntry(o.path, o.value);
			return { script, yaml: [`- id: ${id}`, ...configToYamlBody(config).map((l) => `  ${l}`)] };
		})
	];

	if (allEntries.length > 0) {
		const lines = [PATCH_BLOCK_BEGIN];
		for (const e of allEntries) {
			lines.push(`${PATCH_ENTRY_COMMENT}${e.script}`);
			lines.push(...e.yaml);
		}
		lines.push(PATCH_BLOCK_END);
		const block = lines.join('\n');
		const sep = before === '' ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
		text = `${before}${sep}${block}${after}`;
	} else {
		// 纯摘除且无其他条目：不留区块
		text = `${before}${after}`;
	}

	writeFileSync(patchPath, text, 'utf8');
	return true;
}

/** 读取账本：返回所有 (script, yaml) 条目。 */
export function readLedger(patchPath) {
	if (!existsSync(patchPath)) return [];
	const text = readFileSync(patchPath, 'utf8');
	const beginIdx = text.indexOf(PATCH_BLOCK_BEGIN);
	if (beginIdx === -1) return [];
	const endIdx = text.indexOf(PATCH_BLOCK_END, beginIdx);
	if (endIdx === -1) return [];
	const kept = parseBlockEntries(text.slice(beginIdx, endIdx));
	return entriesToLedger(kept);
}

/** 摘除某脚本名下的全部条目（幂等）。 */
export function removeScriptEntries(patchPath, script) {
	return writeScriptOverrides(patchPath, script, null);
}
