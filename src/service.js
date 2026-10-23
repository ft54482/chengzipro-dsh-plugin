/**
 * 业务层：登录（验证码/密码）、会话刷新、分组密钥、模型目录、余额、推理取钥。
 *
 * 铁律（来自平台对接文档）：
 * - 余额只显示平台返回值，不做本地加减；
 * - 模型/价格/能力一律来自目录接口，不硬编码；
 * - 调用模型 X 用目录里 X 的 group 对应组的密钥；401/403 时重拉密钥重试一次。
 */
import {
  OrangePlatform,
  PlatformError,
  DEFAULT_BFF_BASE,
  normalizeBaseURL,
} from './platform.js'
import { StateStore } from './state.js'
import { resolveModelSpec, applySafety, applyOverride } from './model-spec.js'
import { compatPromptFor } from './model-compat.js'
import { extractPricingTextModels } from './catalog-extra.js'
import { extractMediaModels } from './media-catalog.js'
import { recordKey, isValidRecordKey, sanitizeScope } from './credential-key.js'
import { resolveReplyLanguage, detectHostLocale, normalizeLocale, languageLabel } from './locale.js'
import { deriveDiscountLabel } from './discount.js'
import { supportsImageInput, requestImageTarget } from './vision.js'

const SYNC_TTL_MS = 10 * 60 * 1000
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000
const ACCESS_SAFETY_MS = 60 * 1000

export class OrangeProService {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.loaderConfig = config && typeof config === 'object' ? config : {}
    this.store = new StateStore()
    this.syncPromise = null
    this.keysPromise = null
    this.lastAttemptAt = 0
  }

  // ---------- 基础 ----------

  effectiveConfig() {
    const state = this.store.get().config
    return {
      bffBaseURL: normalizeBaseURL(state.bffBaseURL || this.loaderConfig.bffBaseURL || '', DEFAULT_BFF_BASE),
      providerId: sanitizeScope(state.providerId || this.loaderConfig.providerId || 'orange-pro'),
      displayName: state.displayName || this.loaderConfig.displayName || '橙子PRO',
      autoSync: state.autoSync !== false,
      contextSafetyFactor: state.contextSafetyFactor ?? 1,
      modelContextOverrides: state.modelContextOverrides ?? {},
      compat: state.compat ?? { enabled: true, targets: [], language: 'auto', prompt: '', overrides: {} },
      vision: state.vision ?? { include: [], exclude: [] },
    }
  }

  /** 视觉能力显式覆盖（精确模型 id）。 */
  visionOverrides() {
    return this.effectiveConfig().vision ?? { include: [], exclude: [] }
  }

  /**
   * 该模型是否接受图片输入。
   * @param {string} modelId
   */
  supportsImageInput(modelId) {
    return supportsImageInput(modelId, this.findModel(modelId), this.visionOverrides())
  }

  /**
   * 把一张 durable 图片附件解析成 OpenAI 兼容的 `image_url` data URL。
   *
   * 第三方 bundle 解析不到 `@deepseek-ai/dsh-*`，所以直接调用挂载的
   * `ctx.get('attachments')` 服务方法 `readImageRequest(ref, target, signal)`。
   * target 为路由自选的 `{width,height,maxBytes}`（长边按像素预算等比缩放）。
   *
   * @param {{ attachmentId: string, mediaType?: string, width?: number, height?: number, bytes?: number }} ref
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>} `data:image/…;base64,…`
   */
  async imageDataUrl(ref, signal) {
    const attachments = this.ctx.get('attachments')
    if (!attachments || typeof attachments.readImageRequest !== 'function') {
      throw new PlatformError('UNSUPPORTED_CONTENT', '附件服务未加载，无法把图片转换成模型请求')
    }
    const target = requestImageTarget(ref)
    const version = await attachments.readImageRequest(ref, target, signal)
    const data = version?.data
    if (!data || data.byteLength === 0) {
      throw new PlatformError('BAD_RESPONSE', '图片附件读取为空')
    }
    const mediaType = typeof version.mediaType === 'string' && version.mediaType
      ? version.mediaType
      : (typeof ref.mediaType === 'string' && ref.mediaType ? ref.mediaType : 'image/png')
    return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
  }

  /** 解析当前应使用的答复语言（配置 > 客户端上报 > Host 系统语言）。 */
  replyLanguage() {
    const cfg = this.effectiveConfig().compat
    return resolveReplyLanguage({
      configured: cfg.language ?? 'auto',
      clientLocale: this.store.get().detectedLocale,
      hostLocale: detectHostLocale(),
    })
  }

  /** 客户端回报当前 DSH 界面语言（<html lang>）。 */
  setDetectedLocale(locale) {
    const normalized = normalizeLocale(locale)
    if (normalized) this.store.update({ detectedLocale: normalized })
    return this.replyLanguage()
  }

  /** 该模型应追加的答复规范（空串表示不追加）。 */
  compatPrompt(modelId) {
    return compatPromptFor(modelId, this.effectiveConfig().compat, this.replyLanguage().language)
  }

  platform() {
    return new OrangePlatform({ bffBase: this.effectiveConfig().bffBaseURL })
  }

  displayName() {
    return this.effectiveConfig().displayName
  }

  credentials() {
    const service = this.ctx.get('credentials')
    if (!service) throw new PlatformError('HTTP', '凭据服务未加载，无法保存登录状态')
    return service
  }

  // 凭据键必须是 <scope>/<id> 两段式，每段须匹配 /^[a-z][a-z0-9-]*$/；
  // 键里多一段会导致凭据插件解析失败，整个应用无法启动（2026-10-20 实际踩过）。
  sessionKey() {
    return recordKey(this.effectiveConfig().providerId, 'session')
  }

  keysKey() {
    return recordKey(this.effectiveConfig().providerId, 'keys')
  }

  manualKeyRef() {
    return `${this.effectiveConfig().providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  }

  async readRecord(key) {
    try {
      const record = await this.credentials().readRecord(key)
      return record?.kind === 'grant' ? record.payload : undefined
    } catch {
      return undefined
    }
  }

  async writeRecord(key, payload) {
    // 双保险：任何键在写盘前再校验一次；非法键宁可不写，也绝不让它进 .credentials.yaml。
    if (!isValidRecordKey(key)) {
      throw new PlatformError('INVALID_KEY', `拒绝写入非法凭据键：${key}（必须是 <scope>/<id> 两段）`)
    }
    await this.credentials().modifyRecord(key, async () => ({ kind: 'grant', payload }))
  }

  async deleteRecord(key) {
    try {
      await this.credentials().deleteRecord(key)
    } catch {
      // 不存在时忽略
    }
  }

  // ---------- 会话 ----------

  async session() {
    return this.readRecord(this.sessionKey())
  }

  async saveSession(session) {
    await this.writeRecord(this.sessionKey(), session)
  }

  /** 返回可用的 accessToken；过期前自动用 refreshToken 轮换一次。 */
  async accessToken() {
    const session = await this.session()
    if (!session?.accessToken) return undefined
    if (Date.now() < Number(session.expiresAt ?? 0) - ACCESS_SAFETY_MS) return session.accessToken
    if (!session.refreshToken) return session.accessToken
    try {
      const next = await this.platform().refresh(session.refreshToken)
      const merged = {
        ...session,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        expiresAt: Date.now() + 25 * 60 * 1000,
      }
      await this.saveSession(merged)
      return merged.accessToken
    } catch {
      return session.accessToken
    }
  }

  /** 带鉴权执行；401 时刷新会话重试一次。 */
  async withAccess(operation) {
    let access = await this.accessToken()
    if (!access) throw new PlatformError('AUTH', '还没有登录橙子平台')
    try {
      return await operation(access)
    } catch (error) {
      if (error?.code !== 'AUTH') throw error
      const session = await this.session()
      if (!session?.refreshToken) throw loginRequired()
      let next
      try {
        next = await this.platform().refresh(session.refreshToken)
      } catch {
        throw loginRequired()
      }
      await this.saveSession({
        ...session,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        expiresAt: Date.now() + 25 * 60 * 1000,
      })
      return operation(next.accessToken)
    }
  }

  // ---------- 登录 ----------

  async sendSmsCode(phone) {
    const value = normalizePhone(phone)
    if (!/^1[3-9]\d{9}$/.test(value)) throw inputError('手机号格式不正确（11 位，1 开头）')
    await this.platform().sendSmsCode(value)
    return { sent: true, phone: value }
  }

  async loginWithCode(phone, code) {
    const value = normalizePhone(phone)
    if (!/^1[3-9]\d{9}$/.test(value)) throw inputError('手机号格式不正确（11 位，1 开头）')
    const digits = String(code ?? '').trim()
    if (!/^\d{4,8}$/.test(digits)) throw inputError('验证码应为 6 位数字')
    const result = await this.platform().loginWithCode(value, digits)
    return this.#finishLogin(result)
  }

  async loginWithPassword(username, password) {
    const account = String(username ?? '').trim()
    const secret = String(password ?? '')
    if (!account || !secret) throw inputError('请填写账号和密码')
    const result = await this.platform().loginWithPassword(account, secret)
    return this.#finishLogin(result)
  }

  async #finishLogin(result) {
    await this.saveSession({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: Date.now() + 25 * 60 * 1000,
      loggedInAt: new Date().toISOString(),
    })
    this.store.update({ account: accountFrom(result.user ?? {}, result.balance ?? {}) })
    await this.refreshKeys()
    await this.refreshBalance({ force: true })
    await this.sync({ force: true })
    return this.status()
  }

  // ---------- 密钥 ----------

  async keysBundle() {
    return this.readRecord(this.keysKey())
  }

  /** 重拉分组密钥（旧批立即作废）。并发调用合并成一次请求。 */
  async refreshKeys() {
    if (this.keysPromise) return this.keysPromise
    this.keysPromise = this.withAccess(async access => {
      const bundle = await this.platform().fetchKeys(access)
      const stored = { ...bundle, fetchedAt: new Date().toISOString() }
      await this.writeRecord(this.keysKey(), stored)
      return stored
    }).finally(() => {
      this.keysPromise = null
    })
    return this.keysPromise
  }

  /** 模型调用前的取钥：目录 group → 该组密钥；缺失时回退默认组。 */
  async inferenceTarget(modelId) {
    const entry = this.findModel(modelId)
    const session = await this.session()
    let bundle = await this.keysBundle()
    if (!bundle?.keys) {
      if (!session?.accessToken) {
        throw notLoggedIn()
      }
      try {
        bundle = await this.refreshKeys()
      } catch (error) {
        if (error?.code === 'AUTH') throw loginRequired()
        throw error
      }
    }
    const group = entry?.group ?? ''
    const keys = bundle?.keys ?? {}
    // 模型可能属于多个分组（pricing 的 enable_groups）；挑一个我们真正有密钥的分组。
    const candidates = Array.isArray(entry?.groups) && entry.groups.length > 0
      ? entry.groups
      : group
        ? [group]
        : []
    let apiKey = ''
    for (const candidate of candidates) {
      if (keys[candidate]) {
        apiKey = keys[candidate]
        break
      }
    }
    apiKey =
      apiKey ||
      (bundle?.defaultGroup && keys[bundle.defaultGroup]) ||
      bundle?.apiKey ||
      (await this.manualKey())
    if (!apiKey) {
      throw new PlatformError(
        'MISSING_CREDENTIAL',
        `没有模型「${modelId}」所属分组「${group || '默认'}」的密钥，请重新登录以同步全部模型权限`,
      )
    }
    const apiBase = bundle?.baseUrl || this.store.get().apiBaseUrl || ''
    return { apiKey, apiBase, group }
  }

  async manualKey() {
    try {
      const resolved = await this.credentials().resolve(this.manualKeyRef())
      return resolved?.value ?? ''
    } catch {
      return ''
    }
  }

  // ---------- 目录 ----------

  catalog() {
    return this.store.get().models
  }

  /** 媒体模型目录（image/video）：只给媒体工具用，不进 llm 选择器。 */
  mediaCatalog() {
    return this.store.get().mediaModels
  }

  findMediaModel(id) {
    return this.store.get().mediaModels.find(model => model.id === id)
  }

  findModel(id) {
    return this.store.get().models.find(model => model.id === id)
  }

  async sync(options = {}) {
    const state = this.store.get()
    if (
      options.force !== true &&
      state.models.length > 0 &&
      state.lastSyncAt &&
      Date.now() - Date.parse(state.lastSyncAt) < SYNC_TTL_MS
    ) {
      return { count: state.models.length, cached: true }
    }
    if (this.syncPromise) return this.syncPromise

    this.syncPromise = (async () => {
      try {
        const { models, apiBaseUrl } = await this.platform().fetchModels()
        // 媒体模型（image/video）先摘出来：它们不进 llm 目录，只给 Agent 工具用。
        const mediaModels = extractMediaModels(models)
        const cfg = this.effectiveConfig()
        const overrides = cfg.modelContextOverrides
        const factor = cfg.contextSafetyFactor
        const usable = []
        for (const raw of models) {
          if (!raw || typeof raw.id !== 'string' || !raw.id) continue
          if (raw.type !== 'text') continue
          if (raw.capabilities?.protocol !== 'openai-chat') continue
          // 目录字段 > 显式规格表 > 家族兜底；再叠加按模型覆盖；最后乘安全垫。
          const base = resolveModelSpec(raw)
          const applied = applyOverride(base, overrides[raw.id])
          const effective = applySafety(applied, factor)
          const discountLabel = deriveDiscountLabel(raw)
          usable.push({
            id: raw.id,
            name: raw.displayName || raw.id,
            group: typeof raw.group === 'string' ? raw.group : '',
            groups: typeof raw.group === 'string' && raw.group ? [raw.group] : [],
            protocol: 'openai-chat',
            catalogSource: 'catalog',
            ...(raw.free === true ? { free: true } : {}),
            contextWindow: effective.contextWindow,
            maxTokens: effective.maxTokens,
            baseContextWindow: applied.contextWindow,
            baseMaxTokens: applied.maxTokens,
            contextSource: applied.source,
            contextNote: applied.note,
            // 倍率/价格：只做展示，本地不计算。
            // discountLabel 可能为 null（新上架模型常见），此时用 discountRatio 推导，避免只显示"2.5"。
            ...(discountLabel ? { discountLabel } : {}),
            ...(Number.isFinite(Number(raw.discountRatio)) ? { discountRatio: Number(raw.discountRatio) } : {}),
            ...(Number.isFinite(Number(raw.groupRatio)) ? { groupRatio: Number(raw.groupRatio) } : {}),
            ...(Number.isFinite(Number(raw.modelRatio)) ? { modelRatio: Number(raw.modelRatio) } : {}),
            ...(Number.isFinite(Number(raw.completionRatio)) ? { completionRatio: Number(raw.completionRatio) } : {}),
            ...(Number.isFinite(Number(raw.inputPriceCny)) ? { inputPriceCny: Number(raw.inputPriceCny) } : {}),
            ...(Number.isFinite(Number(raw.outputPriceCny)) ? { outputPriceCny: Number(raw.outputPriceCny) } : {}),
          })
        }
        // BFF 目录可能比网站在售清单少（实测 40 vs 46），用 New API 的 pricing 补漏。
        const knownIds = new Set(usable.map(model => model.id))
        let supplemented = 0
        try {
          const pricing = await this.platform().fetchPricing()
          for (const extra of extractPricingTextModels(pricing, knownIds)) {
            const base = resolveModelSpec(extra)
            const applied = applyOverride(base, overrides[extra.id])
            const effective = applySafety(applied, factor)
            usable.push({
              ...extra,
              contextWindow: effective.contextWindow,
              maxTokens: effective.maxTokens,
              baseContextWindow: applied.contextWindow,
              baseMaxTokens: applied.maxTokens,
              contextSource: applied.source,
              contextNote: `${applied.note}+pricing-supplement`,
            })
            supplemented++
          }
        } catch (error) {
          this.ctx.logger?.warn?.(`orange-pro: pricing supplement skipped: ${error?.message ?? error}`)
        }

        if (usable.length === 0) {
          throw new PlatformError('BAD_RESPONSE', '模型目录里没有可用的文本模型')
        }
        const groupCounts = new Map()
        for (const model of usable) {
          const names = Array.isArray(model.groups) && model.groups.length > 0 ? model.groups : model.group ? [model.group] : []
          for (const name of names) groupCounts.set(name, (groupCounts.get(name) ?? 0) + 1)
        }
        this.store.update({
          models: usable,
          mediaModels,
          groups: [...groupCounts.entries()].map(([name, count]) => ({ name, count })),
          apiBaseUrl,
          lastSyncAt: new Date().toISOString(),
          lastSyncError: null,
        })
        this.ctx.logger?.info?.(
          `orange-pro: synced ${usable.length} text + ${mediaModels.length} media models (${supplemented} supplemented from pricing) from ${this.effectiveConfig().bffBaseURL}`,
        )
        return { count: usable.length, mediaCount: mediaModels.length, supplemented, cached: false }
      } catch (error) {
        this.store.update({ lastSyncError: String(error?.message ?? error) })
        throw error
      } finally {
        this.syncPromise = null
      }
    })()
    return this.syncPromise
  }

  // ---------- 余额 ----------

  async refreshBalance(options = {}) {
    const state = this.store.get()
    const checkedAt = Date.parse(state.account?.checkedAt ?? '')
    if (!options.force && Number.isFinite(checkedAt) && Date.now() - checkedAt < 30_000) return state.account
    const session = await this.session()
    if (!session?.accessToken) return state.account
    try {
      const payload = await this.withAccess(access => this.platform().me(access))
      const account = accountFrom(payload?.user ?? state.account ?? {}, payload?.balance ?? {})
      this.store.update({ account })
      return account
    } catch (error) {
      this.ctx.logger?.warn?.(`orange-pro: balance refresh failed: ${error?.message ?? error}`)
      return state.account
    }
  }

  // ---------- 状态 / 生命周期 ----------

  async status() {
    const state = this.store.get()
    const cfg = this.effectiveConfig()
    const session = await this.session()
    const bundle = await this.keysBundle()
    const hasKey = Boolean(bundle?.keys && Object.keys(bundle.keys).length > 0) || Boolean(await this.manualKey())
    const account = state.account
    void this.refreshBalance().catch(() => {})
    return {
      configured: Boolean(session?.accessToken || hasKey),
      bffBaseURL: cfg.bffBaseURL,
      providerId: cfg.providerId,
      displayName: cfg.displayName,
      autoSync: cfg.autoSync,
      loggedIn: Boolean(session?.accessToken),
      hasKeys: Boolean(bundle?.keys),
      groupCount: state.groups.length,
      account: account
        ? {
            phone: account.phone ?? '',
            nickname: account.nickname ?? '',
            role: account.role ?? 1,
            balanceCny: Number(account.balanceCny ?? 0),
            balanceTokens: Number(account.balanceTokens ?? 0),
            checkedAt: account.checkedAt ?? null,
          }
        : null,
      models: state.models,
      modelCount: state.models.length,
      mediaModels: state.mediaModels,
      mediaModelCount: state.mediaModels.length,
      vision: {
        include: this.visionOverrides().include ?? [],
        exclude: this.visionOverrides().exclude ?? [],
        // 当前目录里允许上传图片的模型（DSH 只认 inputModalities 里的 image）。
        models: state.models.filter(model => this.supportsImageInput(model.id)).map(model => model.id),
      },
      groups: state.groups,
      modelContextOverrides: cfg.modelContextOverrides,
      contextSafetyFactor: cfg.contextSafetyFactor,
      compat: {
        enabled: cfg.compat?.enabled !== false,
        targets: cfg.compat?.targets ?? [],
        customPrompt: Boolean(cfg.compat?.prompt),
        language: cfg.compat?.language ?? 'auto',
        detectedLocale: state.detectedLocale || '',
        replyLocale: this.replyLanguage().locale,
        replyLanguage: this.replyLanguage().language,
        replySource: this.replyLanguage().source,
      },
      lastSyncAt: state.lastSyncAt,
      lastSyncError: state.lastSyncError,
    }
  }

  async configure(patch = {}) {
    const current = this.store.get().config
    const next = { ...current }
    if (patch.bffBaseURL !== undefined) next.bffBaseURL = normalizeBaseURL(patch.bffBaseURL, '')
    if (patch.displayName !== undefined) next.displayName = String(patch.displayName).trim() || current.displayName
    if (patch.autoSync !== undefined) next.autoSync = Boolean(patch.autoSync)
    if (patch.modelContextOverrides !== undefined) {
      next.modelContextOverrides = normalizeOverrides(patch.modelContextOverrides)
    }
    if (patch.contextSafetyFactor !== undefined) {
      const factor = Number(patch.contextSafetyFactor)
      if (Number.isFinite(factor) && factor > 0 && factor <= 1) next.contextSafetyFactor = factor
    }
    if (patch.compat !== undefined && patch.compat && typeof patch.compat === 'object') {
      const current = next.compat ?? {}
      next.compat = {
        enabled: patch.compat.enabled !== undefined ? patch.compat.enabled !== false : current.enabled,
        targets: Array.isArray(patch.compat.targets) ? patch.compat.targets : current.targets,
        language: patch.compat.language !== undefined ? String(patch.compat.language) : current.language,
        prompt: patch.compat.prompt !== undefined ? String(patch.compat.prompt) : current.prompt,
        overrides: { ...(current.overrides ?? {}), ...(patch.compat.overrides ?? {}) },
      }
    }
    this.store.update({ config: next })
    if (patch.modelContextOverrides !== undefined || patch.contextSafetyFactor !== undefined) {
      this.reapplyContextOverrides()
    }
    if (next.autoSync && next.bffBaseURL) void this.maybeAutoSync()
    return this.status()
  }

  /**
   * 就地重算缓存里的上下文/输出上限（不重新拉目录）：
   * 以同步时保存的 baseContextWindow 为准，再叠加当前 override。
   */
  reapplyContextOverrides() {
    const state = this.store.get()
    const overrides = state.config.modelContextOverrides ?? {}
    const factor = state.config.contextSafetyFactor ?? 1
    const models = state.models.map(model => {
      // 旧版本缓存可能没有 base/maxTokens 字段，用规格表补齐。
      const inferred = resolveModelSpec({ id: model.id })
      const base = {
        contextWindow: model.baseContextWindow ?? model.contextWindow ?? inferred.contextWindow,
        maxTokens: model.baseMaxTokens ?? model.maxTokens ?? inferred.maxTokens,
        source: model.contextSource ?? inferred.source,
        note: model.contextNote ?? inferred.note,
      }
      const applied = applyOverride(base, overrides[model.id])
      const effective = applySafety(applied, factor)
      return {
        ...model,
        contextWindow: effective.contextWindow,
        maxTokens: effective.maxTokens,
        baseContextWindow: applied.contextWindow,
        baseMaxTokens: applied.maxTokens,
        contextSource: applied.source,
        contextNote: applied.note,
      }
    })
    this.store.update({ models })
  }

  async logout() {
    const session = await this.session()
    if (session?.refreshToken) {
      try {
        await this.platform().logout(session.refreshToken)
      } catch {
        // 忽略
      }
    }
    await this.deleteRecord(this.sessionKey())
    await this.deleteRecord(this.keysKey())
    try {
      await this.credentials().unset(this.manualKeyRef())
    } catch {
      // 忽略
    }
    this.store.reset({ keepConfig: true })
    return this.status()
  }

  maybeAutoSync() {
    const cfg = this.effectiveConfig()
    if (!cfg.autoSync) return Promise.resolve()
    const now = Date.now()
    if (now - this.lastAttemptAt < 30_000) return Promise.resolve()
    this.lastAttemptAt = now
    return this.sync().catch(error => {
      this.ctx.logger?.warn?.(`orange-pro: background sync failed: ${error?.message ?? error}`)
    })
  }

  startAutoSync() {
    const timer = setInterval(() => void this.maybeAutoSync(), AUTO_SYNC_INTERVAL_MS)
    timer.unref?.()
    const kickoff = setTimeout(() => void this.maybeAutoSync(), 2_000)
    kickoff.unref?.()
    return () => {
      clearInterval(timer)
      clearTimeout(kickoff)
    }
  }
}

function accountFrom(user, balance) {
  return {
    phone: String(user.phone ?? ''),
    nickname: user.nickname ?? '',
    role: Number(user.role ?? 1),
    balanceCny: Number(balance.cny ?? 0),
    balanceTokens: Number(balance.tokens ?? 0),
    checkedAt: new Date().toISOString(),
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

function normalizePhone(value) {
  return String(value ?? '').replace(/[\s-]/g, '')
}

// providerId 会作为凭据键的 scope 段，必须满足 /^[a-z][a-z0-9-]*$/；
// 统一由 sanitizeScope 处理（见 credential-key.js），这里不再保留重复实现。

function inputError(message) {
  return new PlatformError('HTTP', message, { friendly: message })
}

function loginRequired() {
  const error = new PlatformError('AUTH', '登录已过期，请重新登录橙子平台')
  error.friendly = error.message
  return error
}

function notLoggedIn() {
  const error = new PlatformError(
    'MISSING_CREDENTIAL',
    '还没有登录橙子平台：打开「设置 → 橙子Pro 中转站」用手机验证码或账号密码登录。',
  )
  error.friendly = error.message
  return error
}

export { SYNC_TTL_MS }
