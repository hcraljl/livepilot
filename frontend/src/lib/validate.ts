/**
 * 运行时类型守卫 —— SSE 帧来自后端，编译期类型 ≠ 运行时保证
 *
 * 契约依据：shared/types.ts（B 冻结版，main @ fcad9e2）+ API.md v1.1
 * 负责人：A · @since v0.1.0
 *
 * 维护警示：契约演进必须同步本文件。v0.1.0 初版只认 3 种 DecisionStatus，
 * 契约 v1.1 新增 'failed' 后，一条失败决策会导致整帧被误判丢弃——
 * 枚举类守卫务必与 shared/types.ts 逐一对齐。
 *
 * 策略：整帧严格校验，任一必填字段缺失/类型不符即丢弃该帧并 console.warn，
 * 绝不让脏数据进入 React 状态（演示现场不崩是第一纪律）。
 */
import type { ActionType, Decision, LiveState, Metrics, Mode } from '@livepilot/shared';

const MODES: readonly string[] = ['suggest', 'semiauto', 'auto'];

const ACTIONS: readonly string[] = [
  'lottery',
  'welfare_lottery',
  'answer_card',
  'checkin',
  'push_card',
  'push_product',
  'bulletin',
];

/** 与 shared/types.ts 的 DecisionStatus 一一对应（v1.1 含 failed） */
const DECISION_STATUSES: readonly string[] = [
  'suggested',
  'pending_confirm',
  'executed',
  'failed',
];

/** LiveState.source 枚举（v1.1） */
const SOURCES: readonly string[] = ['simulator', 'polyv'];

/** AiLevel 枚举（契约 v2：C 的三档智能设置 off/hybrid/full） */
const AI_LEVELS: readonly string[] = ['off', 'hybrid', 'full'];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNumOrNull = (v: unknown): boolean => v === null || isNum(v);
const isStrOrNull = (v: unknown): boolean => v === null || isStr(v);

/** Mode 守卫 @since v0.1.0 */
export function isMode(v: unknown): v is Mode {
  return isStr(v) && MODES.includes(v);
}

/** ActionType 守卫 @since v0.1.0 */
export function isActionType(v: unknown): v is ActionType {
  return isStr(v) && ACTIONS.includes(v);
}

/** Metrics 9 字段（契约 v1.1 起未变） @since v0.1.0 */
export function isMetrics(v: unknown): v is Metrics {
  if (!isObj(v)) return false;
  return (
    isNum(v.online) &&
    isNum(v.totalViewers) &&
    isNum(v.productClicks) &&
    isNum(v.orders) &&
    isNum(v.gmv) &&
    isNum(v.danmakuRate) &&
    isStr(v.currentProduct) &&
    isNum(v.elapsedMin) &&
    isNum(v.totalMin)
  );
}

/** 单条决策；status 含 failed（v1.1 修复） @since v0.1.0 */
export function isDecision(v: unknown): v is Decision {
  if (!isObj(v)) return false;
  return (
    isStr(v.id) &&
    isNum(v.ts) &&
    isStr(v.rule) &&
    isActionType(v.action) &&
    isStr(v.reason) &&
    isMode(v.mode) &&
    isStr(v.status) &&
    DECISION_STATUSES.includes(v.status) &&
    isStr(v.channelId)
  );
}

/** 转化漏斗四层 @since v0.1.0 */
const isFunnel = (v: unknown): boolean => {
  if (!isObj(v)) return false;
  return isNum(v.view) && isNum(v.interact) && isNum(v.click) && isNum(v.order);
};

/** 商品转化榜（v1.1 起含 gmv 字段） @since v0.1.0 */
const isProductRanking = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.every((p) => {
    if (!isObj(p)) return false;
    return isStr(p.name) && isNum(p.clicks) && isNum(p.orders) && isNum(p.gmv);
  });

/** 时间轴采样点（v1.1 新增） @since v0.1.0 */
const isTimelinePoint = (v: unknown): boolean => {
  if (!isObj(v)) return false;
  return (
    isNum(v.t) &&
    isNum(v.online) &&
    isNum(v.gmv) &&
    isNum(v.orders) &&
    isNum(v.danmakuRate) &&
    (v.marked === undefined || isBool(v.marked))
  );
};

/** 事件流条目（v1.1 新增） @since v0.1.0 */
const isLiveEvent = (v: unknown): boolean => {
  if (!isObj(v)) return false;
  return isStr(v.id) && isNum(v.ts) && isStr(v.type) && isStr(v.title);
};

/** 策略阈值（v2 新增 aiLevel 三档智能 + experienceTopK） @since v0.1.0 */
const isStrategy = (v: unknown): boolean => {
  if (!isObj(v)) return false;
  return (
    isBool(v.enabled) &&
    isStr(v.aiLevel) &&
    AI_LEVELS.includes(v.aiLevel) &&
    isNum(v.experienceTopK) &&
    isNum(v.retentionDropPct) &&
    isNum(v.retentionWindowSec) &&
    isNum(v.conversionCtrThreshold) &&
    isNum(v.conversionWindowSec) &&
    isNum(v.coldDanmakuRate) &&
    isNum(v.coldWindowSec) &&
    isNum(v.gmvTarget) &&
    isNum(v.pushWindowMin) &&
    isNum(v.cooldownSec)
  );
};

/**
 * 完整 LiveState 帧校验（契约 v1.1 全字段）
 * 设计取舍：联调期从严——任一层级不合法即整帧丢弃并 console.warn，
 * 让契约漂移在开发期暴露，而非带病上场。
 * @since v0.1.0（v1.1 契约适配：2026-10-22，补 failed/timeline/events/strategy 等）
 */
export function isLiveState(v: unknown): v is LiveState {
  if (!isObj(v)) return false;
  return (
    isBool(v.running) &&
    isMode(v.mode) &&
    isStr(v.channelId) &&
    isStr(v.sessionId) &&
    isNumOrNull(v.startedAt) &&
    isNumOrNull(v.endedAt) &&
    isMetrics(v.metrics) &&
    Array.isArray(v.decisions) &&
    v.decisions.every(isDecision) &&
    isFunnel(v.funnel) &&
    isProductRanking(v.productRanking) &&
    Array.isArray(v.timeline) &&
    v.timeline.every(isTimelinePoint) &&
    Array.isArray(v.events) &&
    v.events.every(isLiveEvent) &&
    isStrategy(v.strategy) &&
    isStrOrNull(v.scenario) &&
    isStr(v.source) &&
    SOURCES.includes(v.source) &&
    isNum(v.updatedAt)
  );
}
