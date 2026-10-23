/**
 * 橙子平台客户端（pro.nat6.net）。
 *
 * 双轨鉴权：
 * - BFF（账号/目录/余额/用量）：`{bffBase}/api/v1/*`，`Authorization: Bearer <accessToken>`
 * - 推理：`{apiBaseUrl}/chat/completions`，`Authorization: Bearer sk-…`（按模型 group 选密钥）
 *
 * 只依赖全局 fetch；错误统一成 PlatformError，带稳定 code 供上层转中文。
 */

export class PlatformError extends Error {
  constructor(code, message, meta = {}) {
    super(message)
    this.name = 'PlatformError'
    this.code = code
    this.status = meta.status
    this.detail = meta.detail
    this.provisionState = meta.provisionState
    this.friendly = meta.friendly
  }
}

export const DEFAULT_BFF_BASE = 'https://pro.nat6.net/video-api'
export const DEFAULT_API_BASE = 'https://pro.nat6.net/v1'

export function normalizeBaseURL(input, fallback = '') {
  let raw = String(input ?? '').trim()
  if (!raw) return fallback
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  return raw.replace(/\/+$/, '')
}

const TIMEOUT_MS = 20_000

export class OrangePlatform {
  constructor(options = {}) {
    this.bffBase = normalizeBaseURL(options.bffBase, DEFAULT_BFF_BASE)
    this.apiBase = normalizeBaseURL(options.apiBase, DEFAULT_API_BASE)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  }

  withBff(bffBase) {
    return new OrangePlatform({ bffBase, apiBase: this.apiBase, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs })
  }

  async bff(path, { method = 'GET', body, access, signal } = {}) {
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (access) headers.Authorization = `Bearer ${access}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs)
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    let response
    try {
      response = await this.fetchImpl(`${this.bffBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      throw new PlatformError(controller.signal.aborted ? 'TIMEOUT' : 'UNREACHABLE', String(error?.message ?? error))
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const text = await response.text()
    let payload
    try {
      payload = text ? JSON.parse(text) : undefined
    } catch {
      throw new PlatformError('BAD_RESPONSE', `expected JSON from ${path}`, { status: response.status, detail: text.slice(0, 300) })
    }

    if (!response.ok) {
      throw platformErrorFor(response.status, payload, path)
    }
    return payload
  }

  async sendSmsCode(phone) {
    return this.bff('/api/v1/auth/sms-code', { method: 'POST', body: { phone } })
  }

  async loginWithCode(phone, code) {
    const payload = await this.bff('/api/v1/auth/login', { method: 'POST', body: { phone, code } })
    return normalizeLogin(payload)
  }

  async loginWithPassword(username, password) {
    const payload = await this.bff('/api/v1/auth/login-password', {
      method: 'POST',
      body: { username, password },
    })
    return normalizeLogin(payload)
  }

  async refresh(refreshToken) {
    const payload = await this.bff('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    })
    if (!payload?.accessToken || !payload?.refreshToken) {
      throw new PlatformError('BAD_RESPONSE', 'refresh did not return a token pair')
    }
    return payload
  }

  async logout(refreshToken) {
    try {
      await this.bff('/api/v1/auth/logout', { method: 'POST', body: { refreshToken } })
    } catch {
      // 登出失败不影响本地清理
    }
  }

  async me(access) {
    return this.bff('/api/v1/me', { access })
  }

  /** 拉取分组密钥；新账号开通中（409）时按 5 秒间隔重试，最多 60 秒。 */
  async fetchKeys(access, { retryMs = 5_000, maxWaitMs = 60_000, signal } = {}) {
    const startedAt = Date.now()
    for (;;) {
      try {
        const payload = await this.bff('/api/v1/account/api-key', { access, signal })
        if (!payload?.keys || typeof payload.keys !== 'object') {
          throw new PlatformError('BAD_RESPONSE', 'api-key response has no keys map', { detail: payload })
        }
        return {
          keys: payload.keys,
          defaultGroup: payload.defaultGroup ?? payload.group ?? '',
          apiKey: payload.apiKey ?? '',
          group: payload.group ?? '',
          baseUrl: normalizeBaseURL(payload.baseUrl, '' ),
        }
      } catch (error) {
        if (error?.code !== 'PROVISIONING') throw error
        if (Date.now() - startedAt >= maxWaitMs) {
          throw new PlatformError('PROVISIONING', '账号开通超时（60 秒），请稍后重新登录', {
            provisionState: error.provisionState,
          })
        }
        await sleep(retryMs, signal)
      }
    }
  }

  /** 模型目录（免登录）。返回 {models, apiBaseUrl}。 */
  async fetchModels(signal) {
    const payload = await this.bff('/api/v1/models', { signal })
    const models = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : []
    return {
      models,
      apiBaseUrl: normalizeBaseURL(payload?.apiBaseUrl, this.apiBase),
    }
  }

  /**
   * New API 的定价/模型清单（网站用的数据源），用于补 BFF 目录的漏。
   * 位于站点根：`{origin}/api/pricing`，不是 BFF 前缀下。失败返回空数组（补全只是增强）。
   */
  async fetchPricing(signal) {
    let origin
    try {
      origin = new URL(this.bffBase).origin
    } catch {
      return []
    }
    try {
      const response = await this.fetchImpl(`${origin}/api/pricing`, {
        headers: { Accept: 'application/json' },
        signal,
      })
      if (!response.ok) return []
      const payload = await response.json()
      return Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []
    } catch {
      return []
    }
  }

  async usage(access, query = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
    }
    const suffix = params.toString() ? `?${params}` : ''
    return this.bff(`/api/v1/usage${suffix}`, { access })
  }

  /** 推理请求：返回原始 Response，由调用方解析 SSE 或 JSON。 */
  async chat({ apiBase, apiKey, body, signal, headers = {} }) {
    const base = normalizeBaseURL(apiBase, this.apiBase)
    const response = await this.fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: body?.stream === false ? 'application/json' : 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
        ...headers,
      },
      body: JSON.stringify(body),
      signal,
    })
    return response
  }
}

function normalizeLogin(payload) {
  const data = payload?.data ?? payload
  if (!data?.accessToken || !data?.refreshToken) {
    throw new PlatformError('BAD_RESPONSE', 'login response did not contain tokens', { detail: payload })
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    user: data.user ?? null,
    balance: data.balance ?? null,
    provisionState: data.provisionState ?? 'ready',
  }
}

function platformErrorFor(status, payload, path) {
  const message =
    payload?.error?.message ?? (typeof payload?.error === 'string' ? payload.error : payload?.message) ??
    `HTTP ${status}`
  const code =
    status === 401 ? 'AUTH'
      : status === 403 ? 'FORBIDDEN'
        : status === 409 ? 'PROVISIONING'
          : status === 429 ? 'RATE_LIMIT'
            : status === 503 ? 'MODEL_NOT_FOUND'
              : status >= 500 ? 'SERVER'
                : 'HTTP'
  const isModelNotFound = code === 'MODEL_NOT_FOUND' && String(payload?.error?.code ?? '') === 'model_not_found'
  return new PlatformError(isModelNotFound ? 'MODEL_NOT_FOUND' : code, String(message), {
    status,
    detail: payload,
    provisionState: payload?.provisionState,
  })
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    const onAbort = () => {
      clearTimeout(timer)
      reject(new PlatformError('ABORTED', 'aborted'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 解析 OpenAI 兼容 SSE 流。容忍 CRLF、注释行、末尾缺 [DONE]。
 * @param {ReadableStream<Uint8Array>} body
 */
export async function* readSSE(body, signal) {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + (buffer[index] === '\r' ? 4 : 2))
        const payload = parseEventChunk(chunk)
        if (payload !== undefined) yield payload
      }
    }
    if (buffer.trim()) {
      const payload = parseEventChunk(buffer)
      if (payload !== undefined) yield payload
    }
  } finally {
    reader.releaseLock?.()
  }
}

function parseEventChunk(chunk) {
  const dataLines = []
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return undefined
  const data = dataLines.join('\n').trim()
  if (!data) return undefined
  if (data === '[DONE]') return { done: true }
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}
