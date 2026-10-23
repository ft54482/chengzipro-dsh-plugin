/**
 * 媒体能力编排层：把"平台密钥 + 目录 + 已落盘产物"接成工具可用的动作。
 *
 * 与 service.js 的分工：
 * - service.js 管账号/会话/分组密钥/文本目录；
 * - 这里只管 image/video 两条链路，密钥仍然**全部**从 service.inferenceTarget 取
 *   （同一个 `orange-pro/keys` 凭据记录，不新建凭据、不重复登录）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { PlatformError } from './platform.js'
import {
  MediaError,
  OFFICIAL_PATHS,
  downloadVideoUrl,
  extensionForMime,
  generateImage,
  nativeDownload,
  nativeQuery,
  nativeSubmit,
  nativeUploadMaterial,
  newIdempotencyKey,
  officialImageContent,
  officialQuery,
  officialSubmit,
  officialUploadFile,
  probeOfficialProtocol,
  randomMaterialId,
  sniffImageMime,
  MAX_MATERIAL_BYTES,
} from './media-client.js'
import {
  mediaModelsOfType,
  normalizeImageSize,
  pickDefaultMediaModel,
  priceLabelOf,
  videoBounds,
  VIDEO_CANVAS,
} from './media-catalog.js'

/** 官方协议探测结果的缓存时长。 */
const PROTOCOL_CACHE_MS = 10 * 60 * 1000

/** 视频轮询节奏与上限（平台排队可达数十分钟，勿用短超时判死）。 */
const POLL_INTERVAL_MS = 5_000
const MAX_POLL_MS = 28 * 60 * 1000

export class OrangeMediaService {
  /** @param {import('./service.js').OrangeProService} service */
  constructor(service, options = {}) {
    this.service = service
    this.request = options.request
    this.protocolCache = { value: 'unknown', checkedAt: 0 }
  }

  // ---------- 目录 ----------

  imageModels() {
    return mediaModelsOfType(this.service.mediaCatalog(), 'image')
  }

  videoModels() {
    return mediaModelsOfType(this.service.mediaCatalog(), 'video')
  }

  /** 目录不可用时的兜底（与平台现役模型一致，仅用于工具描述渲染）。 */
  fallbackImageModels() {
    return [
      { id: 'gpt-image-2.5-flare', name: 'Flare 标准', type: 'image', priceCny: 0.15 },
      { id: 'gpt-image-2.5-sunburst', name: 'Sunburst 标准', type: 'image', priceCny: 0.15 },
      { id: 'gpt-image-2.5-flare-4k', name: 'Flare 4K', type: 'image', priceCny: 0.38 },
      { id: 'gpt-image-2.5-sunburst-4k', name: 'Sunburst 4K', type: 'image', priceCny: 0.45 },
    ]
  }

  fallbackVideoModels() {
    return [
      { id: 'MiniMax-H3 768P', name: 'MiniMax H3 768P', type: 'video', priceCny: 1.2 },
      { id: 'MiniMax-H3 2K', name: 'MiniMax H3 2K', type: 'video', priceCny: 1.9 },
    ]
  }

  /** 解析要用的图片模型：显式 id > 目录默认 > 兜底默认。 */
  resolveImageModel(requested) {
    const models = this.imageModels()
    const source = models.length > 0 ? models : this.fallbackImageModels()
    if (typeof requested === 'string' && requested) {
      const hit = source.find(model => model.id === requested)
      if (!hit) {
        throw new MediaError(`未知的图片模型「${requested}」。可用：${source.map(model => model.id).join('、')}`, 'INVALID_REQUEST')
      }
      return hit
    }
    return pickDefaultMediaModel(source)
  }

  /** 解析要用的视频模型。 */
  resolveVideoModel(requested) {
    const models = this.videoModels()
    const source = models.length > 0 ? models : this.fallbackVideoModels()
    if (typeof requested === 'string' && requested) {
      const hit = source.find(model => model.id === requested)
      if (!hit) {
        throw new MediaError(`未知的视频模型「${requested}」。可用：${source.map(model => model.id).join('、')}`, 'INVALID_REQUEST')
      }
      return hit
    }
    return pickDefaultMediaModel(source)
  }

  // ---------- 密钥 ----------

  /** 取该模型的推理目标（分组密钥 + API base），复用文本链路的自愈逻辑。 */
  async target(modelId) {
    try {
      return await this.service.inferenceTarget(modelId)
    } catch (error) {
      if (error instanceof PlatformError) {
        const code = error.code === 'MISSING_CREDENTIAL' ? 'MISSING_CREDENTIAL'
          : error.code === 'AUTH' ? 'AUTH' : 'MEDIA'
        throw new MediaError(error.message, code, { status: error.status })
      }
      throw error
    }
  }

  // ---------- 图片 ----------

  /**
   * 生成图片并把结果写到会话工作区。
   * @param {{ prompt: string, model?: string, size?: string, cwd: string, signal?: AbortSignal }} input
   */
  async generateImage(input) {
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) throw new MediaError('prompt 不能为空。', 'INVALID_REQUEST')
    const model = this.resolveImageModel(input.model)
    const size = normalizeImageSize(input.size)
    const target = await this.target(model.id)
    const startedAt = Date.now()
    const result = await generateImage({
      apiBase: target.apiBase,
      apiKey: target.apiKey,
      model: model.id,
      prompt,
      ...(size ? { size } : {}),
      signal: input.signal,
    }, { request: this.request })

    const directory = join(input.cwd, 'orange-images')
    await mkdir(directory, { recursive: true })
    const files = []
    for (const [index, image] of result.images.entries()) {
      const stamp = timestamp()
      const name = `image-${stamp}${result.images.length > 1 ? `-${index + 1}` : ''}.${extensionForMime(image.mime)}`
      const path = join(directory, name)
      await writeFile(path, Buffer.from(image.base64, 'base64'))
      files.push({ path: `orange-images/${name}`, bytes: Buffer.from(image.base64, 'base64').byteLength })
    }
    return {
      model: model.id,
      modelName: model.name,
      files,
      size: size ?? null,
      priceLabel: priceLabelOf(model),
      elapsedMs: Date.now() - startedAt,
      revisedPrompt: result.revisedPrompt ?? null,
    }
  }

  // ---------- 视频 ----------

  /** 官方端点是否上线（带缓存）。 */
  async officialAvailable(modelId, signal) {
    const now = Date.now()
    if (now - this.protocolCache.checkedAt < PROTOCOL_CACHE_MS && this.protocolCache.value !== 'unknown') {
      return this.protocolCache.value === 'official'
    }
    const target = await this.target(modelId)
    const result = await probeOfficialProtocol({
      apiBase: target.apiBase,
      apiKey: target.apiKey,
      signal,
    }, { request: this.request })
    this.protocolCache = { value: result, checkedAt: now }
    return result === 'official'
  }

  /**
   * 生成视频（提交 → 轮询 → 下载 → 落盘）。
   *
   * 协议选择：官方 V2 优先；探测到未上线则回退 native `/v1/h3/*`。
   * 两条链路都遵守"失败自动退款""勿以短超时判死"的平台语义。
   *
   * @param {{ prompt: string, model?: string, durationSeconds?: number, aspectRatio?: string,
   *           referenceImages?: { path: string, bytes: Buffer, mime: string }[],
   *           taskType?: string, cwd: string, signal?: AbortSignal }} input
   */
  async generateVideo(input) {
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) throw new MediaError('prompt 不能为空。', 'INVALID_REQUEST')
    const model = this.resolveVideoModel(input.model)
    const bounds = videoBounds(model)
    const aspectRatio = normalizeAspectRatio(input.aspectRatio, bounds)
    const canvas = VIDEO_CANVAS[aspectRatio] ?? VIDEO_CANVAS['16:9']
    const references = Array.isArray(input.referenceImages) ? input.referenceImages : []
    for (const reference of references) {
      if (reference.bytes.byteLength > MAX_MATERIAL_BYTES) {
        throw new MediaError(`参考图超过 20MB 上限：${reference.path}`, 'INVALID_REQUEST')
      }
      if (!sniffImageMime(reference.bytes)) {
        throw new MediaError(`参考图格式不支持（仅 JPEG/PNG/WebP）：${reference.path}`, 'INVALID_REQUEST')
      }
    }
    const taskType = resolveTaskType(input.taskType, references.length, bounds)
    const target = await this.target(model.id)
    const official = await this.officialAvailable(model.id, input.signal)
    // 官方契约 H3 档 duration 4-15；原生 /v1/h3/* 是 1-15（与目录一致）。
    const limits = official ? { minDuration: 4, maxDuration: 15 } : bounds
    const duration = clampDuration(input.durationSeconds ?? defaultDuration(limits), limits)
    const startedAt = Date.now()

    const taskId = official
      ? await this.#submitOfficial({ target, model, prompt, duration, references, taskType, aspectRatio, signal: input.signal })
      : await this.#submitNative({ target, model, prompt, duration, canvas, aspectRatio, references, taskType, signal: input.signal })

    const finalView = await this.#poll({ target, model, taskId, official, signal: input.signal })
    const bytes = official
      ? await this.#downloadOfficial({ target, view: finalView, signal: input.signal })
      : await nativeDownload({
        apiBase: target.apiBase,
        apiKey: target.apiKey,
        taskId,
        videoUrl: finalView.videoUrl,
        signal: input.signal,
      }, { request: this.request })

    const directory = join(input.cwd, 'orange-videos')
    await mkdir(directory, { recursive: true })
    const fileName = `video-${timestamp()}.mp4`
    await writeFile(join(directory, fileName), bytes)

    return {
      model: model.id,
      modelName: model.name,
      protocol: official ? 'official-v2' : 'native-h3',
      taskId,
      taskType,
      aspectRatio,
      canvas: `${canvas.width}x${canvas.height}`,
      durationSeconds: duration,
      file: { path: `orange-videos/${fileName}`, bytes: bytes.byteLength },
      priceLabel: priceLabelOf(model),
      elapsedMs: Date.now() - startedAt,
    }
  }

  async #submitOfficial({ target, model, prompt, duration, references, taskType, aspectRatio, signal }) {
    // 官方契约：content[] 里 ≥1 个 text；图片走 /v1/files/upload 换 file_id 后以
    // `mm_file://{file_id}` 引用。首尾帧用 role first_frame/last_frame，其余用 reference_image。
    const upload = async reference => officialUploadFile({
      apiBase: target.apiBase,
      apiKey: target.apiKey,
      bytes: reference.bytes,
      mime: reference.mime,
      filename: reference.filename ?? 'ref.png',
      signal,
    }, { request: this.request })

    const content = [{ type: 'text', text: prompt }]
    if (taskType === 'first_last_frame_to_video') {
      const [first, last] = await Promise.all(references.map(upload))
      content.push(officialImageContent(first, 'first_frame'))
      content.push(officialImageContent(last, 'last_frame'))
    } else if (references.length > 0) {
      for (const reference of references) {
        content.push(officialImageContent(await upload(reference), 'reference_image'))
      }
    }

    const body = {
      // 官方 model 枚举只有 MiniMax-H3 / MiniMax-H3-Max；768P 与 2K 是 resolution 档位。
      model: 'MiniMax-H3',
      content,
      resolution: /2k/i.test(model.id) ? '2K' : '768P',
      duration: Math.round(duration),
      // t2v 必须显式给非 adaptive 画幅；i2v 会被忽略、r2v 默认 adaptive。
      ...(taskType === 'text_to_video' ? { ratio: aspectRatio } : taskType === 'multi_reference_to_video' ? { ratio: aspectRatio } : {}),
    }
    const { taskId } = await officialSubmit({
      apiBase: target.apiBase,
      apiKey: target.apiKey,
      body,
      signal,
    }, { request: this.request })
    return taskId
  }

  async #submitNative({ target, model, prompt, duration, canvas, aspectRatio, references, taskType, signal }) {
    const materials = []
    for (const reference of references) {
      materials.push(await nativeUploadMaterial({
        apiBase: target.apiBase,
        apiKey: target.apiKey,
        materialId: randomMaterialId('cz'),
        bytes: reference.bytes,
        mime: reference.mime,
        filename: reference.filename ?? 'ref.png',
        signal,
      }, { request: this.request }))
    }
    const { taskId } = await nativeSubmit({
      apiBase: target.apiBase,
      apiKey: target.apiKey,
      idempotencyKey: newIdempotencyKey(),
      body: {
        model: model.id,
        task: taskType,
        prompt,
        duration_seconds: duration,
        width: canvas.width,
        height: canvas.height,
        // 文档 §7.3 的参数集：duration_seconds/width/height/seed/materials；不传未在契约里的字段。
        seed: Math.floor(Math.random() * 2_147_483_647),
        ...(materials.length > 0 ? { materials } : {}),
      },
      signal,
    }, { request: this.request })
    return taskId
  }

  async #poll({ target, model, taskId, official, signal }) {
    const deadline = Date.now() + MAX_POLL_MS
    let last = { status: 'queued' }
    for (;;) {
      if (signal?.aborted) throw new MediaError('视频生成已取消（平台侧任务可能仍在跑，可稍后用 task_id 查询）。', 'ABORTED')
      const view = official
        ? await officialQuery({ apiBase: target.apiBase, apiKey: target.apiKey, taskId, signal }, { request: this.request })
        : await nativeQuery({ apiBase: target.apiBase, apiKey: target.apiKey, taskId, signal }, { request: this.request })
      last = view
      if (view.status === 'failed') {
        throw new MediaError(view.errorMessage ?? view.errorCode ?? '平台视频生成失败（已自动退款）。', 'PLATFORM', {
          detail: view.raw,
        })
      }
      if (view.status === 'completed') return view
      if (Date.now() >= deadline) {
        throw new MediaError(
          `视频生成超时（任务 ${taskId} 仍处于 ${view.status}）。平台不会重复扣费，可稍后用同一 task_id 查询。`,
          'TIMEOUT',
        )
      }
      await sleep(POLL_INTERVAL_MS, signal)
    }
  }

  async #downloadOfficial({ view, signal }) {
    // 官方契约：成片地址在查询响应的 content.url（限时直链）；拿不到就是平台侧没给。
    const url = view.downloadUrl
    if (!url) throw new MediaError('任务已完成但官方查询没有返回 content.url，请稍后用同一 task_id 重查。', 'BAD_RESPONSE')
    return downloadVideoUrl(url, { request: this.request, signal })
  }

  /** 读会话工作区内的参考图（拒绝父级穿越）。 */
  async readReferenceImage(cwd, relativePath) {
    const value = String(relativePath ?? '').trim()
    if (!value) throw new MediaError('参考图路径为空。', 'INVALID_REQUEST')
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)) {
      throw new MediaError(`参考图路径不得包含父级穿越（..）：${value}`, 'INVALID_REQUEST')
    }
    const absolute = resolve(cwd, value)
    const root = resolve(cwd)
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new MediaError(`参考图必须位于会话工作区内：${value}`, 'INVALID_REQUEST')
    }
    let bytes
    try {
      bytes = await readFileBounded(absolute, MAX_MATERIAL_BYTES)
    } catch (error) {
      throw new MediaError(`参考图不存在或不可读：${value}（${error?.code ?? 'read error'}）`, 'INVALID_REQUEST')
    }
    const mime = sniffImageMime(bytes)
    if (!mime) throw new MediaError(`参考图格式不支持（仅 JPEG/PNG/WebP）：${value}`, 'INVALID_REQUEST')
    return { path: value, bytes, mime, filename: `ref-${Date.now()}.${extensionForMime(mime)}` }
  }

  /** 余额预拦截（文档 §8：生成前用 /me 预检）。 */
  async assertBalance(priceCny) {
    const price = Number(priceCny)
    if (!Number.isFinite(price) || price <= 0) return
    const account = await this.service.refreshBalance()
    const balance = Number(account?.balanceCny)
    if (Number.isFinite(balance) && balance < price) {
      throw new MediaError(
        `账户余额 ¥${balance.toFixed(2)} 不足本次生成（约 ¥${price.toFixed(2)}），请先充值：https://pro.nat6.net/topup`,
        'QUOTA',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function readFileBounded(path, maxBytes) {
  const { stat } = await import('node:fs/promises')
  const info = await stat(path)
  if (info.size > maxBytes) {
    const error = new Error(`file exceeds ${maxBytes} bytes`)
    error.code = 'TOO_LARGE'
    throw error
  }
  return readFile(path)
}

function timestamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function sleep(ms, signal) {
  return new Promise((resolveSleep, reject) => {
    if (signal?.aborted) {
      reject(new MediaError('已取消。', 'ABORTED'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolveSleep()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new MediaError('已取消。', 'ABORTED'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function clampDuration(raw, bounds) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return defaultDuration(bounds)
  return Math.min(bounds.maxDuration, Math.max(bounds.minDuration, Math.round(value)))
}

function defaultDuration(bounds) {
  const preferred = 5
  return Math.min(bounds.maxDuration, Math.max(bounds.minDuration, preferred))
}

function normalizeAspectRatio(raw, bounds) {
  const value = String(raw ?? '').trim()
  if (value && bounds.aspectRatios.includes(value)) return value
  return bounds.aspectRatios.includes('16:9') ? '16:9' : bounds.aspectRatios[0]
}

function resolveTaskType(requested, referenceCount, bounds) {
  const allowed = Array.isArray(bounds?.taskTypes) && bounds.taskTypes.length > 0
    ? bounds.taskTypes
    : ['text_to_video', 'multi_reference_to_video', 'first_last_frame_to_video']
  const wanted = typeof requested === 'string' ? requested : ''
  if (wanted) {
    if (!allowed.includes(wanted)) {
      throw new MediaError(`该模型不支持任务类型「${wanted}」。可用：${allowed.join('、')}`, 'INVALID_REQUEST')
    }
    if (wanted === 'first_last_frame_to_video' && referenceCount !== 2) {
      throw new MediaError('first_last_frame_to_video 需要恰好 2 张参考图（第 1 张为首帧、第 2 张为尾帧）。', 'INVALID_REQUEST')
    }
    if (wanted === 'text_to_video' && referenceCount > 0) {
      throw new MediaError('text_to_video 不接受参考图；传了参考图请用 multi_reference_to_video。', 'INVALID_REQUEST')
    }
    return wanted
  }
  if (referenceCount === 0) return 'text_to_video'
  if (referenceCount === 2 && allowed.includes('first_last_frame_to_video')) return 'multi_reference_to_video'
  return 'multi_reference_to_video'
}

/** 平台模型 id → 官方 model 名：官方枚举只有 MiniMax-H3（档位走 resolution）。 */
export { OFFICIAL_PATHS } from './media-client.js'
