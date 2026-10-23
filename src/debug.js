/**
 * 极小的调试日志：写到 `$DSH_HOME/orange-pro/plugin.log`。
 * Host 插件没有稳定的控制台，排障时这是唯一能事后取证的地方；失败静默，绝不影响业务。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'orange-pro')
}

export function debug(message, extra) {
  try {
    mkdirSync(dir(), { recursive: true })
    const line = `${new Date().toISOString()} ${message}${extra === undefined ? '' : ` ${safe(extra)}`}\n`
    appendFileSync(join(dir(), 'plugin.log'), line, 'utf8')
  } catch {
    // 日志失败不影响主流程
  }
}

function safe(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}
