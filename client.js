/**
 * Client 半：设置 →「橙子Pro 中转站」。
 *
 * 只做 UI 与同源 fetch；登录、令牌、分组密钥、模型目录都在 Host 半。
 * 页面不接收、不回显任何 token 或 sk- 密钥；只显示账号、余额与模型。
 */
window.__ModuleLoader__.load({
  id: '@orange-pro/dsh-orange-pro',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'orange-pro'
    const API = '/orange-pro/api'

    const DICT = {
      zh: {
        nav: '橙子Pro 中转站',
        title: '橙子Pro 中转站',
        desc: '登录橙子平台账号（pro.nat6.net），同步全部文本模型与分组密钥；余额与模型均以平台返回为准。',
        connected: '已连接',
        notLoggedIn: '未登录',
        phone: '手机号',
        code: '验证码',
        sendCode: '发送验证码',
        resendIn: '秒后重发',
        username: '账号',
        password: '密码',
        modeSms: '手机验证码',
        modePassword: '账号密码',
        login: '登录并同步',
        loggingIn: '登录中…',
        syncing: '同步中…',
        sync: '立即同步',
        logout: '退出登录',
        account: '账号',
        balance: '余额',
        models: '文本模型',
        groups: '分组',
        modelList: '已读取模型',
        emptyModels: '还没有模型，点「立即同步」拉取。',
        lastSync: '上次同步',
        never: '从未',
        autoSync: '每 10 分钟自动同步',
        errorTitle: '操作失败',
        hintSms: '未注册的手机号验证码登录会自动开通账号，约 30 秒就绪。',
        hintWhere: '同步后，在输入框左下角的模型选择器里选择「橙子Pro」即可使用。',
        hintPassword: '账号密码通道用于官网既有账号（与验证码通道是两套账号）。',
        balanceHint: '余额由平台实时返回，本插件不做任何本地记账。',
        free: '免费',
        refresh: '刷新状态',
        safetyHint: '上下文按 {pct}% 系数显示（已按需提前触发压缩）。',
        contextReal: '上下文按平台真实上限显示，未打折。',
        compatOn: '已启用答复规范（{targets}）：跟随用户语言、先结论后依据、不复述过程。',
        replyLang: '答复语言',
        supplement: '目录补充',
      },
      en: {
        nav: 'Orange Pro Relay',
        title: 'Orange Pro Relay',
        desc: 'Sign in to the Orange platform (pro.nat6.net) to sync every text model and group key. Balance and models come straight from the platform.',
        connected: 'Connected',
        notLoggedIn: 'Not signed in',
        phone: 'Phone',
        code: 'Code',
        sendCode: 'Send code',
        resendIn: 's to resend',
        username: 'Account',
        password: 'Password',
        modeSms: 'SMS code',
        modePassword: 'Password',
        login: 'Sign in and sync',
        loggingIn: 'Signing in…',
        syncing: 'Syncing…',
        sync: 'Sync now',
        logout: 'Sign out',
        account: 'Account',
        balance: 'Balance',
        models: 'Text models',
        groups: 'Groups',
        modelList: 'Discovered models',
        emptyModels: 'No models yet — press Sync now.',
        lastSync: 'Last sync',
        never: 'never',
        autoSync: 'Syncs every 10 minutes',
        errorTitle: 'Request failed',
        hintSms: 'Signing in with an unregistered phone auto-creates an account, ready in about 30 seconds.',
        hintWhere: 'After syncing, pick a model from the Orange Pro group in the composer model selector.',
        hintPassword: 'Password sign-in is for existing website accounts (a separate account space from SMS).',
        balanceHint: 'Balance is reported by the platform; this plugin never keeps its own ledger.',
        free: 'free',
        refresh: 'Refresh',
        safetyHint: 'Context shows a {pct}% factor (compaction triggered earlier by choice).',
        contextReal: 'Context shows the platform’s real limit — no discount applied.',
        compatOn: 'Reply guidance enabled for {targets}: same language as the user, conclusion first, no process narration.',
        replyLang: 'Reply language',
        supplement: 'catalog+',
      },
    }

    async function call(action, body) {
      const init = body === undefined
        ? { method: 'GET', headers: { Accept: 'application/json' } }
        : {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
      const response = await fetch(`${API}/${action}`, init)
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || !payload || payload.ok === false) {
        const message = payload?.error?.message ?? `HTTP ${response.status}`
        const error = new Error(message)
        error.code = payload?.error?.code
        throw error
      }
      return payload.data
    }

    function formatCny(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '¥0.00'
      if (n > 0 && n < 0.01) return `¥${n.toFixed(4)}`
      return `¥${n.toFixed(2)}`
    }

    function formatContext(model) {
      const n = Number(model?.contextWindow)
      if (!Number.isFinite(n) || n <= 0) return ''
      const label = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}K`
      return model?.contextSource === 'override' ? `${label} 自定义` : label
    }

    function relativeTime(iso, neverLabel) {
      if (!iso) return neverLabel
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return String(iso)
      const diff = Date.now() - then
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
      return new Date(then).toLocaleString()
    }

    const styles = `
.op-root { display:flex; flex-direction:column; gap:18px; padding:4px 0 28px; color:var(--dsw-alias-label-primary); }
.op-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.op-title { font-size:17px; font-weight:600; margin:0 0 6px; }
.op-desc { font-size:13px; line-height:1.6; color:var(--dsw-alias-label-secondary); margin:0; max-width:580px; }
.op-badge { flex:none; display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:4px 10px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.op-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); }
.op-dot.ok { background:var(--dsw-alias-state-success-primary); }
.op-card { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); padding:16px; display:flex; flex-direction:column; gap:12px; }
.op-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; }
.op-stat { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; padding:10px 12px; background:var(--dsw-alias-bg-layer-2); }
.op-stat-label { font-size:12px; color:var(--dsw-alias-label-secondary); margin-bottom:4px; }
.op-stat-value { font-size:15px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.op-field { display:flex; flex-direction:column; gap:6px; }
.op-label { font-size:12px; color:var(--dsw-alias-label-secondary); }
.op-row { display:flex; gap:8px; align-items:flex-end; }
.op-row .op-field { flex:1; }
.op-input { width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; font-family:inherit; }
.op-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.op-tabs { display:inline-flex; padding:3px; gap:3px; border-radius:9px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); align-self:flex-start; }
.op-tab { border:none; background:transparent; color:var(--dsw-alias-label-secondary); font-size:12px; padding:5px 12px; border-radius:7px; cursor:pointer; }
.op-tab.on { background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); box-shadow:0 1px 2px rgba(0,0,0,.12); }
.op-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.op-btn { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:13px; padding:7px 14px; border-radius:8px; cursor:pointer; }
.op-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.op-btn.primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:var(--dsw-alias-label-primary-foreground); }
.op-btn.primary:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover); color:var(--dsw-alias-label-primary-foreground); }
.op-btn:disabled { opacity:.55; cursor:default; }
.op-hint { font-size:12px; line-height:1.6; color:var(--dsw-alias-label-secondary); margin:0; }
.op-error { border:1px solid var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); border-radius:10px; padding:10px 12px; font-size:13px; line-height:1.5; background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.op-models { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; max-height:300px; overflow:auto; }
.op-model { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 12px; font-size:13px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.op-model:last-child { border-bottom:none; }
.op-model-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.op-model-id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.op-chips { display:flex; gap:6px; flex:none; align-items:center; }
.op-chip { font-size:11px; padding:2px 7px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.op-chip.free { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }
.op-empty { padding:14px 12px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.op-sub { font-size:12px; color:var(--dsw-alias-label-secondary); display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
`

    function Section(props) {
      const t = typeof props?.t === 'function' ? props.t : key => DICT.zh[key] ?? key
      const [status, setStatus] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [mode, setMode] = useState('sms')
      const [cooldown, setCooldown] = useState(0)
      const [form, setForm] = useState({ phone: '', code: '', username: '', password: '' })
      const timerRef = useRef(null)

      const load = useCallback(async () => {
        setLoadError('')
        try {
          const next = await call('status')
          setStatus(next)
          setForm(old => ({
            ...old,
            phone: old.phone || next.account?.phone || '',
            username: old.username || next.account?.phone || '',
          }))
        } catch (cause) {
          setLoadError(cause?.message ?? String(cause))
        }
      }, [])

      useEffect(() => {
        // 先把当前 DSH 界面语言（<html lang>）回报给 Host，再拉状态，
        // 这样答复规范按客户的语言生成，而不是假设中文。
        const reported = (typeof document !== 'undefined' && document.documentElement?.lang) || (typeof navigator !== 'undefined' && navigator.language) || ''
        const bootstrap = async () => {
          if (reported) {
            try {
              await call('locale', { locale: reported })
            } catch {
              // 上报失败不影响页面
            }
          }
          await load()
        }
        void bootstrap()
        return () => {
          if (timerRef.current) clearInterval(timerRef.current)
        }
      }, [load])

      const run = async (label, action) => {
        setBusy(label)
        setError('')
        try {
          const data = await action()
          if (data && typeof data === 'object' && 'models' in data) setStatus(data)
          else await load()
          return data
        } catch (cause) {
          setError(cause?.message ?? String(cause))
          return undefined
        } finally {
          setBusy('')
        }
      }

      const sendCode = async () => {
        if (cooldown > 0) return
        setError('')
        setBusy('sms')
        try {
          await call('sms-code', { phone: form.phone.trim() })
          setCooldown(60)
          if (timerRef.current) clearInterval(timerRef.current)
          timerRef.current = setInterval(() => {
            setCooldown(value => {
              if (value <= 1) {
                clearInterval(timerRef.current)
                timerRef.current = null
                return 0
              }
              return value - 1
            })
          }, 1000)
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        } finally {
          setBusy('')
        }
      }

      const loginSms = () => run('login', () => call('login', { phone: form.phone.trim(), code: form.code.trim() }))
      const loginPassword = () => run('password', () => call('login-password', {
        username: form.username.trim(),
        password: form.password,
      }))
      const onSync = () => run('sync', () => call('sync', { force: true }))
      const onLogout = () => run('logout', () => call('logout'))

      const field = (label, key, options = {}) =>
        h('label', { className: 'op-field', key },
          h('span', { className: 'op-label' }, label),
          h('input', {
            className: 'op-input',
            type: options.type ?? 'text',
            value: form[key],
            placeholder: options.placeholder ?? '',
            autoComplete: options.autoComplete ?? 'off',
            inputMode: options.inputMode,
            maxLength: options.maxLength,
            spellCheck: false,
            onChange: event => setForm(old => ({ ...old, [key]: event.target.value })),
            onKeyDown: event => {
              if (event.key === 'Enter' && options.onEnter) options.onEnter()
            },
          }),
        )

      const loggedIn = Boolean(status?.loggedIn)
      const pending = Boolean(busy)
      const groups = status?.groups ?? []

      return h('div', { className: 'op-root' },
        h('style', { key: 'style' }, styles),
        h('div', { className: 'op-head' },
          h('div', null,
            h('h2', { className: 'op-title' }, t('title')),
            h('p', { className: 'op-desc' }, t('desc')),
          ),
          h('span', { className: 'op-badge' },
            h('span', { className: `op-dot${loggedIn ? ' ok' : ''}` }),
            loggedIn ? t('connected') : t('notLoggedIn'),
          ),
        ),

        loadError ? h('div', { className: 'op-error' }, `${t('errorTitle')}: ${loadError}`) : null,
        error ? h('div', { className: 'op-error' }, `${t('errorTitle')}: ${error}`) : null,

        status
          ? h('div', { className: 'op-card' },
              h('div', { className: 'op-grid' },
                h('div', { className: 'op-stat' },
                  h('div', { className: 'op-stat-label' }, t('account')),
                  h('div', { className: 'op-stat-value' }, status.account?.nickname || status.account?.phone || '—'),
                ),
                h('div', { className: 'op-stat' },
                  h('div', { className: 'op-stat-label' }, t('balance')),
                  h('div', { className: 'op-stat-value' }, formatCny(status.account?.balanceCny)),
                ),
                h('div', { className: 'op-stat' },
                  h('div', { className: 'op-stat-label' }, t('models')),
                  h('div', { className: 'op-stat-value' }, String(status.modelCount ?? 0)),
                ),
                h('div', { className: 'op-stat' },
                  h('div', { className: 'op-stat-label' }, t('groups')),
                  h('div', { className: 'op-stat-value' }, String(status.groupCount ?? 0)),
                ),
              ),
              h('div', { className: 'op-sub' },
                h('span', null, `${t('lastSync')}: ${relativeTime(status.lastSyncAt, t('never'))}`),
                status.autoSync ? h('span', null, t('autoSync')) : null,
                h('span', null, t('balanceHint')),
              ),
              status.lastSyncError ? h('div', { className: 'op-error' }, status.lastSyncError) : null,
              h('div', { className: 'op-actions' },
                h('button', {
                  className: 'op-btn primary',
                  disabled: pending,
                  onClick: onSync,
                }, busy === 'sync' ? t('syncing') : t('sync')),
                h('button', {
                  className: 'op-btn',
                  disabled: pending || !loggedIn,
                  onClick: onLogout,
                }, t('logout')),
              ),
            )
          : null,

        !loggedIn
          ? h('div', { className: 'op-card' },
              h('div', { className: 'op-tabs' },
                h('button', {
                  className: `op-tab${mode === 'sms' ? ' on' : ''}`,
                  onClick: () => setMode('sms'),
                }, t('modeSms')),
                h('button', {
                  className: `op-tab${mode === 'password' ? ' on' : ''}`,
                  onClick: () => setMode('password'),
                }, t('modePassword')),
              ),
              mode === 'sms'
                ? h(React.Fragment, null,
                    h('div', { className: 'op-row' },
                      field(t('phone'), 'phone', { inputMode: 'tel', maxLength: 11, placeholder: '11 位手机号' }),
                      h('button', {
                        className: 'op-btn',
                        disabled: pending || cooldown > 0 || !form.phone.trim(),
                        onClick: sendCode,
                      }, cooldown > 0 ? `${cooldown}${t('resendIn')}` : t('sendCode')),
                    ),
                    field(t('code'), 'code', { inputMode: 'numeric', maxLength: 6, placeholder: '123456', onEnter: loginSms }),
                    h('p', { className: 'op-hint' }, t('hintSms')),
                  )
                : h(React.Fragment, null,
                    field(t('username'), 'username', { autoComplete: 'username' }),
                    field(t('password'), 'password', { type: 'password', autoComplete: 'current-password', onEnter: loginPassword }),
                    h('p', { className: 'op-hint' }, t('hintPassword')),
                  ),
              h('div', { className: 'op-actions' },
                h('button', {
                  className: 'op-btn primary',
                  disabled: pending,
                  onClick: mode === 'sms' ? loginSms : loginPassword,
                }, pending && (busy === 'login' || busy === 'password')
                  ? t('loggingIn')
                  : t('login')),
              ),
            )
          : null,

        status
          ? h('div', { className: 'op-card' },
              h('div', { className: 'op-label' }, t('modelList')),
              status.models?.length
                ? h('div', { className: 'op-models' },
                    status.models.map(model =>
                      h('div', { className: 'op-model', key: model.id },
                        h('div', null,
                          h('div', { className: 'op-model-name' }, model.name || model.id),
                          h('div', { className: 'op-model-id' }, model.id),
                        ),
                        h('div', { className: 'op-chips' },
                          formatContext(model) ? h('span', { className: 'op-chip' }, formatContext(model)) : null,
                          model.discountLabel ? h('span', { className: 'op-chip' }, model.discountLabel) : null,
                          model.free ? h('span', { className: 'op-chip free' }, t('free')) : null,
                          model.catalogSource === 'pricing' ? h('span', { className: 'op-chip' }, t('supplement')) : null,
                          model.group ? h('span', { className: 'op-chip' }, model.group) : null,
                        ),
                      ),
                    ),
                  )
                : h('div', { className: 'op-empty' }, t('emptyModels')),
              h('p', { className: 'op-hint' }, t('hintWhere')),
              h('p', { className: 'op-hint' }, (status.contextSafetyFactor ?? 1) >= 0.999
                ? t('contextReal')
                : t('safetyHint').replaceAll('{pct}', String(Math.round((status.contextSafetyFactor ?? 1) * 100)))),
              status.compat?.enabled
                ? h('p', { className: 'op-hint' },
                    t('compatOn').replaceAll('{targets}', (status.compat.targets ?? []).join('、'))
                    + (status.compat.replyLanguage ? ` · ${t('replyLang')} ${status.compat.replyLanguage}` : ''),
                  )
                : null,
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get?.('locale')
        if (locale?.register) {
          ctx.effect(() => {
            try {
              return locale.register(NS, DICT)
            } catch (error) {
              console.warn('[orange-pro] locale registration failed', error)
              return () => {}
            }
          }, 'orange-pro: locale dictionary')
        }
        const translate = key => {
          try {
            return locale?.bind ? locale.bind(NS)(key) : DICT.zh[key] ?? key
          } catch {
            return DICT.zh[key] ?? key
          }
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'orange-pro',
          order: 60,
          label: () => translate('nav'),
          locale: NS,
        }, Section))
      },
    }
  },
})
