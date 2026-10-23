/**
 * 插件状态：配置、账号/余额快照、模型目录缓存。
 * 令牌与分组密钥不在这里 —— 它们在 DSH 凭据服务的记录里。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TARGETS } from './model-compat.js'

const STATE_VERSION = 4

export function defaultDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'orange-pro')
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    config: {
      bffBaseURL: '',
      providerId: 'orange-pro',
      displayName: '橙子PRO',
      autoSync: true,
      // 上下文系数：默认 1 = 按平台真实上限展示（不打折，避免客户误解为模型缩水）；
      // 如需提前触发压缩，可显式调小（0 < factor <= 1）。
      contextSafetyFactor: 1,
      // 按模型覆盖上下文/输出上限：{ "<model id>": { contextWindow, maxTokens } }
      modelContextOverrides: {},
      // 模型答复规范（兼容层）：对指定模型追加 system 文本
      compat: {
        enabled: true,
        targets: [...DEFAULT_TARGETS],
        // 答复语言：auto = 跟随客户系统/DSH 语言；也可固定为 BCP 47（如 ja-JP）
        language: 'auto',
        prompt: '',
        overrides: {},
      },
      // 图片输入（视觉）能力覆盖：平台目录不下发 modalities，只能靠证据表 + 这里显式覆盖。
      // include/exclude 里填精确模型 id，优先级高于内置证据表。
      vision: { include: [], exclude: [] },
    },
    // 客户端上报的当前 DSH 界面语言（<html lang>），用于 auto 模式
    detectedLocale: '',
    account: null,
    models: [],
    // 媒体模型（image / video）：不进 llm 模型选择器，只供 orange_pro_image / orange_pro_video 使用。
    mediaModels: [],
    groups: [],
    apiBaseUrl: '',
    lastSyncAt: null,
    lastSyncError: null,
  }
}

function normalizeModel(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null
  const positive = value => (Number.isInteger(value) && value > 0 ? value : undefined)
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : undefined)
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
    group: typeof raw.group === 'string' ? raw.group : '',
    ...(Array.isArray(raw.groups) ? { groups: raw.groups.filter(g => typeof g === 'string' && g) } : {}),
    ...(typeof raw.catalogSource === 'string' ? { catalogSource: raw.catalogSource } : {}),
    ...(typeof raw.protocol === 'string' ? { protocol: raw.protocol } : {}),
    ...(raw.free === true ? { free: true } : {}),
    ...(positive(raw.contextWindow) ? { contextWindow: positive(raw.contextWindow) } : {}),
    ...(positive(raw.maxTokens) ? { maxTokens: positive(raw.maxTokens) } : {}),
    ...(positive(raw.baseContextWindow) ? { baseContextWindow: positive(raw.baseContextWindow) } : {}),
    ...(positive(raw.baseMaxTokens) ? { baseMaxTokens: positive(raw.baseMaxTokens) } : {}),
    ...(typeof raw.contextSource === 'string' ? { contextSource: raw.contextSource } : {}),
    ...(typeof raw.contextNote === 'string' ? { contextNote: raw.contextNote } : {}),
    // 倍率/价格展示字段（只展示，不参与本地计算）
    ...(typeof raw.discountLabel === 'string' && raw.discountLabel ? { discountLabel: raw.discountLabel } : {}),
    ...(num(raw.discountRatio) !== undefined ? { discountRatio: num(raw.discountRatio) } : {}),
    ...(num(raw.groupRatio) !== undefined ? { groupRatio: num(raw.groupRatio) } : {}),
    ...(num(raw.modelRatio) !== undefined ? { modelRatio: num(raw.modelRatio) } : {}),
    ...(num(raw.completionRatio) !== undefined ? { completionRatio: num(raw.completionRatio) } : {}),
    ...(num(raw.inputPriceCny) !== undefined ? { inputPriceCny: num(raw.inputPriceCny) } : {}),
    ...(num(raw.outputPriceCny) !== undefined ? { outputPriceCny: num(raw.outputPriceCny) } : {}),
  }
}

/** 媒体模型（image/video）的持久化归一：只保留工具需要的字段，能力元数据原样保留。 */
function normalizeMediaModel(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  if (raw.type !== 'image' && raw.type !== 'video') return null
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : undefined)
  const price = num(raw.priceCny)
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
    type: raw.type,
    ...(typeof raw.protocol === 'string' ? { protocol: raw.protocol } : {}),
    group: typeof raw.group === 'string' ? raw.group : '',
    ...(Array.isArray(raw.groups) ? { groups: raw.groups.filter(g => typeof g === 'string' && g) } : {}),
    ...(Number(raw.quotaType) === 1 ? { quotaType: 1 } : {}),
    ...(price !== undefined && price >= 0 ? { priceCny: price } : {}),
    ...(raw.free === true ? { free: true } : {}),
    ...(raw.capabilities && typeof raw.capabilities === 'object' ? { capabilities: raw.capabilities } : {}),
  }
}

function normalizeState(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const config = { ...base.config, ...(typeof raw.config === 'object' && raw.config ? raw.config : {}) }
  config.bffBaseURL = typeof config.bffBaseURL === 'string' ? config.bffBaseURL : ''
  config.providerId = typeof config.providerId === 'string' && config.providerId ? config.providerId : base.config.providerId
  config.displayName = typeof config.displayName === 'string' && config.displayName ? config.displayName : base.config.displayName
  config.autoSync = config.autoSync !== false
  const factor = Number(config.contextSafetyFactor)
  config.contextSafetyFactor = Number.isFinite(factor) && factor > 0 && factor <= 1 ? factor : base.config.contextSafetyFactor
  // v2 → v3 迁移：旧版本默认 0.95 是"安全垫"，会让 1M 模型显示成 950K，客户误以为缩水。
  // 只迁移"仍是旧默认值"的用户；显式设过其他系数的保持不变。
  if ((Number(raw.version) || 0) < 3 && Math.abs(config.contextSafetyFactor - 0.95) < 1e-9) {
    config.contextSafetyFactor = 1
  }
  config.modelContextOverrides = normalizeOverrides(config.modelContextOverrides)
  config.compat = normalizeCompat(config.compat, base.config.compat)
  config.vision = normalizeVision(config.vision, base.config.vision)
  const models = Array.isArray(raw.models) ? raw.models.map(normalizeModel).filter(Boolean) : []
  const mediaModels = Array.isArray(raw.mediaModels) ? raw.mediaModels.map(normalizeMediaModel).filter(Boolean) : []
  const groups = Array.isArray(raw.groups)
    ? raw.groups.filter(g => g && typeof g.name === 'string').map(g => ({ name: g.name, count: Number(g.count) || 0 }))
    : []
  return {
    version: STATE_VERSION,
    config,
    detectedLocale: typeof raw.detectedLocale === 'string' ? raw.detectedLocale : '',
    account: raw.account && typeof raw.account === 'object' ? raw.account : null,
    models,
    mediaModels,
    groups,
    apiBaseUrl: typeof raw.apiBaseUrl === 'string' ? raw.apiBaseUrl : '',
    lastSyncAt: typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : null,
    lastSyncError: typeof raw.lastSyncError === 'string' ? raw.lastSyncError : null,
  }
}

function normalizeOverrides(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !value || typeof value !== 'object') continue
    const contextWindow = Number(value.contextWindow)
    const maxTokens = Number(value.maxTokens)
    const entry = {}
    if (Number.isFinite(contextWindow) && contextWindow > 0) entry.contextWindow = Math.floor(contextWindow)
    if (Number.isFinite(maxTokens) && maxTokens > 0) entry.maxTokens = Math.floor(maxTokens)
    if (Object.keys(entry).length > 0) out[id] = entry
  }
  return out
}

function normalizeCompat(raw, defaults) {
  if (!raw || typeof raw !== 'object') return { ...defaults }
  const targets = Array.isArray(raw.targets)
    ? raw.targets.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
    : defaults.targets
  const overrides = {}
  if (raw.overrides && typeof raw.overrides === 'object') {
    for (const [id, text] of Object.entries(raw.overrides)) {
      if (typeof text === 'string' && text.trim()) overrides[id] = text
    }
  }
  return {
    enabled: raw.enabled !== false,
    targets: targets.length > 0 ? targets : defaults.targets,
    language: typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : 'auto',
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    overrides,
  }
}

/** 视觉能力覆盖：只接受字符串 id 数组，去重、去空。 */
function normalizeVision(raw, defaults) {
  const base = defaults ?? { include: [], exclude: [] }
  if (!raw || typeof raw !== 'object') return { ...base }
  const clean = value => Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
    : []
  return {
    include: clean(raw.include),
    exclude: clean(raw.exclude),
  }
}

export class StateStore {
  constructor(dir = defaultDir()) {
    this.dir = dir
    this.file = join(dir, 'state.json')
    this.state = this.#read()
  }

  #read() {
    try {
      if (!existsSync(this.file)) return emptyState()
      return normalizeState(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return emptyState()
    }
  }

  get() {
    return this.state
  }

  update(patch) {
    this.state = normalizeState({ ...this.state, ...patch })
    this.save()
    return this.state
  }

  save() {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  reset({ keepConfig = false } = {}) {
    const next = emptyState()
    if (keepConfig) next.config = this.state.config
    this.state = next
    this.save()
  }

  destroy() {
    this.state = emptyState()
    try {
      rmSync(this.file, { force: true })
    } catch {
      // 不存在时忽略
    }
  }
}
