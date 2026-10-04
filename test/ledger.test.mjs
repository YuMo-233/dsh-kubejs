/**
 * 账本离线单元测试：不依赖 DSH 运行时，直接驱动 lib/patch-ledger.js。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { writeScriptOverrides, readLedger, removeScriptEntries } from '../lib/patch-ledger.js';
import { findBareYamlSeparator } from '../lib/shared.js';

const dir = mkdtempSync(join(tmpdir(), 'kubejs-ledger-'));
const patchPath = join(dir, 'cordis.patch.yml');

// 预置一份“真实风格”的 patch.yml（手写条目 + agent-sync 区块）
writeFileSync(patchPath, `# Your patch layer
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    baseURL: https://api.deepseek.com/anthropic
- id: subagent-model-switch
  name: '@local/dsh-subagent-model-switch'

# --- dsh-agent-sync managed (sync source; edit via agent_sync_* tools) ---
- insert: []
# --- end dsh-agent-sync managed ---
`);

// 1. 追加两个脚本的覆写
writeScriptOverrides(patchPath, 'scriptA', [
	{ path: 'llm-deepseek.config.baseURL', value: 'https://mirror.example.com/v1' },
	{ path: 'dsh-kubejs.debug', value: true }
]);

// 2. 回读
const ledger1 = readLedger(patchPath);
assert(ledger1.length === 2, `应有 2 条账目，实际 ${ledger1.length}`);
assert(ledger1[0].script === 'scriptA');

// 3. 新脚本追加、旧脚本摘除
writeScriptOverrides(patchPath, 'scriptB', [{ path: 'ui-chat.config.transcriptView', value: 'detailed' }]);
removeScriptEntries(patchPath, 'scriptA');

// 4. 结果校验
const finalText = readFileSync(patchPath, 'utf8');
assert(finalText.includes('# script:scriptB'), 'scriptB 条目应存在');
assert(!finalText.includes('# script:scriptA'), 'scriptA 条目应被摘除');
assert(!finalText.includes('mirror.example.com'), 'scriptA 摘除后其覆写值应消失');
assert(finalText.includes('detailed'), 'scriptB 覆写值应写入');
assert(finalText.includes('dsh-agent-sync managed'), '手写区块应保留');
assert(finalText.includes("name: '@local/dsh-subagent-model-switch'"), '手写条目应保留');

// 5. 写盘闸门：区块之外有裸 --- 时拒绝写盘，且原文件一个字节都不动
const guardPath = join(dir, 'guard.yml');
writeFileSync(guardPath, `# Your patch layer
- id: keep-me
  config:
    a: 1

---
- id: someone-broke-it
  config:
    b: 2
`);
const beforeGuard = readFileSync(guardPath, 'utf8');
let guardError = null;
try {
	writeScriptOverrides(guardPath, 'scriptC', [{ path: 'keep-me.config.c', value: 3 }]);
} catch (e) {
	guardError = e;
}
assert(guardError, '区块外存在裸 --- 时必须抛错拒绝写盘');
assert(/拒绝写入/.test(guardError.message), `错误信息应说明拒绝写入，实际: ${guardError.message}`);
assert(/第 6 行/.test(guardError.message), `应报出裸 --- 的行号，实际: ${guardError.message}`);
assert.equal(readFileSync(guardPath, 'utf8'), beforeGuard, '拒绝写盘时原文件必须一个字节都不变');
assert(!readFileSync(guardPath, 'utf8').includes('scriptC'), '拒绝写盘时绝不能留下新写入的内容');

// 手工修好（加 # 前缀）后应能正常写入
writeFileSync(guardPath, beforeGuard.replace(/^---$/m, '# ---'));
writeScriptOverrides(guardPath, 'scriptC', [{ path: 'keep-me.config.c', value: 3 }]);
const healed = readFileSync(guardPath, 'utf8');
assert(healed.includes('# script:scriptC'), '修好后应能正常写入');
assert(healed.includes('c: 3'), '修好后覆写值应写入');
assert.equal(findBareYamlSeparator(healed), null, '写入结果不应含裸分隔符');

// 闸门函数本身：各种形态的裸分隔符都要认，注释行不算
assert(findBareYamlSeparator('# --- ok ---') === null, '注释行不算违规');
assert(findBareYamlSeparator('---')?.line === 1, '顶格 --- 应认');
assert(findBareYamlSeparator('  --- ')?.line === 1, '缩进 --- 应认');
assert(findBareYamlSeparator('--- dsh-kubejs managed BEGIN ---')?.line === 1, '裸标记行应认');
assert(findBareYamlSeparator('...')?.line === 1, '文档结束符 ... 应认');
assert(findBareYamlSeparator('----') === null, '四个横杠不是分隔符，不应误报');
assert(findBareYamlSeparator('a: ---') === null, '值里含 --- 不应误报');

console.log('ledger tests OK');
console.log('--- final patch.yml ---');
console.log(finalText);
rmSync(dir, { recursive: true, force: true });
