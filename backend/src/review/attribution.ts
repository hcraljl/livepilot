import type {
  ActionType,
  AttributionItem,
  Decision,
  TimelinePoint,
} from '../../../shared/types.js';
import { RULE_META, type RuleId } from '../engine/rules.js';

export const DEFAULT_WINDOW_MIN = 3;
export const DEFAULT_BASELINE_MIN = 5;

export interface AttributionOptions {
  windowMin?: number;
  baselineMin?: number;
  liveEndMin?: number;
  /** true = 直播已结束，允许截断未满窗口 */
  force?: boolean;
}

export interface DecisionGroup {
  groupId: string;
  decisionId: string;
  rule: string;
  ruleName: string;
  title: string;
  action: ActionType;
  startMin: number;
  decisions: Decision[];
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;

function ruleNameOf(decision: Decision): string {
  const ruleId = (decision.ruleId ?? decision.rule) as RuleId;
  return RULE_META[ruleId]?.name ?? decision.rule;
}

function startMinOf(decision: Decision): number {
  const raw =
    decision.executedElapsedMin ?? decision.snapshot?.elapsedMin ?? 0;
  return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}

/** 同一次规则触发的多个动作共享 groupId，归因窗口按组计算 */
export function groupExecutedDecisions(
  decisions: Decision[],
): DecisionGroup[] {
  const groups = new Map<string, Decision[]>();
  for (const decision of decisions) {
    if (decision.status !== 'executed') continue;
    // 异常安抚属于稳定性动作，不计入转化归因，避免把邻近促销增量错记到兜底公告上。
    if (
      decision.ruleId === 'anomaly_fallback' ||
      decision.rule === '异常兜底'
    ) {
      continue;
    }
    const groupId = decision.groupId ?? decision.id;
    const list = groups.get(groupId) ?? [];
    list.push(decision);
    groups.set(groupId, list);
  }

  return [...groups.entries()]
    .map(([groupId, list]) => {
      const sorted = [...list].sort(
        (a, b) => startMinOf(a) - startMinOf(b),
      );
      const primary = sorted[0];
      const titles = [
        ...new Set(sorted.map((item) => item.title).filter(Boolean)),
      ];
      return {
        groupId,
        decisionId: primary.id,
        rule: primary.ruleId ?? primary.rule,
        ruleName: ruleNameOf(primary),
        title: titles.join(' + ') || ruleNameOf(primary),
        action: primary.action,
        startMin: startMinOf(primary),
        decisions: sorted,
      };
    })
    .sort((a, b) => a.startMin - b.startMin);
}

function pointAtOrBefore(
  timeline: TimelinePoint[],
  minute: number,
): TimelinePoint | null {
  let found: TimelinePoint | null = null;
  for (const point of timeline) {
    if (point.t > minute) break;
    found = point;
  }
  return found;
}

function confidenceOf(
  baselineOrders: number,
  windowOrders: number,
): 'high' | 'medium' | 'low' {
  if (baselineOrders >= 5 && windowOrders >= 6) return 'high';
  if (baselineOrders >= 2 && windowOrders >= 3) return 'medium';
  return 'low';
}

function liftPct(
  incrementalOrders: number,
  baselineOrders: number,
): number {
  if (baselineOrders <= 0) return incrementalOrders > 0 ? 100 : 0;
  return Math.round((incrementalOrders / baselineOrders) * 100);
}

/**
 * 基于 store.timeline（GMV / 订单累计值）做时间窗口归因：
 * - 每个动作组从执行时刻开窗，默认 3 分钟；
 * - 窗口在下一个动作开始时截断，避免多动作重复计数；
 * - 用动作前 5 分钟的斜率扣掉自然增长基线。
 */
export function attributeDecisions(
  decisions: Decision[],
  timeline: TimelinePoint[],
  options: AttributionOptions = {},
): AttributionItem[] {
  const windowMin = options.windowMin ?? DEFAULT_WINDOW_MIN;
  const baselineMin = options.baselineMin ?? DEFAULT_BASELINE_MIN;
  const points = [...timeline].sort((a, b) => a.t - b.t);
  if (points.length === 0) return [];

  const liveEndMin = Math.max(
    options.liveEndMin ?? points[points.length - 1].t,
    points[0].t,
  );
  const groups = groupExecutedDecisions(decisions);
  const windows = groups.map((group, index) => ({
    start: group.startMin,
    end: Math.min(
      group.startMin + windowMin,
      groups[index + 1]?.startMin ?? liveEndMin,
      liveEndMin,
    ),
  }));
  const items: AttributionItem[] = [];

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];

    if (!options.force && group.startMin + windowMin > liveEndMin) {
      continue;
    }

    const windowEnd = windows[index].end;
    if (windowEnd <= group.startMin) continue;

    const startPoint = pointAtOrBefore(points, group.startMin);
    const endPoint = pointAtOrBefore(points, windowEnd);
    if (!startPoint || !endPoint) continue;

    const actualWindowMin = endPoint.t - startPoint.t;
    if (actualWindowMin < 0.05) continue;

    const windowOrders = endPoint.orders - startPoint.orders;
    const windowGmv = endPoint.gmv - startPoint.gmv;

    // 基线窗口要排除之前 AI 动作的归因窗口，否则上一波的增量会抬高基线，
    // 让下一次本来有效的动作被算成负增长。
    const preStart = Math.max(0, group.startMin - baselineMin);
    const prePoints = points.filter(
      (point) =>
        point.t >= preStart &&
        point.t < group.startMin &&
        !windows.some(
          (window) =>
            point.t >= window.start && point.t < window.end,
        ),
    );

    let baselineOrders = 0;
    let baselineGmv = 0;
    if (prePoints.length >= 2) {
      const first = prePoints[0];
      const last = prePoints[prePoints.length - 1];
      const preDuration = last.t - first.t;
      if (preDuration >= 0.2) {
        const orderSlope =
          (last.orders - first.orders) / preDuration;
        const gmvSlope = (last.gmv - first.gmv) / preDuration;
        baselineOrders = orderSlope * actualWindowMin;
        baselineGmv = gmvSlope * actualWindowMin;
      }
    }

    const incrementalOrders = round1(windowOrders - baselineOrders);
    const incrementalGmv = Math.round(windowGmv - baselineGmv);

    items.push({
      decisionId: group.decisionId,
      groupId: group.groupId,
      rule: group.rule,
      ruleName: group.ruleName,
      title: group.title,
      action: group.action,
      startMin: round2(group.startMin),
      endMin: round2(endPoint.t),
      windowSec: Math.round(actualWindowMin * 60),
      windowOrders: round1(windowOrders),
      windowGmv: Math.round(windowGmv),
      baselineOrders: round1(baselineOrders),
      baselineGmv: Math.round(baselineGmv),
      incrementalOrders,
      incrementalGmv,
      liftPct: liftPct(incrementalOrders, baselineOrders),
      confidence: confidenceOf(baselineOrders, windowOrders),
    });
  }

  return items;
}
