import type {
  ExperienceMatch,
  ReplayResp,
  ReviewMark,
  ReviewReport,
  SessionExport,
  TimelinePoint,
} from '../../../shared/types.js';
import type {
  AiService,
  EngineLogger,
  ReviewNarrativeInput,
  ReviewNarrativeResult,
} from '../engine/contracts.js';
import { createAiService, templateReviewNarrative } from '../engine/ai.js';
import { buildExperienceQuery } from '../experience/query.js';
import {
  getDefaultExperienceLibrary,
  isUsefulExperience,
  type ExperienceLibrary,
} from '../experience/store.js';
import {
  attributeDecisions,
  groupExecutedDecisions,
} from './attribution.js';

export interface BuildReviewInput {
  session: SessionExport;
  ai: AiService;
  experienceLibrary?: ExperienceLibrary;
  generatedAt?: number;
  windowMin?: number;
  baselineMin?: number;
  logger?: EngineLogger;
}

export interface ReportContext {
  config?: {
    deepseek?: {
      apiKey?: string;
      base?: string;
      model?: string;
    };
  };
  store?: unknown;
}

export interface GenerateReportOptions {
  ai?: AiService;
  experienceLibrary?: ExperienceLibrary;
  logger?: EngineLogger;
}

const DEFAULT_LOGGER: EngineLogger = {
  info: (message, meta) => console.log(`[review] ${message}`, meta ?? ''),
  warn: (message, meta) => console.warn(`[review] ${message}`, meta ?? ''),
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

function downsampleTimeline(
  points: TimelinePoint[],
  maxPoints = 120,
): TimelinePoint[] {
  if (points.length <= maxPoints) return points.map((point) => ({ ...point }));
  const step = (points.length - 1) / (maxPoints - 1);
  const result: TimelinePoint[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const point = points[Math.round(index * step)];
    result.push({ ...point });
  }
  return result;
}

function buildReportText(report: ReviewReport): string {
  const lines = [
    `【本场关键指标】直播 ${round1(report.live.totalMin)} 分钟，峰值在线 ${report.live.peakOnline} 人，`
      + `累计观看 ${report.live.totalViewers} 人次，下单 ${report.live.finalOrders} 单，GMV ¥${report.live.finalGmv}。`,
    report.leaderboard.length > 0
      ? `【互动效果】AI 共执行 ${report.live.actionCount} 次动作；最强的是「${report.leaderboard[0].title}」，`
        + `其后 ${report.leaderboard[0].windowSec} 秒带来 +${report.leaderboard[0].incrementalOrders} 单 / +¥${report.leaderboard[0].incrementalGmv}。`
      : `【互动效果】本场 AI 共执行 ${report.live.actionCount} 次动作，暂无足够数据归因。`,
    report.bestWindow
      ? `【最佳互动时段】第 ${Math.round(report.bestWindow.startMin)}–${Math.round(report.bestWindow.endMin)} 分钟 · ${report.bestWindow.label}。`
      : '【最佳互动时段】暂无。',
    `【转化归因】${report.conclusion}`,
    `【下次优化建议】${report.suggestions.join(' ')}`,
    report.experiences.length > 0
      ? `【历史经验】匹配到 ${report.experiences.length} 条相似案例：${report.experiences
          .map((item) => `「${item.title}」`)
          .join('、')}。`
      : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function buildReviewReport(
  input: BuildReviewInput,
): Promise<ReviewReport> {
  const { session, ai } = input;
  const liveEndMin = Math.max(
    session.durationMin || session.metrics.elapsedMin,
    session.timeline[session.timeline.length - 1]?.t ?? 0,
  );

  const leaderboard = attributeDecisions(session.decisions, session.timeline, {
    windowMin: input.windowMin,
    baselineMin: input.baselineMin,
    liveEndMin,
    force: true,
  }).sort((a, b) => b.incrementalGmv - a.incrementalGmv);

  const executed = session.decisions.filter(
    (decision) => decision.status === 'executed',
  );
  const firedRules = [
    ...new Set(
      executed.map((decision) => decision.ruleId ?? decision.rule),
    ),
  ];
  const peakOnline = Math.max(
    session.metrics.online,
    ...session.timeline.map((point) => point.online),
    0,
  );
  const best = leaderboard[0] ?? null;
  const bestWindow = best
    ? {
        startMin: best.startMin,
        endMin: best.endMin,
        incrementalGmv: best.incrementalGmv,
        label: `第 ${Math.round(best.startMin)} 分钟 · ${best.ruleName}`,
      }
    : null;

  const experienceTopK = Math.min(
    10,
    Math.max(1, session.strategy.experienceTopK ?? 3),
  );
  let experiences: ExperienceMatch[] = [];
  if (input.experienceLibrary) {
    try {
      experiences = (
        await input.experienceLibrary.search(
          buildExperienceQuery({
            metrics: session.metrics,
            leaderboard,
            productRanking: session.products,
          }),
          experienceTopK + 3,
        )
      )
        .filter(
          (item) =>
            item.source !== 'review' ||
            item.sessionId !== session.sessionId,
        )
        .filter(isUsefulExperience)
        .slice(0, experienceTopK);
    } catch (error) {
      input.logger?.warn('经验库检索失败，跳过历史经验', { error });
    }
  }

  const narrativeInput: ReviewNarrativeInput = {
    totalMin: liveEndMin,
    peakOnline,
    finalOnline: session.metrics.online,
    totalViewers: session.metrics.totalViewers,
    finalOrders: session.metrics.orders,
    finalGmv: session.metrics.gmv,
    actionCount: executed.length,
    items: leaderboard.map((item) => ({
      rule: item.rule,
      ruleName: item.ruleName,
      action: item.action,
      minute: item.startMin,
      incrementalOrders: item.incrementalOrders,
      incrementalGmv: item.incrementalGmv,
      liftPct: item.liftPct,
      confidence: item.confidence,
    })),
    bestWindow: bestWindow
      ? {
          startMin: bestWindow.startMin,
          endMin: bestWindow.endMin,
          incrementalGmv: bestWindow.incrementalGmv,
        }
      : null,
    productRanking: session.products.map((item) => ({
      name: item.name,
      orders: item.orders,
      gmv: item.gmv,
    })),
    firedRules,
    experiences,
  };

  let narrative: ReviewNarrativeResult;
  try {
    narrative = await ai.generateReview(narrativeInput);
  } catch {
    narrative = {
      ...templateReviewNarrative(narrativeInput),
      source: 'template',
    };
  }

  const groups = groupExecutedDecisions(session.decisions);
  const marks: ReviewMark[] = groups.map((group) => ({
    t: group.startMin,
    label: group.title,
    rule: group.rule,
    action: group.action,
    decisionId: group.decisionId,
  }));

  return {
    generatedAt: input.generatedAt ?? Date.now(),
    source: narrative.source,
    sessionId: session.sessionId,
    live: {
      totalMin: round1(liveEndMin),
      peakOnline,
      finalOnline: session.metrics.online,
      totalViewers: session.metrics.totalViewers,
      finalOrders: session.metrics.orders,
      finalGmv: Math.round(session.metrics.gmv),
      actionCount: executed.length,
    },
    overview: narrative.overview,
    leaderboard,
    bestWindow,
    conclusion: narrative.conclusion,
    suggestions: narrative.suggestions,
    experiences,
    productRanking: session.products,
    timeline: downsampleTimeline(session.timeline),
    marks,
  };
}

/** B 的 /api/replay 自动调用：返回兼容 ReplayResp 的结构，并附带完整 review */
export async function generateReport(
  payload: SessionExport,
  ctx: ReportContext = {},
  options: GenerateReportOptions = {},
): Promise<ReplayResp> {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const deepseek = ctx.config?.deepseek;
  const ai =
    options.ai ??
    createAiService({
      apiKey: deepseek?.apiKey,
      baseUrl: deepseek?.base,
      model: deepseek?.model,
      logger,
    });
  const experienceLibrary =
    options.experienceLibrary ?? getDefaultExperienceLibrary();

  const report = await buildReviewReport({
    session: payload,
    ai,
    experienceLibrary,
    logger,
  });

  return {
    report: buildReportText(report),
    structured: {
      summary: report.overview,
      keyMetrics: payload.metrics,
      topActions: report.leaderboard.map((item) => ({
        decisionId: item.decisionId,
        title: item.title,
        rule: item.ruleName,
        gmvDelta: item.incrementalGmv,
        orderDelta: item.incrementalOrders,
      })),
      bestWindow: report.bestWindow
        ? {
            from: report.bestWindow.startMin,
            to: report.bestWindow.endMin,
            note: report.bestWindow.label,
          }
        : undefined,
      suggestions: report.suggestions,
      leaderboard: report.leaderboard,
      experiences: report.experiences,
    },
    generatedAt: report.generatedAt,
    engine: report.source === 'llm' ? 'ai' : 'template',
    review: report,
  };
}
