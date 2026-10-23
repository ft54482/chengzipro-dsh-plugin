/**
 * 模型答复规范（兼容层）。
 *
 * 背景：同一模型经中转站转发时，风格可能和官方直连不一致（英文过程旁白、结论少、把内部推理写进正文）。
 * 与其让每个客户自己在会话里补指令，插件对指定模型自动追加一段 system 规范；可配置、可关闭。
 *
 * 语言策略：规范文本用英文书写（各语种模型都能理解），目标语言从客户系统/DSH 语言解析后插入；
 * 同时保留"用户用别的语言时跟随用户"。不假设客户是中文用户。
 */
import { buildCompatPrompt } from './locale.js'

export const DEFAULT_TARGETS = ['deepseek-v4.1-flash', 'deepseek-flash', 'deepseek-v4.1']

/** 兼容旧导出：英文规范。 */
export const DEFAULT_PROMPT = buildCompatPrompt('English')

/**
 * @param {string} modelId
 * @param {{ enabled?: boolean, targets?: string[], prompt?: string, overrides?: Record<string,string> }} [compat]
 * @param {string} [language] 目标语言英文名（如 "Japanese"）；缺省英文
 * @returns {string} 需要追加的规范文本；空串表示不追加
 */
export function compatPromptFor(modelId, compat = {}, language = 'English') {
  if (compat.enabled === false) return ''
  const id = String(modelId ?? '')
  if (!id) return ''

  const overrides = compat.overrides && typeof compat.overrides === 'object' ? compat.overrides : {}
  if (typeof overrides[id] === 'string') return overrides[id]

  const targets = Array.isArray(compat.targets) && compat.targets.length > 0 ? compat.targets : DEFAULT_TARGETS
  if (!targets.includes(id)) return ''

  if (typeof compat.prompt === 'string' && compat.prompt.trim()) return compat.prompt
  return buildCompatPrompt(language)
}
