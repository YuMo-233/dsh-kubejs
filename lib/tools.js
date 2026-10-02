/**
 * dsh-kubejs AI 工具：kubejs_inspect / kubejs_write_script / kubejs_reload / kubejs_check
 *
 * 输出为「裸工具对象」（照 liangshen tool-activate.mjs 先例，不依赖 @deepseek-ai/dsh-tools）：
 * { name, description, parameters: JSON schema, output: { schema, render }, execute(args, exec) }
 * 注册方（lib/tools-row.mjs 的行插件）直接 ctx.tools.register(tool)。
 * 数据源：
 *  - inspect：真实扫描 + host 状态（只读）
 *  - write_script：写脚本文件 + 落盘校验（JSON.parse / new Function / node --check）
 *  - reload：host.loadAll 重新扫描+加载
 *  - check：健康报告（失败脚本、失配包、账本一致性）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { scanPackages } from './scanner.js';
import { scriptsRoot } from './shared.js';
import { readLedger } from './patch-ledger.js';

const execFileAsync = promisify(execFile);

/** 包摘要（工具/面板友好）。 */
function pkgSummary(pkg) {
	return {
		name: pkg.name,
		plane: pkg.plane,
		target: pkg.target,
		targetRange: pkg.targetRange ?? null,
		status: pkg.status,
		reasons: pkg.reasons ?? [],
		scripts: (pkg.scripts ?? []).map((s) => s.file),
		path: pkg.dir
	};
}

/** 统一 output.render：紧凑 JSON 文本块。 */
const renderJson = (args, value) => [{
	type: 'text',
	text: '```json\n' + JSON.stringify(value, null, 2) + '\n```'
}];

/** server 平面脚本是 ESM：写临时 .mjs 用 node --check 校验语法。 */
async function checkEsmSyntax(code) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-kubejs-check-'));
	const file = join(dir, 'snippet.mjs');
	try {
		writeFileSync(file, code, 'utf8');
		await execFileAsync(process.execPath, ['--check', file], { timeout: 10_000 });
		return null;
	} catch (err) {
		return String(err.stderr || err.message || err);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function createTools({ host, profileName, patchPath }) {
	const tools = [];

	// ---- kubejs_inspect（只读）----
	tools.push({
		name: 'kubejs_inspect',
		description: '列出 dsh-kubejs 脚本包、脚本与失配/失败状态（只读）。写脚本前先调用它了解现状。',
		parameters: {
			type: 'object',
			properties: {
				plane: { type: 'string', description: '可选过滤：server_scripts | client_scripts' }
			},
			additionalProperties: false
		},
		output: { schema: { type: 'object' }, render: renderJson },
		isConcurrencySafe: true,
		async execute(args) {
			const { packages, errors } = scanPackages({ profile: profileName });
			const pkgs = packages.filter((p) => !args?.plane || p.plane === args.plane);
			return {
				root: scriptsRoot(),
				profile: profileName,
				packages: pkgs.map(pkgSummary),
				scanErrors: errors,
				runtime: host.state,
				ledger: readLedger(patchPath)
			};
		}
	});

	// ---- kubejs_write_script（写+校验）----
	tools.push({
		name: 'kubejs_write_script',
		description: '写/改 dsh-kubejs 脚本文件（.js 或 manifest.json），落盘前自动校验语法/JSON。只能写进 dsh-kubejs 脚本目录。',
		parameters: {
			type: 'object',
			properties: {
				plane: { type: 'string', description: 'server_scripts | client_scripts' },
				pkg: { type: 'string', description: '脚本包目录名（按目标插件分组，如 snowluma-humanize）' },
				file: { type: 'string', description: '文件名（如 humanize.js 或 manifest.json）' },
				content: { type: 'string', description: '文件完整内容（UTF-8）' }
			},
			required: ['plane', 'pkg', 'file', 'content'],
			additionalProperties: false
		},
		output: { schema: { type: 'object' }, render: renderJson },
		async execute(args) {
			// ① 参数合法性
			if (args.plane !== 'server_scripts' && args.plane !== 'client_scripts') {
				throw new Error('plane 必须是 server_scripts | client_scripts');
			}
			if (!/^[A-Za-z0-9_-]+$/.test(args.pkg)) {
				throw new Error(`pkg 名不合法（只允许 [A-Za-z0-9_-]）: ${args.pkg}`);
			}
			if (!/^[A-Za-z0-9_.-]+\.(js|json)$/.test(args.file)) {
				throw new Error(`file 名不合法: ${args.file}`);
			}
			// ② 路径约束：必须落在脚本目录之内
			const root = resolve(scriptsRoot());
			const pkgDir = join(root, args.plane, args.pkg);
			const filePath = join(pkgDir, args.file);
			if (!resolve(filePath).startsWith(root + sep)) {
				throw new Error('路径逃逸：目标必须在 dsh-kubejs 脚本目录内');
			}
			// ③ 落盘前校验
			if (args.file.endsWith('.json')) {
				let parsed;
				try {
					parsed = JSON.parse(args.content);
				} catch (e) {
					throw new Error(`manifest.json 不是合法 JSON: ${e.message}`);
				}
				if (args.file === 'manifest.json') {
					if (typeof parsed.target !== 'string' || parsed.target === '') {
						throw new Error('manifest.json 缺必填字段 target（目标插件包名）');
					}
				}
			} else {
				// server 平面 = ESM（可用 import/export）；client 平面 = 纯脚本体（不可 import/export）
				if (/(^|\n)\s*(import|export)\s/.test(args.content) && args.plane === 'client_scripts') {
					throw new Error('client_scripts 不支持 import/export：脚本由 new Function 执行，用 require() 取依赖');
				}
				if (/(^|\n)\s*(import|export)\s/.test(args.content)) {
					const err = await checkEsmSyntax(args.content);
					if (err) throw new Error(`ESM 语法校验失败（node --check）:\n${err}`);
				} else {
					try {
						// eslint-disable-next-line no-new-func
						new Function(args.content);
					} catch (e) {
						throw new Error(`JS 语法错误: ${e.message}`);
					}
				}
			}
			// ④ 落盘
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(filePath, args.content, 'utf8');
			return {
				ok: true,
				path: filePath,
				note: '已写入。改 .js 后调用 kubejs_reload 生效；改 manifest.json 后同样 reload。'
			};
		}
	});

	// ---- kubejs_reload ----
	tools.push({
		name: 'kubejs_reload',
		description: '重新扫描并加载全部 dsh-kubejs 脚本包（热重载）。服务包装与 slot 变更可能需要重启 DSH / 刷新页面。',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		output: { schema: { type: 'object' }, render: renderJson },
		async execute() {
			await host.unloadAll();
			await host.loadAll({});
			return {
				ok: true,
				state: host.state,
				hint: '事件钩子与配置覆写即时生效；服务包装如未生效请重启 DSH；client 脚本改动需刷新网页。'
			};
		}
	});

	// ---- kubejs_check（健康报告）----
	tools.push({
		name: 'kubejs_check',
		description: 'dsh-kubejs 健康报告：失配包、被隔离/失败的脚本、账本里指向不存在脚本的孤儿条目。',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		output: { schema: { type: 'object' }, render: renderJson },
		isConcurrencySafe: true,
		async execute() {
			const { packages, errors } = scanPackages({ profile: profileName });
			const mismatched = packages.filter((p) => p.status === 'mismatch').map(pkgSummary);
			const invalid = packages.filter((p) => p.status === 'invalid').map(pkgSummary);
			const failed = [...host.failed].map(([name, reason]) => ({ name, reason }));
			// 孤儿账本条目：账本里有记录但脚本文件已不存在
			const ledger = readLedger(patchPath);
			const orphans = [];
			for (const [script] of Object.entries(ledger.scripts ?? {})) {
				const m = /^([^/]+)\/([^/]+)$/.exec(script);
				if (!m) continue;
				const [, planeDir, rest] = m;
				const slash = rest.indexOf('/');
				if (slash < 0) continue;
				const pkgName = rest.slice(0, slash);
				const file = rest.slice(slash + 1);
				const p = join(scriptsRoot(), planeDir, pkgName, file);
				if (!existsSync(p)) orphans.push(script);
			}
			return {
				ok: failed.length === 0 && mismatched.length === 0 && invalid.length === 0 && orphans.length === 0 && errors.length === 0,
				profile: profileName,
				scanErrors: errors,
				mismatched,
				invalid,
				failed,
				ledgerOrphans: orphans,
				runtime: host.state
			};
		}
	});

	return tools;
}
