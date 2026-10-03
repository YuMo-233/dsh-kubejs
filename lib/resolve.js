/**
 * dsh-kubejs 目标插件版本解析器。
 *
 * 目标插件不一定能从 profile 的 node_modules 解析到（很多插件是 patch.yml 里
 * 用绝对路径注入的本地包，或者像 qq-bridge 一样根本没有发布成包），所以按三级兜底：
 *   ① Node 解析：createRequire(profile 目录).resolve(`${target}/package.json`)
 *   ② 入口上溯：① 因 package.json 未导出（ERR_PACKAGE_PATH_NOT_EXPORTED）失败时，
 *      解析包入口再逐级上溯找同名 package.json
 *   ③ patch.yml 线索：从 cordis.patch.yml 里捞 `.../<target>/...` 形式的绝对路径，
 *      同样逐级上溯找同名 package.json
 *
 * 返回 { installed, version?, manifestPath?, via? }：
 *   installed=false → 包确实找不到（Node 报 MODULE_NOT_FOUND 且无兜底线索）
 *   installed=true, version 缺失 → 包存在但读不到版本（保持宽松放行 + 提示）
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_UPWARD = 8;
const NOT_FOUND_CODES = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']);

/** 读 package.json 的 version（要求非空字符串）。 */
function readManifestVersion(manifestPath) {
	try {
		const json = JSON.parse(readFileSync(manifestPath, 'utf8'));
		return typeof json.version === 'string' && json.version.trim() !== '' ? json.version.trim() : null;
	} catch {
		return null;
	}
}

function readManifestName(manifestPath) {
	try {
		const json = JSON.parse(readFileSync(manifestPath, 'utf8'));
		return typeof json.name === 'string' ? json.name : null;
	} catch {
		return null;
	}
}

/** 从文件或目录出发逐级上溯，找 name 命中 target 的 package.json。 */
function manifestUpward(startPath, target) {
	let dir = startPath;
	try {
		if (existsSync(dir) && statSync(dir).isFile()) dir = dirname(dir);
	} catch {
		return null;
	}
	for (let i = 0; i < MAX_UPWARD; i++) {
		const candidate = join(dir, 'package.json');
		if (existsSync(candidate)) {
			const manifestName = readManifestName(candidate);
			if (manifestName === target || manifestName === null) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** ① / ② Node 解析：返回 { manifestPath } | { error } | null。 */
function tryNodeResolve(target, anchor) {
	let req;
	try {
		req = createRequire(anchor);
	} catch {
		return null;
	}
	try {
		return { manifestPath: req.resolve(`${target}/package.json`) };
	} catch (error) {
		const code = error?.code;
		if (NOT_FOUND_CODES.has(code)) return { error: code };
		// package.json 未导出：退到入口上溯
		try {
			const entry = req.resolve(target);
			const manifestPath = manifestUpward(entry, target);
			if (manifestPath) return { manifestPath };
		} catch { /* 继续兜底 */ }
		return { error: code ?? 'UNRESOLVED' };
	}
}

/** ③ patch.yml 线索：捞绝对路径里含 <target> 目录的一项，上溯找 manifest。 */
function tryPatchClues(target, patchText) {
	if (typeof patchText !== 'string' || patchText === '') return null;
	const paths = patchText.match(/(?:[A-Za-z]:[\\/]|\/)[^\s'"`,)\]}]+/g) ?? [];
	const needleWin = `${sep}${target}${sep}`;
	const needlePosix = `/${target}/`;
	for (const raw of paths) {
		const normalized = raw.replace(/[\\/]+$/, '');
		if (!normalized.includes(needleWin) && !normalized.includes(needlePosix)) continue;
		const manifestPath = manifestUpward(normalized, target);
		if (manifestPath) return manifestPath;
	}
	return null;
}

/**
 * 创建目标插件解析器。
 * @param {object} opts
 * @param {string} [opts.profileDir] 当前 profile 目录（Node 解析 anchor）
 * @param {string} [opts.patchPath]  cordis.patch.yml 绝对路径（线索兜底）
 * @param {object} [opts.logger]     宿主日志（debug 级）
 * @returns {(target: string) => {installed: boolean, version?: string, manifestPath?: string, via?: string}}
 */
export function createPluginResolver({ profileDir, patchPath, logger } = {}) {
	const anchor = profileDir ? pathToFileURL(join(profileDir, 'package.json')).href : null;
	let patchText = null;
	let patchRead = false;

	const readPatch = () => {
		if (patchRead) return patchText;
		patchRead = true;
		try {
			patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
		} catch {
			patchText = '';
		}
		return patchText;
	};

	return function resolvePlugin(target) {
		if (typeof target !== 'string' || target.trim() === '') return { installed: false };
		const name = target.trim();

		if (anchor) {
			const nodeResult = tryNodeResolve(name, anchor);
			if (nodeResult?.manifestPath) {
				const version = readManifestVersion(nodeResult.manifestPath);
				logger?.debug?.(`[dsh-kubejs] 解析 ${name} → ${nodeResult.manifestPath} (version=${version ?? '未声明'})`);
				return { installed: true, version: version ?? undefined, manifestPath: nodeResult.manifestPath, via: 'node' };
			}
			if (!nodeResult) {
				// anchor 不可用，继续走线索
			}
		}

		const clueManifest = tryPatchClues(name, readPatch());
		if (clueManifest) {
			const version = readManifestVersion(clueManifest);
			logger?.debug?.(`[dsh-kubejs] 线索解析 ${name} → ${clueManifest} (version=${version ?? '未声明'})`);
			return { installed: true, version: version ?? undefined, manifestPath: clueManifest, via: 'patch' };
		}

		return { installed: false };
	};
}
