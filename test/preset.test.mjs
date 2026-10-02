/**
 * dsh-kubejs 模式 preset 构建冒烟测试（不依赖 DSH 运行时）
 * 验证：
 *  1. buildPresetPlugins() rows 结构完整（标准工具行 + isolate 分组 + kubejs 工具行）
 *  2. dsh-kubejs-tools 行指向真实存在的 tools-row.mjs file URL
 *  3. tools-row.mjs 的 apply(ctx) 能从 kubejsHost 服务装配并注册 4 个 kubejs_* 工具
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

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

console.log('== preset 构建冒烟 ==');

const { buildPresetPlugins } = await import('../lib/preset.js');
const rows = buildPresetPlugins();

// ---- 结构断言 ----
check('rows 非空且含标准工具行', () => {
	assert.ok(Array.isArray(rows) && rows.length >= 20);
	const ids = new Set(rows.map((r) => r.id));
	for (const must of ['persona', 'agent-instructions', 'tool-fs', 'tool-fs-search', 'tool-jobs',
		'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal', 'planning', 'compaction',
		'delegation', 'tool-ask-user', 'tool-todo', 'tool-web', 'present', 'dsh-kubejs-tools']) {
		assert.ok(ids.has(must), `缺行: ${must}`);
	}
});

check('persona prefix 含 dsh-kubejs 纪律、suffix 含 cwd 模板', () => {
	const persona = rows.find((r) => r.id === 'persona');
	assert.equal(persona.name, '@deepseek-ai/dsh-persona');
	assert.match(persona.config.prefix, /dsh-kubejs/);
	assert.match(persona.config.prefix, /kubejs_inspect/);
	assert.match(persona.config.prefix, /禁止修改 plugins\/ 或 node_modules\//);
	assert.equal(persona.config.suffix, 'Your working directory is {{cwd}}.');
});

check('shell 行按平台 disable（win32: bash 禁 / pwsh 启）', () => {
	const bash = rows.find((r) => r.id === 'tool-bash');
	const pwsh = rows.find((r) => r.id === 'tool-pwsh');
	assert.equal(bash.disabled, process.platform === 'win32');
	assert.equal(pwsh.disabled, process.platform !== 'win32');
});

check('isolate 分组三件套齐全', () => {
	const groups = rows.filter((r) => r.name === 'cordis:group');
	const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
	assert.equal(byId.planning.isolate.planMode, true);
	assert.deepEqual(byId.compaction.isolate, { compaction: true, toolResultPruner: true });
	assert.deepEqual(byId.delegation.isolate, { workflowEngine: true });
	for (const g of groups) {
		assert.equal(g.group, true);
		assert.ok(Array.isArray(g.config) && g.config.length > 0, `${g.id} 组 config 应为行数组`);
	}
});

check('kubejs 工具行 = 存在的 file URL（tools-row.mjs）', () => {
	const row = rows.find((r) => r.id === 'dsh-kubejs-tools');
	assert.ok(row, '缺 dsh-kubejs-tools 行');
	assert.match(row.name, /^file:\/\//);
	const p = fileURLToPath(row.name);
	assert.ok(existsSync(p), `file URL 指向不存在的文件: ${p}`);
	assert.ok(p.endsWith('tools-row.mjs'));
});

// ---- 行插件装配冒烟 ----
const { name, inject, apply } = await import('../lib/tools-row.mjs');

check('tools-row.mjs 导出形状（name/inject/apply）', () => {
	assert.equal(name, 'dsh-kubejs-tools-row');
	assert.deepEqual(inject, ['tools', 'kubejsHost']);
	assert.equal(typeof apply, 'function');
});

check('apply 注册 4 个 kubejs_* 工具', async () => {
	const registered = [];
	const svc = {
		kubejsHost: {
			host: {
				state: { loadedScripts: [], failed: [], wrapped: [], hooks: 0 },
				failed: new Map(),
				unloadAll: async () => {},
				loadAll: async () => ({})
			},
			profileName: 'test',
			patchPath: 'unused.yml'
		}
	};
	const fakeCtx = {
		console: console,
		inject(names, cb) { cb(svc); },
		tools: { register(t) { registered.push(t); } }
	};
	apply(fakeCtx);
	await new Promise((r) => setImmediate(r)); // inject 回调同步执行，保险让出微任务
	const names = registered.map((t) => t.name).sort();
	assert.deepEqual(names, ['kubejs_check', 'kubejs_inspect', 'kubejs_reload', 'kubejs_write_script']);
	for (const t of registered) {
		assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`);
		assert.ok(t.parameters?.type === 'object', `${t.name} parameters 应为 JSON schema`);
		assert.equal(typeof t.output?.render, 'function', `${t.name} 缺 output.render`);
	}
	// 抽查一次真实执行
	const inspect = registered.find((t) => t.name === 'kubejs_inspect');
	const result = await inspect.execute({});
	assert.equal(result.profile, 'test');
	assert.ok(Array.isArray(result.packages));
});

console.log(`\n== 结果: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail > 0 ? 1 : 0);
