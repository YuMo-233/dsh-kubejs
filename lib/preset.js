/**
 * 「dsh-kubejs 模式」agent preset 定义构建器。
 *
 * rows 照抄 standard.patch.yml（E:\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-web-app\presets\standard.patch.yml）
 * 的行参数，仅两处不同：
 *  1. persona prefix 换成 dsh-kubejs 纪律文本；
 *  2. 追加一行 dsh-kubejs-tools（指向 lib/tools-row.mjs 的 file URL，kubejs 四工具）。
 * JS 构建而非 YAML（不写解析器），供 index.js 运行时 ctx.agentPresets.register({...}) 使用。
 * YAML 里的 `disabled: !!js <expr>` 在这里直接求值为布尔。
 */
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 计划模式纪律（照抄 standard.patch.yml plan-mode section）。 */
const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`;

/** dsh-kubejs 模式纪律（persona prefix）。 */
const KUBEJS_PERSONA = `You are a dsh-kubejs coding agent powered by the {{model}} model.
dsh-kubejs lets you customize other installed plugins WITHOUT editing their files: modifiers are script packages under dsh-kubejs/{server_scripts,client_scripts}/<pkg>/ (each pkg has manifest.json declaring target + .js scripts) loaded by the dsh-kubejs host plugin.

纪律（必须遵守）：
1. 禁止修改 plugins/ 或 node_modules/ 下任何文件；修改第三方插件功能一律走 dsh-kubejs 脚本。
2. 写脚本前先 kubejs_inspect 了解现状（已有包/失配状态/账本），避免重复造轮子。
3. 新建包 = 先写 manifest.json（target 必填，可选 targetRange/description/profiles/disabled），再写 .js 脚本；脚本之间禁止互相 import。manifest.author 是作者署名，写**真正作者的名字**（郁酱自己的脚本写 YuMo233），不许写工具名或来源插件名（dsh-kubejs 是工具，不是作者）；沿用/改造别人的脚本保留原作者。
4. server_scripts 用 ESM（export function activate(api)），五原语：api.on 事件钩子（waterfall 可改写值）、api.config.override 配置覆写（写 cordis.patch.yml 账本）、api.service.wrap 服务包装（洋葱式）、api.fetch.wrap 全局 fetch 拦截（洋葱式）；client_scripts 的 api.slot 注册 UI 槽位组件。
5. client_scripts 由 new Function 执行，禁止 import/export，用 require() 取依赖（react、@deepseek-ai/dsh-client-ui-primitives 等）。
6. 写完脚本必须调用 kubejs_reload 生效，再用 kubejs_check 确认无失配/失败/孤儿账本条目；失败脚本会被自动隔离，不会拖垮 DSH。
7. 失配检查以包为单位：target 插件未安装或版本不满足 targetRange 时整包禁用并报警，不静默。
8. 需求不清时用 ask_user_question 向用户确认；复杂多步任务用 todo 跟踪；碰红线（改 DSH 本体、删用户数据）必须先问用户。

已知坑（踩过真故障，务必避开）：
A. 往 cordis.patch.yml 写东西时，绝不能出现顶格或缩进的裸 "---" / "..."（YAML 文档分隔符，会把文件劈成多个文档导致 DSH 起不来）。托管区块标记行必须是注释形式 "# --- dsh-kubejs managed BEGIN ---"。
B. manifest.json 必须无 BOM（PowerShell 的 Set-Content 默认加 BOM，会导致 JSON.parse 报 Unexpected token）；用 kubejs_write_script 写，或显式指定 utf8NoBOM。
C. 改 .js 内容用 kubejs_reload 即时生效；但新增/删除/重命名脚本文件属于新 loader entry，必须重启 DSH。
D. 事件钩子：不拥有决策就 return undefined 透传；要改就先 await next() 再 spread 宿主决策，绝不自造决策对象（会顶掉 kind/messages）。`;

/** 标准工具行（与 standard.patch.yml 完全一致的包名与参数）。 */
export function buildPresetPlugins() {
	const plugins = [
		// ---- persona：dsh-kubejs 纪律 ----
		{
			id: 'persona',
			name: '@deepseek-ai/dsh-persona',
			config: { prefix: KUBEJS_PERSONA, suffix: 'Your working directory is {{cwd}}.' }
		},
		// ---- 通用 agent 基建 ----
		{ id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
		// ---- shell（按平台二选一）----
		{ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
		{ id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: process.platform !== 'win32' },
		// ---- 文件 / 搜索 / 任务 ----
		{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
		{ id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
		{ id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
		// ---- skills ----
		{ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
		{ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
		// ---- goal ----
		{ id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
		{ id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
		// ---- 计划模式（isolate realm：planMode）----
		{
			id: 'planning',
			name: 'cordis:group',
			group: true,
			isolate: { planMode: true },
			config: [
				{
					id: 'plan-mode',
					name: '@deepseek-ai/dsh-plan-mode',
					config: { section: PLAN_MODE_SECTION }
				}
			]
		},
		// ---- 压缩（isolate realm：compaction + toolResultPruner）----
		{
			id: 'compaction',
			name: 'cordis:group',
			group: true,
			isolate: { compaction: true, toolResultPruner: true },
			config: [
				{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
				{ id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
				{
					id: 'tool-result-pruner',
					name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
					config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
				}
			]
		},
		// ---- 委派（isolate realm：workflowEngine）----
		{
			id: 'delegation',
			name: 'cordis:group',
			group: true,
			isolate: { workflowEngine: true },
			config: [
				{ id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
				{ id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
				{
					id: 'tool-subagent',
					name: '@deepseek-ai/dsh-tool-subagent',
					config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true, backgroundMode: 'continuable' }
				},
				{
					id: 'tool-subagent-fork',
					name: '@deepseek-ai/dsh-tool-subagent',
					config: { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' }
				},
				{
					id: 'tool-subagent-codex',
					name: '@deepseek-ai/dsh-tool-subagent',
					disabled: true,
					config: { provider: 'codex', toolName: 'subagent_codex', backgroundMode: 'one-shot', maxDepth: 'provider-managed' }
				},
				{
					id: 'tool-subagent-claude-code',
					name: '@deepseek-ai/dsh-tool-subagent',
					disabled: true,
					config: { provider: 'claude-code', toolName: 'subagent_claude_code', backgroundMode: 'one-shot', maxDepth: 'provider-managed' }
				},
				{ id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
				{ id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
				{
					id: 'tool-ralph',
					name: '@deepseek-ai/dsh-tool-ralph',
					disabled: true,
					config: { subagentProvider: 'spawn', maxRounds: 64 }
				}
			]
		},
		// ---- 交互 / 任务清单 / 网络 / 展示 ----
		{ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
		{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
		{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
		{ id: 'present', name: '@deepseek-ai/dsh-tool-present' },
		{ id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true },
		// ---- dsh-kubejs 四工具（行插件，file URL 挂载）----
		{ id: 'dsh-kubejs-tools', name: pathToFileURL(join(here, 'tools-row.mjs')).href }
	];
	return plugins;
}
