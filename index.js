/**
 * dsh-kubejs — DSH 插件修改者主插件（server 平面）
 *
 * 职责：
 * 1. 创建 host（脚本加载器 + 故障隔离 + 四原语 host 端）
 * 2. 注册管理面板 HTTP API（面板数据读写走同源路由）
 * 3. 启动时扫描 DSH_HOME/dsh-kubejs/ 并加载 server 脚本
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHost } from './host.js';
import { scriptsRoot, dshHome } from './lib/shared.js';
import { readLedger } from './lib/patch-ledger.js';
import { buildPresetPlugins } from './lib/preset.js';

const PLUGIN_NAME = 'dsh-kubejs';
const PANEL_ROUTE = '/dsh-kubejs/panel';
const PRESET_ID = 'dsh-kubejs';

/** 读 JSON body（webServer.register handler 用）。 */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (error) {
				reject(new Error(`JSON body 解析失败: ${error.message}`));
			}
		});
		req.on('error', reject);
	});
}

/** 统一 JSON 响应。 */
function sendJson(res, status, data) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(data));
}

export const name = PLUGIN_NAME;

export function apply(ctx) {
	// ---- 基础依赖 ----
	const logger = ctx.console ?? ctx.logger ?? console;
	// 配置：dsh-kubejs.debug（读当前生效配置，缺省 false）
	let debug = false;
	try {
		debug = Boolean(ctx.config?.get?.('dsh-kubejs.debug') ?? false);
	} catch {
		debug = false;
	}

	// ---- profile / patch.yml 定位 ----
	// 优先用 cordis 提供的 profile 信息；否则回退 ~/.dsh/profiles/desktop
	let profileName = 'desktop';
	let patchPath = join(dshHome(), 'profiles', profileName, 'cordis.patch.yml');
	try {
		const hinted = ctx.runtime?.profile ?? ctx.profile?.name;
		if (typeof hinted === 'string' && hinted !== '') profileName = hinted;
		if (typeof ctx.runtime?.patchPath === 'string') patchPath = ctx.runtime.patchPath;
	} catch { /* 尽力推断 */ }

	// ---- host 组装 ----
	const notify = {
		send(_name, message, level) {
			// 尽力而为：有 notify 服务就转发，否则只落日志
			try {
				ctx.notify?.send?.({ title: 'dsh-kubejs', message, level });
			} catch { /* 忽略 */ }
		}
	};
	const host = createHost({ ctx, logger, profileName, patchPath, notify });

	// ---- 服务提供：kubejsHost（行插件 tools-row.mjs 从这里取 host 组装工具）----
	ctx.provide('kubejsHost', { host, profileName, patchPath });

	// ---- 「dsh-kubejs 模式」agent preset 声明 ----
	// 照 liangshen 模式：运行时 ctx.agentPresets.register 声明，不改 DSH 本体。
	// 关键点：
	//  - agentPresets 可能晚于本插件激活（issue #1721），用 ctx.inject 迟到恢复；
	//  - register 返回 dispose，插件卸载/重声明时先调它；
	//  - generation guard 防乱序（旧声明迟到的 dispose 不能拆掉新声明）。
	const declarePreset = async (registry) => {
		const definition = {
			id: PRESET_ID,
			name: 'dsh-kubejs 模式',
			description: '修改其他插件/写脚本的专用模式：kubejs 四工具 + dsh-kubejs 脚本纪律，禁止直接改插件文件。',
			order: 30,
			plugins: buildPresetPlugins()
		};
		const dispose = await registry.register(definition);
		logger.info?.(`[dsh-kubejs] agent preset「${definition.name}」已声明`);
		return dispose;
	};

	let currentDispose = null;
	let generation = 0;
	let closed = false;
	let queue = Promise.resolve(); // 串行化 rearm，防并发 register 撞 Duplicate agent preset
	const registryMissing = () => {
		try { return !ctx.get?.('agentPresets'); } catch { return true; }
	};

	const rearm = () => {
		if (closed) return;
		queue = queue.then(async () => {
			if (closed) return;
			const registry = (() => { try { return ctx.get('agentPresets'); } catch { return undefined; } })();
			if (!registry) return;
			const myGen = ++generation;
			try {
				// 先摘旧声明（若已被别处 dispose 也无妨），再注册新声明
				if (currentDispose) { try { await currentDispose(); } catch { /* 尽力 */ } currentDispose = null; }
				currentDispose = await declarePreset(registry);
			} catch (error) {
				if (myGen === generation) {
					logger.error?.('[dsh-kubejs] agent preset 声明失败（模式不可用，不影响 DSH 其他功能）:', error?.stack ?? error);
				}
			}
		});
		return queue;
	};

	ctx.on?.('loader/volatile-update', () => { Promise.resolve().then(rearm); });
	ctx.inject(['agentPresets'], () => {
		if (registryMissing() || !currentDispose) Promise.resolve().then(rearm);
	});
	Promise.resolve().then(rearm);

	ctx.effect(() => {
		return async () => {
			closed = true;
			generation += 1;
			await queue.catch(() => {}); // 等在途 rearm 落定，避免迟到声明重建已卸载的 preset
			if (currentDispose) { try { await currentDispose(); } catch { /* 尽力 */ } currentDispose = null; }
		};
	});

	// ---- 管理面板 HTTP API ----
	ctx.inject(['webServer'], (child) => {
		child.effect(() => child.webServer.register({
			kind: 'exact',
			path: PANEL_ROUTE,
			handler: async (req, res) => {
				try {
					if (req.method === 'GET') {
						sendJson(res, 200, {
							ok: true,
							root: scriptsRoot(),
							profile: profileName,
							debug,
							state: host.state,
							clientScripts: host.collectClientScripts(),
							ledger: readLedger(patchPath)
						});
						return;
					}
					if (req.method === 'POST') {
						const body = await readJsonBody(req);
						// action: reload | setDebug
						if (body.action === 'reload') {
							host.unloadAll();
							const summary = await host.loadAll({ profile: profileName });
							sendJson(res, 200, { ok: true, summary, state: host.state });
							return;
						}
						if (body.action === 'setDebug') {
							debug = Boolean(body.value);
							sendJson(res, 200, { ok: true, debug });
							return;
						}
						sendJson(res, 400, { ok: false, error: `未知 action: ${String(body.action)}` });
						return;
					}
					sendJson(res, 405, { ok: false, error: `method ${req.method} 不支持` });
				} catch (error) {
					sendJson(res, 500, { ok: false, error: String(error?.stack ?? error) });
				}
			}
		}), 'dsh-kubejs: panel data API');
	});

	// ---- 启动加载（异步执行，绝不阻塞/拖垮 DSH 启动） ----
	const start = async () => {
		try {
			mkdirSync(scriptsRoot(), { recursive: true });
			mkdirSync(join(scriptsRoot(), 'server_scripts'), { recursive: true });
			mkdirSync(join(scriptsRoot(), 'client_scripts'), { recursive: true });
			const summary = await host.loadAll({ profile: profileName });
			logger.info?.(`[dsh-kubejs] server 脚本加载完成: ${summary.loaded} loaded, ${summary.mismatch.length} mismatch, ${summary.disabled.length} disabled, ${summary.invalid.length} invalid, ${summary.failed.length} failed`);
		} catch (error) {
			logger.error?.('[dsh-kubejs] 启动加载失败（不影响 DSH 运行）:', error?.stack ?? error);
		}
	};
	Promise.resolve().then(start);
}
