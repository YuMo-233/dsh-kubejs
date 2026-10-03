/**
 * dsh-kubejs — DSH 插件修改者主插件（server 平面）
 *
 * 职责：
 * 1. 创建 host（脚本加载器 + 故障隔离 + 四原语 host 端）
 * 2. 注册管理面板 HTTP API（面板数据读写走同源路由）
 * 3. 启动时扫描 DSH_HOME/dsh-kubejs/ 并加载 server 脚本
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHost } from './host.js';
import { createPluginResolver } from './lib/resolve.js';
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

export function apply(ctx, config) {
	// ---- 基础依赖 ----
	// ctx.logger 是 cordis 内置服务，一定可用；不要写 ctx.console / ctx.config 这类
	// 未提供属性——cordis 的 ctx Proxy 会直接抛 `cannot get property "x" without inject`，
	// `??` / `?.` 都挡不住，apply 会当场失败。
	const logger = ctx.logger;
	// 配置：行 config.debug（patch.yml 的 config 段），缺省 false
	let debug = Boolean(config?.debug ?? false);

	// ---- profile / patch.yml 定位 ----
	// 优先用 profileContext 服务（profile-boot 提供：{name, patchPath, dir, home, ...}）；
	// 否则回退 ~/.dsh/profiles/desktop
	let profileName = 'desktop';
	let patchPath = join(dshHome(), 'profiles', profileName, 'cordis.patch.yml');
	let profileDir = join(dshHome(), 'profiles', profileName);
	try {
		const profileContext = ctx.get('profileContext');
		if (typeof profileContext?.name === 'string' && profileContext.name !== '') profileName = profileContext.name;
		if (typeof profileContext?.patchPath === 'string') patchPath = profileContext.patchPath;
		if (typeof profileContext?.dir === 'string' && profileContext.dir !== '') profileDir = profileContext.dir;
		else profileDir = join(dshHome(), 'profiles', profileName);
	} catch { /* 尽力推断 */ }

	// 目标插件版本解析：先试 profile 的 node_modules，再退回 patch.yml 里的绝对路径线索
	const resolvePlugin = createPluginResolver({ profileDir, patchPath, logger });

	// ---- host 组装 ----
	const notify = {
		send(_name, message, level) {
			// 尽力而为：有 notify 服务就转发，否则只落日志
			try {
				const service = ctx.get('notify');
				if (service?.send) {
					service.send({ title: 'dsh-kubejs', message, level });
					return;
				}
			} catch { /* 忽略 */ }
			logger.info?.(`[dsh-kubejs] ${message}`);
		}
	};
	const host = createHost({ ctx, logger, profileName, patchPath, notify });

	// ---- 服务提供：kubejsHost（行插件 tools-row.mjs 从这里取 host 组装工具）----
	ctx.provide('kubejsHost', { host, profileName, patchPath, resolvePlugin });

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
							clientScripts: host.collectClientScripts({ resolvePlugin }),
							ledger: readLedger(patchPath)
						});
						return;
					}
					if (req.method === 'POST') {
						const body = await readJsonBody(req);
						// action: reload | setDebug
						if (body.action === 'reload') {
							host.unloadAll();
							const summary = await host.loadAll({ profile: profileName, resolvePlugin });
							sendJson(res, 200, { ok: true, summary, state: host.state });
							return;
						}
						// 启用/禁用脚本包：写回 manifest.json 的 disabled 字段后重载
						if (body.action === 'setEnabled') {
							const pkg = host.state.packages.find((p) => p.name === body.name);
							if (!pkg) {
								sendJson(res, 404, { ok: false, error: `脚本包不存在: ${String(body.name)}` });
								return;
							}
							const manifestPath = join(pkg.dir, 'manifest.json');
							const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
							manifest.disabled = body.enabled === false;
							writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
							host.unloadAll();
							const summary = await host.loadAll({ profile: profileName, resolvePlugin });
							logger.info?.(`[dsh-kubejs] 脚本包 ${pkg.name} 已${manifest.disabled ? '禁用' : '启用'}`);
							sendJson(res, 200, { ok: true, disabled: manifest.disabled, summary, state: host.state });
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
			const summary = await host.loadAll({ profile: profileName, resolvePlugin });
			logger.info?.(`[dsh-kubejs] server 脚本加载完成: ${summary.loaded} loaded, ${summary.mismatch.length} mismatch, ${summary.disabled.length} disabled, ${summary.invalid.length} invalid, ${summary.failed.length} failed`);
			for (const pkg of summary.packages) {
				logger.info?.(`[dsh-kubejs]  ├ ${pkg.name} [${pkg.status}] target=${pkg.target}${pkg.targetVersion ? `@${pkg.targetVersion}` : ''} ${pkg.reasons.length ? `· ${pkg.reasons.join('; ')}` : ''}`);
			}
		} catch (error) {
			logger.error?.('[dsh-kubejs] 启动加载失败（不影响 DSH 运行）:', error?.stack ?? error);
		}
	};
	Promise.resolve().then(start);
}
