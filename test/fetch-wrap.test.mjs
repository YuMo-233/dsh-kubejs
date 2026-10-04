/**
 * fetch 拦截内核 + 空闲看门狗离线测试。
 * 不依赖 DSH 运行时，也不碰真实 ~/.dsh/dsh-kubejs（自带 fixture 根目录）。
 * 覆盖：
 *   1. matcher 纯函数（声明式 urlIncludes/method/headers、函数式、'*'）
 *   2. createIdleSignal：首字节超时触发、pulse 重新上弦延长、upstream abort 联动、abort 转发
 *   3. host.fetch：注册规则 → 全局 fetch 被拦 → 命中改写 signal → 未命中透传 native → 卸载还原
 *   4. 洋葱链：两个脚本规则按注册顺序串接，外层 next() 进内层
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../host.js';
import { normalizeRequest, matchRequest } from '../lib/fetch-match.js';
import { createIdleSignal } from '../lib/idle-signal.js';

let tmpRoot = null;
process.on('exit', () => {
	if (!tmpRoot) return;
	try {
		rmSync(tmpRoot, { recursive: true, force: true });
	} catch {}
});

// ---- 1. matcher ----
{
	const info = normalizeRequest('https://x.com/algo/api/v2/service/pro/sse/agent_chat_generation?a=1', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		signal: undefined
	});
	assert(info.url.includes('agent_chat_generation'), 'url 归一');
	assert(info.method === 'POST', 'method 归一');
	assert(matchRequest({ urlIncludes: 'agent_chat_generation' }, info) === true, 'urlIncludes 命中');
	assert(matchRequest({ urlIncludes: 'nope' }, info) === false, 'urlIncludes 不命中');
	assert(matchRequest({ urlRegex: 'sse/.+generation' }, info) === true, 'urlRegex 命中');
	assert(matchRequest({ method: 'post' }, info) === true, 'method 忽略大小写');
	assert(matchRequest({ method: 'GET' }, info) === false, 'method 不匹配');
	assert(matchRequest({ headers: { 'content-type': 'application/json' } }, info) === true, 'header 精确命中');
	assert(matchRequest({ headers: { 'content-type': 'text/plain' } }, info) === false, 'header 值不符');
	assert(matchRequest({ headers: { 'x-absent': true } }, info) === false, 'header 缺失不命中');
	assert(matchRequest('*', info) === true, '星号匹配全部');
	assert(matchRequest((i) => i.url.includes('generation'), info) === true, '函数式命中');
	assert(matchRequest(undefined, info) === true, '省略=匹配全部');
	// init 浅拷贝不污染原对象
	const origInit = { method: 'POST', signal: 'SENTINEL' };
	const nr = normalizeRequest('u', origInit);
	nr.init.signal = 'REPLACED';
	assert(origInit.signal === 'SENTINEL', '改写 request.init 不应污染原始 init');
	assert(nr.signal === 'SENTINEL', '归一读取的 signal 来自原始 init');
}

// ---- 2. createIdleSignal（注入假计时器，确定性） ----
{
	let current = 0;
	const timers = new Set();
	const setTimer = (fn, ms) => {
		const t = { fn, at: current + ms, id: timers.size + 1 };
		timers.add(t);
		return t;
	};
	const clearTimer = (t) => timers.delete(t);
	const tick = (ms) => {
		current += ms;
		for (const t of [...timers]) {
			if (t.at <= current) {
				timers.delete(t);
				t.fn();
			}
		}
	};

	// 2a. 首字节超时：无 pulse，到 firstByteMs 触发
	const a = createIdleSignal({ idleMs: 5000, firstByteMs: 1000, now: () => current, setTimer, clearTimer });
	tick(999);
	assert(!a.signal.aborted, '首字节未到期不 abort');
	tick(2);
	assert(a.signal.aborted && a.state.pulses === 0, '首字节到期 abort');
	a.dispose();

	// 2b. pulse 重新上弦：持续流动则永不超时；停流后到 idleMs 才触发
	current = 0;
	const b = createIdleSignal({ idleMs: 5000, firstByteMs: 1000, now: () => current, setTimer, clearTimer });
	b.pulse(); // 进入 idle 阶段，预算 5000
	for (let i = 0; i < 5; i++) {
		tick(4000); // 每次都在 5000 内再来字节
		b.pulse();
	}
	assert(!b.signal.aborted, '持续流动不应超时（远超单段 idleMs）');
	tick(4999);
	assert(!b.signal.aborted, '空闲未到期');
	tick(2);
	assert(b.signal.aborted, '停流超过 idleMs 触发');
	assert(b.state.pulses === 6, '累计 pulse 次数');
	b.dispose();

	// 2c. upstream abort 联动
	current = 0;
	const up = new AbortController();
	const c = createIdleSignal({ idleMs: 5000, upstream: up.signal, now: () => current, setTimer, clearTimer });
	up.abort(new Error('user stop'));
	assert(c.signal.aborted && c.signal.reason.message === 'user stop', 'upstream abort 透传 reason');
	c.dispose();

	// 2d. abort() 主动转发（脚本用于区分 timeout vs 用户 stop）
	current = 0;
	const d = createIdleSignal({ idleMs: 5000, now: () => current, setTimer, clearTimer });
	d.abort(new Error('forwarded'));
	assert(d.signal.aborted && d.signal.reason.message === 'forwarded', 'idle.abort 转发');
	d.dispose();

	// 2e. dispose 后 pulse 不再上弦、不再触发
	current = 0;
	const e = createIdleSignal({ idleMs: 5000, now: () => current, setTimer, clearTimer });
	e.dispose();
	tick(99999);
	assert(!e.signal.aborted, 'dispose 后定时器已清，不应 abort');
}

// ---- 3 & 4. host.fetch 拦截（fixture 脚本 + stub ctx + 替换 globalThis.fetch） ----
{
	tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-kubejs-fetch-test-'));
	const root = join(tmpRoot, 'dsh-kubejs');
	mkdirSync(join(root, 'server_scripts', 'one'), { recursive: true });
	writeFileSync(join(root, 'server_scripts', 'one', 'manifest.json'), JSON.stringify({ target: 'demo' }));
	// 外层脚本：改 init.signal 标记 + 代发；内层脚本再改一次
	writeFileSync(join(root, 'server_scripts', 'one', 'outer.js'), `
export function activate(api) {
	api.fetch.wrap({ urlIncludes: 'agent_chat_generation' }, async (request, next, helpers) => {
		request.init.signal = 'OUTER';
		const res = await next();
		res.__outer = true;
		return res;
	});
	api.fetch.wrap('*', async (request, next) => {
		request.init.signal = request.init.signal === 'OUTER' ? 'INNER' : 'ONLY_INNER';
		return next();
	});
}
`);

	const captured = [];
	const originalFetch = globalThis.fetch;
	const testStub = async (input, init) => {
		captured.push({ input, init });
		return { ok: true, status: 200, body: null };
	};
	globalThis.fetch = testStub;

	const logs = [];
	const logger = { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]), debug: () => {} };
	const host = createHost({
		ctx: { config: { get: () => false }, on: () => () => {} },
		logger,
		profileName: 'desktop',
		patchPath: '',
		notify: { send: () => {} },
		root
	});
	const summary = await host.loadAll();
	assert(summary.loaded === 1, `应加载 1 个脚本，实际 ${summary.loaded}`);
	assert(host.state.fetchPatched === true, '注册规则后全局 fetch 应被 patch');
	assert(host.state.fetchRules.length === 2, `应登记 2 条规则，实际 ${host.state.fetchRules.length}`);

	// 命中 agent_chat_generation：外层置 OUTER，内层见 OUTER 改 INNER；native 收到 INNER
	const r1 = await globalThis.fetch('https://h/algo/agent_chat_generation', { method: 'POST', signal: 'WALLCLOCK' });
	assert(captured.at(-1).init.signal === 'INNER', `洋葱链最终 signal 应为 INNER，实际 ${captured.at(-1).init.signal}`);
	assert(r1.__outer === true, '外层脚本应改写到 Response');

	// 未命中生成端点但命中 '*' 内层：内层 signal 为 ONLY_INNER
	captured.length = 0;
	await globalThis.fetch('https://h/other', { method: 'GET', signal: 'X' });
	assert(captured.at(-1).init.signal === 'ONLY_INNER', '未命中外层规则时内层 * 仍生效');

	// 卸载：还原全局 fetch，规则清空
	host.unloadAll();
	assert(globalThis.fetch === testStub, 'unloadAll 后全局 fetch 应还原为安装时捕获的 native');
	assert(host.state.fetchRules.length === 0 && host.state.fetchPatched === false, '卸载后无规则、补丁已撤');
	globalThis.fetch = originalFetch;
	rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('fetch-wrap tests OK');
