/**
 * 凭据记录键（CredentialKey）的构造与校验。
 *
 * DSH 凭据服务要求记录键恰好是 `<scope>/<id>` 两段，每段匹配 `/^[a-z][a-z0-9-]*$/`。
 * 一旦 CredentialKey 里多出一段（例如 `orange-pro/orange-pro/session`），凭据插件在启动时
 * 解析 `.credentials.yaml` 会直接抛异常，连带依赖它的插件全部无法激活 —— 整个应用起不来。
 * 所以：所有写记录的路径都必须经过这里构造键，并在写入前再校验一次。
 */

const SEGMENT = /^[a-z][a-z0-9-]*$/

/** @param {string} key */
export function isValidRecordKey(key) {
  const parts = String(key ?? '').split('/')
  return parts.length === 2 && parts.every(part => SEGMENT.test(part))
}

/** 把任意值规整成一个合法的键段；不合法时回退到 fallback。 */
export function sanitizeScope(value, fallback = 'orange-pro') {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return SEGMENT.test(cleaned) ? cleaned : fallback
}

/**
 * 构造凭据记录键。
 * @param {string} providerId 插件 provider id（会被规整成合法段）
 * @param {'session'|'keys'|string} suffix 记录种类
 * @returns {string} `<scope>/<id>`
 */
export function recordKey(providerId, suffix) {
  const key = `${sanitizeScope(providerId)}/${sanitizeScope(suffix, 'session')}`
  if (!isValidRecordKey(key)) {
    throw new Error(`invalid credential record key: ${key}`)
  }
  return key
}
