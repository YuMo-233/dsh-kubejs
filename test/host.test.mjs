/**
 * 扫描器 + host 离线测试：真实脚本目录扫描、脚本加载、故障隔离、waterfall emit。
 * 不依赖 DSH 运行时（ctx 用 stub）。
 */
import assert from 'node:assert';
import { scanPackages } from '../lib/scanner.js';
import { createHost } from '../host.js';
import { scriptsRoot } from '../lib/shared.js';

const logs = [];
const logger = {
	info: (...a) => logs.push(['info', ...a]),
	warn: (...a) => logs.push(['warn', ...a]),
	error: (...a) => logs.push(['error', ...a]),
	debug: (...a) => logs.push(['debug', ...a])
};

// ---- 1. 扫描真实脚本目录 ----
const scan = scanPackages({ profile: 'desktop' });
console.log('scan root:', scan.root);
for (const p of scan.packages) {
	console.log(`  [${p.status}] ${p.plane}/${p.name} → ${p.target} scripts=${p.scripts?.map((s) => s.file).join(',')}`);
}
assert(scan.packages.length >= 2, '至少扫到 2 个示例包');
const serverPkg = scan.packages.find((p) => p.plane === 'server_scripts' && p.name === 'snowluma-humanize');
const clientPkg = scan.packages.find((p) => p.plane === 'client_scripts' && p.name === 'cachebilling-stats');
assert(serverPkg?.status === 'ok', `server 包应 ok，实际 ${serverPkg?.status}: ${serverPkg?.reasons?.join(';')}`);
assert(clientPkg?.status === 'ok', `client 包应 ok，实际 ${clientPkg?.status}: ${clientPkg?.reasons?.join(';')}`);

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
	notify: { send: (name, message, level) => logs.push(['notify', name, level, message]) }
});
const summary = await host.loadAll({ profile: 'desktop' });
console.log('loadAll summary:', JSON.stringify({ loaded: summary.loaded, mismatch: summary.mismatch.length, invalid: summary.invalid.length, failed: summary.failed.length, disabled: summary.disabled.length }));
assert(summary.loaded >= 1, `至少加载 1 个 server 脚本，实际 ${summary.loaded}`);

// ---- 3. waterfall emit ----
const out = host.emit('agent/pre-step', { step: 1 });
console.log('emit result:', JSON.stringify(out));
assert(out?.delayHint >= 500 && out?.delayHint <= 2500, 'humanize 脚本应注入 delayHint 500~2500');

// ---- 4. 故障隔离：写一个必炸脚本再重载 ----
const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const badDir = join(scriptsRoot(), 'server_scripts', 'zz-bad-example');
mkdirSync(badDir, { recursive: true });
writeFileSync(join(badDir, 'manifest.json'), JSON.stringify({ target: 'dsh' }));
writeFileSync(join(badDir, 'boom.js'), 'export function activate(api) { throw new Error("boom"); }');
const summary2 = await host.loadAll({ profile: 'desktop' });
console.log('after bad script:', JSON.stringify({ loaded: summary2.loaded, failed: summary2.failed }));
assert(summary2.failed.some((f) => f.script === 'boom'), 'boom.js 应进入 failed');
rmSync(badDir, { recursive: true, force: true });

console.log('host tests OK');
