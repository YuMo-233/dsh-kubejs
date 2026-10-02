/**
 * cachebilling-stats：meow-cachebilling 面板统计行增强（client 槽位示例）。
 *
 * 演示原语② api.slot：向一个既有槽位注册 UI 组件。
 * 组件用纯 DOM（api.require 不可用时退化为 document.createElement），
 * 不与宿主 React 版本耦合。
 */
function activate(api) {
	api.log.info('cachebilling-stats 已激活（示例：面板统计行）');

	api.slot('conversation.session.header.actions', {
		id: 'dsh-kubejs:cachebilling-stats-demo',
		order: -25,
		inject: (sessionId) => ({ available: true, sessionId })
	}, function CacheBillingStatsDemo(props) {
		// 组件可以是任意返回 DOM/React 元素的函数；这里用 ModuleLoader require 的 react
		const react = api.require('react');
		const [clicked, setClicked] = react.useState(false);
		if (props.available === false) return null;
		return react.createElement('span', {
			title: 'dsh-kubejs client 脚本示例（cachebilling-stats）',
			style: { fontSize: '11px', opacity: 0.6, cursor: 'pointer', padding: '2px 6px' },
			onClick: () => setClicked(!clicked)
		}, clicked ? '✓ KJS 示例' : 'KJS 示例');
	});
}
