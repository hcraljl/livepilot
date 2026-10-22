/**
 * className 拼接工具（避免引入 clsx 依赖）
 * 负责人：A · @since v0.1.0
 */
export const cn = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
