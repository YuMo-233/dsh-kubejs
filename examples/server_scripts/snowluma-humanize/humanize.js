/**
 * snowluma-humanize：QQ 回复间隔人性化示例（server 事件钩子）。
 *
 * 机制：挂 qq-bridge 的 agent/pre-step 事件（与 dsh-meow-bili-bridge 同款挂点），
 * 在桥接每次准备回复前注入随机 0.5~2.5s 的“正在输入”延迟感——通过改写事件负载里的
 * delayHint 字段实现（qq-bridge 若支持该字段则采用；不支持则无副作用，仅记录日志）。
 *
 * 演示四原语：
 *   - api.on 事件钩子（waterfall：返回值替换负载）
 *   - api.config.override 配置覆写（示例：声明本脚本的调试开关）
 */
export function activate(api) {
	const MIN_MS = 500;
	const MAX_MS = 2500;

	api.log.info('humanize 脚本已激活（示例：回复间隔人性化）');

	api.on('agent/pre-step', (payload) => {
		const delay = Math.floor(MIN_MS + Math.random() * (MAX_MS - MIN_MS));
		api.log.debug(`agent/pre-step 延迟提示: ${delay}ms`);
		// waterfall：返回新负载（浅拷贝改字段，不动原对象）
		return { ...payload, delayHint: delay };
	});

	// 配置覆写示例：把本脚本的调试开关写进 profile patch.yml 管理区块
	// （真实脚本里通常不需要每次 activate 都写；此处仅为演示账本机制）
	if (api.env.debug) {
		api.config.override('dsh-kubejs.debug', true);
	}
}
