/**
 * 视觉（图片输入）能力判定。
 *
 * 背景：平台目录**没有**下发 `inputModalities` / vision 字段（实测 2026-10-22 的 40 条目录
 * 只有 `capabilities.tools/protocol`）。所以"哪些模型能收图"必须靠证据：
 *
 * - 已实测**接受并看见图片**（响应内容/推理里描述了图片，且 prompt_tokens 明显上涨）：
 *   `deepseek-v4.1-flash`、`deepseek-flash`、`DeepSeek-V4.1-flash-2.5`、
 *   `gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-luna`、`gemini-3.7-flash`。
 * - 已实测**上游明确拒绝图片**：`glm-5.3`（400 code 1210：`type 参数非法，取值范围 ['text']`）。
 * - 未确认（默认按不支持处理，宁可拦在前端也不把坏请求发给上游）：
 *   kimi / qwen / minimax / claude（中转层会丢图或无响应）。
 *
 * 目录/配置一旦开始下发能力字段，本模块优先采用：
 * 1. 目录 `capabilities.inputModalities` / `inputModalities` / `capabilities.vision` / `vision`
 * 2. 状态文件里的显式覆盖 `vision.include` / `vision.exclude`
 * 3. 内置证据表
 */
const EVIDENCE_VISION = [
  /^deepseek-v4\.1-flash$/i,        // 实测收图：回答"橙色"
  /^deepseek-v4\.1-flash-\d(?:\.\d+)?$/i, // DeepSeek-V4.1-flash-2.5（实测收图）
  /^deepseek-flash$/i,              // 实测同样收图
  /^gpt-5\./i,                      // gpt-5.5 / 5.6-sol / 5.6-terra / 5.6-luna（实测收图）
  /^gemini-3\./i,                   // gemini-3.x flash/pro（实测收图）
]

const EVIDENCE_NO_VISION = [
  /^deepseek-v4-pro/i,              // 实测：中转把图片替换成 [Unsupported…] 占位，模型看不到
  /^glm-/i,                         // 智谱上游只收 text（400 code 1210）
  /^kimi-/i,
  /^qwen/i,
  /^minimax-/i,
  /^claude-/i,
]

/** 目录条目里的显式能力字段优先。 */
function catalogModalities(entry) {
  const candidates = [
    entry?.capabilities?.inputModalities,
    entry?.inputModalities,
  ]
  for (const value of candidates) {
    if (Array.isArray(value)) return value.filter(item => typeof item === 'string')
  }
  const vision = entry?.capabilities?.vision ?? entry?.vision
  if (vision === true) return ['text', 'image']
  if (vision === false) return ['text']
  return undefined
}

/**
 * 该模型是否接受图片输入。
 * @param {string} modelId
 * @param {object|undefined} entry 目录缓存条目
 * @param {{ include?: string[], exclude?: string[] }} [overrides] 用户显式覆盖（精确 id）
 * @returns {boolean}
 */
export function supportsImageInput(modelId, entry, overrides = {}) {
  const id = String(modelId ?? '')
  if (!id) return false
  const include = Array.isArray(overrides?.include) ? overrides.include : []
  const exclude = Array.isArray(overrides?.exclude) ? overrides.exclude : []
  if (exclude.includes(id)) return false
  if (include.includes(id)) return true

  const fromCatalog = catalogModalities(entry)
  if (fromCatalog !== undefined) return fromCatalog.includes('image')

  for (const pattern of EVIDENCE_NO_VISION) {
    if (pattern.test(id)) return false
  }
  for (const pattern of EVIDENCE_VISION) {
    if (pattern.test(id)) return true
  }
  return false
}

/** listModels / resolveModel 用：文本模型永远至少支持 text。 */
export function modalitiesFor(modelId, entry, overrides) {
  return supportsImageInput(modelId, entry, overrides) ? ['text', 'image'] : ['text']
}

/** 从请求消息里收集用户图片引用（去重），供适配器批量解析为 data URL。 */
export function collectImageRefs(messages) {
  const refs = new Map()
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== 'image') continue
      if (block.offloaded === true) continue
      const id = block.attachment?.attachmentId
      if (typeof id === 'string' && id && !refs.has(id)) refs.set(id, block.attachment)
    }
  }
  return [...refs.values()]
}

/** 4096² 像素上限 / 1MB 字节上限：与 DSH 内建 pi-ai 的请求图像预算同档。 */
export const REQUEST_IMAGE_MAX_PIXELS = 4_194_304
export const REQUEST_IMAGE_MAX_BYTES = 1_048_576

/**
 * 计算请求版本目标尺寸（长边等比缩放，保证不超像素预算）。
 * @param {{ width?: number, height?: number, bytes?: number }} image
 * @returns {{ width: number, height: number, maxBytes: number }}
 */
export function requestImageTarget(image, maxPixels = REQUEST_IMAGE_MAX_PIXELS,
  maxBytes = REQUEST_IMAGE_MAX_BYTES) {
  const width = Math.max(1, Math.floor(Number(image?.width) || 1))
  const height = Math.max(1, Math.floor(Number(image?.height) || 1))
  const pixels = width * height
  const scale = pixels > maxPixels ? Math.sqrt(maxPixels / pixels) : 1
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    maxBytes,
  }
}
