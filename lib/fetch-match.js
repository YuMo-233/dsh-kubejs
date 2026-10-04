/**
 * fetch 拦截规则的作用域匹配（纯函数，无依赖，便于单测）。
 *
 * matcher 形态：
 *   - 函数 (info) => boolean            —— 自由判定，info 见 normalizeRequest。
 *   - 对象 { urlIncludes, urlRegex, method, headers }  —— 声明式：
 *       urlIncludes: string，URL 包含该子串即命中；
 *       urlRegex:    string（正则源），new RegExp(urlRegex).test(url) 命中；
 *       method:      string，忽略大小写比较（缺省不限）；
 *       headers:     { name: value }，请求头 name 存在（value 为 true/省略）
 *                    或等于 value 即命中（多个键需全部满足）。
 *   - 省略 / '*'  —— 匹配一切请求（慎用）。
 */

/**
 * 把 fetch(input, init) 归一成 { url, method, headers, signal, init, input }。
 * input 可为 string / URL / Request；headers 统一成可读的 get(name) 视图。
 * init 是对原始 init 的浅拷贝（原始缺省则新建 {}），供拦截脚本安全改写 signal/method 等
 * 而不污染调用方对象；框架代发时用的就是这份可变 init。
 * @param {any} input
 * @param {any} init
 * @returns {{ url: string, method: string, headers: Headers|MapLike, signal: AbortSignal|undefined,
 *             input: any, init: any }}
 */
export function normalizeRequest(input, init) {
	const url =
		typeof input === 'string' || input instanceof URL
			? String(input)
			: input && typeof input === 'object' && typeof input.url === 'string'
				? input.url
				: String(input);
	const methodFromInput = input && typeof input === 'object' && typeof input.method === 'string' ? input.method : 'GET';
	const method = (init && init.method) || methodFromInput;
	const headers = resolveHeaders(input, init);
	const signal = (init && 'signal' in init ? init.signal : undefined) ?? (input && typeof input === 'object' ? input.signal : undefined);
	// 可变浅拷贝：原始 init 缺省或非对象时给 {}，供 handler 改写。
	const mutableInit = init && typeof init === 'object' ? { ...init } : {};
	if (signal !== undefined && !('signal' in mutableInit)) mutableInit.signal = signal;
	return { url, method, headers, signal, input, init: mutableInit };
}

function resolveHeaders(input, init) {
	const raw =
		(init && init.headers) ??
		(input && typeof input === 'object' && input.headers ? input.headers : undefined);
	const view = new Map();
	if (!raw) return { get: (k) => view.get(String(k).toLowerCase()) };
	try {
		if (typeof raw.forEach === 'function') {
			raw.forEach((value, key) => view.set(String(key).toLowerCase(), value));
		} else if (typeof raw[Symbol.iterator] === 'function') {
			for (const pair of raw) view.set(String(pair[0]).toLowerCase(), pair[1]);
		} else {
			for (const key of Object.keys(raw)) view.set(key.toLowerCase(), raw[key]);
		}
	} catch {
		/* 结构异常：保留空视图，规则退化为不依赖 header */
	}
	return { get: (k) => view.get(String(k).toLowerCase()) };
}

/**
 * 判定一条 matcher 是否命中归一后的请求。
 * @param {Function|object|undefined|null|'*'} matcher
 * @param {{url:string, method:string, headers:{get:(k:string)=>any}}} info
 * @returns {boolean}
 */
export function matchRequest(matcher, info) {
	if (matcher === undefined || matcher === null || matcher === '*') return true;
	if (typeof matcher === 'function') {
		try {
			return Boolean(matcher(info));
		} catch {
			return false;
		}
	}
	if (typeof matcher !== 'object') return false;
	if (typeof matcher.urlIncludes === 'string' && !info.url.includes(matcher.urlIncludes)) return false;
	if (typeof matcher.urlRegex === 'string') {
		let re;
		try {
			re = new RegExp(matcher.urlRegex);
		} catch {
			return false;
		}
		if (!re.test(info.url)) return false;
	}
	if (typeof matcher.method === 'string' && String(info.method).toUpperCase() !== matcher.method.toUpperCase()) return false;
	if (matcher.headers && typeof matcher.headers === 'object') {
		for (const key of Object.keys(matcher.headers)) {
			const expected = matcher.headers[key];
			const actual = info.headers.get(key);
			if (actual === undefined) return false;
			if (expected !== true && expected !== undefined && String(actual) !== String(expected)) return false;
		}
	}
	return true;
}
