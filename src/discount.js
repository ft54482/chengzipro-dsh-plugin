/**
 * 折扣标签推导。
 *
 * 平台目录里有两个来源：
 *   - `discountLabel`：平台已算好的展示文案（如 "3.8折"），有则直接采用，这是权威口径；
 *   - `discountRatio`：折扣系数（0.25 = 2.5 折、0.38 = 3.8 折、1 = 原价）。
 *     实测很多新上模型（如 DeepSeek-V4.1-flash-2.5）只给 discountRatio，discountLabel 为 null，
 *     于是界面只剩"2.5"这个数字、看不到"折"，客户无法判断是折扣还是上下文单位。
 *
 * 因此：优先 discountLabel；缺失时用 discountRatio 生成同口径文案。
 */

/** 把系数格式化成"折"的数字部分：0.25 → "2.5"，0.38 → "3.8"，0.9 → "9"。 */
function ratioToZhe(ratio) {
  const zhe = Math.round(ratio * 100) / 10
  return Number.isInteger(zhe) ? String(zhe) : zhe.toFixed(1)
}

/**
 * @param {{ discountLabel?: unknown, discountRatio?: unknown, groupRatio?: unknown }} model
 * @returns {string} 展示文案（如 "2.5折"），无折扣或不可用时返回空串
 */
export function deriveDiscountLabel(model) {
  const label = typeof model?.discountLabel === 'string' ? model.discountLabel.trim() : ''
  if (label) return label

  const ratio = Number(model?.discountRatio)
  // 只在真正打折时展示：0 < ratio < 1。1 表示原价，>1 或非数字视为无折扣信息。
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return ''
  return `${ratioToZhe(ratio)}折`
}

/** 供 UI 判断是否"真有折扣"（用于文案，不参与计费）。 */
export function hasDiscount(model) {
  return deriveDiscountLabel(model) !== ''
}
