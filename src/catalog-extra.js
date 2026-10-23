/**
 * 目录补全：从 New API 的 `/api/pricing` 里取 BFF 目录漏掉的模型。
 *
 * 背景：橙子平台的网站模型列表来自 New API `/api/pricing`（46 个），而 BFF 的
 * `/video-api/api/v1/models` 只有 40 个，两边会漂移（例如 claude-opus-5-5-CC 只在 pricing 里）。
 * 插件以 BFF 目录为主，pricing 只做"补漏"，避免客户看不到在售模型。
 *
 * 过滤规则（用真实数据验证过）：
 *   - quota_type === 0：按 token 计费的文本模型；图片/视频是 1（按次/按张）
 *   - supported_endpoint_types 含 'openai'：走 /v1/chat/completions
 *   - 视频的 endpoint 是 h3-video / openai-video，自然被排除
 */

/**
 * @param {Array<object>} pricingItems /api/pricing 的 data 数组
 * @param {Set<string>|string[]} knownIds 目录里已有的模型 id
 * @returns {Array<{id:string,name:string,group:string,groups:string[],protocol:string,catalogSource:string}>}
 */
export function extractPricingTextModels(pricingItems, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? [])
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(pricingItems) ? pricingItems : []) {
    const id = typeof item?.model_name === 'string' ? item.model_name : typeof item?.model === 'string' ? item.model : ''
    if (!id || known.has(id) || seen.has(id)) continue
    if (Number(item.quota_type) !== 0) continue
    const endpoints = Array.isArray(item.supported_endpoint_types) ? item.supported_endpoint_types : []
    if (!endpoints.includes('openai')) continue
    const groups = Array.isArray(item.enable_groups) ? item.enable_groups.filter(g => typeof g === 'string' && g) : []
    seen.add(id)
    out.push({
      id,
      name: id,
      group: groups[0] ?? '',
      groups,
      protocol: 'openai-chat',
      catalogSource: 'pricing',
    })
  }
  return out
}
