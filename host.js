/**
 * dsh-kubejs host（server 平面）：脚本包扫描、加载执行、故障隔离、原语 host 端实现。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanPackages, PLANES } from './lib/scanner.js';
import { createScriptApi } from './lib/api.js';
import { writeScriptOverrides, removeScriptEntries } from './lib/patch-ledger.js';

/**
 * 创建 dsh-kubejs host。
 * @param {object} deps
 * @param {object} deps.ctx         cordis 上下文（插件 apply 收到的 ctx）
 * @param {object} deps.logger      宿主日志对象（info/warn/error/debug）
 * @param {string} deps.profileName 当前激活 profile 名
 * @param {string} deps.patchPath   当前激活 profile 的 cordis.patch.yml 绝对路径
 * @param {object} [deps.notify]    通知渠道 { send(name, message, level) }
 * @param {string} [deps.root]      脚本根目录覆写（默认 DSH_HOME/dsh-kubejs；测试注入用）
 */
export function createHost({ ctx, logger, profileName, patchPath, notify, root }) {
	const hooks = new Map();          // scriptName -> [{event, handler}]
	const wrapped = new Map();        // scriptName -> [{serviceName, wrapper, applied}]
	const failed = new Set();         // 已触发故障隔离的脚本
	const loadedScripts = new Map();  // scriptName -> {pkg, api}
	let packagesSnapshot = [];        // 最近一次 loadAll 的包列表（面板展示用）

	const log = {
		info: (...a) => logger?.info?.(...a),
		warn: (...a) => logger?.warn?.(...a),
		error: (...a) => logger?.error?.(...a),
		debug: (...a) => {
			if (host.debug) logger?.info?.('[debug]', ...a);
		}
	};

	const host = {
		ctx,
		get debug() {
			return debugEnabled;
		},
		set debug(value) {
			debugEnabled = Boolean(value);
		},
		addHook,
		wrapService,
		writeOverride,
		log,
		notify(name, message, level = 'info') {
			try {
				notify?.send?.(name, message, level);
			} catch (error) {
				log.warn('notify 渠道异常:', error?.message ?? error);
			}
		},
		/** 摘除某脚本的 patch.yml 条目（脚本删除/失配时调用）。 */
		removeLedgerEntries(scriptName) {
			try {
				removeScriptEntries(patchPath, scriptName);
			} catch (error) {
				log.warn(`摘除 ${scriptName} 账本条目失败:`, error?.message ?? error);
			}
		}
	};

	let debugEnabled = false;

	/** 故障隔离：把脚本标记为 failed，摘除其 patch 条目，并报警。 */
	function quarantine(scriptName, reason) {
		if (failed.has(scriptName)) return;
		failed.add(scriptName);
		const hooksOf = hooks.get(scriptName);
		if (hooksOf) {
			hooksOf.length = 0; // 保留 Map 键使事件分发快速跳过
		}
		const wrapsOf = wrapped.get(scriptName);
		if (wrapsOf) wrapsOf.length = 0;
		host.removeLedgerEntries(scriptName);
		log.warn(`脚本 ${scriptName} 已被隔离: ${reason}`);
		host.notify(scriptName, `脚本异常被隔离: ${reason}`, 'warning');
	}

	/**
	 * 事件钩子注册。返回注销函数。
	 * waterfall：handler(payload) 返回非 undefined 则替换负载。
	 */
	function addHook(scriptName, event, handler) {
		let list = hooks.get(scriptName);
		if (!list) {
			list = [];
			hooks.set(scriptName, list);
		}
		const entry = { event, handler };
		list.push(entry);
		return () => {
			const idx = list.indexOf(entry);
			if (idx >= 0) list.splice(idx, 1);
		};
	}

	/**
	 * 事件分发（供插件在关键生命周期事件上调用，也可由 api.ctx.on 的旁路调用）。
	 * 任何脚本 handler 异常只记日志，不影响其他脚本与 DSH。
	 */
	function emit(event, payload) {
		let result = payload;
		for (const [scriptName, list] of hooks) {
			if (failed.has(scriptName) || list.length === 0) continue;
			for (const { event: e, handler } of list) {
				if (e !== event) continue;
				try {
					const next = handler(result);
					if (next !== undefined) result = next;
				} catch (error) {
					log.error(`事件 ${event} 处理异常（脚本 ${scriptName}）:`, error?.stack ?? error);
				}
			}
		}
		return result;
	}

	/** 服务包装注册（洋葱式）。实际应用由宿主在服务实例化点执行；返回撤销函数。 */
	function wrapService(scriptName, serviceName, wrapper) {
		let list = wrapped.get(scriptName);
		if (!list) {
			list = [];
			wrapped.set(scriptName, list);
		}
		const entry = { serviceName, wrapper, applied: false };
		list.push(entry);
		log.debug(`服务包装登记: ${serviceName}（多数服务需重启生效）`);
		return () => {
			const idx = list.indexOf(entry);
			if (idx >= 0) list.splice(idx, 1);
		};
	}

	/** 配置覆写落盘（写当前激活 profile 的 patch.yml 管理区块）。 */
	function writeOverride(scriptName, path, value) {
		writeScriptOverrides(patchPath, scriptName, [{ path, value }]);
	}

	/**
	 * 加载所有脚本包。
	 * @param {object} opts
	 * @param {(name: string) => {installed: boolean, version?: string}} [opts.resolvePlugin]
	 */
	async function loadAll({ resolvePlugin } = {}) {
		const { packages, errors, root: scanRoot } = scanPackages({ profile: profileName, resolvePlugin, root });
		for (const error of errors) {
			log.warn(`脚本目录扫描异常: ${error.error}`);
		}
		const summary = { loaded: 0, mismatch: [], disabled: [], invalid: [], failed: [], total: packages.length, root, packages: [] };

		packagesSnapshot = packages;

		for (const pkg of packages) {
			// 双平面：server 包现在加载；client 包记录后交给 client bundle
			summary.packages.push(pkg);
			if (pkg.plane !== 'server_scripts') continue;
			switch (pkg.status) {
				case 'mismatch':
					summary.mismatch.push(pkg);
					log.warn(`脚本包 ${pkg.name} 失配: ${pkg.reasons.join('; ')}`);
					host.notify(pkg.name, `脚本包失配: ${pkg.reasons.join('; ')}`, 'warning');
					// 失配时摘除其历史账本条目，避免残留 patch 污染
					host.removeLedgerEntries(pkg.name);
					continue;
				case 'disabled':
					summary.disabled.push(pkg);
					log.info(`脚本包 ${pkg.name} 已禁用: ${pkg.reasons.join('; ')}`);
					continue;
				case 'invalid':
					summary.invalid.push(pkg);
					log.error(`脚本包 ${pkg.name} 非法: ${pkg.reasons.join('; ')}`);
					host.notify(pkg.name, `脚本包非法: ${pkg.reasons.join('; ')}`, 'error');
					continue;
				case 'empty':
					summary.disabled.push(pkg);
					continue;
			}
			// status === 'ok'
			for (const script of pkg.scripts) {
				try {
					await loadServerScript(pkg, script.file);
					summary.loaded++;
				} catch (error) {
					// 故障隔离：脚本异常只禁用自己，绝不拖垮 DSH 启动
					quarantine(script.name, error?.stack ?? String(error));
					summary.failed.push({ pkg: pkg.name, script: script.name, reason: String(error?.message ?? error) });
				}
			}
		}
		return summary;
	}

	/** 加载单个 server 脚本（ESM 动态导入）。 */
	async function loadServerScript(pkg, file) {
		const scriptName = file.replace(/\.js$/, '');
		const scriptPath = join(pkg.dir, file);
		const mod = await import(pathToFileURL(scriptPath).href);
		const exporter = mod.default ?? mod;
		// api 实例绑定脚本身份
		const api = createScriptApi({
			name: scriptName,
			plane: 'server',
			target: pkg.target,
			host: {
				ctx,
				get debug() {
					return debugEnabled;
				},
				addHook: (n, e, h) => addHook(n, e, h),
				wrapService: (n, s, w) => wrapService(n, s, w),
				writeOverride: (n, p, v) => writeOverride(n, p, v),
				log,
				notify: host.notify
			}
		});
		// 脚本导出 activate(api) 或默认导出函数
		const activate = typeof exporter === 'function' ? exporter : exporter?.activate;
		if (typeof activate !== 'function') {
			throw new Error('脚本必须导出 activate(api) 函数（或默认导出函数）');
		}
		await activate(api);
		loadedScripts.set(scriptName, { pkg, api });
		log.info(`脚本加载成功: ${pkg.name}/${scriptName} → ${pkg.target}`);
	}

	/** 卸载全部钩子（重载用）。 */
	function unloadAll() {
		hooks.clear();
		wrapped.clear();
		loadedScripts.clear();
	}

	/**
	 * 收集 client 平面脚本源码（下发浏览器执行用）。
	 * 只返回状态 ok 的 client 包；每项 { name, target, files: [{file, code}] }。
	 */
	function collectClientScripts() {
		const { packages } = scanPackages({ profile: profileName, root });
		const out = [];
		for (const pkg of packages) {
			if (pkg.plane !== 'client_scripts' || pkg.status !== 'ok') continue;
			const files = [];
			for (const script of pkg.scripts) {
				try {
					files.push({ file: script.file, code: readFileSync(join(pkg.dir, script.file), 'utf8') });
				} catch (error) {
					log.warn(`读取 client 脚本 ${pkg.name}/${script.file} 失败: ${error?.message ?? error}`);
				}
			}
			out.push({ name: pkg.name, target: pkg.target, manifest: pkg.manifest, files });
		}
		return out;
	}

	return {
		loadAll,
		unloadAll,
		emit,
		quarantine,
		collectClientScripts,
		get state() {
			return {
				loadedScripts: [...loadedScripts.keys()],
				failed: [...failed],
				hooks: hooks.size,
				wrapped: wrapped.size,
				packages: packagesSnapshot
			};
		}
	};
}
