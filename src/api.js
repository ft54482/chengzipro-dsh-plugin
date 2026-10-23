/**
 * 设置页与 Host 之间的私有 HTTP 通道。
 *
 * 第三方插件无法新增 Remote 命名空间，所以用 webServer 自注册同源路由：
 * - 只接受同源请求（Origin / Sec-Fetch-Site，loopback 同义写法归一）；
 * - 只接受 JSON，body ≤ 64 KiB；
 * - 响应不含任何 token / 密钥，只回账号、余额、模型与状态。
 */
import { PlatformError } from './platform.js'

const PREFIX = '/orange-pro/api'
const MAX_BODY_BYTES = 64 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function registerRoutes(ctx, service, logger, options = {}) {
  const media = options.media
  const webServer = ctx.get('webServer')
  if (!webServer) {
    logger?.warn?.('orange-pro: webServer 未加载，设置页 API 不可用')
    return () => {}
  }
  let origin = ''
  try {
    origin = webServer.getOrigin()
  } catch {
    origin = ''
  }

  return webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      if (!sameOrigin(req, origin)) {
        return send(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'cross-origin request rejected' } })
      }
      const url = new URL(req.url ?? PREFIX, 'http://localhost')
      const action = url.pathname.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
      try {
        if (req.method === 'GET' && (action === 'status' || action === '')) {
          return send(res, 200, { ok: true, data: await service.status() })
        }
        if (req.method === 'GET' && action === 'diagnose') {
          return send(res, 200, { ok: true, data: await diagnose(ctx, service) })
        }
        if (req.method === 'GET' && action === 'media') {
          return send(res, 200, { ok: true, data: await mediaStatus(service, media) })
        }
        if (req.method !== 'POST') {
          return send(res, 405, { ok: false, error: { code: 'METHOD', message: 'use GET status or POST actions' } })
        }
        const body = await readJSON(req)
        switch (action) {
          case 'sms-code':
            return send(res, 200, { ok: true, data: await service.sendSmsCode(body.phone) })
          case 'login':
            return send(res, 200, { ok: true, data: await service.loginWithCode(body.phone, body.code) })
          case 'login-password':
            return send(res, 200, { ok: true, data: await service.loginWithPassword(body.username, body.password) })
          case 'config':
            return send(res, 200, { ok: true, data: await service.configure(body) })
          case 'locale':
            return send(res, 200, { ok: true, data: service.setDetectedLocale(body.locale) })
          case 'sync':
            return send(res, 200, { ok: true, data: await service.sync({ force: body?.force !== false }) })
          case 'balance':
            return send(res, 200, { ok: true, data: { account: await service.refreshBalance({ force: true }) } })
          case 'compare':
            return send(res, 200, { ok: true, data: await compare(ctx, service, body) })
          case 'selftest':
            if (body?.mode === 'media') {
              return send(res, 200, { ok: true, data: await mediaSelftest(media, body) })
            }
            if (body?.mode === 'history' || body?.mode === 'empty') {
              return send(res, 200, { ok: true, data: await historySelftest(service, body?.model, body.mode) })
            }
            return send(res, 200, { ok: true, data: await selftest(ctx, service, body?.model) })
          case 'logout':
            return send(res, 200, { ok: true, data: await service.logout() })
          default:
            return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `unknown action: ${action}` } })
        }
      } catch (error) {
        const code = error instanceof PlatformError ? error.code : 'INTERNAL'
        const message = error?.friendly ?? error?.message ?? String(error)
        logger?.warn?.(`orange-pro: ${action || 'status'} failed: ${message}`)
        return send(res, code === 'FORBIDDEN' ? 403 : 400, { ok: false, error: { code, message } })
      }
    },
  })
}

/**
 * 诊断端点：回读 DSH 运行时实际看到的路由与目录，不涉及凭据。
 */
async function diagnose(ctx, service) {
  const providerId = service.effectiveConfig().providerId
  let providers = []
  try {
    providers = ctx.llm.listProviders()
  } catch (error) {
    providers = [{ error: String(error?.message ?? error) }]
  }
  let models = []
  let modelError = ''
  try {
    models = (await ctx.llm.listModels(providerId)).map(model => ({ id: model.id, name: model.name }))
  } catch (error) {
    modelError = String(error?.message ?? error)
  }
  let resolved
  const sample = models[0]?.id
  if (sample) {
    try {
      resolved = await ctx.llm.resolveModelInfo(providerId, sample)
    } catch (error) {
      resolved = { error: String(error?.message ?? error) }
    }
  }
  return {
    providerId,
    registered: providers.some(provider => provider?.id === providerId),
    providers,
    modelCount: models.length,
    models: models.slice(0, 20),
    modelError,
    sampleModel: sample,
    resolved,
  }
}

/**
 * 自检：通过 DSH 的 llm 服务实发一次最小请求，验证"路由 → 适配器 → 分组密钥 → 平台"整链路。
 */
async function selftest(ctx, service, modelId) {
  const providerId = service.effectiveConfig().providerId
  const catalog = service.catalog()
  const preferred = modelId || catalog.find(model => model.free)?.id || catalog[0]?.id || ''
  if (!preferred) throw new PlatformError('HTTP', '还没有同步到任何模型，请先同步')
  let text = ''
  let reasoning = ''
  let finish
  let usage
  const startedAt = Date.now()
  for await (const chunk of ctx.llm.stream({
    provider: providerId,
    model: preferred,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：正常。' }] }],
    maxTokens: 4096,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
    else if (chunk.type === 'usage') usage = chunk.usage
  }
  return {
    provider: providerId,
    model: preferred,
    ms: Date.now() - startedAt,
    text,
    reasoningPreview: reasoning.slice(0, 200),
    finish: finish ?? null,
    usage: usage ?? null,
  }
}

/** 同源校验：允许 127.0.0.1 / localhost / ::1 的等价写法，拒绝其他来源。 */
/**
 * 历史回传自检：用真实分组密钥发一个带 reasoning_content + tool_calls 的两轮请求。
 * mode=history：回传真实 reasoning；mode=empty：回传空串（验证兜底值上游是否接受）。
 */
async function historySelftest(service, modelId, mode = 'history') {
  const model = String(modelId || service.catalog().find(m => /deepseek/i.test(m.id))?.id || '')
  if (!model) throw new PlatformError('HTTP', '目录里没有 deepseek 模型')
  const target = await service.inferenceTarget(model)
  const reasoningContent = mode === 'empty' ? '' : '用户查询天气，需要调用天气工具。'
  const response = await service.platform().chat({
    apiBase: target.apiBase,
    apiKey: target.apiKey,
    body: {
      model,
      stream: false,
      max_tokens: 32,
      messages: [
        { role: 'user', content: '北京天气怎么样？' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: reasoningContent,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '晴，26 度' },
        { role: 'user', content: '那需要带伞吗？只回答两个字。' },
      ],
    },
  })
  const text = await response.text()
  return {
    model,
    mode,
    group: target.group,
    status: response.status,
    ok: response.ok,
    reply: text.slice(0, 300),
  }
}

/**
 * A/B 对比：同一提示、同一工具、同一 system，分别走官方 provider 与 orange-pro。
 * 只读诊断：不写会话、不改配置；用来回答"显示差异是模型、通道还是插件造成的"。
 */
async function compare(ctx, service, body = {}) {
  const prompt = String(body.prompt || '请先调用 get_weather 查询北京天气，然后用一句中文给出是否需要带伞的结论。')
  const tools = body.tools === false ? undefined : [{
    name: 'get_weather',
    description: '查询城市天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }]
  const system = String(body.system || '你是中文助手。回答简洁，先给结论，不要复述过程。')
  const ids = ctx.llm.listProviders().map(provider => provider.id)
  const official = ['deepseek-account', 'deepseek-official'].find(id => ids.includes(id))

  const runs = []
  if (official) runs.push({ label: 'official', provider: official, model: String(body.officialModel || 'deepseek-flash') })
  runs.push({ label: 'orange-pro', provider: 'orange-pro', model: String(body.model || 'deepseek-v4.1-flash') })

  const results = []
  for (const run of runs) {
    results.push({ ...run, ...(await captureStream(ctx, { ...run, prompt, tools, system })) })
  }
  return { prompt, system, withTools: Boolean(tools), results }
}

async function captureStream(ctx, { provider, model, prompt, tools, system }) {
  const started = Date.now()
  const state = { text: '', reasoning: '', toolCalls: [], chunkTypes: {}, usage: null, finish: null, error: null }
  const calls = new Map()
  try {
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      ...(tools ? { tools } : {}),
      maxTokens: 4096,
    })) {
      state.chunkTypes[chunk.type] = (state.chunkTypes[chunk.type] || 0) + 1
      if (chunk.type === 'text-delta') state.text += chunk.text
      else if (chunk.type === 'reasoning-delta') state.reasoning += chunk.text
      else if (chunk.type === 'tool-call-delta') {
        const call = calls.get(chunk.index) || { id: chunk.id, name: '', arguments: '' }
        if (chunk.name) call.name = chunk.name
        call.arguments += chunk.argumentsDelta
        call.id = chunk.id || call.id
        calls.set(chunk.index, call)
      } else if (chunk.type === 'usage') state.usage = chunk.usage
      else if (chunk.type === 'finish') state.finish = chunk.reason
    }
  } catch (error) {
    state.error = String(error?.message ?? error)
    state.errorCode = error?.failure?.code ?? error?.code ?? 'UNKNOWN'
  }
  state.ms = Date.now() - started
  state.toolCalls = [...calls.values()].map(call => ({
    name: call.name,
    arguments: (call.arguments || '').slice(0, 160),
  }))
  state.textLength = state.text.length
  state.reasoningLength = state.reasoning.length
  state.cjkRatio = ratio(state.text, /[\u4e00-\u9fff]/g)
  state.textPreview = state.text.slice(0, 240)
  state.reasoningPreview = state.reasoning.slice(0, 160)
  delete state.text
  delete state.reasoning
  return state
}

function ratio(text, pattern) {
  if (!text) return 0
  const matched = text.match(pattern)
  return Number(((matched ? matched.length : 0) / text.length).toFixed(2))
}

function sameOrigin(req, origin) {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const requestOrigin = req.headers.origin
  if (!requestOrigin) return true
  try {
    const request = new URL(requestOrigin)
    const expected = new URL(origin)
    if (request.protocol !== expected.protocol) return false
    const requestPort = request.port || defaultPort(request.protocol)
    const expectedPort = expected.port || defaultPort(expected.protocol)
    if (requestPort !== expectedPort) return false
    const a = normalizeHost(request.hostname)
    const b = normalizeHost(expected.hostname)
    if (a === b) return true
    return LOOPBACK_HOSTS.has(a) && LOOPBACK_HOSTS.has(b)
  } catch {
    return false
  }
}

function normalizeHost(hostname) {
  const value = String(hostname ?? '').toLowerCase()
  return value === '::1' ? '[::1]' : value
}

function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : '80'
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new PlatformError('HTTP', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new PlatformError('HTTP', '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 媒体能力状态：目录里的 image/video 模型、分组密钥是否覆盖、官方协议是否上线。
 *
 * 只读：不生成、不扣费。key 覆盖判断只看**组名是否存在**，绝不回传密钥内容。
 */
async function mediaStatus(service, media) {
  const mediaModels = service.mediaCatalog()
  const bundle = await service.keysBundle().catch(() => undefined)
  const keyGroups = bundle?.keys && typeof bundle.keys === 'object' ? Object.keys(bundle.keys) : []
  const groupsCovered = model => {
    const groups = Array.isArray(model.groups) && model.groups.length > 0
      ? model.groups
      : model.group ? [model.group] : []
    return groups.some(group => keyGroups.includes(group))
  }
  const decorate = model => ({
    ...model,
    hasKey: groupsCovered(model),
  })
  const images = mediaModels.filter(model => model.type === 'image').map(decorate)
  const videos = mediaModels.filter(model => model.type === 'video').map(decorate)
  let protocol = 'unknown'
  if (media && videos.length > 0 && videos.some(model => model.hasKey)) {
    try {
      protocol = await media.officialAvailable(videos[0].id)
        ? 'official-v2'
        : 'native-h3'
    } catch {
      protocol = 'unknown'
    }
  }
  return {
    imageModels: images,
    videoModels: videos,
    keyGroups,
    imageReady: images.filter(model => model.hasKey).length,
    videoReady: videos.filter(model => model.hasKey).length,
    videoProtocol: protocol,
    imageFallback: images.length === 0 ? media?.fallbackImageModels?.() ?? [] : [],
    videoFallback: videos.length === 0 ? media?.fallbackVideoModels?.() ?? [] : [],
  }
}

/**
 * 媒体自检：只做**不扣费**的链路验证。
 * - `image`：目录 + 分组密钥可用性（不发起生成，因为 sync 图片断开也会计费）；
 * - `video`：官方协议探测 + 余额。
 */
async function mediaSelftest(media, body = {}) {
  if (!media) throw new PlatformError('HTTP', '媒体服务未初始化')
  const kind = body.kind === 'video' ? 'video' : 'image'
  if (kind === 'image') {
    const models = media.imageModels()
    const source = models.length > 0 ? models : media.fallbackImageModels()
    const model = media.resolveImageModel(body.model)
    const target = await media.target(model.id)
    return {
      kind,
      model: model.id,
      group: target.group,
      apiBase: target.apiBase,
      priceLabel: priceLabelOfSafe(model),
      catalogSize: models.length,
      note: '未发起真实生图（sync 协议下断开也会计费）；真正生成请用 orange_pro_image 工具。',
    }
  }
  const models = media.videoModels()
  const source = models.length > 0 ? models : media.fallbackVideoModels()
  const model = media.resolveVideoModel(body.model)
  const target = await media.target(model.id)
  const official = await media.officialAvailable(model.id)
  const account = await media.service.refreshBalance({ force: true }).catch(() => null)
  return {
    kind,
    model: model.id,
    group: target.group,
    apiBase: target.apiBase,
    protocol: official ? 'official-v2' : 'native-h3',
    priceLabel: priceLabelOfSafe(model),
    catalogSize: models.length,
    balanceCny: Number(account?.balanceCny ?? 0),
  }
}

function priceLabelOfSafe(model) {
  const price = Number(model?.priceCny)
  if (!Number.isFinite(price)) return ''
  return `¥${price}`
}

function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}
