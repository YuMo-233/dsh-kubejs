/**
 * 扫描器 + host 离线测试：fixture 脚本目录扫描、脚本加载、故障隔离、waterfall emit。
 * 不依赖 DSH 运行时（ctx 用 stub），也不依赖真实 ~/.dsh/dsh-kubejs（自带 fixture）。
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPackages } from '../lib/scanner.js';
import { createHost } from '../host.js';

// ---- fixture：临时脚本根目录 + 两个示例包 ----
const tmp = mkdtempSync(join(tmpdir(), 'dsh-kubejs-test-'));
const root = join(tmp, 'dsh-kubejs');
process.env.DSH_HOME = tmp; // 满足 shared.scriptsRoot() 的默认路径推导（本测试显式传 root，不受其影响）
mkdirSync(join(root, 'server_scripts', 'demo-server'), { recursive: true });
writeFileSync(join(root, 'server_scripts', 'demo-server', 'manifest.json'), JSON.stringify({
	target: 'demo-target',
	description: '测试 server 包'
}));
writeFileSync(join(root, 'server_scripts', 'demo-server', 'humanize.js'), `
export function activate(api) {
	// 推荐形态：先放行内建逻辑拿决策，再 spread 改写（否则会顶掉 kind/messages）
	api.on('agent/pre-step', async (data, next) => {
		const decision = await next();
		return { ...decision, delayHint: 606 };
	});
}
`);
writeFileSync(join(root, 'server_scripts', 'demo-server', 'passthrough.js'), `
export function activate(api) {
	api.on('demo/passthrough', () => undefined); // 不返回值 = 透传（应转调宿主 next()）
}
`);
mkdirSync(join(root, 'client_scripts', 'demo-client'), { recursive: true });
writeFileSync(join(root, 'client_scripts', 'demo-client', 'manifest.json'), JSON.stringify({
	target: 'demo-target-ui'
}));
writeFileSync(join(root, 'client_scripts', 'demo-client', 'stats.js'), `
function activate(api) {
	api.slot('conversation.session.header.actions', { id: 'demo' }, () => null);
}
`);

// 测试结束清理
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const logs = [];
const logger = {
	info: (...a) => logs.push(['info', ...a]),
	warn: (...a) => logs.push(['warn', ...a]),
	error: (...a) => logs.push(['error', ...a]),
	debug: (...a) => logs.push(['debug', ...a])
};

// ---- 1. 扫描 fixture 目录 ----
const scan = scanPackages({ root, profile: 'desktop' });
console.log('scan root:', scan.root);
for (const p of scan.packages) {
	console.log(`  [${p.status}] ${p.plane}/${p.name} → ${p.target} scripts=${p.scripts?.map((s) => s.file).join(',')}`);
}
assert(scan.packages.length === 2, `应扫到 2 个示例包，实际 ${scan.packages.length}`);
const serverPkg = scan.packages.find((p) => p.plane === 'server_scripts' && p.name === 'demo-server');
const clientPkg = scan.packages.find((p) => p.plane === 'client_scripts' && p.name === 'demo-client');
assert(serverPkg?.status === 'ok', `server 包应 ok，实际 ${serverPkg?.status}: ${serverPkg?.reasons?.join(';')}`);
assert(clientPkg?.status === 'ok', `client 包应 ok，实际 ${clientPkg?.status}: ${clientPkg?.reasons?.join(';')}`);

// 失配检查：resolvePlugin 报未安装 → mismatch
const scanMiss = scanPackages({ root, profile: 'desktop', resolvePlugin: () => ({ installed: false }) });
assert(scanMiss.packages.every((p) => p.status === 'mismatch'), '目标未安装时整包应 mismatch');

// ---- 2. host 加载 server 脚本（stub ctx）----
const hookCalls = [];
const registered = new Map(); // event -> [listener]，模拟宿主 cordis 的钩子表
const ctxStub = {
	config: { get: () => false },
	notify: { send: (o) => hookCalls.push(['notify', o]) },
	// stub 事件注册：登记下来（并返回注销函数），测试里手动派发
	on: (event, listener) => {
		hookCalls.push(['on', event]);
		const list = registered.get(event) ?? [];
		list.push(listener);
		registered.set(event, list);
		return () => {
			const idx = list.indexOf(listener);
			if (idx >= 0) list.splice(idx, 1);
		};
	}
};
// 模拟宿主 cordis 的 waterfall：监听器签名 (payload, next)，不调 next() 即否决整链
const dispatchWaterfall = (event, payload, inner = async () => ({ kind: 'enter' })) => {
	const list = [...(registered.get(event) ?? [])];
	const next = async (...a) => (list.shift() ?? inner)(...(a.length ? a : [payload, next]));
	return next(payload, next);
};
const host = createHost({
	ctx: ctxStub,
	logger,
	profileName: 'desktop',
	patchPath: '', // 测试中脚本不会写账本（debug=false）
	notify: { send: (name, message, level) => logs.push(['notify', name, level, message]) },
	root // 注入 fixture 根目录
});
const summary = await host.loadAll();
console.log('loadAll summary:', JSON.stringify({ loaded: summary.loaded, mismatch: summary.mismatch.length, invalid: summary.invalid.length, failed: summary.failed.length, disabled: summary.disabled.length }));
assert(summary.loaded === 2, `应加载 2 个 server 脚本，实际 ${summary.loaded}`);

// ---- 3. waterfall emit（离线入口）----
const out = await host.emit('agent/pre-step', { step: 1 });
console.log('emit result:', JSON.stringify(out));
assert(out?.step === 1, '离线 next 是恒等：原负载字段应保留');
assert(out?.delayHint === 606, 'humanize 脚本应注入 delayHint=606');

// ---- 3b. 宿主事件桥：脚本钩子经 ctx.on 挂上真事件 ----
assert(host.state.bridges.includes('agent/pre-step'), '宿主桥应登记 agent/pre-step');
assert(host.state.bridges.includes('demo/passthrough'), '宿主桥应登记 demo/passthrough');
assert(hookCalls.some(([kind, event]) => kind === 'on' && event === 'agent/pre-step'), 'ctx.on 应被调用一次');
const bridged = await dispatchWaterfall('agent/pre-step', { step: 1 });
assert(bridged?.delayHint === 606, '经宿主桥派发应拿到脚本改写后的负载');
assert(bridged?.kind === 'enter', '推荐形态必须保住宿主内建决策的 kind（不能被顶掉）');
const passed = await dispatchWaterfall('demo/passthrough', { ok: true });
assert(passed?.kind === 'enter', 'handler 返回 undefined 应转调宿主 next()');
console.log('bridge dispatch:', JSON.stringify({ bridged, passed, bridges: host.state.bridges }));

// ---- 4. 故障隔离：写一个必炸脚本再重载 ----
const badDir = join(root, 'server_scripts', 'zz-bad-example');
mkdirSync(badDir, { recursive: true });
writeFileSync(join(badDir, 'manifest.json'), JSON.stringify({ target: 'demo-target' }));
writeFileSync(join(badDir, 'boom.js'), 'export function activate(api) { throw new Error("boom"); }');
const summary2 = await host.loadAll();
console.log('after bad script:', JSON.stringify({ loaded: summary2.loaded, failed: summary2.failed }));
assert(summary2.failed.some((f) => f.script === 'boom'), 'boom.js 应进入 failed');
assert(registered.get('agent/pre-step')?.length === 1, '重载后宿主桥应摘除重建，不留重复监听器');
assert(host.state.bridges.length === 2, '重载后桥数应稳定为 2');
rmSync(badDir, { recursive: true, force: true });

// ---- 5. 改脚本后重载必须拿到新代码（ESM 按 URL 缓存，裸 import 会静默跑旧代码）----
await new Promise((r) => setTimeout(r, 20)); // 保证 mtime 变化
writeFileSync(join(root, 'server_scripts', 'demo-server', 'humanize.js'), `
export function activate(api) {
	api.on('agent/pre-step', async (data, next) => {
		const decision = await next();
		return { ...decision, delayHint: 707 };
	});
}
`);
const summary3 = await host.loadAll();
assert(summary3.loaded === 2, '重载后仍应加载 2 个 server 脚本');
const out2 = await host.emit('agent/pre-step', { step: 1 });
console.log('after script edit:', JSON.stringify(out2));
assert(out2?.delayHint === 707, '改脚本后重载应执行新代码（缓存击穿失效）');

console.log('host tests OK');
