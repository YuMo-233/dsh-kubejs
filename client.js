/**
 * dsh-kubejs client 平面：
 * 1. 注册管理面板入口按钮（conversation.session.header.actions 槽位）
 * 2. 面板用纯 DOM 渲染（避免 React 版本耦合），数据走同源路由 /dsh-kubejs/panel
 * 3. 执行 client_scripts 脚本：RPC 拉源码 → new Function 执行 → api.slot 可注册 UI
 *
 * client 脚本约定：纯脚本体（非 ESM），定义 function activate(api) 即会被调用；
 * api.require 可取 react 等浏览器侧模块（ModuleLoader 的 require）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-kubejs/client',
  factory(require) {
    const react = require('react')

    const ROUTE = '/dsh-kubejs/panel'
    const MARK = 'data-dsh-kubejs'
    const NS = 'dsh-kubejs'

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
        const data = await fetch(ROUTE)
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

    // ---- 面板 DOM（纯实现） ----
    let panelEl = null

    function closePanel() {
      panelEl?.remove()
      panelEl = null
    }

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

    async function openPanel() {
      closePanel()
      const overlay = document.createElement('div')
      overlay.setAttribute(MARK, 'panel')
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: 99999,
        background: 'rgba(0,0,0,0.35)', display: 'flex',
        alignItems: 'center', justifyContent: 'center'
      })
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel() })

      const dialog = document.createElement('div')
      Object.assign(dialog.style, {
        width: 'min(680px, 90vw)', maxHeight: '80vh', overflow: 'auto',
        background: 'var(--bg-color, #fff)', color: 'var(--fg-color, #1f2328)',
        borderRadius: '12px', padding: '16px 20px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.25)', fontSize: '13px', lineHeight: 1.6
      })
      overlay.appendChild(dialog)
      document.body.appendChild(overlay)
      panelEl = overlay
      dialog.innerHTML = '<div style="opacity:.6">加载中…</div>'

      let data
      try {
        data = await fetch(ROUTE)
        data = await data.json()
      } catch (error) {
        dialog.innerHTML = `<div style="color:#c9372c">面板数据获取失败：${esc(error.message)}</div>`
        return
      }

      const pkgs = data.packages ?? []
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

      dialog.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <b style="font-size:15px">dsh-kubejs 管理面板</b>
          <span style="opacity:.6;font-size:12px">profile: ${esc(data.profile)} · root: ${esc(data.root)}</span>
          <button data-act="close" style="cursor:pointer">✕</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button data-act="reload" style="cursor:pointer">热重载</button>
          <label style="display:flex;gap:4px;align-items:center;cursor:pointer">
            <input type="checkbox" data-act="debug" ${data.debug ? 'checked' : ''}/> debug
          </label>
          <span style="opacity:.5;align-self:center">client 脚本重载后建议刷新页面</span>
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
        </fieldset>`

      dialog.querySelector('[data-act="close"]').addEventListener('click', closePanel)
      dialog.querySelector('[data-act="reload"]').addEventListener('click', async () => {
        try {
          const res = await fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reload' }) })
          const out = await res.json()
          console.info('[dsh-kubejs] reload 结果:', out)
          // server 侧重载完成；client 脚本不重复执行（刷新页面生效）
          openPanel()
        } catch (error) {
          console.error('[dsh-kubejs] reload 失败:', error)
        }
      })
      dialog.querySelector('[data-act="debug"]').addEventListener('change', async (e) => {
        try {
          await fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'setDebug', value: e.target.checked }) })
        } catch (error) {
          console.error('[dsh-kubejs] setDebug 失败:', error)
        }
      })
    }

    // ---- 面板入口按钮（槽位，subagent-model-switch 同款写法） ----
    function PanelButton(props) {
      const { available } = props
      if (available === false) return null
      return react.createElement('button', {
        title: 'dsh-kubejs 管理面板',
        onClick: (e) => { e.preventDefault(); openPanel() },
        style: {
          border: 'none', background: 'transparent', cursor: 'pointer',
          fontSize: '11px', padding: '2px 6px', borderRadius: '6px', opacity: 0.65
        }
      }, 'KJS')
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
        scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-kubejs-panel',
          order: -30,
          inject: (sessionId) => ({ available: true, sessionId })
        }, PanelButton))
      })
      // 拉取并执行 client_scripts（一次；面板 reload 不重复执行，提示刷新）
      Promise.resolve().then(() => runClientScripts(host))
    }

    return { apply, inject }
  }
})
