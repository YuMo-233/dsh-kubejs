/**
 * 账本离线单元测试：不依赖 DSH 运行时，直接驱动 lib/patch-ledger.js。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { writeScriptOverrides, readLedger, removeScriptEntries } from '../lib/patch-ledger.js';

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

console.log('ledger tests OK');
console.log('--- final patch.yml ---');
console.log(finalText);
rmSync(dir, { recursive: true, force: true });
