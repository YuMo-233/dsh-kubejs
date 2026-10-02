/**
 * dsh-kubejs 共享常量与工具（host/client 通用，无依赖）。
 */

/** 脚本根目录：DSH_HOME/dsh-kubejs/（DSH_HOME 注入或默认 ~/.dsh）。 */
export function dshHome() {
	return process.env.DSH_HOME
	?? joinPath(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
}

export const SCRIPTS_DIR_NAME = 'dsh-kubejs';

/** 脚本目录：DSH_HOME/dsh-kubejs */
export function scriptsRoot(home = dshHome()) {
	return joinPath(home, SCRIPTS_DIR_NAME);
}

/** patch.yml 中 dsh-kubejs 管理区块的标记行。 */
export const PATCH_BLOCK_BEGIN = '--- dsh-kubejs managed BEGIN ---';
export const PATCH_BLOCK_END = '--- dsh-kubejs managed END ---';
/** 区块内每条目头的脚本归属注释。 */
export const PATCH_ENTRY_COMMENT = '# script:';

/** 简易路径拼接（避免依赖 node:path 以便 client 复用纯逻辑部分）。 */
export function joinPath(...parts) {
	const joined = parts.filter((p) => p !== '' && p !== undefined && p !== null).join('/')
		.replace(/\\/g, '/');
	// 折叠 a/./b 与 a//b（不处理 ..，本代码库不需要）
	return joined.replace(/\/{2,}/g, '/');
}

/**
 * 极简 semver 范围匹配（支持 ^ ~ >= > < <= = 精确版本 与 空格连接的 AND 组合）。
 * 仅覆盖 dsh-kubejs manifest 的实际用法，不追求完整 semver 规范。
 */
export function satisfiesRange(version, range) {
	if (!range || range === '*' || range.trim() === '') return true;
	const clean = String(version).trim().replace(/^v/i, '');
	const parts = range.split(/\s+/).filter(Boolean);
	return parts.every((clause) => satisfiesClause(clean, clause));
}

function satisfiesClause(version, clause) {
	if (clause === '*') return true;
	const m = clause.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
	if (!m) return false;
	const op = m[1] ?? '=';
	const target = normalize(m[2]);
	const v = normalize(version);
	if (!v || !target) return false;
	const cmp = compareTuple(v, target);
	switch (op) {
		case '>=': return cmp >= 0;
		case '<=': return cmp <= 0;
		case '>': return cmp > 0;
		case '<': return cmp < 0;
		case '=': return cmp === 0;
		case '^': return cmp >= 0 && compareTuple(v, bumpMinor(target)) < 0;
		case '~': return cmp >= 0 && compareTuple(v, bumpPatch(target)) < 0;
		default: return cmp === 0;
	}
}

/** "1.2.3-rc.7" -> [1,2,3]（prerelease 忽略，仅比较主版本元组）。 */
function normalize(version) {
	const m = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareTuple(a, b) {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
	}
	return 0;
}

function bumpMinor(t) { return [t[0], t[1] + 1, 0]; }
function bumpPatch(t) { return [t[0], t[1], t[2] + 1]; }
