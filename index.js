/**
 * Host 半入口：注册 LLM provider 路由、媒体工具、设置页 API、自动同步。
 *
 * 刻意不 export Config：本插件不依赖 schemastery（profile 里解析不到 DSH 内部包），
 * 配置由设置页写入 `$DSH_HOME/orange-pro/state.json`，Loader 行保持无配置即可。
 *
 * 媒体能力（v0.4.0 新增）：
 * - `orange_pro_image`：image2.5 系列（gpt-image-2.5-*）一次一张；
 * - `orange_pro_video`：MiniMax H3，官方 V2 协议优先、new-api `/v1/h3/*` 回退。
 * 两者都注册在全局 tools 服务上，随 fiber 释放；`tools` 缺失时不影响文本链路。
 */
import { OrangeProAdapter } from './src/adapter.js'
import { OrangeProService } from './src/service.js'
import { OrangeMediaService } from './src/media-service.js'
import { registerMediaTools } from './src/media-tools.js'
import { registerRoutes } from './src/api.js'
import { debug } from './src/debug.js'

export const name = 'orange-pro'
export const inject = ['llm']

export function apply(ctx, config = {}) {
  debug('apply: enter', { hasWebServer: Boolean(ctx.get?.('webServer')), hasCredentials: Boolean(ctx.get?.('credentials')) })
  try {
    const service = new OrangeProService(ctx, config)
    const adapter = new OrangeProAdapter(service)
    const media = new OrangeMediaService(service)
    const providerId = service.effectiveConfig().providerId

    ctx.llm.registerAdapter([providerId], adapter)
    debug('apply: adapter registered', providerId)

    // 媒体工具：tools 服务可能比本插件晚激活，用 ctx.inject 等待。
    ctx.inject(['tools'], child => {
      try {
        const disposeTools = registerMediaTools(child, { media, service })
        child.effect(() => disposeTools, 'orange-pro: media tools')
        debug('apply: media tools registered')
      } catch (error) {
        debug('apply: media tool registration failed', String(error?.stack ?? error))
      }
    })

    // webServer 是可选服务：Electron 壳可能没有 HTTP 载体。
    // 用 ctx.inject 等到它出现再注册，避免因激活顺序错过。
    ctx.inject(['webServer'], child => {
      try {
        const disposeRoutes = registerRoutes(child, service, ctx.logger, { media })
        child.effect(() => disposeRoutes, 'orange-pro: http api')
        debug('apply: routes registered', { origin: safeOrigin(child) })
      } catch (error) {
        debug('apply: route registration failed', String(error?.stack ?? error))
      }
    })

    ctx.effect(() => service.startAutoSync(), 'orange-pro: auto sync')
    debug('apply: done', providerId)
  } catch (error) {
    debug('apply: FAILED', String(error?.stack ?? error))
    throw error
  }
}

function safeOrigin(ctx) {
  try {
    return ctx.get('webServer')?.getOrigin?.() ?? 'unknown'
  } catch (error) {
    return String(error?.message ?? error)
  }
}
