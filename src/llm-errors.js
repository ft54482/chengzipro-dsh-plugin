/**
 * 平台错误 → DSH LLM 运行时失败码。
 *
 * 运行时按 `error.failure.code`（必须与 `error.code` 一致）识别失败，
 * 第三方码一律降级为 UNKNOWN；所以这里自己构造带双写字段的 Error。
 */

export function llmError(code, message, meta = {}) {
  const error = new Error(message)
  error.name = 'OrangeProLlmError'
  error.code = code
  error.failure = {
    message,
    code,
    ...(Number.isInteger(meta.status) && meta.status >= 100 && meta.status <= 599 ? { status: meta.status } : {}),
  }
  return error
}

const CODE_MAP = {
  AUTH: 'AUTH',
  FORBIDDEN: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER: 'SERVER',
  TIMEOUT: 'TIMEOUT',
  UNREACHABLE: 'TRANSPORT',
  ABORTED: 'ABORTED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  PROVISIONING: 'PROVISIONING',
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  BAD_RESPONSE: 'BAD_RESPONSE',
  HTTP: 'INVALID_REQUEST',
}

export function fromPlatformError(error) {
  if (error?.failure && error.code) return error
  const code = CODE_MAP[error?.code] ?? 'UNKNOWN'
  const message = String(error?.friendly ?? error?.message ?? error ?? 'platform request failed')
  return llmError(code, message, { status: error?.status })
}

export { CODE_MAP }
