/**
 * dsh-kubejs tools.js 冒烟测试（不依赖 DSH 运行时）
 * 验证：inspect 只读扫描 / write_script 校验+落盘+路径逃逸拒绝 / check 健康报告
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = join(import.meta.dirname, '..');

// ---- 搭一个假脚本目录（避免污染真实 DSH_HOME） ----
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-kubejs-tools-test-'));
const fakeRoot = join(fakeHome, 'dsh-kubejs');
mkdirSync(join(fakeRoot, 'server_scripts', 'demo-pkg'), { recursive: true });
writeFileSync(join(fakeRoot, 'server_scripts', 'demo-pkg', 'manifest.json'), JSON.stringify({
	target: 'meow-cachebilling'
}), 'utf8');
writeFileSync(join(fakeRoot, 'server_scripts', 'demo-pkg', 'demo.js'), 'export function activate(api) { return api; }\n', 'utf8');

// ---- stub 依赖 ----
// tools.js 现在零外部依赖（裸工具对象，照 liangshen 先例），直接 import 即可。
// scanner.js 的 scriptsRoot() 读 DSH_HOME 环境变量 → 用 env 定向到假目录。

const { createTools } = await import(pathToFileURL(join(repoRoot, 'lib', 'tools.js')).href);

const hostStub = {
	state: { loadedScripts: ['demo-pkg/demo.js'], failed: [], wrapped: [], hooks: 1 },
	failed: new Map(),
	unloadAll: async () => {},
	loadAll: async () => ({ loaded: 1, mismatch: [], disabled: [], invalid: [], failed: [] })
};

const tools = createTools({
	host: hostStub,
	profileName: 'test',
	patchPath: join(fakeHome, 'cordis.patch.yml')
});
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

let pass = 0;
let fail = 0;
function check(name, fn) {
	try {
		fn();
		pass += 1;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		fail += 1;
		console.error(`  ✗ ${name}\n    ${e.message}`);
	}
}

console.log('== tools 冒烟 ==');

// ---- inspect ----
check('inspect: 列出 demo-pkg', async () => {
	const r = await byName.kubejs_inspect.execute({});
	assert.equal(r.profile, 'test');
	const pkg = r.packages.find((p) => p.name === 'demo-pkg');
	assert.ok(pkg, 'demo-pkg 应被扫描到');
	assert.equal(pkg.status, 'ok');
	assert.deepEqual(pkg.scripts, ['demo.js']);
});

// ---- write_script: manifest 校验 ----
check('write_script: 非法 JSON 拒绝', async () => {
	await assert.rejects(
		() => byName.kubejs_write_script.execute({
			plane: 'server_scripts', pkg: 'demo-pkg', file: 'manifest.json', content: '{oops'
		}),
		/manifest\.json 不是合法 JSON/
	);
});

check('write_script: 缺 target 拒绝', async () => {
	await assert.rejects(
		() => byName.kubejs_write_script.execute({
			plane: 'server_scripts', pkg: 'demo-pkg', file: 'manifest.json', content: '{"description":"x"}'
		}),
		/缺必填字段 target/
	);
});

check('write_script: 路径逃逸拒绝', async () => {
	await assert.rejects(
		() => byName.kubejs_write_script.execute({
			plane: 'server_scripts', pkg: '..', file: 'evil.js', content: '1'
		}),
		/不合法|逃逸/
	);
});

check('write_script: 非法 pkg 名拒绝', async () => {
	await assert.rejects(
		() => byName.kubejs_write_script.execute({
			plane: 'server_scripts', pkg: 'a/b', file: 'x.js', content: '1'
		}),
		/不合法/
	);
});

check('write_script: ESM 坏语法拒绝（node --check）', async () => {
	await assert.rejects(
		() => byName.kubejs_write_script.execute({
			plane: 'server_scripts', pkg: 'demo-pkg', file: 'bad.js', content: 'export function activate( {'
		}),
		/语法校验失败|ESM/
	);
});

check('write_script: client 平面禁止 import/export', async () => {
	await assert.rejects(
		() => byName.kubejs_write_script.execute({
			plane: 'client_scripts', pkg: 'demo-pkg', file: 'c.js', content: 'import x from "y";\nactivate(api);'
		}),
		/client_scripts 不支持 import\/export/
	);
});

check('write_script: 合法 ESM 落盘成功', async () => {
	const r = await byName.kubejs_write_script.execute({
		plane: 'server_scripts', pkg: 'demo-pkg', file: 'good.js', content: 'export function activate(api) { return 42; }\n'
	});
	assert.equal(r.ok, true);
	const p = join(fakeRoot, 'server_scripts', 'demo-pkg', 'good.js');
	assert.ok(existsSync(p), 'good.js 应落盘');
	assert.equal(readFileSync(p, 'utf8'), 'export function activate(api) { return 42; }\n');
});

// ---- reload ----
check('reload: 调用 host unload/load', async () => {
	let unloaded = 0;
	let loaded = 0;
	const h = {
		...hostStub,
		unloadAll: async () => { unloaded += 1; },
		loadAll: async () => { loaded += 1; return { loaded: 1 }; }
	};
	const t2 = Object.fromEntries(createTools({ host: h, profileName: 't', patchPath: join(fakeHome, 'p.yml') }).map((x) => [x.name, x]));
	await t2.kubejs_reload.execute({});
	assert.equal(unloaded, 1);
	assert.equal(loaded, 1);
});

// ---- check ----
check('check: 健康报告含 failed/orphans', async () => {
	const h = {
		...hostStub,
		failed: new Map([['bad.js', 'ReferenceError: oops']])
	};
	const t3 = Object.fromEntries(createTools({ host: h, profileName: 't', patchPath: join(fakeHome, 'cordis.patch.yml') }).map((x) => [x.name, x]));
	const r = await t3.kubejs_check.execute({});
	assert.equal(r.ok, false);
	assert.deepEqual(r.failed.map((f) => f.name), ['bad.js']);
});

console.log(`\n== 结果: ${pass} 通过, ${fail} 失败 ==`);

// ---- 清理 ----
rmSync(fakeHome, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
