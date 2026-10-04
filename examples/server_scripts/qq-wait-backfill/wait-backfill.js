/**
 * qq-wait-backfill：修复 qq-bridge「回复/思考期间到达的消息在 qq_wait_for_messages 里看不到」。
 *
 * 根因（qq-bridge/src/bridge.js:5674）：
 *   const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent'))
 *     ? readThroughSeqV2(st)   // 模型已见水位
 *     : requestSeq;            // = st.lastUnreadSeq，裸到达水位
 * messages/缺省分支用的是裸到达水位，而 appendSocialV2Message（bridge.js:9026）在消息一到
 * 就 `st.lastUnreadSeq = msg.seq`。于是「模型读完快照 → 思考 → 发言」这段时间到达的消息
 * 既不算 arrived（5701），也不进 newMessages（5771），必须再调一次 qq_get_unread_messages
 * 才看得到。即使该次 wait 后来等到了更新的消息（arrived=true），更早那条仍然漏掉。
 *
 * 本脚本不改 qq-bridge 源码，只在 DSH 侧给 wait 的返回值打补丁：
 *   挂 tools/post-execute → 截 mcp__snowluma__qq_wait_for_messages
 *   → 拿返回里的 readThroughSeq（模型已见水位）去 GET /api/socialV2/unread?afterSeq=<水位>
 *   → 取回「模型确实没见过」的未读，按桥接的模型视图压缩后并入 newMessages
 *   → 同步修正 readThroughSeq / unreadCount / arrived / quiet / timeout / 睡前观察位。
 *
 * 安全约束：
 *   - 只在真的取到漏掉的消息时改写，其余情况原样返回内建决策（不碰任何字段）。
 *   - 任何异常都只记日志并放弃改写：post-execute 的 listener 抛错会把整次工具调用变成
 *     isError（dsh-tools lib/index.js:3256），那比不改还糟。
 *   - 只改 content，不碰 value（value 走 schema 重校验，且模型只看 content）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATS_PATH = join(HERE, 'stats.json');

const WAIT_TOOL = 'mcp__snowluma__qq_wait_for_messages';
const BRIDGE_ROOT = 'E:/Documents/deepseek-harness/default-workspace/qq-bridge';
const DEFAULT_PORT = 3100;
const CONFIG_TTL_MS = 30_000;

// 与桥接 socialV2.wait 的内建默认值对齐（qq-bridge/src/bridge.js:5642-5665）
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_QUIET_MS = 10_000;

export function activate(api) {
	api.log.info('qq-wait-backfill 已激活（给 qq_wait_for_messages 补回未展示的新消息）');

	const stats = { activatedAt: new Date().toISOString(), waits: 0, backfills: 0, backfilledMessages: 0, errors: 0 };

	api.on('tools/post-execute', async (payload, next) => {
		const decision = await next(); // 先跑内建逻辑（默认 { kind: 'accept' }）
		try {
			// cordis waterfall 的多参形态在 kubejs 桥里被包成数组（host.js:112-115）
			const [exec, result] = Array.isArray(payload) ? payload : [payload];
			if (exec?.name !== WAIT_TOOL) return undefined;
			if (decision?.kind !== 'accept') return undefined;
			stats.waits += 1;

			const patched = await patchWaitResult(exec, result, api);
			if (!patched) {
				writeStats();
				// 透传必须是 undefined：kubejs 的 emitAsync（host.js:147-166）把「返回值非 undefined」
				// 当作「本脚本替换了决策」，会把这个对象当成 payload 传给后面的脚本 handler，
				// 也会让桥接跳过 next() —— 不改写时绝不能碰。
				return undefined;
			}
			stats.backfills += 1;
			stats.backfilledMessages += patched.count;
			writeStats();
			api.log.info(`qq-wait-backfill: 补回 ${patched.count} 条未展示消息（${patched.key}）`);
			return { ...decision, content: patched.content };
		} catch (error) {
			stats.errors += 1;
			stats.lastError = String(error?.stack ?? error);
			writeStats();
			api.log.warn(`qq-wait-backfill 处理失败（保持原返回）: ${error?.message ?? error}`);
			return undefined;
		}
	});

	function writeStats() {
		try {
			writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf8');
		} catch {
			/* 观测文件写不了不影响主流程 */
		}
	}

	/**
	 * 读出 wait 返回的 JSON，补回模型没见过的未读，返回新的 content 与补回条数。
	 * 不需要补时返回 null（调用方原样透传内建决策）。
	 */
	async function patchWaitResult(exec, result, api) {
		const blocks = Array.isArray(result?.content) ? result.content : null;
		const textIndex = blocks ? blocks.findIndex((b) => b && b.type === 'text' && typeof b.text === 'string') : -1;
		if (textIndex < 0) return null;
		let data;
		try {
			data = JSON.parse(blocks[textIndex].text);
		} catch {
			return null; // 不是桥接的 JSON（或换了格式），不冒险
		}
		if (!data || data.ok !== true || data.paused === true) return null;

		const args = exec?.arguments ?? {};
		const key = String(args.key ?? '');
		const token = String(args.token ?? '');
		if (!key || !token) return null;
		const seen = Number.isSafeInteger(data.readThroughSeq) ? data.readThroughSeq : null;
		if (seen === null) return null;

		const probe = await getUnread(api, key, token, seen);
		if (!probe || probe.ok !== true) return null;
		const missed = (Array.isArray(probe.messages) ? probe.messages : [])
			.filter((m) => m && !m.isSelf && Number.isSafeInteger(m.seq) && m.seq > seen)
			.map(compactModelMessage);
		if (!missed.length) return null;

		const replyWait = data.purpose === 'reply';
		const quietMs = Math.max(0, Number(data.quietMs) || 0);
		const delivered = (Array.isArray(data.newMessages) ? data.newMessages : []).filter((m) => m && Number.isSafeInteger(m.seq));
		const merged = [...new Map([...delivered, ...missed].map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);

		// 静默/超时位按同一套语义重算：quiet = 最后一条新消息之后已安静够 quietMs
		const times = merged.map((m) => Number(m.time)).filter((t) => Number.isFinite(t) && t > 0);
		const lastNewAt = times.length ? Math.max(...times) : 0;
		const quiet = (replyWait || (quietMs > 0)) && lastNewAt > 0 && Date.now() - lastNewAt >= quietMs;
		const effectiveTimeoutMs = clampTimeout(args.timeoutMs, readConfig().wait);

		const patched = {
			...data,
			arrived: true,
			quiet,
			speakerLikelyDone: quiet,
			timeout: replyWait ? !quiet : (quietMs > 0 && !quiet && (Number(data.waitedMs) || 0) >= effectiveTimeoutMs),
			newMessages: merged,
			readThroughSeq: Number.isSafeInteger(probe.readThroughSeq) ? probe.readThroughSeq : seen,
			unreadCount: Number.isSafeInteger(probe.unreadCount) ? probe.unreadCount : data.unreadCount,
			backfilledMessages: missed.length
		};
		// 睡前观察位：这是一次「沉睡前观察尝试」而又真的有没展示过的消息，
		// 就不能再报 preSleepWaitSatisfied=true（"全程没人说话"），改报"观察到了新消息"。
		if (!replyWait && Number(data.preSleepWaitMs) > 0 && effectiveTimeoutMs >= Number(data.preSleepWaitMs)) {
			patched.preSleepWaitSatisfied = false;
			patched.preSleepWaitObserved = true;
		}

		const content = blocks.slice();
		content[textIndex] = { ...content[textIndex], text: JSON.stringify(patched) };
		return { content, count: missed.length, key };
	}
}

/** GET /api/socialV2/unread?afterSeq=<模型已见水位>：取回模型确实没见过的未读（带 token 会同步记账）。 */
async function getUnread(api, key, token, seen) {
	const cfg = readConfig();
	const url = `http://127.0.0.1:${cfg.port}/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=100&afterSeq=${seen}`;
	try {
		const res = await fetch(url, { headers: { 'x-agent-token': token }, signal: AbortSignal.timeout(5000) });
		const json = await res.json().catch(() => null);
		if (!res.ok || !json || json.ok !== true) {
			api.log.debug(`qq-wait-backfill: unread 探测未成功 HTTP ${res.status} ${json?.error ?? ''}`.trim());
			return null;
		}
		return json;
	} catch (error) {
		api.log.debug(`qq-wait-backfill: unread 探测异常 ${error?.message ?? error}`);
		return null;
	}
}

/** 读 qq-bridge 的 config.json（30s TTL 缓存）：控制台端口 + 等待参数。 */
let cfgCache = { at: 0, port: DEFAULT_PORT, wait: {} };
function readConfig() {
	if (Date.now() - cfgCache.at < CONFIG_TTL_MS) return cfgCache;
	const next = { at: Date.now(), port: DEFAULT_PORT, wait: {} };
	try {
		const raw = JSON.parse(readFileSync(join(BRIDGE_ROOT, 'config.json'), 'utf8'));
		next.port = Number(raw.consolePort) || DEFAULT_PORT;
		next.wait = raw.socialV2?.wait ?? {};
	} catch {
		/* 读不到就用默认值（端口 3100） */
	}
	cfgCache = next;
	return cfgCache;
}

function clampTimeout(raw, waitCfg = {}) {
	const minMs = Math.max(100, Number(waitCfg.minMs) || MIN_TIMEOUT_MS);
	const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || MAX_TIMEOUT_MS);
	const wanted = Math.round(Number(raw) || Number(waitCfg.defaultMs) || DEFAULT_TIMEOUT_MS);
	return Math.min(maxMs, Math.max(minMs, wanted));
}

// ---------------------------------------------------------------------------
// 下面两段是 qq-bridge/src/qq-model-view.js 与 src/v2-wait.js 的等价移植：
// 补回的消息必须和桥接自己给模型看的形态一致，否则同一个 newMessages 数组里
// 会混着两种格式（是否压缩过、字段齐不齐都不一样）。
// ---------------------------------------------------------------------------

const DEFAULT_FALSE_FIELDS = new Set(['quoteTargetIsSelf', 'isOwner', 'isSelf', 'hasMedia', 'hasForward']);
const OPTIONAL_FIELDS = new Set(['seq', 'messageId', 'sender', 'userId', 'text', 'plain', 'tail', 'kind', 'ownerLabel', 'media', 'forwardIds', 'nestedForwardIds']);

function isRecord(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isEmpty(value) {
	return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function compactMedia(media, canResolveByMessage) {
	return media.map((item, index) => {
		if (!isRecord(item)) return item;
		const out = { ...item };
		if (canResolveByMessage) {
			delete out.file;
			delete out.url;
			if (out.index == null) out.index = index + 1;
		} else if (out.file === out.url) {
			delete out.file;
		}
		for (const key of ['file', 'url', 'faceId']) {
			if (isEmpty(out[key])) delete out[key];
		}
		return out;
	});
}

function compactModelMessage(message) {
	if (!isRecord(message)) return message;
	const out = { ...message };
	const seenText = new Set();
	for (const key of ['text', 'plain', 'tail']) {
		if (typeof out[key] !== 'string') continue;
		if (seenText.has(out[key])) delete out[key];
		else seenText.add(out[key]);
	}
	for (const key of OPTIONAL_FIELDS) {
		if (isEmpty(out[key])) delete out[key];
	}
	for (const key of DEFAULT_FALSE_FIELDS) {
		if (out[key] === false) delete out[key];
	}
	if (Array.isArray(out.media)) {
		out.media = compactMedia(out.media, Number.isSafeInteger(out.seq) && out.seq > 0);
	}
	return out;
}

const UNFINISHED_TAIL_RE = /(?:你知道|等一下|我跟你讲|其实吧|但是|所以说|然后|那个|就是|我想说|对了|等我|等等|我看看|还有|再说|主要是|毕竟|因为|所以|但是吧|回头|回头说|待会|晚点|等会|再说吧)$/;
const UNFINISHED_PUNCT_RE = /[，、；：,;:]$/;
const FINISHED_TAIL_RE = /[。！？!?…～~]+$/;

/** 与 qq-bridge/src/v2-wait.js:13 的 looksLikeUnfinished 一致（保留给后续按需使用）。 */
export function looksLikeUnfinished(text) {
	const s = String(text ?? '').trim();
	if (!s) return false;
	if (FINISHED_TAIL_RE.test(s)) return false;
	if (UNFINISHED_TAIL_RE.test(s)) return true;
	if (UNFINISHED_PUNCT_RE.test(s)) return true;
	return false;
}
