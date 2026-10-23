/**
 * 模型规格表（上下文 / 最大输出 / 价格展示字段）。
 *
 * 数据来源分三级，优先级从高到低：
 *   1. 平台目录字段（contextWindow 等）—— 唯一权威，接入方不应覆盖；
 *   2. 本表的显式值（标注 note：verified=官方文档核实 / estimate=保守估计）；
 *   3. 家族正则兜底。
 *
 * 上下文系数（contextSafetyFactor）：默认 1 = 按平台真实上限展示，不打折；
 * 可显式调小以提前触发压缩，但默认不再制造"1M 显示成 950K"的歧义。
 */

const CONTEXT_FIELDS = ['contextWindow', 'context_window', 'context_length', 'contextLength', 'max_context_tokens', 'max_input_tokens', 'input_token_limit']
const OUTPUT_FIELDS = ['maxTokens', 'max_tokens', 'max_output_tokens', 'maxOutputTokens', 'max_completion_tokens']

/** 显式模型表：id 精确匹配（小写）。note 说明可信度。 */
const EXACT = {
  // DeepSeek（V4.1 Flash 由平台确认支持 1M）
  'deepseek-v4.1-flash': { contextWindow: 1_000_000, maxTokens: 65_536, note: 'verified(平台确认 1M)' },
  'deepseek-v4.1': { contextWindow: 1_000_000, maxTokens: 65_536, note: 'estimate(同系列)' },
  'deepseek-flash': { contextWindow: 1_000_000, maxTokens: 65_536, note: 'verified(与 v4.1-flash 同模型)' },
  // GLM（智谱官方模型概览：GLM-5.3 / 5.2 上下文 1M、输出 128K）
  'glm-5.3': { contextWindow: 1_000_000, maxTokens: 131_072, note: 'verified(智谱官方)' },
  'glm-5.2': { contextWindow: 1_000_000, maxTokens: 131_072, note: 'verified(智谱官方)' },
  // Qwen（3.8-Max 百万上下文；免费 32B 按平台文档 24576 输入上限）
  'qwen3.8-max': { contextWindow: 1_000_000, maxTokens: 65_536, note: 'verified(阿里云文章)' },
  'qwen3.8-flash': { contextWindow: 262_144, maxTokens: 32_768, note: 'estimate' },
  'qwen3.7-max': { contextWindow: 262_144, maxTokens: 32_768, note: 'estimate' },
  'qwen3.7-plus': { contextWindow: 262_144, maxTokens: 32_768, note: 'estimate' },
  'qwen3.6-plus': { contextWindow: 262_144, maxTokens: 32_768, note: 'estimate' },
  'qwen3-32b-free': { contextWindow: 24_576, maxTokens: 8_192, note: 'verified(平台文档输入上限)' },
  // Kimi（K2 系 256K）
  'kimi-k3': { contextWindow: 262_144, maxTokens: 32_768, note: 'estimate' },
  'kimi-k2.7-code': { contextWindow: 262_144, maxTokens: 32_768, note: 'estimate' },
  'kimi-k2.6': { contextWindow: 262_144, maxTokens: 32_768, note: 'estimate' },
  // MiniMax
  'minimax-m2.7': { contextWindow: 196_608, maxTokens: 32_768, note: 'estimate' },
  // Claude（200K 保守，Anthropic 长上下文需额外开关）
  'claude-opus-5': { contextWindow: 200_000, maxTokens: 64_000, note: 'estimate(保守)' },
  'claude-opus-4-8': { contextWindow: 200_000, maxTokens: 64_000, note: 'estimate' },
  'claude-opus-4-7': { contextWindow: 200_000, maxTokens: 64_000, note: 'estimate' },
  'claude-opus-4-6': { contextWindow: 200_000, maxTokens: 64_000, note: 'estimate' },
  'claude-sonnet-5': { contextWindow: 200_000, maxTokens: 64_000, note: 'estimate(保守)' },
  'claude-fable-5-1': { contextWindow: 200_000, maxTokens: 64_000, note: 'estimate(保守)' },
  'claude-haiku-4-5': { contextWindow: 200_000, maxTokens: 64_000, note: 'estimate' },
  // GPT-5 系（400K 保守）
  'gpt-5.5': { contextWindow: 400_000, maxTokens: 128_000, note: 'estimate' },
  'gpt-5.6-sol': { contextWindow: 400_000, maxTokens: 128_000, note: 'estimate' },
  'gpt-5.6-terra': { contextWindow: 400_000, maxTokens: 128_000, note: 'estimate' },
  'gpt-5.6-luna': { contextWindow: 400_000, maxTokens: 128_000, note: 'estimate' },
  // Gemini（1M）
  'gemini-3.8-flash': { contextWindow: 1_048_576, maxTokens: 65_536, note: 'estimate' },
  'gemini-3.7-flash': { contextWindow: 1_048_576, maxTokens: 65_536, note: 'estimate' },
  'gemini-3.6-flash': { contextWindow: 1_048_576, maxTokens: 65_536, note: 'estimate' },
  'gemini-3.5-flash': { contextWindow: 1_048_576, maxTokens: 65_536, note: 'estimate' },
  'gemini-3.5-flash-lite': { contextWindow: 1_048_576, maxTokens: 65_536, note: 'estimate' },
  'gemini-3.1-pro-preview': { contextWindow: 1_048_576, maxTokens: 65_536, note: 'estimate' },
  'gemini-3.1-flash-lite-preview': { contextWindow: 1_048_576, maxTokens: 65_536, note: 'estimate' },
  'gemini-3.1-flash-lite': { contextWindow: 1_048_576, maxTokens: 65_536, note: 'estimate' },
  'gemini-3-flash-preview': { contextWindow: 1_048_576, maxTokens: 65_536, note: 'estimate' },
  'gemini-2.5-pro': { contextWindow: 1_048_576, maxTokens: 65_536, note: 'verified(官方 1M)' },
}

/** 家族兜底（没有精确 id 时）。顺序敏感：更具体的规则必须排在前面。 */
const FAMILY = [
  { test: /gemini/i, contextWindow: 1_048_576, maxTokens: 65_536 },
  { test: /gpt-5|gpt-4\.1/i, contextWindow: 400_000, maxTokens: 128_000 },
  { test: /claude/i, contextWindow: 200_000, maxTokens: 64_000 },
  // DeepSeek V4 家族（含 -pro-oc / -2.5 之类的渠道变体）统一按 1M；老版本仍在下面的兜底里。
  { test: /deepseek[^/]*v4/i, contextWindow: 1_000_000, maxTokens: 65_536 },
  { test: /deepseek/i, contextWindow: 131_072, maxTokens: 32_768 },
  { test: /kimi|moonshot/i, contextWindow: 262_144, maxTokens: 32_768 },
  { test: /qwen|qwq|qvq/i, contextWindow: 131_072, maxTokens: 32_768 },
  { test: /glm|chatglm/i, contextWindow: 1_000_000, maxTokens: 131_072 },
  { test: /minimax/i, contextWindow: 196_608, maxTokens: 32_768 },
  { test: /grok/i, contextWindow: 262_144, maxTokens: 32_768 },
]

const FALLBACK = { contextWindow: 65_536, maxTokens: 8_192 }

function positive(source, keys) {
  for (const key of keys) {
    const value = Number(source?.[key])
    if (Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return undefined
}

/** 原始规格（未乘安全垫）。 */
export function resolveModelSpec(model) {
  const id = String(model?.id ?? '').toLowerCase()
  const exact = EXACT[id]
  const family = FAMILY.find(entry => entry.test.test(id))
  const contextFromCatalog = positive(model, CONTEXT_FIELDS)
  const outputFromCatalog = positive(model, OUTPUT_FIELDS)

  const contextWindow = contextFromCatalog ?? exact?.contextWindow ?? family?.contextWindow ?? FALLBACK.contextWindow
  const maxTokens = outputFromCatalog ?? exact?.maxTokens ?? family?.maxTokens ?? FALLBACK.maxTokens
  return {
    contextWindow,
    maxTokens: Math.min(maxTokens, Math.floor(contextWindow / 2) || maxTokens),
    source: contextFromCatalog !== undefined ? 'catalog' : exact ? 'table' : family ? 'family' : 'fallback',
    note: contextFromCatalog !== undefined ? 'catalog' : exact?.note ?? (family ? 'family-fallback' : 'default'),
  }
}

/** 乘安全垫后的有效上下文（DSH 用它做压缩阈值）。 */
export function applySafety(spec, factor) {
  const f = Number(factor)
  const ratio = Number.isFinite(f) && f > 0 && f <= 1 ? f : 1
  const contextWindow = Math.max(1, Math.floor(spec.contextWindow * ratio))
  return {
    ...spec,
    contextWindow,
    maxTokens: Math.min(spec.maxTokens, Math.floor(contextWindow / 2) || spec.maxTokens),
    safety: ratio,
  }
}

/** 应用按模型覆盖（覆盖值视为"真实上限"，之后仍会乘安全垫）。 */
export function applyOverride(spec, override) {
  if (!override || typeof override !== 'object') return spec
  const contextWindow = Number(override.contextWindow)
  const maxTokens = Number(override.maxTokens)
  const next = {
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : spec.contextWindow,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : spec.maxTokens,
    source: contextWindow > 0 || maxTokens > 0 ? 'override' : spec.source,
    note: 'override',
  }
  next.maxTokens = Math.min(next.maxTokens, Math.floor(next.contextWindow / 2) || next.maxTokens)
  return next
}

/** 推断（不看目录字段），供 adapter 兜底。 */
export function inferModelSpec(modelId) {
  const { contextWindow, maxTokens } = resolveModelSpec({ id: modelId })
  return { contextWindow, maxTokens }
}

export { EXACT as MODEL_SPEC_TABLE }
