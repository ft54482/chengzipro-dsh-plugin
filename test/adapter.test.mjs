/**
 * Adapter 请求构造自测（不依赖 DSH、不需要网络）。
 * 重点验证：DeepSeek 思考模式必须回传 reasoning_content，其他模型不回传。
 * 用法：node tools/test-adapter.mjs
 */
import { buildChatBody, OrangeProAdapter } from '../src/adapter.js'
import { resolveModelSpec, applyOverride, applySafety } from '../src/model-spec.js'
import { compatPromptFor } from '../src/model-compat.js'
import { resolveReplyLanguage } from '../src/locale.js'
import { deriveDiscountLabel } from '../src/discount.js'
import { extractPricingTextModels } from '../src/catalog-extra.js'
import { isValidRecordKey, recordKey, sanitizeScope } from '../src/credential-key.js'

let failures = 0
const ok = (label, condition, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
  if (!condition) failures++
}

const history = [
  { role: 'user', content: [{ type: 'text', text: '帮我查一下天气' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '用户想查天气，需要调用工具。' },
      { type: 'text', text: '我来查一下。' },
      { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
    ],
  },
  { role: 'tool', content: [{ type: 'text', text: '晴，26 度' }], toolCallId: 'call_1' },
  { role: 'user', content: [{ type: 'text', text: '那要带伞吗？' }] },
]

const options = {
  provider: 'orange-pro',
  messages: history,
  system: '你是助手',
}

const deepseek = buildChatBody({ ...options, model: 'deepseek-v4.1-flash' }, { reasoning: { efforts: [] } })
const assistant = deepseek.messages.find(message => message.role === 'assistant')
ok('deepseek: assistant history carries reasoning_content', assistant?.reasoning_content === '用户想查天气，需要调用工具。')
ok('deepseek: tool_calls preserved', assistant?.tool_calls?.[0]?.id === 'call_1' && assistant.tool_calls[0].function.name === 'get_weather')
ok('deepseek: tool arguments stay raw JSON string', assistant?.tool_calls?.[0]?.function?.arguments === '{"city":"北京"}')
ok('deepseek: tool result mapped with tool_call_id', deepseek.messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_1'))
ok('deepseek: system prompt passes through', deepseek.messages[0].role === 'system')

const gpt = buildChatBody({ ...options, model: 'gpt-5.5' }, { reasoning: { efforts: [] } })
const gptAssistant = gpt.messages.find(message => message.role === 'assistant')
ok('non-deepseek: reasoning_content omitted', gptAssistant && !('reasoning_content' in gptAssistant))
ok('non-deepseek: tool_calls still preserved', gptAssistant?.tool_calls?.length === 1)

const noHistory = buildChatBody({
  provider: 'orange-pro',
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
}, undefined)
ok('first turn has no assistant message', !noHistory.messages.some(m => m.role === 'assistant'))

// 上游没打包 reasoning：带 tool_calls 的 assistant 消息必须补兜底，否则 DeepSeek 报 INVALID_REQUEST。
const missingReasoning = [
  { role: 'user', content: [{ type: 'text', text: '查天气' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '我查一下' },
      { type: 'tool-call', id: 'call_9', name: 'get_weather', arguments: '{}' },
    ],
  },
  { role: 'tool', content: [{ type: 'text', text: '晴' }], toolCallId: 'call_9' },
]
const emptyFallback = buildChatBody({ provider: 'orange-pro', model: 'deepseek-v4.1-flash', messages: missingReasoning }, undefined)
const emptyAssistant = emptyFallback.messages.find(m => m.role === 'assistant')
ok('missing reasoning: empty string fallback injected', emptyAssistant?.reasoning_content === '')

const contentFallback = buildChatBody(
  { provider: 'orange-pro', model: 'deepseek-v4.1-flash', messages: missingReasoning },
  undefined,
  { reasoningFallback: 'content' },
)
const contentAssistant = contentFallback.messages.find(m => m.role === 'assistant')
ok('missing reasoning: content fallback is non-empty', typeof contentAssistant?.reasoning_content === 'string' && contentAssistant.reasoning_content.length > 0)

const nonThinking = buildChatBody({ provider: 'orange-pro', model: 'gpt-5.5', messages: missingReasoning }, undefined)
ok('non-deepseek never gets fallback', !('reasoning_content' in (nonThinking.messages.find(m => m.role === 'assistant') ?? {})))

ok('small max_tokens omitted (thinking models)', buildChatBody({ ...options, model: 'deepseek-v4.1-flash', maxTokens: 64 }, undefined).max_tokens === undefined)
ok('large max_tokens kept', buildChatBody({ ...options, model: 'deepseek-v4.1-flash', maxTokens: 4096 }, undefined).max_tokens === 4096)

// ---- 模型规格：目录优先 / 规格表 / 安全垫 / 按模型覆盖 ----
const table = resolveModelSpec({ id: 'deepseek-v4.1-flash' })
ok('spec: explicit table wins without catalog field', table.contextWindow === 1_000_000, `ctx=${table.contextWindow} source=${table.source}`)

const fromCatalog = resolveModelSpec({ id: 'deepseek-v4.1-flash', context_window: 2_000_000, max_output_tokens: 64_000 })
ok('spec: catalog context wins over table', fromCatalog.contextWindow === 2_000_000 && fromCatalog.source === 'catalog', `ctx=${fromCatalog.contextWindow}`)

// 平台新增的渠道变体（大小写/后缀不同）也要按 V4 → 1M，而不是落到 generic deepseek 的 128K
for (const variant of ['DeepSeek-V4.1-flash-2.5', 'deepseek-v4-pro-oc', 'deepseek-v4.1-flash-cc']) {
  const spec = resolveModelSpec({ id: variant })
  ok(`spec: variant ${variant} → 1M`, spec.contextWindow === 1_000_000, `ctx=${spec.contextWindow} source=${spec.source}`)
}
ok('spec: deepseek-flash is 1M (same model)', resolveModelSpec({ id: 'deepseek-flash' }).contextWindow === 1_000_000)
ok('spec: unknown legacy deepseek still conservative', resolveModelSpec({ id: 'deepseek-chat-v3' }).contextWindow === 131_072)

const effective = applySafety(table, 0.95)
ok('spec: 95% factor applied when configured', effective.contextWindow === 950_000, `ctx=${effective.contextWindow}`)
ok('spec: default factor 1 keeps real limit', applySafety(table, 1).contextWindow === 1_000_000)

const overridden = applyOverride(table, { contextWindow: 2_000_000 })
ok('spec: override wins before safety', overridden.contextWindow === 2_000_000 && overridden.source === 'override')
ok('spec: override + safety', applySafety(overridden, 0.95).contextWindow === 1_900_000)
ok('spec: maxTokens capped by context/2', applyOverride(table, { contextWindow: 100, maxTokens: 999 }).maxTokens <= 50)

// ---- 模型答复规范（兼容层） ----
ok('compat: hits deepseek-v4.1-flash', compatPromptFor('deepseek-v4.1-flash').includes('Response guidelines'))
ok('compat: hits deepseek-flash', compatPromptFor('deepseek-flash').includes('Response guidelines'))
ok('compat: default language is English', compatPromptFor('deepseek-flash').includes('Reply in English'))
ok('compat: follows detected language', compatPromptFor('deepseek-v4.1-flash', {}, 'Japanese').includes('Reply in Japanese'))
ok('compat: traditional Chinese label', compatPromptFor('deepseek-v4.1-flash', {}, 'Traditional Chinese').includes('Traditional Chinese'))
ok('compat: skips other models', compatPromptFor('gpt-5.5') === '')
ok('compat: disabled switch', compatPromptFor('deepseek-flash', { enabled: false }) === '')
ok('compat: custom prompt', compatPromptFor('deepseek-flash', { prompt: 'CUSTOM' }) === 'CUSTOM')
ok('compat: per-model override', compatPromptFor('deepseek-flash', { overrides: { 'deepseek-flash': 'OVERRIDE' } }) === 'OVERRIDE')

// ---- 回复语言解析：配置 > 客户端 > 系统 > 英文 ----
ok('locale: config wins', resolveReplyLanguage({ configured: 'fr-FR', clientLocale: 'en-US' }).source === 'config')
ok('locale: client wins over host', resolveReplyLanguage({ clientLocale: 'ja-JP', hostLocale: 'zh-CN' }).language === 'Japanese')
ok('locale: host fallback', resolveReplyLanguage({ hostLocale: 'de-DE' }).language === 'German')
ok('locale: fallback English', resolveReplyLanguage({}).language === 'English')
ok('locale: zh-TW traditional', resolveReplyLanguage({ clientLocale: 'zh-TW' }).language === 'Traditional Chinese')
ok('locale: zh-CN simplified', resolveReplyLanguage({ clientLocale: 'zh-CN' }).language === 'Simplified Chinese')

const withCompat = buildChatBody(
  { provider: 'orange-pro', model: 'deepseek-v4.1-flash', system: 'BASE', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
  undefined,
  { compat: 'DIRECTIVE' },
)
ok('compat: appended after original system',
  withCompat.messages[0].role === 'system' && withCompat.messages[0].content.includes('BASE') && withCompat.messages[0].content.includes('DIRECTIVE'))
ok('compat: empty directive leaves system untouched', (() => {
  const body = buildChatBody({ provider: 'orange-pro', model: 'gpt-5.5', system: 'BASE', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, undefined, { compat: '' })
  return body.messages[0].content === 'BASE'
})())

// ---- 目录补全：从 pricing 提取 BFF 目录漏掉的文本模型 ----
const pricingItems = [
  { model_name: 'claude-opus-5-5-CC', quota_type: 0, enable_groups: ['claude-enterprise'], supported_endpoint_types: ['openai'] },
  { model_name: 'claude-opus-5-5-CC', quota_type: 0, enable_groups: ['dup'], supported_endpoint_types: ['openai'] },
  { model_name: 'gpt-image-x', quota_type: 1, enable_groups: ['vip'], supported_endpoint_types: ['openai'] },
  { model_name: 'video-x', quota_type: 1, enable_groups: ['vip'], supported_endpoint_types: ['h3-video'] },
  { model_name: 'already-known', quota_type: 0, enable_groups: ['vip'], supported_endpoint_types: ['openai'] },
]
const extras = extractPricingTextModels(pricingItems, ['already-known'])
ok('catalog+: keeps missing text model', extras.length === 1 && extras[0].id === 'claude-opus-5-5-CC')
ok('catalog+: carries enable group', extras[0]?.group === 'claude-enterprise' && extras[0].groups.length === 1)
ok('catalog+: marks source', extras[0]?.catalogSource === 'pricing')
ok('catalog+: skips image/video/known', !extras.some(item => ['gpt-image-x', 'video-x', 'already-known'].includes(item.id)))

// ---- 凭据记录键：两段式；非法键绝不写盘 ----
ok('cred: two-segment key is valid', isValidRecordKey('orange-pro/session'))
ok('cred: three-segment key is rejected', !isValidRecordKey('orange-pro/orange-pro/session'))
ok('cred: uppercase segment is rejected', !isValidRecordKey('Orange/session'))
ok('cred: underscore segment is rejected', !isValidRecordKey('orange_pro/session'))
ok('cred: recordKey normalizes providerId', recordKey('Orange Pro!', 'session') === 'orange-pro/session')
ok('cred: recordKey keeps keys suffix', recordKey('orange-pro', 'keys') === 'orange-pro/keys')
ok('cred: sanitizeScope falls back', sanitizeScope('!!!', 'orange-pro') === 'orange-pro')

// ---- 折扣标签：优先平台文案，缺失时用 discountRatio 推导 ----
ok('discount: platform label wins', deriveDiscountLabel({ discountLabel: '3.8折', discountRatio: 0.38 }) === '3.8折')
ok('discount: derive 2.5 from ratio', deriveDiscountLabel({ discountLabel: null, discountRatio: 0.25 }) === '2.5折')
ok('discount: derive integer zhe', deriveDiscountLabel({ discountRatio: 0.9 }) === '9折')
ok('discount: full price hidden', deriveDiscountLabel({ discountRatio: 1 }) === '')
ok('discount: missing ratio yields nothing', deriveDiscountLabel({}) === '')
ok('discount: live 2.5 model gets 折 suffix', deriveDiscountLabel({ discountLabel: null, discountRatio: 0.25, groupRatio: 1 }) === '2.5折')


// ---- LlmAdapter 可选成员：漏实现会让 DSH 的「上下文压缩」计价直接 TypeError ----
{
  const adapter = new OrangeProAdapter({
    catalog: () => [],
    findModel: () => undefined,
    visionOverrides: () => ({}),
    compatPrompt: () => '',
  })
  ok('adapter: imageRequestPricing exists (compaction pricing)', typeof adapter.imageRequestPricing === 'function')
  ok('adapter: imageRequestPricing returns undefined (platform bills tokens)', adapter.imageRequestPricing('orange-pro', 'deepseek-v4.1-flash') === undefined)
  const target = adapter.imageRequestTarget('orange-pro', 'deepseek-v4.1-flash', { width: 4096, height: 2048, bytes: 3_000_000 })
  ok('adapter: imageRequestTarget scales to 4MP budget', target.width === 2896 && target.height === 1448 && target.maxBytes === 1_048_576)
  const small = adapter.imageRequestTarget('orange-pro', 'deepseek-v4.1-flash', { width: 800, height: 600, bytes: 100_000 })
  ok('adapter: imageRequestTarget keeps small images', small.width === 800 && small.height === 600)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)