/**
 * 空闲看门狗 signal（纯逻辑，无依赖，host/client 通用）。
 *
 * 用途：把「整条请求的墙钟总超时」换成「只在没有字节流动时才触发的空闲超时」。
 * 典型场景——上游 provider 的 openAttempt 用 AbortSignal.timeout(6e4) 一刀切，
 * 持续吐 token 的长思考流也会在第 60s 被误杀；这里产出的 signal 只要还在喂字节
 * （headers 到达 / 每个 chunk 到达）就重新上弦，真正卡死（阈值内无字节）才 abort。
 *
 * 两个阶段的计时：
 *   - 首字节阶段：挂载后 firstByteMs 内没有任何 pulse → abort（连接被接受但永不回头）。
 *   - 空闲阶段：一旦 pulse 过一次，之后每次 pulse 重新计时 idleMs；超过 idleMs 无新
 *     字节 → abort（流停滞）。idleMs 通常远大于 firstByteMs 之间的字节间隔。
 *
 * upstream：可选的外部 AbortSignal（如用户手动 stop）。它 abort 时本 signal 联动 abort，
 * 透传 reason，保证「取消能力」不因换成看门狗而丢失。
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.idleMs=300000]        空闲阶段阈值（逐字节重置）。
 * @param {number} [opts.firstByteMs=60000]    首字节阶段阈值（首个 pulse 前）。
 * @param {AbortSignal} [opts.upstream]        外部取消信号，abort 时联动。
 * @param {() => number} [opts.now]            计时基准（测试注入）。
 * @param {(fn,ms)=>any} [opts.setTimer]       setTimeout 注入。
 * @param {(id)=>void} [opts.clearTimer]       clearTimeout 注入。
 * @returns {{ signal: AbortSignal, pulse: () => void, dispose: () => void,
 *             get state(): { pulses: number, aborted: boolean, phase: string } }}
 */
export function createIdleSignal(opts = {}) {
	const idleMs = Number.isFinite(opts.idleMs) && opts.idleMs > 0 ? opts.idleMs : 3e5;
	const firstByteMs = Number.isFinite(opts.firstByteMs) && opts.firstByteMs > 0 ? opts.firstByteMs : 6e4;
	const now = opts.now ?? (() => Date.now());
	const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));
	const upstream = opts.upstream;

	const controller = new AbortController();
	let timer = null;
	let pulses = 0;
	let disposed = false;
	let phase = 'first-byte';

	function currentBudget() {
		return pulses === 0 ? firstByteMs : idleMs;
	}

	function abort(reason) {
		if (disposed || controller.signal.aborted) return;
		try {
			controller.abort(reason);
		} catch {
			// 某些运行时 abort 需 reason 为特定类型，退化为无参
			controller.abort();
		}
	}

	function arm() {
		if (disposed) return;
		if (timer !== null) clearTimer(timer);
		timer = setTimer(() => {
			timer = null;
			abort(new Error(`idle-signal: no bytes within ${currentBudget()}ms (phase=${phase})`));
		}, currentBudget());
		// Node 定时器默认会让进程保活；看门狗不该阻止事件循环退出。
		if (timer && typeof timer.unref === 'function') timer.unref();
	}

	function pulse() {
		if (disposed || controller.signal.aborted) return;
		pulses += 1;
		phase = 'idle';
		arm();
	}

	function dispose() {
		if (disposed) return;
		disposed = true;
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
		if (upstream) upstream.removeEventListener('abort', onUpstreamAbort);
	}

	function onUpstreamAbort() {
		if (!disposed) abort(upstream.reason);
	}

	if (upstream) {
		if (upstream.aborted) abort(upstream.reason);
		else upstream.addEventListener('abort', onUpstreamAbort, { once: true });
	}

	arm();

	return {
		signal: controller.signal,
		pulse,
		/**
		 * 主动终止本 signal（透传 reason）。用于把「真正的用户取消」转发进看门狗——
		 * 调用方需自行判别 reason（如 AbortSignal.timeout 的 reason.name==='TimeoutError'
		 * 是要被丢弃的墙钟，不应转发；用户 stop 才转发）。
		 */
		abort,
		dispose,
		get state() {
			return { pulses, aborted: controller.signal.aborted, phase };
		}
	};
}

/**
 * 包装 fetch 的 Response：每读到一个 body chunk 就 pulse 看门狗，并保留原
 * status/headers/url 等元信息。body 为 null（无响应体）时直接 onSettle 并原样返回。
 * @param {Response} response
 * @param {() => void} pulse
 * @param {() => void} [onSettle]  流结束（读完 / 出错 / 无 body）时调用一次（用于 dispose 看门狗）。
 * @returns {Response}
 */
export function wrapResponseBody(response, pulse, onSettle) {
	if (!response || typeof response.clone !== 'function') return response;
	if (response.body === null || response.body === undefined) {
		if (typeof onSettle === 'function') {
			try {
				onSettle();
			} catch {}
		}
		return response;
	}
	let settled = false;
	const settle = () => {
		if (settled) return;
		settled = true;
		if (typeof onSettle === 'function') {
			try {
				onSettle();
			} catch {}
		}
	};
	const transform = new TransformStream({
		transform(chunk, controller) {
			try {
				pulse();
			} catch {
				// 看门狗异常绝不影响透传字节
			}
			controller.enqueue(chunk);
		},
		flush() {
			settle();
		},
		// TransformStream 的 writable 侧出错（上游流被取消/报错）时也结算。
		async cancel(reason) {
			settle();
			return reason;
		}
	});
	let piped;
	try {
		piped = response.body.pipeThrough(transform);
	} catch {
		settle();
		return response; // 不支持 pipeThrough 的运行时：放弃包装但不破坏原响应
	}
	// 上游 response.body 出错也会让 piped 出错；catch 住以触发结算，错误仍沿 piped 传播给消费者。
	void piped.catch(settle);
	const wrapped = new Response(piped, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
	// Response 构造器不携带 url/redirected；尽量以可读方式补回（部分运行时为只读，忽略）。
	for (const key of ['url', 'redirected', 'type', 'ok']) {
		if (!(key in wrapped)) {
			try {
				Object.defineProperty(wrapped, key, { value: response[key], configurable: true });
			} catch {
				/* 只读，跳过 */
			}
		}
	}
	return wrapped;
}
