/**
 * The standalone panel's page shell.
 *
 * The panel is the existing `webui/lib/client.js` bundle, not a second UI: this file only supplies
 * what the dsh web shell normally supplies around it — React, the `window.__ModuleLoader__.load`
 * facade, the small client context (`effect`, `locale`, `slots`) and the `--dsw-alias-*` theme
 * tokens the bundle styles itself with. The panel body (width, cards, inbox/settings/hooks
 * sections) is entirely the bundle's.
 *
 * The tokens below are the values the dsh shell exposes for the same names (light and dark), read
 * from the running shell. Only the host frame differs: a collapsed panel rail instead of dsh's
 * session sidebar and top bar.
 */

/** CSS custom properties the bundle reads. */
const THEME_TOKENS = {
  dark: {
    '--dsw-alias-bg-base': '#151517',
    '--dsw-alias-bg-layer-1': '#232324',
    '--dsw-alias-bg-layer-3': '#353638',
    '--dsw-alias-bg-module-platform': '#353638',
    '--dsw-alias-border-l1': '#ffffff0f',
    '--dsw-alias-border-l2': '#ffffff1f',
    '--dsw-alias-border-l3': '#ffffff29',
    '--dsw-alias-border-l4': '#fff3',
    '--dsw-alias-button-primary-fill': '#f9fafb',
    '--dsw-alias-button-primary-hover': '#ebeef2',
    '--dsw-alias-interactive-bg-hover': '#ffffff14',
    '--dsw-alias-label-caption': '#81858c',
    '--dsw-alias-label-dimmed': '#43454a',
    '--dsw-alias-label-primary': '#f9fafb',
    '--dsw-alias-label-primary-foreground': '#0f1115',
    '--dsw-alias-label-secondary': '#cfd3d6',
    '--dsw-alias-label-tertiary': '#adb2b8',
    '--dsw-alias-link': '#7aaaff',
    '--dsw-alias-markdown-code-block': '#1b1b1c',
    '--dsw-alias-markdown-inline-code': '#292929',
    '--dsw-alias-state-business-primary': '#7aaaff',
    '--dsw-alias-state-error-primary': '#f25a5a',
    '--dsw-alias-state-success-primary': '#22c55e',
    '--dsw-alias-state-warn-primary': '#f59e0b',
    '--dsw-focus-ring-color': 'currentColor',
    '--dsw-focus-ring-width': '2px',
    '--dsw-radius-lg': '16px',
    '--dsw-radius-md': '12px',
    '--dsw-radius-sm': '8px',
  },
  light: {
    '--dsw-alias-bg-base': '#fff',
    '--dsw-alias-bg-layer-1': '#fff',
    '--dsw-alias-bg-layer-3': '#fff',
    '--dsw-alias-bg-module-platform': '#f5f6f7',
    '--dsw-alias-border-l1': '#0000000a',
    '--dsw-alias-border-l2': '#0000001a',
    '--dsw-alias-border-l3': '#0000001f',
    '--dsw-alias-border-l4': '#00000029',
    '--dsw-alias-button-primary-fill': '#0f1115',
    '--dsw-alias-button-primary-hover': '#43454a',
    '--dsw-alias-interactive-bg-hover': '#2631480f',
    '--dsw-alias-label-caption': '#adb2b8',
    '--dsw-alias-label-dimmed': '#e1e5ee',
    '--dsw-alias-label-primary': '#0f1115',
    '--dsw-alias-label-primary-foreground': '#fff',
    '--dsw-alias-label-secondary': '#61666b',
    '--dsw-alias-label-tertiary': '#81858c',
    '--dsw-alias-link': '#4176e6',
    '--dsw-alias-markdown-code-block': '#f9fafb',
    '--dsw-alias-markdown-inline-code': '#fafafa',
    '--dsw-alias-state-business-primary': '#4176e6',
    '--dsw-alias-state-error-primary': '#ec1313',
    '--dsw-alias-state-success-primary': '#22c55e',
    '--dsw-alias-state-warn-primary': '#f59e0b',
    '--dsw-focus-ring-color': 'currentColor',
    '--dsw-focus-ring-width': '2px',
    '--dsw-radius-lg': '16px',
    '--dsw-radius-md': '12px',
    '--dsw-radius-sm': '8px',
  },
}

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif'
const MONO_STACK =
  '"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"'

const VARIABLES = {
  dark: {
    '--dsw-font-markdown-base': `14px / 24px ${FONT_STACK}`,
    '--dsw-font-markdown-base-strong': `600 14px / 24px ${FONT_STACK}`,
    '--dsw-font-markdown-code': `12px / 19px ${MONO_STACK}`,
    '--dsw-font-markdown-code-block-small': `11px / 16px ${MONO_STACK}`,
    '--dsw-font-markdown-h1': `700 21px / 30px ${FONT_STACK}`,
    '--dsw-font-markdown-h2': `700 19px / 28px ${FONT_STACK}`,
    '--dsw-font-markdown-h3': `700 18px / 26px ${FONT_STACK}`,
    '--dsw-font-markdown-h4': `600 14px / 24px ${FONT_STACK}`,
    '--dsw-font-markdown-table': `13px / 22px ${FONT_STACK}`,
    '--dsw-font-markdown-table-head': `500 13px / 22px ${FONT_STACK}`,
  },
}

function declarations(values) {
  return Object.entries(values)
    .map(([name, value]) => `      ${name}: ${value};`)
    .join('\n')
}

/**
 * One stylesheet: the shell frame on top of the bundle's own `.wca-page` rules, plus the host tokens
 * in both themes. The bundle's visual constants (`--wca-content-max`, card radius, spacing) are
 * untouched.
 */
const STYLES = `    :root {
      color-scheme: dark;
${declarations(THEME_TOKENS.dark)}
${declarations(VARIABLES.dark)}
      --wca-shell-rail: 48px;
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
${declarations(THEME_TOKENS.light)}
      }
    }
    :root[data-panel-theme="dark"] {
      color-scheme: dark;
${declarations(THEME_TOKENS.dark)}
    }
    :root[data-panel-theme="light"] {
      color-scheme: light;
${declarations(THEME_TOKENS.light)}
    }
    html, body { height: 100%; margin: 0; }
    body {
      background: var(--dsw-alias-bg-base);
      color: var(--dsw-alias-label-primary);
      font-family: ${FONT_STACK};
      font-size: 14px;
      line-height: 20px;
      -webkit-font-smoothing: antialiased;
      overflow: hidden;
    }
    #root { height: 100%; }
    .wca-shell { display: flex; height: 100%; }
    .wca-rail {
      box-sizing: border-box;
      flex: none;
      width: var(--wca-shell-rail);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 10px 0;
      border-right: 1px solid var(--dsw-alias-border-l2);
      background: var(--dsw-alias-bg-base);
    }
    .wca-rail button {
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      border-radius: var(--dsw-radius-sm);
      background: transparent;
      color: var(--dsw-alias-label-tertiary);
      cursor: pointer;
    }
    .wca-rail button:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .wca-rail button[aria-current="page"] {
      background: var(--dsw-alias-interactive-bg-hover);
      color: var(--dsw-alias-label-primary);
    }
    .wca-main { flex: 1; min-width: 0; height: 100%; overflow: hidden; }
    .wca-boot-error {
      box-sizing: border-box;
      margin: 48px auto;
      max-width: 720px;
      padding: 20px 24px;
      border: 1px solid var(--dsw-alias-state-error-primary);
      border-radius: var(--dsw-radius-md);
      color: var(--dsw-alias-state-error-primary);
      font-family: ${MONO_STACK};
      white-space: pre-wrap;
    }`

/** The page shell served at `/`. */
export const PANEL_SHELL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wheelchair-agent</title>
  <script>
    (() => {
      const theme = new URLSearchParams(location.search).get('theme')
      if (theme === 'dark' || theme === 'light') document.documentElement.dataset.panelTheme = theme
    })()
  </script>
  <style>
${STYLES}
  </style>
  <script src="/vendor/react.production.min.js"></script>
  <script src="/vendor/react-dom.production.min.js"></script>
  <script>
    // dsh's module loader registers bundles lazily and materializes them through this facade.
    // The standalone host needs only the registration half the plugin bundles are built against.
    window.__ModuleLoader__ = {
      modules: new Map(),
      load({ id, factory }) {
        if (typeof id !== 'string' || id.length === 0) throw new Error('panel host: module loader load() needs an id')
        if (typeof factory !== 'function') throw new Error('panel host: module loader load(' + id + ') needs a factory')
        if (this.modules.has(id)) throw new Error('panel host: duplicate client module "' + id + '"')
        this.modules.set(id, factory)
      },
      require(name) {
        const bare = name.endsWith('/client') ? name.slice(0, -7) : name
        if (bare === 'react') return window.React
        if (bare === 'react/jsx-runtime') return jsxRuntime
        throw new Error('panel host: unknown client module "' + name + '" (this host only supplies react and react/jsx-runtime)')
      },
      materialize(id) {
        const factory = this.modules.get(id)
        if (factory === undefined) throw new Error('panel host: client module "' + id + '" was never registered')
        return factory(name => this.require(name))
      },
    }
    // The bundle calls jsx/jsxs directly; React 18 elements only need createElement + key handling.
    const jsxRuntime = {
      Fragment: window.React.Fragment,
      jsx: (type, props, key) => window.React.createElement(type, key === undefined ? props : { ...props, key }),
      jsxs: (type, props, key) => window.React.createElement(type, key === undefined ? props : { ...props, key }),
    }
  </script>
  <script>
    // One module, one apply(): enough of the dsh client context for the bundle's inject list.
    function createPanelContext() {
      const localeDictionaries = new Map()
      const localeLanguage = String(navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const slotEntries = new Map()
      let injecting = null
      const disposers = []
      function format(template, params) {
        if (params === undefined) return template
        return String(template).replace(/\\{(\\w+)\\}/g, (whole, name) =>
          Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
      }
      function entriesOf(name) {
        return [...(slotEntries.get(name) ?? [])].sort((a, b) => (a.order - b.order) || a.sequence - b.sequence)
      }
      const ctx = {
        effect(fn) {
          const result = fn()
          if (typeof result === 'function') disposers.push(result)
          return result
        },
        locale: {
          register(namespace, dictionaries) {
            localeDictionaries.set(namespace, dictionaries)
          },
          bind(namespace) {
            return (key, params) => {
              const dictionaries = localeDictionaries.get(namespace) ?? {}
              const table = dictionaries[localeLanguage] ?? dictionaries.zh ?? dictionaries.en ?? {}
              const template = table[key] ?? dictionaries.en?.[key] ?? key
              return format(template, params)
            }
          },
        },
        slots: {
          inject(name, fn) {
            const previous = injecting
            injecting = name
            try {
              const result = fn()
              if (typeof result === 'function') disposers.push(result)
              return result
            } finally {
              injecting = previous
            }
          },
          register(definition, Component) {
            const name = injecting
            if (name === null) throw new Error('panel host: slots.register called outside slots.inject')
            if (definition === null || typeof definition !== 'object' || definition.name !== name) {
              throw new Error('panel host: slot definition for "' + name + '" must carry name: "' + name + '"')
            }
            const list = slotEntries.get(name) ?? []
            list.push({
              definition,
              Component,
              order: typeof definition.order === 'number' ? definition.order : 0,
              sequence: list.length,
            })
            slotEntries.set(name, list)
            return () => {
              const current = slotEntries.get(name) ?? []
              slotEntries.set(name, current.filter(entry => entry.definition !== definition))
            }
          },
        },
        entriesOf,
        dispose() {
          for (const dispose of disposers.splice(0)) {
            try { dispose() } catch (error) { console.error('panel host: disposer failed', error) }
          }
        },
      }
      return ctx
    }
  </script>
  <script src="/client.js"></script>
  <script>
    function bootPanel() {
      const root = document.getElementById('root')
      const fail = (error) => {
        console.error('panel host:', error)
        root.innerHTML = ''
        const box = document.createElement('pre')
        box.className = 'wca-boot-error'
        box.textContent = 'The panel client failed to start.\\n\\n' + (error instanceof Error ? (error.stack || error.message) : String(error))
        root.append(box)
      }
      try {
        const loader = window.__ModuleLoader__
        const client = loader.materialize('wheelchair-agent-webui')
        const ctx = createPanelContext()
        client.apply(ctx)
        const Rail = () => {
          const entries = ctx.entriesOf('sidebar.panellist')
          if (entries.length === 0) return null
          return window.React.createElement('nav', { className: 'wca-rail', 'aria-label': 'panels' },
            entries.map(entry => {
              const { definition, Component } = entry
              const label = typeof definition.label === 'function' ? definition.label() : String(definition.label ?? definition.id ?? '')
              return window.React.createElement('button', {
                key: definition.id ?? label,
                type: 'button',
                title: label,
                'aria-label': label,
                'aria-current': 'page',
              }, window.React.createElement(Component, { size: 18, active: true }))
            }))
        }
        const Main = () => {
          const entries = ctx.entriesOf('main')
          if (entries.length === 0) {
            return window.React.createElement('div', { className: 'wca-boot-error' }, 'The wheelchair-agent bundle registered no page for the main slot.')
          }
          const chosen = entries.find(entry => entry.definition.key === 'wheelchair-agent' || entry.definition.id === 'wheelchair-agent') ?? entries[entries.length - 1]
          const injected = typeof chosen.definition.inject === 'function' ? chosen.definition.inject() : {}
          return window.React.createElement(chosen.Component, injected)
        }
        window.ReactDOM.createRoot(root).render(
          window.React.createElement('div', { className: 'wca-shell' },
            window.React.createElement(Rail),
            window.React.createElement('div', { className: 'wca-main' }, window.React.createElement(Main)),
          ),
        )
      } catch (error) {
        fail(error)
      }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPanel)
    else bootPanel()
  </script>
</head>
<body>
  <div id="root"></div>
</body>
</html>
`
