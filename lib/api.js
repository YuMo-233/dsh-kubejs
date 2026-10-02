/**
 * dsh-kubejs 脚本 API 门面。
 *
 * 四原语：
 *   api.on(event, handler)           事件钩子（waterfall：handler 返回值替换事件负载）
 *   api.slot(...)                    仅 client 平面可用（server 侧调用抛错）
 *   api.config.override(path, value) 配置覆写（写当前激活 profile 的 cordis.patch.yml 管理区块）
 *   api.service.wrap(name, wrapper)  服务包装（洋葱式；多数服务需重启生效，api 会标注）
 *
 * 逃生舱：
 *   api.ctx                          直通 cordis 上下文（本机信任模型）
 *
 * 每个 api 实例绑定一个脚本（name/plane/target），日志与故障隔离都以此为单元。
 */
import { PATCH_BLOCK_BEGIN, PATCH_BLOCK_END, PATCH_ENTRY_COMMENT } from './shared.js';

export function createScriptApi({ name, plane, target, host }) {
	const logPrefix = `[dsh-kubejs:${plane}/${name}]`;

	const api = {
		/** 脚本元信息（只读）。 */
		meta: Object.freeze({ name, plane, target }),

		/** 原语①：事件钩子（waterfall）。返回注销函数。 */
		on(event, handler) {
			if (typeof event !== 'string' || event === '') throw new Error('api.on: event 必须是非空字符串');
			if (typeof handler !== 'function') throw new Error('api.on: handler 必须是函数');
			return host.addHook(name, event, handler);
		},

		/** 原语②：client UI 槽位。server 平面不可用。 */
		slot(...args) {
			throw new Error(`api.slot 仅在 client_scripts 中可用（当前脚本 ${plane}/${name}）`);
		},

		/** 原语③：配置覆写。写入当前激活 profile 的 cordis.patch.yml 管理区块。 */
		config: {
			/**
			 * @param {string} path  配置路径，如 'dsh-kubejs.debug' 或 'qq-agent-presets.foo.bar'
			 * @param {*} value      任意可 JSON 序列化的值
			 */
			override(path, value) {
				if (typeof path !== 'string' || path === '') throw new Error('api.config.override: path 必须是非空字符串');
				host.writeOverride(name, path, value);
				host.log.info(`${logPrefix} config.override ${path} = ${JSON.stringify(value)}`);
			}
		},

		/** 原语④：服务包装（洋葱式）。 */
		service: {
			/**
			 * @param {string} serviceName  cordis 服务名（inject 用的键）
			 * @param {(service, ctx) => any} wrapper  接收原服务，返回包装后的服务
			 */
			wrap(serviceName, wrapper) {
				if (typeof serviceName !== 'string' || serviceName === '') throw new Error('api.service.wrap: serviceName 必须是非空字符串');
				if (typeof wrapper !== 'function') throw new Error('api.service.wrap: wrapper 必须是函数');
				return host.wrapService(name, serviceName, wrapper);
			}
		},

		/** 逃生舱：cordis 上下文直通。 */
		get ctx() {
			return host.ctx;
		},

		/** 日志（debug 级别受 dsh-kubejs.debug 配置控制）。 */
		log: {
			info: (...args) => host.log.info(logPrefix, ...args),
			warn: (...args) => host.log.warn(logPrefix, ...args),
			error: (...args) => host.log.error(logPrefix, ...args),
			debug: (...args) => host.log.debug(logPrefix, ...args)
		},

		/** 通知宿主面板/用户（notify 渠道，尽力而为）。 */
		notify(message, level = 'info') {
			host.notify(name, message, level);
		},

		/** 环境探测。 */
		env: Object.freeze({
			plane,
			get debug() {
				return host.debug;
			}
		})
	};

	return api;
}

/**
 * 把管理区块写入 patch.yml 文本（幂等：已存在则整体替换区块）。
 * entries: [{ script, insertYaml }] —— insertYaml 为 YAML 数组条目文本（不含前导 -）。
 */
export function renderPatchBlock(entries) {
	const lines = [PATCH_BLOCK_BEGIN];
	for (const entry of entries) {
		lines.push(`${PATCH_ENTRY_COMMENT}${entry.script}`);
		lines.push(entry.insertYaml);
	}
	lines.push(PATCH_BLOCK_END);
	return lines.join('\n');
}

/** 从 patch.yml 文本中摘出 dsh-kubejs 管理区块，返回 { before, blockBody, after, hasBlock }。 */
export function splitPatchBlock(text) {
	const beginIdx = text.indexOf(PATCH_BLOCK_BEGIN);
	if (beginIdx === -1) return { before: text, blockBody: '', after: '', hasBlock: false };
	const endIdx = text.indexOf(PATCH_BLOCK_END, beginIdx);
	if (endIdx === -1) {
		// 区块未闭合：视为损坏，保留原文并报告
		return { before: text, blockBody: '', after: '', hasBlock: false, broken: true };
	}
	return {
		before: text.slice(0, beginIdx),
		blockBody: text.slice(beginIdx, endIdx + PATCH_BLOCK_END.length),
		after: text.slice(endIdx + PATCH_BLOCK_END.length),
		hasBlock: true
	};
}
