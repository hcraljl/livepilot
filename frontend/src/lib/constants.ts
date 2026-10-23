/**
 * 全局常量与枚举标签表（契约枚举的中文展示名，组件禁止各写各的）
 * 负责人：A · @since v0.1.0（v0.2.0 扩充标签表；v0.5.0 移除 M1 遗留的 PLACEHOLDER_MODULES）
 *
 * 维护约定：`Record<契约枚举, string>` 的完整性由 TypeScript 保证——
 * 契约增删枚举时这里会编译报错，是**有意的**；不要用 Partial/宽泛类型绕开。
 */
import type { ActionType, AiLevel, DecisionStatus, Mode } from '@livepilot/shared';

/** 三档模式中文名 @since v0.2.0 */
export const MODE_LABELS: Record<Mode, string> = {
  suggest: '建议',
  semiauto: '半自动',
  auto: '全自动',
};

/** 决策四态中文名（契约 v1.1 含 failed） @since v0.2.0 */
export const DECISION_STATUS_LABELS: Record<DecisionStatus, string> = {
  suggested: '建议',
  pending_confirm: '待确认',
  executed: '已执行',
  failed: '执行失败',
};

/** 8 个动作中文名 @since v0.2.0 */
export const ACTION_LABELS: Record<ActionType, string> = {
  lottery: '无条件抽奖',
  welfare_lottery: '福利抽奖',
  answer_card: '答题卡',
  checkin: '批量签到',
  push_card: '卡片推送',
  push_product: '商品推送',
  bulletin: '公告',
};

/** 模拟器 5 类加戏场景中文名（POST /api/sim/scenario） @since v0.2.0 */
export const SCENARIO_LABELS: Record<string, string> = {
  online_drop: '留存下跌',
  cold_start: '冷场',
  low_ctr: '低点击',
  endgame: '逼单时段',
  stream_stall: '无流卡顿',
};

/** 演示默认参数：固定 seed 保证曲线可复现（API.md 明确要求） @since v0.2.0 */
export const DEMO_SIM_PARAMS = { totalMin: 30, speed: 10, seed: 20261024 } as const;

/** 三档智能设置中文名（契约 v2：AiLevel，C 的编排引擎档位） @since v0.3.0 */
export const AI_LEVEL_LABELS: Record<AiLevel, string> = {
  off: '人工',
  hybrid: '人机协同',
  full: '全自动',
};

/** 三档智能说明（策略面板 tooltip） @since v0.3.0 */
export const AI_LEVEL_HINTS: Record<AiLevel, string> = {
  off: '只给经验候选，AI 不推荐，全部人工选择',
  hybrid: 'AI 在候选中推荐一个，人工二次确认后执行',
  full: 'AI 直接推荐并执行（受规则护栏约束）',
};
