/**
 * 数值格式统一出口（指标卡 / 漏斗 / 时间轴 / 决策流共用）
 * 负责人：A · @since v0.1.0
 */

/** 整数千分位 @since v0.1.0 */
export const formatInt = (n: number): string => Math.round(n).toLocaleString('zh-CN');

/** GMV 金额（¥ 前缀，最多两位小数） @since v0.1.0 */
export const formatGMV = (n: number): string =>
  `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** 比率（0~1）→ 百分比 @since v0.1.0 */
export const formatPct = (ratio: number, digits = 1): string =>
  `${(ratio * 100).toFixed(digits)}%`;

/** 已播分钟（float）→ mm′ss″ 时钟 @since v0.1.0 */
export const formatClock = (min: number): string => {
  const totalSec = Math.max(0, Math.round(min * 60));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, '0')}′${String(ss).padStart(2, '0')}″`;
};
