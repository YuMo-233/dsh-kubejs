# dsh-kubejs

> DSH 插件修改者 —— 以独立脚本包定制其他已安装插件，**不改任何插件源码**（KubeJS 模式）。

灵感来自 Minecraft 的 KubeJS：你想改别的 mod，不是去改它的源码，而是写一个脚本项目丢进 `kubejs/` 目录。dsh-kubejs 把这套模式带进 DSH：

- **插件（修改者）与脚本（修改）分离**——dsh-kubejs 自身是普通 DSH 插件，只负责加载修改脚本；
- 脚本集中放在独立目录，与插件代码完全隔离，**插件更新、重装都不会丢修改**；
- 脚本按「目标插件」分包声明依赖，目标插件未安装或版本失配时**整包禁用并报警**，绝不静默失效。

## 解决什么问题

让 AI（或你自己）直接修改已安装插件是很脆弱的：

| 直接改插件文件 | 用 dsh-kubejs 脚本 |
|---|---|
| 插件一更新修改即丢失 | 修改独立存放，更新不丢 |
| 改坏会拖垮 DSH 启动 | 脚本异常只禁用自己 + 通知报警 |
| 修改散落各处无法 review | 集中目录 + 统一管理面板 |
| 无法精确回滚配置覆写 | 配置覆写有账本，可精确摘除 |

## 五原语

脚本通过 `activate(api)` 获得五个原语，全部作用于**已存在的东西**：

| 原语 | 作用 | 平面 |
|---|---|---|
| `api.on(event, handler)` | 事件钩子（真实挂在宿主 cordis 事件上；waterfall 语义见下） | server |
| `api.slot(id, props, Component)` | 向 client 槽位注册 UI 组件 | client |
| `api.config.override(path, value)` | 配置覆写（写入 profile cordis.patch.yml 的托管区块，带账本可精确摘除） | server |
| `api.service.wrap(name, wrapper)` | 服务包装（洋葱式，可拦截/增强任意已注册服务） | server |
| `api.fetch.wrap(matcher, handler)` | 全局 fetch 拦截（洋葱式，运行时即时生效，无需重启） | server |

### 事件钩子怎么用

```js
export function activate(api) {
	// 只看不动：返回 undefined 就是完全透传，绝不干扰 DSH
	api.on('agent/pre-step', (payload) => {
		api.log.debug('当前步:', payload.step);
	});

	// 改决策：一定要先 await next() 拿到宿主的内建决策，再 spread 它
	api.on('agent/pre-step', async (payload, next) => {
		const decision = await next();          // { kind: 'enter', messages: [...] }
		return { ...decision, delayHint: 800 };
	});

	// 拦截：不调 next()，直接返回自己的决策（宿主内建逻辑不再执行）
	api.on('tools/pre-execute', (exec) => exec.name === 'kubejs_write_script'
		? { kind: 'cancel', reason: '本会话禁止脚本自我改写' }
		: undefined);
}
```

三条纪律：

1. **不拥有决策就返回 undefined**（透传），别自造对象——自造会顶掉宿主的内建决策字段。
2. **想改就先 `await next()`**，再 spread 它的返回值。
3. **钩子是异步的**，handler 可以是 async；慢 handler 会拖慢事件（这本身就是节奏控制能力）。

逃生舱：`api.ctx` 全量直通（本机信任模型，读状态、钩冷门事件等「读或改」场景用它；**想「造」新东西时请写成独立插件**——脚本的产出是行为差异，插件的产出是可依赖、可分发的东西）。

### fetch 拦截怎么用

```js
export function activate(api) {
	api.fetch.wrap({ urlIncludes: '/v1/chat/completions' }, async (request, next, helpers) => {
		// 把「整条请求一刀切超时」换成「没字节流动才超时」的看门狗
		const idle = helpers.createIdleSignal({ firstByteMs: 60_000, idleMs: 300_000, upstream: request.signal });
		request.init.signal = idle.signal;

		const res = await next();                          // 返回 undefined 则由框架代发
		return helpers.wrapResponseBody(res, idle.pulse, idle.dispose);
	});
}
```

要点：

- `matcher` 三种形态：函数 `(info) => boolean`、声明式 `{ urlIncludes, urlRegex, method, headers }`、省略或 `'*'` 匹配全部（慎用）。
- `request.init` 是**可改写的浅拷贝**：mutate 它的 `signal` / `method` / `headers` 即可改请求，不会污染调用方对象。
- handler 返回 `undefined` = 你没代发，框架按 `request` 当前状态代发；返回 `Response` = 你已代发或自构造。
- `helpers.createIdleSignal(opts)` 内置空闲看门狗：首字节阈值 `firstByteMs`（默认 60s）+ 空闲阈值 `idleMs`（默认 300s，每来一个 chunk 重新上弦），`upstream` 可挂外部取消信号联动。解决「持续吐 token 的长思考流被墙钟总超时误杀」。
- 首次注册时装 `globalThis.fetch` 补丁，最后一条规则移除即还原，**卸载即净**；规则按注册顺序派发。

## 安装

### 方式一：DSH 官方插件管理器（推荐）

在 DSH Desktop 的「插件」面板中输入以下任一地址安装：

```
github:YuMo-233/dsh-kubejs
```

或直接填仓库地址 `https://github.com/YuMo-233/dsh-kubejs`。官方安装器会自动完成拉包、bundles 登记、cordis.patch.yml 注册，装完重启即可。

### 方式二：开发安装（link，改代码即时生效）

```bash
# 1. clone 到任意位置
git clone https://github.com/YuMo-233/dsh-kubejs.git

# 2. junction（或复制）进 DSH profile 的 node_modules
#    Windows:
mklink /J "%DSH_HOME%\profiles\desktop\node_modules\dsh-kubejs" "<clone 路径>"

# 3. 在 profile 的 package.json 里登记
#    dependencies 加：  "dsh-kubejs": "link:<clone 路径>"
#    dsh.profile.bundles 数组加："dsh-kubejs"

# 4. 在 profile 的 cordis.patch.yml 里注册插件
- insert:
    - id: dsh-kubejs
      name: 'dsh-kubejs'

# 5. 重启 DSH Desktop
```

## 脚本目录

脚本不放在插件里，而是放在 DSH 数据目录（默认 `~/.dsh/`）：

```
~/.dsh/dsh-kubejs/
├── server_scripts/          # server 平面：事件钩子 / 配置覆写 / 服务包装（Node 侧，ESM）
│   └── snowluma-humanize/
│       ├── manifest.json    # 声明目标插件
│       └── humanize.js
└── client_scripts/          # client 平面：槽位 UI（浏览器执行，纯脚本体）
    └── cachebilling-stats/
        ├── manifest.json
        └── stats.js
```

**manifest.json**（包的唯一声明入口）：

```json
{
  "target": "qq-bridge",
  "targetRange": ">=1.0.0 <2.0.0",
  "description": "让 snowluma 的回复更有人味",
  "author": "you",
  "disabled": false
}
```

- `target`（必填）：目标插件包名；`targetRange`（可选）：semver 范围（支持 `^ ~ >= > < <= =` 及空格 AND 组合）。
- 包内 `.js` 自动扫描发现；包内脚本**禁止互相 import**（脚本是叶子，不是构建块）。
- 失配以包为单位：目标未安装或版本不满足 → **整包禁用 + 日志 + notify 报警**。
- 包内可放可选的 `profiles` 白名单，限制脚本只作用于特定 profile。

## DshKubeJS 模式（AI 会话模式）

dsh-kubejs 会向 DSH 声明一个会话级 agent preset「**dsh-kubejs 模式**」（模仿创造模式）。选中该模式的会话会获得：

- 完整标准工具套（read / glob / grep / edit / write / pwsh / web / todo / subagent …）；
- 四个专用工具：

| 工具 | 作用 |
|---|---|
| `kubejs_inspect` | 列出脚本包、脚本、失配/失败状态与配置账本（只读，写前先看） |
| `kubejs_write_script` | 写/改脚本文件，落盘前自动校验（JSON / ESM 语法 / client 禁 import-export / 路径逃逸） |
| `kubejs_reload` | 热重载全部脚本包（含 fetch 规则摘除重建） |
| `kubejs_check` | 健康报告：失配包、被隔离脚本、账本孤儿条目 |

- persona 纪律：禁止修改 `plugins/`、`node_modules/` 下任何文件，一切修改走 dsh-kubejs 脚本。

## 管理面板

client 平面在左侧边栏注册「脚本」入口（位于「插件」按钮旁），点击后在主面板区打开管理页：浏览全部脚本包（状态徽章 / 失配红标）、client 脚本执行状态、配置覆写账本、热重载、调试开关。数据走同源路由 `/dsh-kubejs/panel`。

## 配置覆写账本

`api.config.override` 不直接改内存配置，而是把覆写写进 profile 的 `cordis.patch.yml` 托管区块：

```yaml
# --- dsh-kubejs managed BEGIN ---
# script: snowluma-humanize/humanize.js
- id: qq-bridge
  config:
    reply:
      humanize: true
# --- dsh-kubejs managed END ---
```

每个条目带 `# script:` 归属注释；脚本删除或失配时**精确摘除自己的条目**，手工写的其他配置不受影响。

同一插件实例（同 `- id:`）**分多次写不同路径是累加而非覆盖**：账本按 (包 id + 配置路径) 深合并，写第二次不会抹掉第一次的键。

> 给插件作者的提醒：托管区块的标记行必须以 `#` 开头（`# --- ... managed BEGIN ---`）。写成裸 `--- ...` 会被 YAML 当成文档分隔符，导致整个 `cordis.patch.yml` 解析失败、DSH 起不来。

## 故障隔离

- 脚本抛异常只禁用脚本自己 + notify 报警，**绝不拖垮 DSH 启动**；
- 运行期钩子异常只记日志；
- `dsh-kubejs.debug` 配置（或面板开关）打开后输出 `api.log.debug` 调试日志。

## 热重载（尽力）

| 修改内容 | 生效方式 |
|---|---|
| 事件钩子 / 配置覆写 / fetch 拦截 | `kubejs_reload` 即时生效（无需重启） |
| 服务包装 | 建议重启 DSH |
| client 槽位 | 刷新页面 |

## 能力边界

脚本是「修改者」不是「插件」：能钩既有事件、覆既有配置、包既有服务、填既有槽位、拦既有 fetch；**不能**造新接入点（provide 新服务 / 注册新工具 / 新路由）、不能引入新依赖（client 侧只能 require 页面已打包的模块）。需要这些时，请把脚本「毕业」成独立插件。

## 开发

```bash
node --test                 # 跑全部测试（推荐）
node test/tools.test.mjs    # 四工具（参数校验 / 语法校验 / 落盘）
node test/host.test.mjs     # host：扫描 / 加载 / 故障隔离
node test/ledger.test.mjs   # 配置覆写账本：写入 / 摘除 / 幂等
node test/preset.test.mjs   # agent preset 构建与工具行装配
node test/fetch-wrap.test.mjs  # fetch 拦截：匹配 / 洋葱 / 卸载还原 + 空闲看门狗
```

`examples/` 内有三个可直接参考的脚本包：`snowluma-humanize`（server 事件钩子 + 配置覆写）、`cachebilling-stats`（client 槽位统计行）与 `qq-wait-backfill`（钩 `tools/post-execute` 改写工具返回 content）。

## License

[MIT](./LICENSE)
