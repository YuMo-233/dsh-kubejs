/**
 * dsh-kubejs 模式行插件：把 kubejs 四工具注册进 preset scope 的 tools registry。
 *
 * 这是一个标准 cordis 行插件（照 liangshen tool-activate.mjs 先例）：
 *   export const name / export const inject / export function apply(ctx)
 *
 * 依赖：
 *  - 'tools'      ：host tools registry（preset scope 可解析，见 liangshen 注释——纯注册行无需 isolate realm）
 *  - 'kubejsHost' ：主插件 ctx.provide 的复合服务 { host, profileName, patchPath }
 *
 * 以 file URL 被 DSH loader 挂载；tools.js 及其子模块均为零外部依赖（仅 node 内置 + 相对导入）。
 */
import { createTools } from './tools.js';

export const name = 'dsh-kubejs-tools-row';

export const inject = ['tools', 'kubejsHost'];

export function apply(ctx) {
	// ctx.logger 是 cordis 内置服务；ctx.console 之类未提供属性会让 Proxy 直接抛错，不要写。
	const logger = ctx.logger;

	ctx.inject(['kubejsHost'], (svc) => {
		const { host, profileName, patchPath } = svc.kubejsHost;
		for (const tool of createTools({ host, profileName, patchPath })) {
			ctx.tools.register(tool);
		}
		logger.info?.('[dsh-kubejs] 模式工具已注册（kubejs_inspect / write_script / reload / check）');
	});
}
