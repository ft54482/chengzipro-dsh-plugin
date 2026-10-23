/**
 * 媒体模型目录（image / video）：从平台目录里筛出来，与文本目录分开存放。
 *
 * 为什么分开：DSH 的模型选择器只吃 `llm.listModels()` 的文本模型；把 image/video
 * 塞进同一个数组会让选择器里出现"选不了的模型"。媒体能力通过 Agent 工具暴露
 * （`orange_pro_image` / `orange_pro_video`），目录只做参数与计费口径的来源。
 *
 * 铁律（平台对接文档 v1.3 §6）：能力、画幅、时长、价格一律以目录字段为准，不硬编码。
 */

/** 图片协议：同步一次性响应（实测 20s~600s+，网关等待上限 600s）。 */
export const IMAGE_PROTOCOL = 'sync'
/** 视频协议：提交任务 + 轮询（异步）。 */
export const VIDEO_PROTOCOL = 'async-task'

/** 图片尺寸预设（文档 §7.2：尺寸任意直通，六个官方示例画幅优先）。 */
export const IMAGE_SIZE_PRESETS = Object.freeze({
  '16:9': { size: '1344x768', label: '16:9 横屏 1344×768' },
  '4:3': { size: '1152x864', label: '4:3 1152×864' },
  '1:1': { size: '1024x1024', label: '1:1 方形 1024×1024' },
  '3:4': { size: '864x1152', label: '3:4 竖版 864×1152' },
  '9:16': { size: '768x1344', label: '9:16 竖屏 768×1344' },
  '21:9': { size: '2688x1152', label: '21:9 宽银幕 2688×1152' },
  'hd': { size: '1536x1024', label: 'HD 横版 1536×1024' },
  '2k': { size: '2560x1440', label: '2K 横版 2560×1440' },
})

/** 视频画布（目录 aspectRatios → 768P 档画布；2K 档由服务端超分）。 */
export const VIDEO_CANVAS = Object.freeze({
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '1:1': { width: 1024, height: 1024 },
  '4:3': { width: 1152, height: 864 },
  '3:4': { width: 864, height: 1152 },
  '21:9': { width: 2688, height: 1152 },
})

const SIZE_PATTERN = /^\d{2,5}x\d{2,5}$/

/**
 * 校验并归一化图片尺寸。
 * @param {unknown} raw 目录/工具传入的尺寸（"1344x768" 或 "16:9" 预设键）
 * @returns {string|undefined} 归一化后的 `宽x高`；为空表示不传（平台默认）
 */
export function normalizeImageSize(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = String(raw).trim()
  if (!value) return undefined
  const preset = IMAGE_SIZE_PRESETS[value]
  if (preset) return preset.size
  if (SIZE_PATTERN.test(value)) {
    const [width, height] = value.split('x').map(Number)
    if (width >= 64 && width <= 4096 && height >= 64 && height <= 4096) return `${width}x${height}`
  }
  return undefined
}

/**
 * 目录条目 → 媒体模型（只保留 image/video 且协议已知的条目）。
 * @param {Record<string, unknown>} raw 平台目录的单个模型对象
 * @returns {object|null}
 */
export function toMediaModel(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return null
  const type = raw.type === 'image' || raw.type === 'video' ? raw.type : ''
  if (!type) return null
  const capabilities = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {}
  const protocol = typeof capabilities.protocol === 'string' ? capabilities.protocol : ''
  const expected = type === 'image' ? IMAGE_PROTOCOL : VIDEO_PROTOCOL
  if (protocol !== expected) return null

  const price = Number(raw.inputPriceCny)
  const model = {
    id,
    name: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : id,
    type,
    protocol,
    group: typeof raw.group === 'string' ? raw.group : '',
    groups: typeof raw.group === 'string' && raw.group ? [raw.group] : [],
    // quotaType=1 → 一口价（元/张、元/次）；这是唯一可信的价格来源。
    ...(Number(raw.quotaType) === 1 ? { quotaType: 1 } : {}),
    ...(Number.isFinite(price) && price >= 0 ? { priceCny: price } : {}),
    ...(raw.free === true ? { free: true } : {}),
  }
  if (type === 'video') {
    const taskTypes = Array.isArray(capabilities.taskTypes)
      ? capabilities.taskTypes.filter(value => typeof value === 'string' && value)
      : []
    const aspectRatios = Array.isArray(capabilities.aspectRatios)
      ? capabilities.aspectRatios.filter(value => typeof value === 'string' && value)
      : []
    const duration = capabilities.durationSeconds && typeof capabilities.durationSeconds === 'object'
      ? capabilities.durationSeconds
      : {}
    const min = Number(duration.min)
    const max = Number(duration.max)
    const step = Number(duration.step)
    model.capabilities = {
      ...(taskTypes.length > 0 ? { taskTypes } : {}),
      ...(aspectRatios.length > 0 ? { aspectRatios } : {}),
      ...(Number.isFinite(min) && Number.isFinite(max) ? { durationSeconds: { min, max, ...(Number.isFinite(step) && step > 0 ? { step } : {}) } } : {}),
      ...(Number.isFinite(Number(capabilities.maxRefImages)) ? { maxRefImages: Number(capabilities.maxRefImages) } : {}),
      ...(Number.isFinite(Number(capabilities.maxRefVideos)) ? { maxRefVideos: Number(capabilities.maxRefVideos) } : {}),
      ...(Number.isFinite(Number(capabilities.maxRefAudios)) ? { maxRefAudios: Number(capabilities.maxRefAudios) } : {}),
    }
  }
  return model
}

/**
 * 从完整目录里筛出媒体模型。
 * @param {readonly Record<string, unknown>[]} models 平台目录
 */
export function extractMediaModels(models) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(models) ? models : []) {
    const model = toMediaModel(raw)
    if (!model || seen.has(`${model.type}:${model.id}`)) continue
    seen.add(`${model.type}:${model.id}`)
    out.push(model)
  }
  return out
}

/** 按类型取候选模型（供工具的描述与确认卡渲染）。 */
export function mediaModelsOfType(mediaModels, type) {
  return (Array.isArray(mediaModels) ? mediaModels : []).filter(model => model?.type === type)
}

/**
 * 选一个默认模型：优先带 `-4k` / `2K` 之外的基准款（更便宜），再退回第一个。
 * @param {readonly object[]} candidates
 */
export function pickDefaultMediaModel(candidates) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : []
  if (list.length === 0) return undefined
  const baseline = list.find(model => !/-4k$/i.test(model.id) && !/\b2k\b/i.test(model.id))
  return baseline ?? list[0]
}

/** 把计费口径写成人话（元/张、元/次），无价格时返回空串。 */
export function priceLabelOf(model) {
  const price = Number(model?.priceCny)
  if (!Number.isFinite(price)) return ''
  const unit = model?.type === 'video' ? '次' : '张'
  return `¥${price % 1 === 0 ? price.toFixed(0) : price.toFixed(2)}/${unit}`
}

/** 视频参数边界（优先目录，其次内置兜底）。 */
export function videoBounds(model) {
  const caps = model?.capabilities ?? {}
  const duration = caps.durationSeconds ?? {}
  const min = Number.isFinite(Number(duration.min)) ? Number(duration.min) : 1
  const max = Number.isFinite(Number(duration.max)) ? Number(duration.max) : 15
  const ratios = Array.isArray(caps.aspectRatios) && caps.aspectRatios.length > 0
    ? caps.aspectRatios.filter(ratio => Object.prototype.hasOwnProperty.call(VIDEO_CANVAS, ratio))
    : Object.keys(VIDEO_CANVAS)
  return {
    minDuration: min,
    maxDuration: max,
    aspectRatios: ratios.length > 0 ? ratios : Object.keys(VIDEO_CANVAS),
    maxRefImages: Number.isFinite(Number(caps.maxRefImages)) ? Number(caps.maxRefImages) : 9,
  }
}
