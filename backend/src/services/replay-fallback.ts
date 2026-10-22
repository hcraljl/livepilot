/**
 * 复盘兜底生成器（B 侧保险）
 *
 * 正常链路由 C 的 engine/ai.ts + review/report.ts 产出（DeepSeek）。
 * 这里只保证：即使 C 的模块尚未合并 / LLM 不可用，/api/replay 也永远返回一份**基于真实数据**的报告，
 * 绝不空接口、绝不编造数字 —— 演示现场不能因为队友模块没到位就黑屏。
 */
import type { Decision, ReplayResp, TimelinePoint } from '../../../shared/types.ts';import { store } from '../store/state.ts';

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 简化归因：决策后 3 分钟窗口内的下单/GMV 增量（正式归因由 C 的 attribution.ts 实现） */
const windowDelta = (timeline: TimelinePoint[], atMin: number, windowMin = 3) => {
  const from = timeline.filter((p) => p.t >= atMin);
  const within = from.filter((p) => p.t <= atMin + windowMin);
  if (within.length === 0) return { orderDelta: 0, gmvDelta: 0 };
  const first = within[0];
  const last = within[within.length - 1];
  return { orderDelta: last.orders - first.orders, gmvDelta: last.gmv - first.gmv };
};

export const buildFallbackReplay = (): ReplayResp => {
  const s = store.exportSession();
  const m = s.metrics;
  const executed = s.decisions.filter((d: Decision) => d.status === 'executed');
  const convRate = m.totalViewers > 0 ? (m.orders / m.totalViewers) * 100 : 0;

  const topActions = executed
    .map((d) => {
      const atMin = typeof d.snapshot?.elapsedMin === 'number' ? d.snapshot.elapsedMin : 0;
      const delta = windowDelta(s.timeline, atMin);
      return { decisionId: d.id, title: d.title ?? d.rule, rule: d.rule, ...delta };
    })
    .sort((a, b) => b.gmvDelta - a.gmvDelta)
    .slice(0, 5);

  const bestWindow = [...topActions][0];
  const suggestions = [
    m.totalViewers > 0 && convRate < 2
      ? '整体转化率偏低：建议把「商品点击」环节前置到开场 3 分钟内，并配合条件抽奖绑定主推品。'
      : '转化节奏健康：保持「讲品 3 分钟 + 一次互动」的固定节拍，避免连续长时间纯讲品。',
    executed.length === 0
      ? '本场未产生自动动作：确认策略面板是否开启「自动模式」，或阈值设置过严导致规则未触发。'
      : `本场共触发 ${executed.length} 次自动动作，建议复盘 ROI 最高的那一次并把该场景固化为标准 SOP。`,
    `末段剩余 10 分钟时 GMV 为 ¥${Math.round(m.gmv)}，建议提前 15 分钟做一次福利券预热，给逼单留出 2 个转化波峰。`,
  ];

  const report = [
    `【本场关键指标】直播 ${round1(m.elapsedMin)} 分钟，峰值在线 ${m.online} 人，累计观看 ${m.totalViewers} 人次，`
      + `下单 ${m.orders} 单，GMV ¥${Math.round(m.gmv)}，观看-下单转化率 ${round1(convRate)}%。`,
    `【互动效果】AI 共产出 ${s.decisions.length} 条决策，其中落地执行 ${executed.length} 条；`
      + (executed.length
        ? `表现最好的是「${bestWindow.title}」，其后 3 分钟带来 +${bestWindow.orderDelta} 单 / +¥${Math.round(bestWindow.gmvDelta)}。`
        : '本场未落地自动动作。'),
    `【下一步建议】${suggestions[0]}`,
    '（当前为后端兜底报告：未检测到 AI 复盘模块或 LLM 未配置，接入 DeepSeek 后同一份数据会生成更细腻的归因叙述。）',
  ].join('\n');

  return {
    report,
    structured: {
      summary: `直播 ${round1(m.elapsedMin)} 分钟 · 累计观看 ${m.totalViewers} · GMV ¥${Math.round(m.gmv)}`,
      keyMetrics: m,
      topActions,
      bestWindow: bestWindow ? { from: 0, to: 0, note: `最佳互动：${bestWindow.title}` } : undefined,
      suggestions,
    },
    generatedAt: Date.now(),
    engine: 'template',
  };
};
