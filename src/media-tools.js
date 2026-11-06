/**
 * Agent 工具：`orange_pro_image`（平台目录里的图像模型，按张计费）与
 * `orange_pro_video`（MiniMax H3 生视频）。模型 id 与价格一律来自平台目录，不在代码里写死版本
 * （平台会整体换版，如 image2.5 → image2.6）。
 *
 * 为什么不 import `@deepseek-ai/dsh-tools`：第三方 bundle 安装在 profile 里，解析不到
 * DSH 内部包（与 index.js 不 export Config 是同一个原因）。`ToolRuntime.register()`
 * 只校验 `output.render` 是函数、`output.schema` 属于受支持的 JSON Schema 子集、
 * `timeoutMs` 为正有限数、名字不是保留的 `run_code`，因此**手工构造**定义对象即可。
 *
 * 计费安全：
 * - 生成前查余额（平台 /me），不足直接拒；
 * - 有 `userQuestions` 服务时先弹确认卡（含单价），没有则要求模型显式传 `confirm: true`。
 */
import { PlatformError } from './platform.js'
import { MediaError } from './media-client.js'
import { priceLabelOf, videoBounds } from './media-catalog.js'

const MAX_PROMPT_CHARS = 4_000
/** 生图工具超时：确认卡等待 + 平台排队（文档：实测可达 600s+），给到 30 分钟。 */
const IMAGE_TIMEOUT_MS = 1_800_000
/** 生视频工具超时：确认卡 + 排队数十分钟 + 下载，35 分钟。 */
const VIDEO_TIMEOUT_MS = 2_100_000

const CONFIRM_LABEL = '确认生成'
const CANCEL_LABEL = '取消，不生成'

/** 受支持的 JSON Schema 子集：type/oneOf/properties/required/additionalProperties/items/enum/const + 注解。 */
const IMAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['generated', 'cancelled', 'needs_confirmation'] },
    files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative image paths.' },
    model: { type: 'string' },
    available_models: { type: 'array', items: { type: 'string' }, description: 'Image model ids currently offered by the platform catalog.' },
    size: { type: 'string' },
    price_label: { type: 'string' },
    elapsed_ms: { type: 'number' },
    revised_prompt: { type: 'string' },
    note: { type: 'string' },
  },
}

const VIDEO_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['generated', 'cancelled', 'needs_confirmation'] },
    file_path: { type: 'string', description: 'Workspace-relative MP4 path.' },
    model: { type: 'string' },
    available_models: { type: 'array', items: { type: 'string' }, description: 'Video model ids currently offered by the platform catalog.' },
    protocol: { type: 'string', description: 'official-v2 or native-h3.' },
    task_id: { type: 'string' },
    task_type: { type: 'string' },
    aspect_ratio: { type: 'string' },
    canvas: { type: 'string' },
    duration_seconds: { type: 'number' },
    price_label: { type: 'string' },
    elapsed_ms: { type: 'number' },
    note: { type: 'string' },
  },
}

/**
 * 注册两个媒体工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文
 * @param {{ media: import('./media-service.js').OrangeMediaService,
 *           service: import('./service.js').OrangeProService }} deps
 * @returns {() => void} 注销函数
 */
export function registerMediaTools(ctx, deps) {
  const disposers = []
  disposers.push(ctx.tools.register(imageToolDefinition(ctx, deps)))
  disposers.push(ctx.tools.register(videoToolDefinition(ctx, deps)))
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // 注销失败不影响其他工具
      }
    }
  }
}

/** 目录里当前可用的媒体模型 id（放在工具返回值里，避免描述快照过期）。 */
function availableModelIds(media, type) {
  const list = safeList(() => (type === 'image' ? media.imageModels() : media.videoModels()))
  return list.map(model => model.id)
}

/**
 * 解析模型；显式 id 已被平台下架时回退到目录默认值并给出提示。
 * 这样"平台把 2.6 换成 2.7"时，旧 id 的调用不会直接失败。
 */
function resolveWithFallback(resolve, requested) {
  if (typeof requested === 'string' && requested) {
    try {
      return { model: resolve(requested), note: '' }
    } catch {
      const model = resolve(undefined)
      return { model, note: `请求的模型 ${requested} 已不在平台目录中，已自动改用 ${model.id}。` }
    }
  }
  return { model: resolve(undefined), note: '' }
}

function imageToolDefinition(ctx, { media, service }) {
  return {
    name: 'orange_pro_image',
    description:
      'Generate one image with the Orange Pro platform image models. '
      + 'Model ids and per-image prices are resolved LIVE from the platform catalog at call time '
      + '(never hardcoded), so models the platform adds, upgrades or retires (e.g. image2.6 → image2.7) '
      + 'work without a plugin update; the result reports available_models. '
      + 'Use it whenever the user asks to create/draw/生成 a picture, poster, illustration, or slide artwork. '
      + 'Omit `model` to use the catalog default (the baseline non-4K variant; 4K variants cost more). '
      + 'Generation is billed per image to the signed-in Orange Pro account, so the tool first shows a cost confirmation card '
      + '(or requires confirm=true when no interactive answerer is available). '
      + 'The image is written into the session workspace under orange-images/; call present on the returned path so the user sees it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: `Image description in natural language (1-${MAX_PROMPT_CHARS} chars). Keep the user's intent; enrich only with concrete visual details they stated.`,
        },
        model: {
          type: 'string',
          description: 'Optional image model id from the live platform catalog. Omit to use the catalog default; if a given id is no longer offered, the tool falls back to the default and says so in `note`.',
        },
        size: {
          type: 'string',
          description: 'Optional size, either "宽x高" (e.g. "1344x768") or a preset key: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, hd, 2k. Omit for the platform default.',
        },
        confirm: {
          type: 'boolean',
          description: 'Set true only after the user explicitly agreed to the per-image charge. Ignored when an interactive confirmation card is available.',
        },
      },
    },
    output: {
      schema: IMAGE_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value ?? {}
        if (result.status === 'cancelled') {
          return [{ type: 'text', text: 'The user cancelled image generation; nothing was billed.' }]
        }
        if (result.status === 'needs_confirmation') {
          return [{ type: 'text', text: String(result.note ?? 'This call generates a billed image; ask the user to confirm, then call again with confirm=true.') }]
        }
        const paths = Array.isArray(result.files) ? result.files.join(', ') : ''
        return [{
          type: 'text',
          text: `Generated ${paths} with ${result.model ?? ''}`
            + `${result.size ? ` at ${result.size}` : ''} (${result.price_label ?? 'per image'}, ${Math.round(Number(result.elapsed_ms ?? 0) / 1000)}s). `
            + 'Call present on the returned path now so the user can see the image.',
        }]
      },
    },
    timeoutMs: IMAGE_TIMEOUT_MS,
    async execute(args, exec) {
      const prompt = String(args?.prompt ?? '').trim()
      if (!prompt) throw new Error('prompt is required.')
      if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt must be at most ${MAX_PROMPT_CHARS} characters.`)
      const { model, note: modelNote } = resolveWithFallback(
        id => media.resolveImageModel(id),
        typeof args?.model === 'string' ? args.model : undefined,
      )
      const priceLabel = priceLabelOf(model) || '按次计费'
      const availableModels = availableModelIds(media, 'image')

      const decision = await confirmWithUser(ctx, exec, {
        title: '生图确认',
        question: `使用 ${model.name} 生成 1 张图片（${priceLabel}），从橙子PRO 账户余额扣除，确认生成？`,
        detail: truncate(modelNote ? `${modelNote}\n${prompt}` : prompt, 400),
        confirmed: args?.confirm === true,
      })
      if (decision === 'cancelled') return { status: 'cancelled' }
      if (decision === 'unconfirmed') {
        return {
          status: 'needs_confirmation',
          model: model.id,
          available_models: availableModels,
          note: [`This generates one billed image (${model.name}, ${priceLabel}).`, modelNote, 'Ask the user to confirm, then call orange_pro_image again with confirm=true.']
            .filter(Boolean).join(' '),
        }
      }

      await media.assertBalance(model.priceCny)
      const cwd = sessionCwd(exec)
      try {
        const result = await media.generateImage({
          prompt,
          model: model.id,
          ...(typeof args?.size === 'string' ? { size: args.size } : {}),
          cwd,
          signal: exec.signal,
        })
        return {
          status: 'generated',
          files: result.files.map(file => file.path),
          model: result.model,
          available_models: availableModels,
          ...(result.size ? { size: result.size } : {}),
          ...(result.priceLabel ? { price_label: result.priceLabel } : {}),
          elapsed_ms: result.elapsedMs,
          ...(result.revisedPrompt ? { revised_prompt: result.revisedPrompt } : {}),
          ...(modelNote ? { note: modelNote } : {}),
        }
      } catch (error) {
        throw mediaErrorToToolError(error, service)
      }
    },
  }
}

function videoToolDefinition(ctx, { media, service }) {
  const models = safeList(() => media.videoModels())
  const catalog = models
  const bounds = videoBounds(catalog[catalog.length - 1])

  return {
    name: 'orange_pro_video',
    description:
      'Generate one short video (1-15s) with the Orange Pro platform video models. '
      + 'Model ids and per-call prices are resolved LIVE from the platform catalog at call time, '
      + 'so models the platform adds, upgrades or retires work without a plugin update; the result reports available_models. '
      + 'Use it whenever the user asks to create/生成 a video, animation, or short clip. '
      + 'Omit `model` to use the catalog default. '
      + 'Supports text-to-video, multi-reference (1-9 reference images) and first/last-frame (exactly 2 images) modes. '
      + 'The platform speaks the MiniMax official /v2 protocol when it is deployed and falls back to the native /v1/h3 protocol otherwise — '
      + 'both are handled automatically, no extra input from the model. '
      + 'Billing is per call, so the tool shows a cost/duration/aspect confirmation card first '
      + '(or requires confirm=true when no interactive answerer is available). '
      + 'The MP4 is written into the session workspace under orange-videos/; call present on it so the user can open the video.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'Video description. Reference uploaded images positionally as <Picture 1>, <Picture 2>, … matching reference_images order.',
        },
        model: {
          type: 'string',
          description: 'Optional video model id from the live platform catalog. Omit to use the catalog default; if a given id is no longer offered, the tool falls back to the default and says so in `note`.',
        },
        duration_seconds: {
          type: 'number',
          description: `Video length ${bounds.minDuration}-${bounds.maxDuration} seconds. Billing is per call, independent of duration.`,
        },
        aspect_ratio: {
          type: 'string',
          enum: bounds.aspectRatios,
          description: `Aspect ratio, one of: ${bounds.aspectRatios.join(', ')}. Default 16:9.`,
        },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description: `Optional 1-${bounds.maxRefImages} image paths inside the session workspace (PNG/JPEG/WebP, ≤20MB each), e.g. ["orange-images/image-...png"]. Order defines <Picture N>.`,
        },
        task: {
          type: 'string',
          enum: ['text_to_video', 'multi_reference_to_video', 'first_last_frame_to_video'],
          description: 'Generation mode. Omit to infer: no references → text_to_video; 1-9 references → multi_reference_to_video; exactly 2 with explicit first_last_frame_to_video → first→last frame.',
        },
        confirm: {
          type: 'boolean',
          description: 'Set true only after the user explicitly agreed to the per-call charge. Ignored when an interactive confirmation card is available.',
        },
      },
    },
    output: {
      schema: VIDEO_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value ?? {}
        if (result.status === 'cancelled') {
          return [{ type: 'text', text: 'The user cancelled video generation; nothing was billed.' }]
        }
        if (result.status === 'needs_confirmation') {
          return [{ type: 'text', text: String(result.note ?? 'This call generates a billed video; ask the user to confirm, then call again with confirm=true.') }]
        }
        return [{
          type: 'text',
          text: `Generated ${result.file_path ?? ''} with ${result.model ?? ''} via ${result.protocol ?? ''} `
            + `(${result.price_label ?? 'per call'}, ${String(result.duration_seconds ?? '')}s, ${result.canvas ?? ''}, `
            + `${Math.round(Number(result.elapsed_ms ?? 0) / 1000)}s wall). `
            + 'Call present on file_path now so the user can open the video.',
        }]
      },
    },
    timeoutMs: VIDEO_TIMEOUT_MS,
    async execute(args, exec) {
      const prompt = String(args?.prompt ?? '').trim()
      if (!prompt) throw new Error('prompt is required.')
      if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt must be at most ${MAX_PROMPT_CHARS} characters.`)

      const { model, note: modelNote } = resolveWithFallback(
        id => media.resolveVideoModel(id),
        typeof args?.model === 'string' ? args.model : undefined,
      )
      const priceLabel = priceLabelOf(model) || '按次计费'
      const availableModels = availableModelIds(media, 'video')
      const modelBounds = videoBounds(model)
      const pathList = Array.isArray(args?.reference_images)
        ? args.reference_images.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
        : []
      if (pathList.length > modelBounds.maxRefImages) {
        throw new Error(`At most ${modelBounds.maxRefImages} reference images are allowed for ${model.id}.`)
      }

      const decision = await confirmWithUser(ctx, exec, {
        title: '生视频确认',
        question: `使用 ${model.name} 生成 1 段视频（${priceLabel}，按次计费与时长无关），从橙子PRO 账户余额扣除，确认生成？`,
        detail: truncate(modelNote ? `${modelNote}\n${prompt}` : prompt, 400),
        confirmed: args?.confirm === true,
      })
      if (decision === 'cancelled') return { status: 'cancelled' }
      if (decision === 'unconfirmed') {
        return {
          status: 'needs_confirmation',
          model: model.id,
          available_models: availableModels,
          note: [`This generates one billed video (${model.name}, ${priceLabel}).`, modelNote, 'Ask the user to confirm, then call orange_pro_video again with confirm=true.']
            .filter(Boolean).join(' '),
        }
      }

      await media.assertBalance(model.priceCny)
      const cwd = sessionCwd(exec)
      const references = []
      for (const path of pathList) {
        references.push(await media.readReferenceImage(cwd, path))
      }
      try {
        const result = await media.generateVideo({
          prompt,
          model: model.id,
          ...(typeof args?.duration_seconds === 'number' ? { durationSeconds: args.duration_seconds } : {}),
          ...(typeof args?.aspect_ratio === 'string' ? { aspectRatio: args.aspect_ratio } : {}),
          ...(typeof args?.task === 'string' ? { taskType: args.task } : {}),
          referenceImages: references,
          cwd,
          signal: exec.signal,
        })
        return {
          status: 'generated',
          file_path: result.file.path,
          model: result.model,
          available_models: availableModels,
          protocol: result.protocol,
          task_id: result.taskId,
          task_type: result.taskType,
          aspect_ratio: result.aspectRatio,
          canvas: result.canvas,
          duration_seconds: result.durationSeconds,
          ...(result.priceLabel ? { price_label: result.priceLabel } : {}),
          elapsed_ms: result.elapsedMs,
          ...(modelNote ? { note: modelNote } : {}),
        }
      } catch (error) {
        throw mediaErrorToToolError(error, service)
      }
    },
  }
}

/**
 * 付费确认。
 * - 有 `userQuestions` 服务：弹确认卡（用户可看到单价）；
 * - 没有：只能用模型传入的 `confirm=true`，否则返回 `unconfirmed` 让模型去问。
 * @returns {Promise<'confirmed'|'cancelled'|'unconfirmed'>}
 */
async function confirmWithUser(ctx, exec, { title, question, detail, confirmed }) {
  const service = ctx.get?.('userQuestions')
  if (!service || typeof service.ask !== 'function') return confirmed ? 'confirmed' : 'unconfirmed'
  let answer
  try {
    answer = await service.ask({
      questions: [{
        id: 'confirm',
        header: title,
        question,
        detail,
        options: [
          { label: CONFIRM_LABEL, description: '按所选参数生成并扣费' },
          { label: CANCEL_LABEL, description: '本次不生成、不扣费' },
        ],
      }],
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    })
  } catch {
    // 无 answerer / 被取消：退回显式确认，绝不默认扣费。
    return confirmed ? 'confirmed' : 'unconfirmed'
  }
  const picked = Array.isArray(answer?.answers)
    ? answer.answers.find(item => item?.id === 'confirm')
    : undefined
  const selected = Array.isArray(picked?.selected) ? picked.selected : []
  if (selected.includes(CONFIRM_LABEL)) return 'confirmed'
  if (selected.includes(CANCEL_LABEL)) return 'cancelled'
  return 'cancelled'
}

/** 会话工作区。媒体产物必须落在用户能看到的地方，禁止落到插件进程 cwd。 */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd) return cwd
  const fallback = exec?.cwd
  if (typeof fallback === 'string' && fallback) return fallback
  throw new Error('These tools need a session workspace (a working directory) to write the generated files into.')
}

/** 把媒体链路错误翻成模型能读懂的短句，并保留稳定 code。 */
function mediaErrorToToolError(error, service) {
  if (error instanceof MediaError) {
    const message = error.code === 'AUTH'
      ? `${error.message}（分组密钥可能已失效，已尝试自愈；仍失败请让用户重新登录橙子PRO）`
      : error.message
    const wrapped = new Error(message)
    wrapped.code = error.code
    return wrapped
  }
  if (error instanceof PlatformError) return new Error(error.message)
  return error instanceof Error ? error : new Error(String(error))
}

function safeList(fn) {
  try {
    const value = fn()
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

export { IMAGE_OUTPUT_SCHEMA, VIDEO_OUTPUT_SCHEMA }
