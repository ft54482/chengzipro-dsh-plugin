/**
 * DSH LLM adapter：把橙子平台的 openai-chat 模型暴露成 provider 路由。
 *
 * 关键协议点：
 * - 按模型目录里的 group 取该组密钥（service.inferenceTarget）；
 * - 401/403 → 重拉分组密钥重试一次；503 model_not_found → 刷新目录重试一次；
 * - 思考型模型 max_tokens 过小会返回空 content，小于 1024 时不传该字段。
 */
import { readSSE, PlatformError } from './platform.js'
import { llmError, fromPlatformError } from './llm-errors.js'
import { inferModelSpec } from './model-spec.js'
import { collectImageRefs, modalitiesFor } from './vision.js'

const APP_USER_AGENT = 'deepseek-harness/0.2.1 (+https://github.com/deepseek-ai/deepseek-harness)'
const MIN_SAFE_MAX_TOKENS = 1024

/** 模型显示名：原名 + 平台目录里的折扣标签（如 "· 3.8折"），让选择器里能直接看到倍率。 */
function displayNameOf(entry, fallbackId) {
  const base = entry?.name || fallbackId
  const label = typeof entry?.discountLabel === 'string' ? entry.discountLabel.trim() : ''
  return label ? `${base} · ${label}` : base
}

export class OrangeProAdapter {
  /** @param {import('./service.js').OrangeProService} service */
  constructor(service) {
    this.service = service
  }

  providerInfo(provider) {
    return { id: provider, name: this.service.displayName() }
  }

  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      backoff: { initialDelayMs: 800, maxDelayMs: 15_000, jitterRatio: 0.15 },
    }
  }

  async listModels(provider) {
    const overrides = this.service.visionOverrides?.() ?? {}
    return this.service.catalog().map(entry => ({
      provider,
      id: entry.id,
      name: displayNameOf(entry, entry.id),
      // 视觉模型必须声明 image，否则 DSH 在上传附件时就拒绝（MODEL_DOES_NOT_SUPPORT_IMAGES）。
      inputModalities: modalitiesFor(entry.id, entry, overrides),
    }))
  }

  async resolveModel(provider, model) {
    const entry = this.service.findModel(model)
    const overrides = this.service.visionOverrides?.() ?? {}
    const spec = {
      contextWindow: entry?.contextWindow ?? inferModelSpec(model).contextWindow,
      maxTokens: entry?.maxTokens ?? inferModelSpec(model).maxTokens,
    }
    const info = {
      provider,
      id: model,
      name: displayNameOf(entry, model),
      inputModalities: modalitiesFor(model, entry, overrides),
    }
    if (Number.isInteger(spec.contextWindow) && spec.contextWindow > 0) {
      info.context = { contextWindow: spec.contextWindow }
    }
    const maxTokens = Math.max(1, Math.min(spec.maxTokens, Math.floor(spec.contextWindow / 2)))
    info.defaultMaxTokens = maxTokens
    const reasoning = inferReasoning(model)
    if (reasoning) info.reasoning = reasoning
    return info
  }

  async prepareCall(provider, model, signal) {
    const info = await this.resolveModel(provider, model, signal)
    return { model: info, stream: options => this.stream(options, info) }
  }

  async *stream(options, resolvedInfo) {
    const info = resolvedInfo ?? (await this.resolveModel(options.provider, options.model))
    // 模型答复规范（兼容层）：只对配置命中的模型追加，跟随用户语言、先结论后依据。
    const compat = this.service.compatPrompt(options.model)
    // 图片输入：视觉模型才把 ImageBlock 解析成 data URL；非视觉模型交给占位文本。
    const images = await this.#prepareImages(options, info)
    let body = buildChatBody(options, info, { compat, images })

    let response = await this.#dispatchSafe(body, options.signal)
    // 自愈：分组密钥失效 → 重拉密钥；模型/分组不匹配 → 刷新目录。
    if (response.status === 401 || response.status === 403) {
      await this.#ignore(() => this.service.refreshKeys())
      response = await this.#dispatchSafe(body, options.signal)
    } else if (response.status === 503) {
      const failure = await readFailure(response)
      if (failure?.code === 'model_not_found') {
        await this.#ignore(() => this.service.sync({ force: true }))
        response = await this.#dispatchSafe(body, options.signal)
      } else {
        throw llmError('SERVER', failure?.message ?? '上游模型不可用')
      }
    } else if (response.status === 400) {
      // 网关/上游没把 history 的 reasoning 打包回来时，补一个非空兜底再试一次。
      const failure = await readFailure(response)
      if (/reasoning_content/i.test(failure?.message ?? '')) {
        body = buildChatBody(options, info, { reasoningFallback: 'content', compat, images })
        response = await this.#dispatchSafe(body, options.signal)
      }
    }
    if (!response.ok) {
      const failure = await readFailure(response)
      // 视觉兜底：模型被声明为可收图、但上游明确拒绝图片时给出可读中文，
      // 而不是把上游的 "type 参数非法，取值范围 ['text']" 直接甩给用户。
      if (looksLikeVisionRejection(failure?.message)) {
        throw llmError(
          'INVALID_REQUEST',
          `当前模型「${options.model}」不接受图片输入。请换用支持视觉的模型（如 deepseek-v4.1-flash / DeepSeek-V4.1-flash-2.5 / gpt-5.x / gemini-3.x），或在设置里把该模型加入 vision.exclude。`,
        )
      }
      throw fromPlatformError(
        new PlatformError(
          response.status === 401 ? 'AUTH'
            : response.status === 403 ? 'FORBIDDEN'
              : response.status === 429 ? 'RATE_LIMIT'
                : response.status >= 500 ? 'SERVER' : 'HTTP',
          failure?.message ?? `HTTP ${response.status}`,
          { status: response.status, detail: failure },
        ),
      )
    }

    const state = { blocks: [], byKey: new Map() }
    const usage = { inputTokens: 0, outputTokens: 0 }
    let finishReason
    let sawDone = false

    try {
      for await (const event of readSSE(response.body, options.signal)) {
        if (event?.done) {
          sawDone = true
          break
        }
        if (event?.error) {
          throw llmError('SERVER', String(event.error?.message ?? event.error?.code ?? '上游流式错误'))
        }
        if (event?.usage) mergeUsage(usage, event.usage)
        const choice = Array.isArray(event?.choices) ? event.choices[0] : undefined
        if (!choice) continue
        const delta = choice.delta ?? {}

        const reasoningText =
          typeof delta.reasoning_content === 'string' ? delta.reasoning_content
            : typeof delta.reasoning === 'string' ? delta.reasoning : ''
        if (reasoningText) yield* emitText(state, 'reasoning', reasoningText)
        if (typeof delta.content === 'string' && delta.content) yield* emitText(state, 'text', delta.content)
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) yield* emitToolCall(state, call)
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }
    } catch (error) {
      if (options.signal?.aborted) throw llmError('ABORTED', '请求已取消')
      if (error?.failure) throw error
      throw fromPlatformError(error)
    }

    if (state.blocks.length === 0) {
      throw llmError('EMPTY_RESPONSE', '平台返回了空响应（思考型模型可能在 max_tokens 过小时不产出正文）。')
    }
    if (!sawDone && finishReason === undefined) {
      throw llmError('STREAM_CLOSED', '平台的流在中途关闭，没有收到结束标记。')
    }

    for (const block of state.blocks) {
      if (block.closed) continue
      block.closed = true
      if (block.type === 'tool-call') {
        yield {
          type: 'block-end',
          index: block.index,
          block: {
            type: 'tool-call',
            id: block.id || `call-${block.index}`,
            name: block.name,
            arguments: block.args || '{}',
          },
        }
      } else {
        yield { type: 'block-end', index: block.index, block: { type: block.type, text: block.text } }
      }
    }

    const hasToolCall = state.blocks.some(block => block.type === 'tool-call')
    usage.totalTokens =
      usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: mapFinishReason(finishReason, hasToolCall) }
  }

  async #dispatch(body, signal) {
    const target = await this.service.inferenceTarget(body.model)
    return this.service.platform().chat({
      apiBase: target.apiBase,
      apiKey: target.apiKey,
      body,
      signal,
      headers: { 'User-Agent': APP_USER_AGENT },
    })
  }

  /** 分发并把平台错误转成 LLM 失败码（缺凭据/未登录/网络）。 */
  async #dispatchSafe(body, signal) {
    try {
      return await this.#dispatch(body, signal)
    } catch (error) {
      if (error?.failure) throw error
      if (signal?.aborted) throw llmError('ABORTED', '请求已取消')
      throw fromPlatformError(error)
    }
  }

  async #ignore(operation) {
    try {
      await operation()
    } catch {
      // 自愈失败不掩盖原始错误
    }
  }

  /**
   * 把本轮用户消息里的图片解析成 data URL（按 attachmentId 去重）。
   * 读失败不炸整轮：记下错误，序列化时退化为占位文本，并在日志里留证据。
   */
  async #prepareImages(options, info) {
    const images = new Map()
    const supportsImage = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
    if (!supportsImage) return images
    const refs = collectImageRefs(options.messages)
    if (refs.length === 0) return images
    await Promise.all(refs.map(async ref => {
      try {
        images.set(ref.attachmentId, { dataUrl: await this.service.imageDataUrl(ref, options.signal) })
      } catch (error) {
        const message = String(error?.message ?? error)
        images.set(ref.attachmentId, { error: message })
        this.service.ctx?.logger?.warn?.(`orange-pro: image attachment ${ref.attachmentId} unavailable: ${message}`)
      }
    }))
    return images
  }
}

function buildChatBody(options, info, { reasoningFallback = 'empty', compat = '', images } = {}) {
  const system = [options.system, compat]
    .filter(text => typeof text === 'string' && text.trim())
    .join('\n\n')
  const body = {
    model: options.model,
    messages: toOpenAIMessages({ ...options, system }, {
      echoReasoning: needsReasoningEcho(options.model),
      reasoningFallback,
      images,
    }),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (options.tools?.length) {
    body.tools = toOpenAITools(options.tools)
    body.tool_choice = 'auto'
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  const maxTokens = Number(options.maxTokens)
  // 文档实测：思考型模型给小 max_tokens 会返回空 content；宁可省略让平台自决。
  if (Number.isFinite(maxTokens) && maxTokens >= MIN_SAFE_MAX_TOKENS) body.max_tokens = maxTokens
  if (info?.reasoning && options.reasoningEffort) body.reasoning_effort = String(options.reasoningEffort)
  return body
}

async function readFailure(response) {
  try {
    const text = await response.text()
    const payload = text ? JSON.parse(text) : undefined
    const failure = payload?.error
    if (failure && typeof failure === 'object') {
      return { code: String(failure.code ?? ''), message: String(failure.message ?? '') }
    }
    return { code: '', message: String(payload?.error ?? payload?.message ?? text.slice(0, 200)) }
  } catch {
    return undefined
  }
}

/** 每个逻辑块（文本 / 推理 / 每个工具调用）在流里的位置与已宣告状态。 */
function blockFor(state, key, type) {
  let block = state.byKey.get(key)
  if (!block) {
    block = {
      key, type,
      index: state.blocks.length,
      text: '', id: '', name: '', args: '',
      closed: false, announced: false,
    }
    state.blocks.push(block)
    state.byKey.set(key, block)
  }
  return block
}

function* emitText(state, kind, text) {
  const block = blockFor(state, kind, kind)
  if (!block.announced) {
    block.announced = true
    yield { type: 'block-start', index: block.index, blockType: kind }
  }
  if (block.closed) return
  block.text += text
  yield { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text }
}

function* emitToolCall(state, call) {
  const slot = Number.isInteger(call?.index) ? call.index : 0
  const block = blockFor(state, `tool:${slot}`, 'tool-call')
  if (!block.announced) {
    block.announced = true
    yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
  }
  if (block.closed) return
  const fn = call?.function ?? {}
  if (typeof call?.id === 'string' && call.id) block.id = call.id
  if (typeof fn.name === 'string' && fn.name) block.name = fn.name
  const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : ''
  if (argsDelta) block.args += argsDelta
  yield {
    type: 'tool-call-delta',
    index: block.index,
    id: block.id || `call-${block.index}`,
    ...(fn.name ? { name: fn.name } : {}),
    argumentsDelta: argsDelta,
  }
}

function mapFinishReason(raw, hasToolCall) {
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'content_filter':
    case 'sensitive':
      return { kind: 'stop' }
    case 'aborted':
      return { kind: 'aborted', failure: { code: 'ABORTED', message: '平台中止了这次生成' } }
    case 'error':
    case 'insufficient_system_resource':
      return { kind: 'error', failure: { code: 'SERVER', message: `平台报告生成失败：${String(raw)}` } }
    case 'stop':
    case 'stop_sequence':
    case 'end_turn':
      return hasToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
    case undefined:
    case null:
    case '':
      return hasToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
    default:
      return { kind: 'stop' }
  }
}

const REASONING_PATTERN = /(reason|thinking|think\b|r1\b|o1|o3|o4|gpt-5|deepseek-v4|deepseek-r|glm-5|qwq|qvq|-max\b)/i

function inferReasoning(modelId) {
  if (!REASONING_PATTERN.test(String(modelId))) return undefined
  return {
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'medium',
  }
}

function plainText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

/** 历史里的推理块文本（DeepSeek 思考模式要求原样回传）。 */
function plainReasoning(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'reasoning' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * 是否需要把历史 `reasoning_content` 回传给 API。
 * DeepSeek 思考模式在多轮/工具调用时必须回传，否则报
 * INVALID_REQUEST "The `reasoning_content` in the thinking mode must be passed back to the API."
 * 其他网关（claude/gpt/gemini 转发）不认这个字段，传了反而可能 400，所以只对 deepseek 家族开启。
 */
function needsReasoningEcho(modelId) {
  return /deepseek/i.test(String(modelId))
}

/** 上游/中转明确拒绝图片输入时的错误特征（实测智谱上游 400 code 1210）。 */
function looksLikeVisionRejection(message) {
  const text = String(message ?? '')
  if (!text) return false
  return /(type\s*参数非法|取值范围\s*\[?\s*['"]?text['"]?\s*\]?|不支持图片|does not support image|image input (?:is )?not supported|invalid.*image.*(?:type|content)|only (?:accepts?|supports?) text)/i.test(text)
}

/**
 * 用户消息 → OpenAI content。
 * 纯文本时返回字符串（旧行为不变）；含图片时返回 content 数组：
 * `[{type:'text'}, {type:'image_url', image_url:{url:'data:image/…;base64,…'}}]`。
 */
function userContent(content, images) {
  const blocks = Array.isArray(content) ? content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block?.type === 'image') {
      const id = block.attachment?.attachmentId
      const image = id && images instanceof Map ? images.get(id) : undefined
      if (image?.dataUrl) {
        parts.push({ type: 'image_url', image_url: { url: image.dataUrl } })
      } else if (image?.error) {
        parts.push({ type: 'text', text: `[图片无法读取：${image.error}]` })
      } else {
        parts.push({ type: 'text', text: '[图片未随本次请求发送]' })
      }
    }
  }
  const hasImage = parts.some(part => part.type === 'image_url')
  if (!hasImage) {
    const text = parts.map(part => part.text).join('')
    return text
  }
  // 合并相邻文本块，避免上游对空/碎片 text 报错。
  const merged = []
  for (const part of parts) {
    const last = merged[merged.length - 1]
    if (part.type === 'text' && last?.type === 'text') last.text += part.text
    else merged.push({ ...part })
  }
  return merged
}

function toOpenAIMessages(options, { echoReasoning = false, reasoningFallback = 'empty', images } = {}) {
  const messages = []
  if (typeof options.system === 'string' && options.system.trim()) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = plainText(message.content)
      if (text) messages.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'user') {
      messages.push({ role: 'user', content: userContent(message.content, images) })
      continue
    }
    if (message.role === 'assistant') {
      const text = plainText(message.content)
      const reasoning = echoReasoning ? plainReasoning(message.content) : ''
      const toolCalls = (message.content ?? [])
        .filter(block => block?.type === 'tool-call')
        .map(block => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments || '{}' },
        }))
      if (!text && !reasoning && toolCalls.length === 0) continue
      const out = { role: 'assistant', content: text }
      if (toolCalls.length) out.tool_calls = toolCalls
      // DeepSeek 思考模式：reasoning_content 必须与本条 assistant 消息一起回传。
      // 上游/网关可能没把 reasoning 打包回来，此时对带 tool_calls 的消息补一个兜底值，
      // 否则会报 INVALID_REQUEST "reasoning_content ... must be passed back"。
      if (reasoning) {
        out.reasoning_content = reasoning
      } else if (echoReasoning && toolCalls.length) {
        out.reasoning_content = reasoningFallback === 'content'
          ? (text || '(no reasoning content was returned upstream)')
          : ''
      }
      messages.push(out)
      continue
    }
    if (message.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: plainText(message.content) })
    }
  }
  return messages
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools
    .filter(tool => tool && typeof tool.name === 'string' && tool.name)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: normalizeParameters(tool.parameters),
      },
    }))
}

function normalizeParameters(parameters) {
  if (!parameters || typeof parameters !== 'object') return { type: 'object', properties: {} }
  if (parameters.type === 'object') return parameters
  return { type: 'object', properties: { value: parameters } }
}

function mergeUsage(target, raw) {
  const input = Number(raw.prompt_tokens ?? raw.input_tokens)
  if (Number.isFinite(input) && input >= 0) target.inputTokens = input
  const output = Number(raw.completion_tokens ?? raw.output_tokens)
  if (Number.isFinite(output) && output >= 0) target.outputTokens = output
  const cacheRead = Number(raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_tokens)
  if (Number.isFinite(cacheRead) && cacheRead >= 0) target.cacheReadTokens = cacheRead
  const reasoning = Number(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens)
  if (Number.isFinite(reasoning) && reasoning >= 0) target.reasoningTokens = reasoning
}

export { buildChatBody, toOpenAIMessages, userContent, looksLikeVisionRejection }

