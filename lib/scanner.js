/**
 * dsh-kubejs 脚本包扫描器。
 *
 * 目录约定：
 *   DSH_HOME/dsh-kubejs/
 *     server_scripts/<包名>/manifest.json + *.js
 *     client_scripts/<包名>/manifest.json + *.js
 *
 * manifest.json:
 *   {
 *     "target": "snowluma",              // 必填：目标插件包名
 *     "targetRange": ">=1.0.0 <2.0.0",   // 可选：目标版本范围（semver 子集）
 *     "description": "...",              // 可选
 *     "author": "...",                   // 可选
 *     "profiles": ["desktop"],           // 可选：仅在这些 profile 生效
 *     "disabled": false                  // 可选：手动禁用整包
 *   }
 *
 * 失配判定以包为单位：target 不在已装插件中，或已装版本不满足 targetRange → 整包 mismatch。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { satisfiesRange, scriptsRoot } from './shared.js';

export const PLANES = ['server_scripts', 'client_scripts'];

/**
 * 扫描脚本根目录，返回所有脚本包信息。
 * @param {object} opts
 * @param {string} [opts.root]        脚本根目录（默认 DSH_HOME/dsh-kubejs）
 * @param {string} [opts.profile]     当前 profile 名（desktop/web/...），用于 profiles 白名单过滤
 * @param {(name: string) => {installed: boolean, version?: string}} [opts.resolvePlugin]
 *        目标插件解析器：包名 -> 是否已装 + 版本
 * @returns {{packages: object[], errors: object[]}}
 */
export function scanPackages(opts = {}) {
	const root = opts.root ?? scriptsRoot();
	const profile = opts.profile;
	const resolvePlugin = opts.resolvePlugin ?? (() => ({ installed: true, version: undefined }));
	const packages = [];
	const errors = [];

	if (!existsSync(root)) {
		return { packages, errors, root };
	}

	for (const plane of PLANES) {
		const planeDir = join(root, plane);
		if (!existsSync(planeDir)) continue;
		let entries = [];
		try {
			entries = readdirSync(planeDir, { withFileTypes: true });
		} catch (error) {
			errors.push({ plane, pkg: null, error: `read dir failed: ${error.message}` });
			continue;
		}
		for (const ent of entries) {
			if (!ent.isDirectory()) continue; // 包必须是目录；散文件不认（避免歧义）
			const pkgDir = join(planeDir, ent.name);
			const pkg = inspectPackage(pkgDir, plane, ent.name, { profile, resolvePlugin });
			packages.push(pkg);
		}
	}
	return { packages, errors, root };
}

/** 检查单个脚本包：manifest 合法性 + 脚本清单 + 失配状态。 */
function inspectPackage(pkgDir, plane, pkgName, { profile, resolvePlugin }) {
	const pkg = {
		plane,                 // server_scripts | client_scripts
		name: pkgName,         // 目录名 = 包名
		dir: pkgDir,
		target: null,
		targetRange: null,
		targetVersion: null,   // 目标插件已装版本（解析不到时为 null）
		description: '',
		author: '',
		profiles: null,        // null = 全部 profile
		disabled: false,
		scripts: [],           // {file, name}
		status: 'ok',          // ok | mismatch | invalid | empty | disabled
		reasons: []            // status != ok 时的原因说明
	};

	// manifest.json 必须存在
	const manifestPath = join(pkgDir, 'manifest.json');
	if (!existsSync(manifestPath)) {
		pkg.status = 'invalid';
		pkg.reasons.push('缺少 manifest.json');
		return pkg;
	}
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		pkg.status = 'invalid';
		pkg.reasons.push(`manifest.json 解析失败: ${error.message}`);
		return pkg;
	}
	if (typeof manifest.target !== 'string' || manifest.target.trim() === '') {
		pkg.status = 'invalid';
		pkg.reasons.push('manifest.target 缺失（必须声明修改的目标插件包名）');
		return pkg;
	}
	pkg.target = manifest.target.trim();
	pkg.targetRange = typeof manifest.targetRange === 'string' ? manifest.targetRange : null;
	pkg.description = typeof manifest.description === 'string' ? manifest.description : '';
	pkg.author = typeof manifest.author === 'string' ? manifest.author : '';
	pkg.profiles = Array.isArray(manifest.profiles) && manifest.profiles.length > 0
		? manifest.profiles
		: null;
	pkg.disabled = manifest.disabled === true;

	// 扫描包内脚本（自动发现，无需声明清单）
	pkg.scripts = listScripts(pkgDir);

	if (pkg.scripts.length === 0) {
		pkg.status = 'empty';
		pkg.reasons.push('包内没有 .js 脚本');
	}

	// 失配检查（以包为单位）
	if (pkg.status === 'ok' || pkg.status === 'empty') {
		const resolved = resolvePlugin(pkg.target) ?? { installed: true };
		pkg.targetVersion = resolved.version ?? null;
		if (!resolved.installed) {
			pkg.status = 'mismatch';
			pkg.reasons.push(`目标插件未安装: ${pkg.target}`);
		} else if (pkg.targetRange && resolved.version && !satisfiesRange(resolved.version, pkg.targetRange)) {
			pkg.status = 'mismatch';
			pkg.reasons.push(`版本失配: 已装 ${resolved.version} 不满足 ${pkg.targetRange}`);
		} else if (pkg.targetRange && !resolved.version) {
			// 包在但没声明 version → 无法判定，放行并提示（宽松处理，避免误杀）
			pkg.reasons.push(`注意: ${pkg.target} 未声明 version，targetRange 未校验`);
		}
	}

	// profile 白名单
	if (profile && pkg.profiles && !pkg.profiles.includes(profile)) {
		if (pkg.status === 'ok') pkg.status = 'disabled';
		pkg.reasons.push(`当前 profile "${profile}" 不在包 profiles 白名单内`);
	}

	if (pkg.disabled && pkg.status === 'ok') {
		pkg.status = 'disabled';
		pkg.reasons.push('manifest.disabled = true（手动禁用）');
	}

	return pkg;
}

/** 列出包内脚本文件（不含 manifest.json，自动发现）。 */
function listScripts(pkgDir) {
	try {
		return readdirSync(pkgDir, { withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith('.js'))
			.map((e) => ({ file: e.name, name: e.name.replace(/\.js$/, '') }));
	} catch {
		return [];
	}
}

/** 读取包 manifest（供单包操作复用）。 */
export function readManifest(pkgDir) {
	return JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf8'));
}

/** 判断给定路径是否为脚本根目录内的合法脚本文件。 */
export function isScriptFileUnder(root, filePath) {
	const resolved = typeof filePath === 'string' ? filePath : '';
	return resolved.startsWith(typeof root === 'string' ? root : String(root))
		&& resolved.endsWith('.js')
		&& existsSync(resolved)
		&& statSync(resolved).isFile();
}

export { dirname };
