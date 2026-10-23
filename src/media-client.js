/**
 * 媒体推理客户端：图片（sync）+ 视频（async-task）。
 *
 * 两条链路，均只依赖全局 fetch：
 * - 图片：`POST {apiBase}/images/generations`（文档 §7.2），响应 `data[].b64_json` 优先。
 * - 视频：**MiniMax 官方 V2 协议优先**（`/v2/video_generation` → `GET /v2/query/video_generation/{id}`
 *   → 成片 URL），探测到官方端点未上线时自动回退到 new-api 原生 `/v1/h3/*` 协议
 *   （`POST /v1/h3/videos/generations` + `GET .../{id}` + `.../{id}/content`）。
 *
 * 每个请求都带 `attributionHeaders()` 语义的 UA；密钥永不进日志/错误消息。
 * 硬约束：响应体读取有字节上限；任务 id 与模型 id 先校验再进 URL/请求体。
 */
import { DEFAULT_API_BASE, normalizeBaseURL } from './platform.js'

/** JSON 响应体上限（图片 b64 会膨胀 ~33%，这里只用于错误体与小响应）。 */
export const MAX_JSON_BYTES = 64 * 1024
/** 图片响应体上限：2K PNG base64 实测 ~1.6MB，留 40× 余量给 4K。 */
export const MAX_IMAGE_JSON_BYTES = 64 * 1024 * 1024
/** 成片下载上限。 */
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024
/** 参考资料（图）上传上限，平台后端为 20MB。 */
export const MAX_MATERIAL_BYTES = 20 * 1024 * 1024

const MAX_ERROR_CHARS = 300
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/
const MATERIAL_ID_PATTERN = /^[a-z][a-z0-9-]{7,63}$/

/** 媒体链路的统一错误；`code` 供上层的工具结果与设置页分类展示。 */
export class MediaError extends Error {
  constructor(message, code = 'MEDIA', meta = {}) {
    super(message)
    this.name = 'MediaError'
    this.code = code
    this.status = meta.status
    this.serverCode = meta.serverCode
    this.detail = meta.detail
  }
}

export function attributeHeaders(extra = {}) {
  return {
    'user-agent': 'deepseek-harness/0.2.1 (+https://github.com/deepseek-ai/deepseek-harness)',
    ...extra,
  }
}

function apiBaseOf(raw) {
  return normalizeBaseURL(raw, DEFAULT_API_BASE)
}

/** 官方协议挂在站点根（`/v2/*`、`/v1/files/*`），不是 `/v1` 之下。 */
function originOf(raw) {
  try {
    return new URL(apiBaseOf(raw)).origin
  } catch {
    return apiBaseOf(raw).replace(/\/v1\/?$/, '')
  }
}

function transportOf(options) {
  return typeof options?.request === 'function' ? options.request : (url, init) => fetch(url, init)
}

async function readBounded(response, maxBytes) {
  const header = response.headers.get('content-length')
  if (header !== null && Number(header) > maxBytes) {
    throw new MediaError('平台响应体超出上限（可能是一张过大的图片），已中止读取。', 'TOO_LARGE')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) throw new MediaError('平台响应体超出上限，已中止读取。', 'TOO_LARGE')
  return buffer
}

/** 统一错误体解析：New API `{error:{code,message}}`、BFF `{error:"…"}`、MiniMax `{base_resp,…}`。 */
function extractFailure(payload, status) {
  const error = payload?.error
  const serverCode = String(
    (error && typeof error === 'object' ? error.code : undefined)
    ?? payload?.code
    ?? payload?.base_resp?.status_code
    ?? '',
  )
  const message = String(
    (error && typeof error === 'object' ? error.message : undefined)
    ?? (typeof error === 'string' ? error : undefined)
    ?? payload?.message
    ?? payload?.base_resp?.status_msg
    ?? `HTTP ${status}`,
  ).slice(0, MAX_ERROR_CHARS)
  return { serverCode, message }
}

function errorFromStatus(status, failure, context) {
  const code = status === 401 || status === 403 ? 'AUTH'
    : status === 429 ? 'RATE_LIMIT'
      : status === 402 ? 'QUOTA'
        : status === 503 ? 'MODEL_NOT_FOUND'
          : status >= 500 ? 'SERVER'
            : status === 404 ? 'NOT_FOUND'
              : 'INVALID_REQUEST'
  const suffix = failure.serverCode ? `（${failure.serverCode}）` : ''
  return new MediaError(`${context}：${failure.message}${suffix}`, code, {
    status,
    serverCode: failure.serverCode,
    detail: failure,
  })
}

async function requestJson(url, init, options, maxBytes = MAX_JSON_BYTES) {
  let response
  try {
    response = await transportOf(options)(url, {
      ...init,
      headers: attributeHeaders(init?.headers),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new MediaError(`无法连接平台：${cause?.message ?? String(cause)}`, 'UNREACHABLE')
  }
  const buffer = await readBounded(response, maxBytes)
  let payload
  try {
    payload = buffer.length === 0 ? undefined : JSON.parse(buffer.toString('utf8'))
  } catch {
    if (!response.ok) throw errorFromStatus(response.status, { serverCode: '', message: `HTTP ${response.status}` }, '平台请求失败')
    throw new MediaError('平台返回的不是 JSON。', 'BAD_RESPONSE', { status: response.status })
  }
  if (!response.ok) {
    throw errorFromStatus(response.status, extractFailure(payload, response.status), '平台请求失败')
  }
  return { response, payload }
}

// ---------------------------------------------------------------------------
// 图片（sync）
// ---------------------------------------------------------------------------

/**
 * 生成一张图片。
 *
 * 计费语义（文档 v1.3）：sync 协议下客户端主动断开**不会**取消生成，且结果无法取回，
 * 因此这里**不做超时重试**，也把默认等待上限设到平台网关之上（600s）。
 *
 * @param {{ apiBase: string, apiKey: string, model: string, prompt: string, size?: string,
 *           responseFormat?: 'b64_json'|'url', signal?: AbortSignal, request?: Function }} input
 * @returns {Promise<{ images: { mime: string, base64: string }[], revisedPrompt?: string }>}
 */
export async function generateImage(input, options = {}) {
  const base = apiBaseOf(input.apiBase)
  const body = {
    model: input.model,
    prompt: input.prompt,
    n: 1,
    // 文档建议显式 b64_json：url 只有分钟级有效期，落盘必须用 b64。
    response_format: input.responseFormat ?? 'b64_json',
    ...(input.size ? { size: input.size } : {}),
  }
  const { payload } = await requestJson(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify(body),
  }, { ...options, signal: input.signal }, MAX_IMAGE_JSON_BYTES)

  const entries = Array.isArray(payload?.data) ? payload.data : []
  if (entries.length === 0) throw new MediaError('平台没有返回图片数据。', 'BAD_RESPONSE', { detail: payload })
  const images = []
  for (const entry of entries) {
    if (typeof entry?.b64_json === 'string' && entry.b64_json) {
      images.push({ mime: sniffImageMimeFromBase64(entry.b64_json), base64: entry.b64_json })
      continue
    }
    if (typeof entry?.url === 'string' && entry.url) {
      const fetched = await downloadImage(entry.url, { ...options, signal: input.signal })
      images.push(fetched)
      continue
    }
    throw new MediaError('平台返回的图片条目既没有 b64_json 也没有 url。', 'BAD_RESPONSE')
  }
  const revised = typeof payload?.revised_prompt === 'string' && payload.revised_prompt.trim()
    ? payload.revised_prompt.trim().slice(0, 2_000)
    : undefined
  return { images, ...(revised ? { revisedPrompt: revised } : {}) }
}

/** 下载 url 形态的图片（临时地址，必须立即下载）。 */
export async function downloadImage(rawUrl, options = {}) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new MediaError('图片地址不合法。', 'INVALID_REQUEST')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MediaError('只允许 http/https 图片地址。', 'INVALID_REQUEST')
  }
  let response
  try {
    response = await transportOf(options)(url.href, {
      headers: attributeHeaders({ accept: 'image/png,image/jpeg,image/webp' }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new MediaError(`图片下载失败：${cause?.message ?? String(cause)}`, 'UNREACHABLE')
  }
  if (!response.ok) {
    const failure = extractFailure(undefined, response.status)
    throw errorFromStatus(response.status, failure, '图片下载失败')
  }
  const buffer = await readBounded(response, MAX_IMAGE_JSON_BYTES)
  const contentType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const mime = /^image\//.test(contentType) ? contentType : sniffImageMime(buffer)
  return { mime, base64: buffer.toString('base64') }
}

/** 魔数嗅探图片类型（平台 b64 不带 mime）。 */
export function sniffImageMime(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp'
  if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  return 'image/png'
}

function sniffImageMimeFromBase64(base64) {
  try {
    return sniffImageMime(Buffer.from(base64.slice(0, 32), 'base64'))
  } catch {
    return 'image/png'
  }
}

export function extensionForMime(mime) {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  return 'png'
}

// ---------------------------------------------------------------------------
// 视频：MiniMax 官方 V2 协议
// ---------------------------------------------------------------------------

/**
 * MiniMax 官方 V2 协议客户端。
 *
 * 端点（官方 / 平台侧官方协议兼容层 兼容层）：
 * - `POST   /v2/video_generation`
 * - `GET    /v2/query/video_generation/{task_id}`
 * - `DELETE /v2/video_generation/{task_id}`
 * - `POST   /v1/files/upload`（素材）
 * - `GET    /v1/files/retrieve?file_id=`
 */
export const OFFICIAL_PATHS = Object.freeze({
  submit: '/v2/video_generation',
  query: taskId => `/v2/query/video_generation/${encodeURIComponent(taskId)}`,
  cancel: taskId => `/v2/video_generation/${encodeURIComponent(taskId)}`,
  upload: '/v1/files/upload',
  retrieve: fileId => `/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
})

/** 官方协议状态 → 内部统一状态（官方枚举：queued/running/succeeded/failed/cancelled）。 */
export function normalizeOfficialStatus(raw) {
  switch (String(raw ?? '').toLowerCase()) {
    case 'queueing':
    case 'queued':
    case 'preparing':
      return 'queued'
    case 'running':
    case 'processing':
    case 'submitted':
    case 'in_progress':
      return 'processing'
    case 'success':
    case 'succeeded':
    case 'completed':
      return 'completed'
    case 'fail':
    case 'failed':
    case 'cancelled':
    case 'canceled':
      return 'failed'
    default:
      return 'unknown'
  }
}

/** 官方 `base_resp` 常见码的稳定中文解释（文档 §9 勘误表）。 */
export function officialStatusMessage(code) {
  switch (Number(code)) {
    case 1002: return '请求过于频繁，请稍后重试（1002）'
    case 1004: return '鉴权失败：密钥无效或分组不匹配（1004）'
    case 1008: return '账户余额不足（1008）'
    case 2013: return '文件不存在或已过期（2013）'
    case 1026: return '内容触发安全审核，请调整提示词或素材（1026）'
    case 1027: return '生成参数不合法（1027）'
    default: return `平台返回错误码 ${String(code)}`
  }
}

/**
 * 用 MiniMax 官方 V2 协议提交一次视频生成。
 *
 * 请求体（官方契约 `official_contract.md` §1）：
 * `{ model: 'MiniMax-H3', content: [{type:'text',text}, {type:'image_url',image_url:{url},role}],
 *    resolution: '768P'|'2K', duration: 4-15, ratio?: '16:9'|… }`
 * 成功响应 200 `{ task_id: "…" }`；错误体是 OaiError（`type:"error"`，`error.message` 尾部带数字码）。
 */
export async function officialSubmit(input, options = {}) {
  const base = originOf(input.apiBase)
  const { payload } = await requestJson(`${base}${OFFICIAL_PATHS.submit}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify(input.body),
  }, { ...options, signal: input.signal })
  if (payload?.type === 'error') {
    throw officialErrorFromBody(payload)
  }
  const taskId = payload?.task_id ?? payload?.data?.task_id
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    if (typeof taskId === 'number') return { taskId: String(taskId), raw: payload }
    throw new MediaError('官方接口没有返回 task_id。', 'BAD_RESPONSE', { detail: payload })
  }
  return { taskId, raw: payload }
}

/** 官方 OaiError 体 → MediaError（保留官方数字码的稳定文案）。 */
function officialErrorFromBody(payload) {
  const message = String(payload?.error?.message ?? payload?.error ?? '')
  const numeric = /\((\d{3,4})\)\s*$/u.exec(message)?.[1] ?? ''
  const known = numeric ? officialStatusMessage(Number(numeric)) : ''
  return new MediaError(
    known || message || '官方视频接口返回错误。',
    'PLATFORM',
    { serverCode: numeric || String(payload?.error?.type ?? ''), detail: payload },
  )
}

/**
 * 查询官方任务：`GET /v2/query/video_generation/{task_id}` → `{ task: {...} }`。
 * 状态枚举：queued / running / succeeded / failed / cancelled；
 * 成片地址在 `task.content.url`（限时，过期重查即新）。
 */
export async function officialQuery(input, options = {}) {
  const base = originOf(input.apiBase)
  const { payload } = await requestJson(`${base}${OFFICIAL_PATHS.query(input.taskId)}`, {
    headers: { authorization: `Bearer ${input.apiKey}` },
  }, { ...options, signal: input.signal })
  if (payload?.type === 'error') throw officialErrorFromBody(payload)
  const task = payload?.task ?? payload ?? {}
  const status = normalizeOfficialStatus(task.status)
  if (status === 'unknown') {
    throw new MediaError('官方查询没有返回可识别的任务状态。', 'BAD_RESPONSE', { detail: payload })
  }
  const downloadUrl = typeof task.content?.url === 'string' && task.content.url ? task.content.url
    : typeof task.video_url === 'string' ? task.video_url : undefined
  return {
    status,
    downloadUrl,
    errorCode: task.error?.code ? String(task.error.code) : undefined,
    errorMessage: task.error?.message ? String(task.error.message).slice(0, MAX_ERROR_CHARS) : undefined,
    duration: Number.isFinite(Number(task.duration)) ? Number(task.duration) : undefined,
    raw: payload,
  }
}

/**
 * 官方文件元数据：`GET /v1/files/retrieve?file_id=` → `{ file: {...}, base_resp }`。
 * 注意：官方 file 对象**不含下载地址**，成片下载走查询里的 content.url。
 */
export async function officialRetrieveFile(input, options = {}) {
  const base = originOf(input.apiBase)
  const { payload } = await requestJson(`${base}${OFFICIAL_PATHS.retrieve(input.fileId)}`, {
    headers: { authorization: `Bearer ${input.apiKey}` },
  }, { ...options, signal: input.signal })
  const baseResp = payload?.base_resp
  if (baseResp && Number(baseResp.status_code) !== 0) {
    throw new MediaError(officialStatusMessage(baseResp.status_code), 'PLATFORM', {
      serverCode: String(baseResp.status_code),
      detail: payload,
    })
  }
  const file = payload?.file ?? payload?.data?.file ?? {}
  return {
    fileId: String(file.file_id ?? input.fileId),
    bytes: Number.isFinite(Number(file.bytes)) ? Number(file.bytes) : undefined,
  }
}

/**
 * 上传素材：官方 `POST /v1/files/upload`（multipart，`purpose=video_generation_input`）。
 * 响应 `{ file: { file_id: int64 }, base_resp }`；素材以 `mm_file://{file_id}` 引用，7 天有效。
 * @returns {Promise<string>} file_id（字符串化，int64 不能过 JSON number 安全整数）
 */
export async function officialUploadFile(input, options = {}) {
  const base = originOf(input.apiBase)
  const form = new FormData()
  form.append('purpose', 'video_generation_input')
  form.append('file', new Blob([input.bytes], { type: input.mime }), input.filename)
  const { payload } = await requestJson(`${base}${OFFICIAL_PATHS.upload}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: form,
  }, { ...options, signal: input.signal })
  const baseResp = payload?.base_resp
  if (baseResp && Number(baseResp.status_code) !== 0) {
    throw new MediaError(officialStatusMessage(baseResp.status_code), 'PLATFORM', {
      serverCode: String(baseResp.status_code),
      detail: payload,
    })
  }
  if (payload?.type === 'error') throw officialErrorFromBody(payload)
  const fileId = payload?.file?.file_id ?? payload?.file_id
  if (fileId === undefined || fileId === null || fileId === '') {
    throw new MediaError('素材上传没有返回 file_id。', 'BAD_RESPONSE', { detail: payload })
  }
  return String(fileId)
}

/** 官方 content 项：把上传的 file_id 包成 `mm_file://` 引用。 */
export function officialImageContent(fileId, role) {
  return {
    type: 'image_url',
    image_url: { url: `mm_file://${fileId}` },
    ...(role ? { role } : {}),
  }
}

// ---------------------------------------------------------------------------
// 视频：new-api 原生 /v1/h3/* 协议（官方端点未上线时的回退）
// ---------------------------------------------------------------------------

export const NATIVE_PATHS = Object.freeze({
  submit: '/h3/videos/generations',
  query: taskId => `/h3/videos/generations/${encodeURIComponent(taskId)}`,
  content: taskId => `/h3/videos/generations/${encodeURIComponent(taskId)}/content`,
  materials: '/h3/materials',
  policy: model => `/h3/videos/policy?model=${encodeURIComponent(model)}`,
})

/** 原生协议状态归一（实测平台回 `submitted` 与 `processing`）。 */
export function normalizeNativeStatus(raw) {
  switch (String(raw ?? '').toLowerCase()) {
    case 'queued':
    case 'submitted':
    case 'pending':
      return 'queued'
    case 'processing':
    case 'in_progress':
    case 'running':
      return 'processing'
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'completed'
    case 'failed':
    case 'error':
    case 'cancelled':
    case 'canceled':
      return 'failed'
    default:
      return 'unknown'
  }
}

/** 原生协议：上传素材换 `material_id`。 */
export async function nativeUploadMaterial(input, options = {}) {
  const base = apiBaseOf(input.apiBase)
  if (!MATERIAL_ID_PATTERN.test(input.materialId)) {
    throw new MediaError('素材 id 不符合平台规则（小写字母开头，8-64 位）。', 'INVALID_REQUEST')
  }
  const form = new FormData()
  form.append('file', new Blob([input.bytes], { type: input.mime }), input.filename)
  form.append('material_id', input.materialId)
  form.append('kind', 'image')
  const { payload } = await requestJson(`${base}${NATIVE_PATHS.materials}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: form,
  }, { ...options, signal: input.signal })
  const material = payload?.material ?? payload
  const materialId = material?.material_id ?? material?.id
  if (typeof materialId !== 'string' || !materialId) throw new MediaError('素材上传没有返回 material_id。', 'BAD_RESPONSE')
  return materialId
}

/** 原生协议：提交任务（必须带幂等键）。 */
export async function nativeSubmit(input, options = {}) {
  const base = apiBaseOf(input.apiBase)
  const { payload } = await requestJson(`${base}${NATIVE_PATHS.submit}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.apiKey}`,
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify(input.body),
  }, { ...options, signal: input.signal })
  const taskId = payload?.id ?? payload?.task_id
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    throw new MediaError('提交成功但没有返回任务 id。', 'BAD_RESPONSE', { detail: payload })
  }
  return { taskId, raw: payload }
}

/** 原生协议：轮询。 */
export async function nativeQuery(input, options = {}) {
  const base = apiBaseOf(input.apiBase)
  const { payload } = await requestJson(`${base}${NATIVE_PATHS.query(input.taskId)}`, {
    headers: { authorization: `Bearer ${input.apiKey}` },
  }, { ...options, signal: input.signal })
  const progressRaw = payload?.progress
  const progress = typeof progressRaw === 'number' ? progressRaw
    : typeof progressRaw === 'string' ? Number(progressRaw.replace('%', '')) : undefined
  return {
    status: normalizeNativeStatus(payload?.status),
    progress: Number.isFinite(progress) ? progress : undefined,
    videoUrl: typeof payload?.video_url === 'string' ? payload.video_url : undefined,
    errorCode: typeof payload?.error_code === 'string' ? payload.error_code : undefined,
    errorMessage: typeof payload?.error_message === 'string' ? payload.error_message : undefined,
    raw: payload,
  }
}

/** 原生协议：下载成片（video_url 为相对路径时补 origin 并带同一把密钥）。 */
export async function nativeDownload(input, options = {}) {
  const base = apiBaseOf(input.apiBase)
  let url = input.videoUrl
  if (typeof url === 'string' && url && !/^https?:\/\//i.test(url)) {
    url = `${new URL(base).origin}${url.startsWith('/') ? '' : '/'}${url}`
  }
  if (typeof url !== 'string' || !url) url = `${base}${NATIVE_PATHS.content(input.taskId)}`
  let response
  try {
    response = await transportOf(options)(url, {
      headers: attributeHeaders({ authorization: `Bearer ${input.apiKey}` }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new MediaError(`成片下载失败：${cause?.message ?? String(cause)}`, 'UNREACHABLE')
  }
  if (!response.ok) {
    const failure = { serverCode: '', message: `HTTP ${response.status}` }
    throw errorFromStatus(response.status, failure, '成片下载失败')
  }
  const buffer = await readBounded(response, MAX_VIDEO_BYTES)
  if (buffer.byteLength === 0) throw new MediaError('平台返回了空视频。', 'BAD_RESPONSE')
  return buffer
}

/** 通用：按 URL 下载成片（官方协议给出的是签名直链）。 */
export async function downloadVideoUrl(rawUrl, options = {}) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new MediaError('成片地址不合法。', 'INVALID_REQUEST')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MediaError('只允许 http/https 成片地址。', 'INVALID_REQUEST')
  }
  let response
  try {
    response = await transportOf(options)(url.href, {
      headers: attributeHeaders(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new MediaError(`成片下载失败：${cause?.message ?? String(cause)}`, 'UNREACHABLE')
  }
  if (!response.ok) throw errorFromStatus(response.status, { serverCode: '', message: `HTTP ${response.status}` }, '成片下载失败')
  const buffer = await readBounded(response, MAX_VIDEO_BYTES)
  if (buffer.byteLength === 0) throw new MediaError('下载到空视频。', 'BAD_RESPONSE')
  return buffer
}

// ---------------------------------------------------------------------------
// 官方协议可用性探测
// ---------------------------------------------------------------------------

/**
 * 探测官方 V2 端点是否在本站上线。
 *
 * 判定：`POST /v2/video_generation` 用空体打一次。
 * - 命中官方语义（`base_resp`，或 401 且错误体是官方形状）→ `official`
 * - 404 / 405 / 返回 HTML（站点 SPA 兜底）→ `native`
 *
 * 结果由 service 缓存（默认 10 分钟），避免每次生成都探一次。
 * @returns {Promise<'official'|'native'|'unknown'>}
 */
export async function probeOfficialProtocol(input, options = {}) {
  const base = originOf(input.apiBase)
  let response
  try {
    response = await transportOf(options)(`${base}${OFFICIAL_PATHS.submit}`, {
      method: 'POST',
      headers: attributeHeaders({
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      }),
      body: '{}',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch {
    return 'unknown'
  }
  const contentType = String(response.headers.get('content-type') ?? '')
  if (/text\/html/i.test(contentType)) return 'native'
  if (response.status === 404 || response.status === 405) return 'native'
  const text = await response.text().catch(() => '')
  if (/"base_resp"|video_generation|task_id/i.test(text)) return 'official'
  if (response.status === 400 || response.status === 401 || response.status === 422) return 'official'
  return 'unknown'
}

/** 生成符合官方/原生素材 id 规则的随机 id。 */
export function randomMaterialId(prefix = 'cz') {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let tail = ''
  for (let index = 0; index < 14; index += 1) tail += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `${prefix}-${tail}`
}

/** 幂等键：业务单号式，唯一即可（官方/原生都要求）。 */
export function newIdempotencyKey() {
  const suffix = Math.random().toString(36).slice(2, 10)
  return `cz-video-${Date.now()}-${suffix}`
}

export { TASK_ID_PATTERN }
