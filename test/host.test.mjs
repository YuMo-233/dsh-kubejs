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
	api.on('agent/pre-step', (data) => {
		data.step = (data.step ?? 0) + 1;
		data.delayHint = 606;
		return data;
	});
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
const ctxStub = {
	config: { get: () => false },
	notify: { send: (o) => hookCalls.push(['notify', o]) },
	// stub 事件注册：直接记录，不发真实事件
	on: (event, handler) => hookCalls.push(['on', event])
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
assert(summary.loaded === 1, `应加载 1 个 server 脚本，实际 ${summary.loaded}`);

// ---- 3. waterfall emit ----
const out = host.emit('agent/pre-step', { step: 1 });
console.log('emit result:', JSON.stringify(out));
assert(out?.step === 2, 'hook 应把 step +1');
assert(out?.delayHint === 606, 'humanize 脚本应注入 delayHint=606');

// ---- 4. 故障隔离：写一个必炸脚本再重载 ----
const badDir = join(root, 'server_scripts', 'zz-bad-example');
mkdirSync(badDir, { recursive: true });
writeFileSync(join(badDir, 'manifest.json'), JSON.stringify({ target: 'demo-target' }));
writeFileSync(join(badDir, 'boom.js'), 'export function activate(api) { throw new Error("boom"); }');
const summary2 = await host.loadAll();
console.log('after bad script:', JSON.stringify({ loaded: summary2.loaded, failed: summary2.failed }));
assert(summary2.failed.some((f) => f.script === 'boom'), 'boom.js 应进入 failed');
rmSync(badDir, { recursive: true, force: true });

console.log('host tests OK');
