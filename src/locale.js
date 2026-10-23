/**
 * 语言解析：决定"答复规范"里应该要求模型用什么语言回复。
 *
 * 优先级：
 *   1. 显式配置 `compat.language`（BCP 47，如 `ja-JP`；`auto` 表示自动）；
 *   2. 客户端回报的当前 DSH 语言（`<html lang>`，由 locale 插件同步）；
 *   3. Host 的系统 locale（`Intl.DateTimeFormat().resolvedOptions().locale`）；
 *   4. 兜底英文。
 *
 * 规范文本用英文书写（各语种模型都能理解），只把"目标语言"替换进去；
 * 同时保留"用户用别的语言时跟随用户"的兜底。
 */

const MANUAL_LABELS = {
  zh: 'Chinese',
  'zh-cn': 'Simplified Chinese',
  'zh-sg': 'Simplified Chinese',
  'zh-hans': 'Simplified Chinese',
  'zh-tw': 'Traditional Chinese',
  'zh-hk': 'Traditional Chinese',
  'zh-mo': 'Traditional Chinese',
  'zh-hant': 'Traditional Chinese',
}

/** 把任意输入规整成 BCP 47 风格的标签；不可用时返回空串。 */
export function normalizeLocale(value) {
  const raw = String(value ?? '').trim().replace(/_/g, '-')
  if (!raw) return ''
  try {
    return Intl.getCanonicalLocales(raw)[0] ?? ''
  } catch {
    return ''
  }
}

/** Host 侧可用的系统语言（Node ICU）。 */
export function detectHostLocale() {
  const fromIntl = normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale)
  if (fromIntl) return fromIntl
  const env = normalizeLocale(process.env.LANG || process.env.LC_ALL || '')
  return env || 'en'
}

/** 给模型看的目标语言名（英文名，必要时区分简繁）。 */
export function languageLabel(locale) {
  const normalized = normalizeLocale(locale)
  if (!normalized) return 'English'
  const lower = normalized.toLowerCase()
  if (MANUAL_LABELS[lower]) return MANUAL_LABELS[lower]
  const base = lower.split('-')[0]
  if (MANUAL_LABELS[base]) return MANUAL_LABELS[base]
  try {
    const display = new Intl.DisplayNames(['en'], { type: 'language' })
    return display.of(base) || base
  } catch {
    return base
  }
}

/**
 * @param {{ configured?: string, clientLocale?: string, hostLocale?: string }} input
 * @returns {{ locale: string, language: string, source: 'config'|'client'|'host'|'fallback' }}
 */
export function resolveReplyLanguage(input = {}) {
  const configured = String(input.configured ?? 'auto').trim()
  if (configured && configured.toLowerCase() !== 'auto') {
    const locale = normalizeLocale(configured) || ''
    return { locale: locale || configured, language: languageLabel(locale || configured), source: 'config' }
  }
  const client = normalizeLocale(input.clientLocale)
  if (client) return { locale: client, language: languageLabel(client), source: 'client' }
  const host = normalizeLocale(input.hostLocale)
  if (host) return { locale: host, language: languageLabel(host), source: 'host' }
  return { locale: 'en', language: 'English', source: 'fallback' }
}

/** 生成默认答复规范（英文书写，插入目标语言）。 */
export function buildCompatPrompt(language) {
  const target = String(language || 'English')
  return [
    '[Response guidelines]',
    `1. Reply in ${target}; if the user writes in a different language, follow the user's language.`,
    '2. Start with the conclusion, then supporting details; do not narrate your reasoning process.',
    '3. Do not output process narration (such as "Let me…" or "Good progress…"); the UI already shows tool activity.',
  ].join('\n')
}
