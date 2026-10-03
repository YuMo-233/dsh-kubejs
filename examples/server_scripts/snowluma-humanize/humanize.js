/**
 * snowluma-humanize：事件钩子示例（server 平面）。
 *
 * 挂点：DSH 的 agent/pre-step waterfall —— 每步开始前放行宿主内建逻辑（await next()），
 * 再把决策原样返回。脚本只做"观察"，不干扰 agent 循环。
 *
 * waterfall 语义纪律：
 *   - handler 签名 (payload, next)；返回 undefined = 完全透传（等价于没挂这个钩子）
 *   - 返回值会替换这一步的决策对象，所以想改必须 spread 内建决策，不能自造对象
 *     （自造会顶掉 { kind: 'enter', messages }，agent 循环会拿到缺字段的决策）
 *
 * 想做节奏控制（例如给回复加"正在输入"停顿）就在 await next() 之后插入 await sleep()；
 * 那是真的拖慢每一步，按需开。本示例默认只记录。
 *
 * 演示原语：
 *   - api.on(event, handler)  事件钩子（见上）
 *   - api.config.override     配置覆写（写进 profile 托管区块，带账本可摘除）
 */
export function activate(api) {
	let hits = 0;

	api.log.info('humanize 脚本已激活（示例：观察 agent/pre-step）');

	api.on('agent/pre-step', async (payload, next) => {
		const decision = await next(); // 先放行内建逻辑，拿到 { kind, messages }
		hits += 1;
		if (hits === 1) api.log.info('humanize: 首次命中 agent/pre-step（事件钩子已生效）');
		api.log.debug(`agent/pre-step #${hits} step=${payload?.step ?? '?'} kind=${decision?.kind}`);
		return decision; // 原样返回：不改任何行为
	});

	// 配置覆写示例：声明本脚本的调试开关（写进 profile patch.yml 托管区块）
	if (api.env.debug) {
		api.config.override('dsh-kubejs.debug', true);
	}
}
