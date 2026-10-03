/**
 * dsh-kubejs client 平面：
 * 1. 侧边栏「脚本」入口（sidebar.panellist 图标 + main 主面板页面，插件按钮旁）
 * 2. 管理面板页面用 React + 官方 primitives 渲染（卡片布局对齐官方插件管理页），数据走同源路由 /dsh-kubejs/panel
 * 3. 执行 client_scripts 脚本：RPC 拉源码 → new Function 执行 → api.slot 可注册 UI
 *
 * 样式：不引用官方哈希类名（易随版本漂移），自建 kjs_ 前缀类名 + 同一套 dsw 设计令牌；
 * 交互控件直接用 @deepseek-ai/dsh-client-ui-primitives（Switch / Button / Checkbox / Tag），与原生一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-kubejs/client',
  factory(require) {
    const react = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const ROUTE = '/dsh-kubejs/panel'
    const MARK = 'data-dsh-kubejs'
    const NS = 'dsh-kubejs'
    const PANEL_ID = 'dsh-kubejs' // 侧边栏入口与主面板页面共用此 id（sidebar.panellist 的 list id ↔ main 的 key）

    // ---- 客户端脚本运行时状态 ----
    const executedScripts = new Map() // name -> { ok, error }
    const executedPackages = []       // 已执行的包名（避免 reload 前 client 脚本重复执行）

    /** 客户端脚本 api 工厂。 */
    function createClientApi({ name, target, host }) {
      const prefix = `[dsh-kubejs:client/${name}]`
      return {
        meta: Object.freeze({ name, plane: 'client', target }),
        /** 原语②：client UI 槽位注册。 */
        slot(slotName, options, component) {
          if (typeof slotName !== 'string' || slotName === '') throw new Error('api.slot: slotName 必须是非空字符串')
          const id = options?.id ?? `${NS}:${name}`
          const order = typeof options?.order === 'number' ? options.order : 0
          const injectFn = options?.inject ?? (() => ({ available: true }))
          host.ctx.inject(['slots'], (scope) => {
            scope.slots.inject(slotName, () => scope.slots.register({
              name: slotName,
              id,
              order,
              inject: injectFn
            }, component))
          })
        },
        /** 逃生舱：client cordis 上下文。 */
        get ctx() {
          return host.ctx
        },
        /** ModuleLoader 的 require（取 react / UI primitives 等）。 */
        require,
        log: {
          info: (...a) => console.info(prefix, ...a),
          warn: (...a) => console.warn(prefix, ...a),
          error: (...a) => console.error(prefix, ...a),
          debug: (...a) => { if (host.debug) console.debug('[debug]', prefix, ...a) }
        },
        notify(message, level = 'info') {
          console.info(`${prefix} [notify:${level}]`, message)
        },
        /** 读取面板数据（同源路由）。 */
        async fetchPanel() {
          const res = await fetch(ROUTE)
          return res.json()
        },
        env: Object.freeze({
          plane: 'client',
          get debug() { return host.debug }
        })
      }
    }

    /** 执行 client 平面脚本（故障隔离：单脚本异常只记自己）。 */
    async function runClientScripts(host) {
      try {
        // fetch 返回的是 Response，必须 .json() 解出数据（旧写法把 Response 当数据用，data.clientScripts 恒 undefined）
        const res = await fetch(ROUTE)
        const data = await res.json()
        if (!data?.ok) throw new Error(`面板数据获取失败: ${JSON.stringify(data).slice(0, 200)}`)
        host.debug = Boolean(data.debug)
        for (const pkg of data.clientScripts ?? []) {
          if (executedPackages.includes(pkg.name)) continue
          executedPackages.push(pkg.name)
          for (const file of pkg.files) {
            const scriptName = file.file.replace(/\.js$/, '')
            const full = `${pkg.name}/${scriptName}`
            try {
              // 纯脚本体：api 为参数，activate(api) 自动调用
              const run = new Function('api', 'require', `"use strict";\n${file.code}\n;if (typeof activate === 'function') return activate(api);`)
              const api = createClientApi({ name: scriptName, target: pkg.target, host })
              run(api, require)
              executedScripts.set(full, { ok: true })
              console.info(`[dsh-kubejs] client 脚本加载成功: ${full} → ${pkg.target}`)
            } catch (error) {
              executedScripts.set(full, { ok: false, error: String(error?.stack ?? error) })
              console.error(`[dsh-kubejs] client 脚本 ${full} 加载失败（已隔离）:`, error)
            }
          }
        }
      } catch (error) {
        console.error('[dsh-kubejs] client 脚本调度失败:', error)
      }
    }

    // ---- 管理面板页面（React + 官方 primitives；卡片布局对齐官方插件管理页） ----

    const PANEL_CSS_ID = `${NS}/panel.css`
    // 只用 dsw 设计令牌，不引用官方哈希类名（那会随 DSH 版本漂移）
    const PANEL_CSS = `
.kjs_page{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);flex-direction:column;align-items:center;gap:32px;padding:0 clamp(24px,4vw,48px) 48px;display:flex;overflow:auto}
.kjs_page>*{width:100%;max-width:960px}
.kjs_pageHead{justify-content:space-between;align-items:flex-start;gap:16px;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));display:flex}
.kjs_pageTitle{margin:0;font-size:20px;font-weight:500;line-height:28px}
.kjs_pageIntro{color:var(--dsw-alias-label-secondary);margin:4px 0 0;font-size:13px;line-height:20px}
.kjs_toolbar{justify-content:flex-end;align-items:center;gap:16px;display:flex}
.kjs_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.kjs_sectionHead{align-items:baseline;gap:10px;display:flex}
.kjs_sectionTitle{margin:0;font-size:14px;font-weight:500;line-height:20px}
.kjs_count{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-size:14px}
.kjs_cards{flex-direction:column;gap:2px;list-style:none;margin:8px 0 0;padding:0;display:flex}
.kjs_card{margin:0;border-radius:var(--dsw-radius-xl)}
.kjs_cardHead{align-items:center;gap:14px;padding:8px;display:flex}
.kjs_cardIcon{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);width:48px;height:48px;color:var(--dsw-alias-label-secondary);flex:none;display:inline-flex;justify-content:center;align-items:center}
.kjs_cardMain{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.kjs_titleRow{flex-wrap:wrap;align-items:center;gap:8px;min-width:0;display:flex}
.kjs_cardTitle{font-size:14px;font-weight:500;line-height:20px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.kjs_cardSub{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.kjs_cardDesc{color:var(--dsw-alias-label-tertiary);-webkit-line-clamp:1;-webkit-box-orient:vertical;font-size:13px;line-height:18px;display:-webkit-box;overflow:hidden}
.kjs_cardEnd{z-index:1;flex:none;align-items:center;gap:8px;display:inline-flex}
.kjs_cardWarn{margin:0;padding:0 8px 10px 70px;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.kjs_rows{flex-direction:column;display:flex;margin:8px 0 0}
.kjs_row{align-items:center;gap:8px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3);display:flex;font-size:13px;line-height:18px}
.kjs_row:last-child{border-bottom:0}
.kjs_rowName{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.kjs_rowErr{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;font-size:12px}
.kjs_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:8px}
.kjs_loading,.kjs_error{padding:28px}
.kjs_loading{color:var(--dsw-alias-label-tertiary)}
.kjs_error{color:var(--dsw-alias-state-error-primary)}
`

    /** 注入面板样式（幂等）。 */
    function ensurePanelCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(PANEL_CSS_ID)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = PANEL_CSS_ID
      tag.textContent = PANEL_CSS
      document.head.appendChild(tag)
    }

    /** 包状态 → Tag tone（官方 Tag 的 tone 调色板）。 */
    const STATUS_TONE = {
      ok: 'success', loaded: 'success',
      mismatch: 'warning', warning: 'warning',
      invalid: 'danger', failed: 'danger', error: 'danger',
      disabled: 'neutral', empty: 'neutral'
    }

    /** 单个脚本包卡片：图标 + 名称 + 状态标签 + 描述 + 右侧启用开关。 */
    function PackageCard({ pkg, onToggle }) {
      const [busy, setBusy] = react.useState(false)
      const enabled = pkg.disabled !== true
      const targetText = pkg.target ? `→ ${pkg.target}${pkg.targetVersion ? `@${pkg.targetVersion}` : ''}` : ''
      const sub = [pkg.plane, targetText, pkg.targetRange].filter(Boolean).join(' · ')
      return react.createElement('li', { className: 'kjs_card', [MARK]: 'card' },
        react.createElement('div', { className: 'kjs_cardHead' },
          react.createElement('span', { className: 'kjs_cardIcon', 'aria-hidden': 'true' },
            react.createElement(primitives.IconCodeOutlineRegular, { size: 24 })),
          react.createElement('div', { className: 'kjs_cardMain' },
            react.createElement('div', { className: 'kjs_titleRow' },
              react.createElement('span', { className: 'kjs_cardTitle' }, pkg.name),
              react.createElement(primitives.Tag, { tone: STATUS_TONE[pkg.status] ?? 'outline' }, String(pkg.status ?? 'unknown')),
              pkg.author ? react.createElement(primitives.Tag, { tone: 'quiet' }, pkg.author) : null),
            react.createElement('span', { className: 'kjs_cardSub' }, sub),
            react.createElement('span', { className: 'kjs_cardDesc', title: pkg.description ?? '' },
              pkg.description || `${pkg.plane} 脚本包（manifest 未写 description）`)),
          react.createElement('div', { className: 'kjs_cardEnd' },
            react.createElement(primitives.Switch, {
              checked: enabled,
              disabled: busy,
              label: `${enabled ? '禁用' : '启用'} ${pkg.name}`,
              title: enabled ? '禁用后不再加载（写回 manifest.json 的 disabled）' : '启用后立即重新加载',
              onChange: (next) => {
                setBusy(true)
                Promise.resolve(onToggle(pkg.name, next)).finally(() => setBusy(false))
              }
            }))),
        pkg.reasons?.length
          ? react.createElement('p', { className: 'kjs_cardWarn' }, pkg.reasons.join('；'))
          : null)
    }

    /** 主面板页面组件（挂载时拉数据并渲染）。 */
    function PanelPage() {
      const [data, setData] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [debugOn, setDebugOn] = react.useState(false)
      const [busy, setBusy] = react.useState(false)
      const [notice, setNotice] = react.useState('')

      const load = react.useCallback(async () => {
        try {
          const next = await (await fetch(ROUTE)).json()
          setData(next)
          setDebugOn(Boolean(next.debug))
          setError(null)
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [])

      react.useEffect(() => { ensurePanelCss(); load() }, [load])

      const post = react.useCallback(async (body) => {
        const res = await fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        const out = await res.json()
        if (!out?.ok) throw new Error(out?.error ?? `HTTP ${res.status}`)
        return out
      }, [])

      const onReload = async () => {
        setBusy(true); setNotice('')
        try {
          await post({ action: 'reload' })
          await load()
          setNotice('server 脚本已重载')
        } catch (err) {
          setNotice(`重载失败：${err.message}`)
        } finally {
          setBusy(false)
        }
      }

      const onToggle = async (name, enabled) => {
        setNotice('')
        try {
          await post({ action: 'setEnabled', name, enabled })
          await load()
          setNotice(`${name} 已${enabled ? '启用' : '禁用'}`)
        } catch (err) {
          setNotice(`操作失败：${err.message}`)
        }
      }

      const onDebug = (value) => {
        setDebugOn(value)
        post({ action: 'setDebug', value }).catch((err) => setNotice(`debug 切换失败：${err.message}`))
      }

      if (error) return react.createElement('div', { className: 'kjs_error', [MARK]: 'page' }, `面板数据获取失败：${error}`)
      if (!data) return react.createElement('div', { className: 'kjs_loading', [MARK]: 'page' }, '加载中…')

      const pkgs = data.state?.packages ?? []
      const scriptRows = [...executedScripts.entries()]
      const ledger = data.ledger ?? []

      return react.createElement('div', { className: 'kjs_page', [MARK]: 'page' },
        react.createElement('header', { className: 'kjs_pageHead' },
          react.createElement('div', null,
            react.createElement('h1', { className: 'kjs_pageTitle' }, '脚本'),
            react.createElement('p', { className: 'kjs_pageIntro' },
              `dsh-kubejs 管理面板 · profile: ${data.profile} · root: ${data.root}`)),
          react.createElement('div', { className: 'kjs_toolbar' },
            notice ? react.createElement('span', { className: 'kjs_hint' }, notice) : null,
            react.createElement(primitives.Checkbox, { checked: debugOn, label: 'debug', onChange: onDebug }),
            react.createElement(primitives.Button, {
              variant: 'outline',
              size: 'sm',
              disabled: busy,
              icon: react.createElement(primitives.IconRefreshOutlineRegular, { size: 16 }),
              onClick: onReload
            }, '热重载'))),
        react.createElement('section', null,
          react.createElement('div', { className: 'kjs_sectionHead' },
            react.createElement('h2', { className: 'kjs_sectionTitle' }, '脚本包'),
            react.createElement('span', { className: 'kjs_count' }, String(pkgs.length))),
          pkgs.length
            ? react.createElement('ul', { className: 'kjs_cards' }, pkgs.map((p) =>
                react.createElement(PackageCard, { key: `${p.plane}/${p.name}`, pkg: p, onToggle })))
            : react.createElement('div', { className: 'kjs_empty' }, '无')),
        react.createElement('section', null,
          react.createElement('div', { className: 'kjs_sectionHead' },
            react.createElement('h2', { className: 'kjs_sectionTitle' }, 'client 脚本执行状态'),
            react.createElement('span', { className: 'kjs_count' }, String(scriptRows.length)),
            react.createElement('span', { className: 'kjs_hint' }, 'client 脚本改动需刷新页面生效')),
          scriptRows.length
            ? react.createElement('div', { className: 'kjs_rows' }, scriptRows.map(([name, st]) =>
                react.createElement('div', { className: 'kjs_row', key: name },
                  react.createElement(primitives.Tag, { tone: st.ok ? 'success' : 'danger' }, st.ok ? 'loaded' : 'failed'),
                  react.createElement('span', { className: 'kjs_rowName' }, name),
                  st.ok ? null : react.createElement('span', { className: 'kjs_rowErr' }, String(st.error)))))
            : react.createElement('div', { className: 'kjs_empty' }, '无')),
        react.createElement('section', null,
          react.createElement('div', { className: 'kjs_sectionHead' },
            react.createElement('h2', { className: 'kjs_sectionTitle' }, '配置覆写账本'),
            react.createElement('span', { className: 'kjs_count' }, String(ledger.length)),
            react.createElement('span', { className: 'kjs_hint' }, 'cordis.patch.yml managed 区块')),
          ledger.length
            ? react.createElement('div', { className: 'kjs_rows' }, ledger.map((e, i) =>
                react.createElement('div', { className: 'kjs_row', key: `${e.script}-${i}` },
                  react.createElement('span', { className: 'kjs_rowName' }, String(e.script)),
                  react.createElement('span', { className: 'kjs_hint' }, String(e.yaml ?? '').split('\n')[0]))))
            : react.createElement('div', { className: 'kjs_empty' }, '无')))
    }

    // ---- 侧边栏「脚本」图标（SidebarPanelIconOwnerProps: { size, active }） ----
    function PanelIcon({ size }) {
      const Icon = primitives?.IconCodeOutlineRegular
      return Icon
        ? react.createElement(Icon, { size })
        : react.createElement('span', {
            style: { width: size, height: size, display: 'inline-block', textAlign: 'center', lineHeight: `${size}px`, fontSize: size * 0.7 }
          }, '📜')
    }

    const inject = ['slots']
    function apply(ctx) {
      const host = {
        ctx,
        get debug() { return this._debug === true },
        set debug(v) { this._debug = Boolean(v) },
        _debug: false
      }
      ctx.inject(['slots'], (scope) => {
        // 侧边栏「脚本」入口：插件按钮 order 0、任务管理器 order 10，此处排插件按钮旁
        scope.slots.inject('sidebar.panellist', () => scope.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 1,
          label: '脚本'
        }, PanelIcon))
        // 主面板页面：key 与侧边栏入口 id 配对，点击图标即显示
        scope.slots.inject('main', () => scope.slots.register({
          name: 'main',
          key: PANEL_ID
        }, PanelPage))
      })
      // 拉取并执行 client_scripts（一次；面板 reload 不重复执行，提示刷新）
      Promise.resolve().then(() => runClientScripts(host))
    }

    return { apply, inject }
  }
})
