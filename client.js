/**
 * dsh-kubejs client 平面：
 * 1. 侧边栏「脚本」入口（sidebar.panellist 图标 + main 主面板页面，插件按钮旁）
 * 2. 管理面板页面用纯 DOM 渲染（避免 React 版本耦合），数据走同源路由 /dsh-kubejs/panel
 * 3. 执行 client_scripts 脚本：RPC 拉源码 → new Function 执行 → api.slot 可注册 UI
 *
 * client 脚本约定：纯脚本体（非 ESM），定义 function activate(api) 即会被调用；
 * api.require 可取 react 等浏览器侧模块（ModuleLoader 的 require）。
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

    // ---- 管理面板页面（纯 DOM 渲染，挂在 main 主面板） ----

    function esc(text) {
      const div = document.createElement('div')
      div.textContent = String(text ?? '')
      return div.innerHTML
    }

    function badge(status) {
      const colors = {
        ok: '#22a06b', loaded: '#22a06b',
        mismatch: '#e5680c', warning: '#e5680c',
        invalid: '#c9372c', failed: '#c9372c', error: '#c9372c',
        disabled: '#8b8b8b', empty: '#8b8b8b'
      }
      return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;color:#fff;background:${colors[status] ?? '#8b8b8b'}">${esc(status)}</span>`
    }

    /** 把面板数据渲染进容器（数据结构同 GET /dsh-kubejs/panel）。 */
    function buildPanelDOM(container, data) {
      // 面板数据里脚本包在 state.packages（顶层 data.packages 不存在，旧写法导致恒显示 0）
      const pkgs = data.state?.packages ?? data.packages ?? []
      const rows = pkgs.map((p) => `
        <div style="display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px dashed var(--border-color, #e5e5e5)">
          ${badge(p.status)}
          <b>${esc(p.name)}</b>
          <span style="opacity:.7">→ ${esc(p.target ?? '-')}</span>
          <span style="opacity:.5">${esc(p.plane)}</span>
          ${p.reasons?.length ? `<span style="color:#e5680c">${esc(p.reasons.join('; '))}</span>` : ''}
        </div>`).join('')

      const scriptRows = [...executedScripts.entries()].map(([name, st]) => `
        <div style="display:flex;gap:8px;align-items:baseline;padding:2px 0">
          ${badge(st.ok ? 'loaded' : 'failed')}
          <span>${esc(name)}</span>
          ${st.ok ? '' : `<span style="color:#c9372c;white-space:pre-wrap">${esc(st.error)}</span>`}
        </div>`).join('')

      const ledgerRows = (data.ledger ?? []).map((e) => `
        <div style="padding:2px 0"><code style="font-size:12px">${esc(e.script)}</code> <span style="opacity:.6">${esc(e.insertLine)}</span></div>`).join('')

      container.innerHTML = `
        <div style="max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 48px;box-sizing:border-box">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
            <b style="font-size:18px">dsh-kubejs 管理面板</b>
            <span style="opacity:.6;font-size:12px">profile: ${esc(data.profile)} · root: ${esc(data.root)}</span>
          </div>
          <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px">
            <button data-act="reload" style="cursor:pointer">热重载</button>
            <label style="display:flex;gap:4px;align-items:center;cursor:pointer">
              <input type="checkbox" data-act="debug" ${data.debug ? 'checked' : ''}/> debug
            </label>
            <span style="opacity:.5;font-size:12px">client 脚本重载后建议刷新页面</span>
          </div>
          <fieldset style="border:1px solid var(--border-color,#ddd);border-radius:8px;margin:0 0 10px">
            <legend>脚本包（${pkgs.length}）</legend>
            ${rows || '<div style="opacity:.5">无</div>'}
          </fieldset>
          <fieldset style="border:1px solid var(--border-color,#ddd);border-radius:8px;margin:0 0 10px">
            <legend>client 脚本执行状态</legend>
            ${scriptRows || '<div style="opacity:.5">无</div>'}
          </fieldset>
          <fieldset style="border:1px solid var(--border-color,#ddd);border-radius:8px;margin:0">
            <legend>配置覆写账本（cordis.patch.yml managed 区块）</legend>
            ${ledgerRows || '<div style="opacity:.5">无</div>'}
          </fieldset>
        </div>`

      container.querySelector('[data-act="reload"]').addEventListener('click', async () => {
        try {
          const res = await fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reload' }) })
          const out = await res.json()
          console.info('[dsh-kubejs] reload 结果:', out)
          // server 侧重载完成；client 脚本不重复执行（刷新页面生效）
          buildPanelDOM(container, await (await fetch(ROUTE)).json())
        } catch (error) {
          console.error('[dsh-kubejs] reload 失败:', error)
        }
      })
      container.querySelector('[data-act="debug"]').addEventListener('change', async (e) => {
        try {
          await fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'setDebug', value: e.target.checked }) })
        } catch (error) {
          console.error('[dsh-kubejs] setDebug 失败:', error)
        }
      })
    }

    /** 主面板页面组件：挂载时拉数据并渲染。 */
    function PanelPage() {
      const ref = react.useRef(null)
      react.useEffect(() => {
        const el = ref.current
        let alive = true
        el.innerHTML = '<div style="opacity:.6;padding:28px">加载中…</div>'
        fetch(ROUTE)
          .then((r) => r.json())
          .then((data) => { if (alive && el.isConnected) buildPanelDOM(el, data) })
          .catch((error) => { if (alive && el.isConnected) el.innerHTML = `<div style="color:#c9372c;padding:28px">面板数据获取失败：${esc(error.message)}</div>` })
        return () => { alive = false }
      }, [])
      return react.createElement('div', {
        ref,
        [MARK]: 'page',
        style: { height: '100%', overflow: 'auto', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary, #1f2328)' }
      })
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
