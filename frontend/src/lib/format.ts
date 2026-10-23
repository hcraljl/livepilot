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

/**
 * 秒 → mm:ss / h:mm:ss（倒计时、推流时长共用） @since v0.9.2
 *
 * 原先这段写在 ControlBar 内部；v0.9.2 客户端唤起对话框也要用倒计时，
 * 按「格式工具统一出口」的约定挪到这里，避免两处各写一份。
 */
export const formatSec = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
};

/** 已播分钟（float）→ mm′ss″ 时钟 @since v0.1.0 */
export const formatClock = (min: number): string => {
  const totalSec = Math.max(0, Math.round(min * 60));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, '0')}′${String(ss).padStart(2, '0')}″`;
};
