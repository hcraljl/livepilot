/**
 * C 侧端到端自测：直接跑 B 的真实模拟器 + store + 路由同款执行链。
 * 用 mock executeDecision 替代保利威调用，验证：
 * 1) 5 条规则在真实模拟剧本中全部触发；
 * 2) 多动作 groupId、执行状态、3 分钟闭环 outcome；
 * 3) 复盘归因 / 经验库检索 / ReplayResp 兼容；
 * 4) LLM 适配层的 JSON 解析与防幻觉兜底。
 *
 * 运行：npm run engine:demo -w backend
 */
import type {
  PolyvCallResult,
  ReplayResp,
  ReviewReport,
  SessionExport,
} from '../../../shared/types.js';
import { config } from '../config.ts';
import { store } from '../store/state.ts';
import { simulator } from '../simulator/simulator.ts';
import { createAiService } from './ai.ts';
import type {
  CandidateRankingInput,
  DecisionExplanationInput,
  EngineLogger,
  ReviewNarrativeInput,
} from './contracts.ts';
import {
  finalizeNow,
  start,
  stopEngine,
} from './orchestrator.ts';
import { RULE_META, type RuleId } from './rules.ts';
import { generateReport } from '../review/report.ts';
import { createExperienceLibrary } from '../experience/store.ts';

const RULE_IDS: RuleId[] = [
  'retention_guard',
  'conversion_boost',
  'atmosphere_activate',
  'closing_push',
  'anomaly_fallback',
];

const logger: EngineLogger = {
  info: (message, meta) => console.log(`[test] ${message}`, meta ?? ''),
  warn: (message, meta) => console.warn(`[test] ${message}`, meta ?? ''),
};

async function mockExecuteDecision(id: string): Promise<unknown> {
  const decision = store.getDecision(id);
  if (!decision) return undefined;
  if (decision.status === 'executed') {
    return { ok: true, decision, result: decision.result };
  }
  const result: PolyvCallResult = {
    ok: true,
    mock: true,
    code: 200,
    message: 'harness mock',
    endpoint: `mock/${decision.action}`,
  };
  const updated = store.updateDecision(id, {
    status: 'executed',
    executedAt: Date.now(),
    executedElapsedMin: store.get().metrics.elapsedMin,
    result,
  });
  store.logEvent(
    'action',
    `已执行（mock）：${decision.title ?? decision.rule}`,
    'harness mock',
    id,
  );
  store.markTimeline();
  return { ok: true, decision: updated, result };
}

function waitForSessionEnd(): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe((state) => {
      if (state.startedAt && !state.running && state.endedAt) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function printDecisions(report: ReviewReport): void {
  console.log('\n=== 决策流 ===');
  for (const decision of store.get().decisions) {
    const at = decision.executedElapsedMin ?? decision.snapshot?.elapsedMin ?? 0;
    const outcome = decision.outcome
      ? ` | 实测 +${decision.outcome.incrementalOrders} 单 / ¥${decision.outcome.incrementalGmv}（${decision.outcome.confidence}）`
      : '';
    const group = decision.groupId ? ` [${decision.groupId.slice(-3)}]` : '';
    console.log(
      `[${at.toFixed(1)}min]${group} ${decision.rule} · ${decision.title ?? decision.action} -> ${decision.status}${outcome}`,
    );
  }
  console.log(`复盘报告 ${report.leaderboard.length} 条归因 / ${report.experiences.length} 条历史经验`);
}

async function smokeAi(): Promise<boolean> {
  const explainInput: DecisionExplanationInput = {
    rule: 'retention_guard',
    ruleName: '留存保卫',
    actionLabels: ['无条件抽奖', '卡片召回'],
    triggerSummary: '在线人数 25% 下滑',
    expectedEffect: '2 分钟内拉回在线人数',
    metrics: {
      online: 900,
      gmv: 6000,
      orders: 20,
      danmakuRate: 0.05,
      elapsedMin: 2.5,
      remainingMin: 12.5,
      currentProduct: '山野茶油 500ml',
    },
    recentActions: [],
  };
  const reviewInput: ReviewNarrativeInput = {
    totalMin: 30,
    peakOnline: 3300,
    finalOnline: 1800,
    totalViewers: 60000,
    finalOrders: 500,
    finalGmv: 50000,
    actionCount: 5,
    items: [
      {
        rule: 'conversion_boost',
        ruleName: '转化助推',
        action: 'push_product',
        minute: 15.6,
        incrementalOrders: 23.1,
        incrementalGmv: 2287,
        liftPct: 963,
        confidence: 'medium',
      },
    ],
    bestWindow: { startMin: 15.6, endMin: 18.6, incrementalGmv: 2287 },
    productRanking: [{ name: '山野茶油 500ml', orders: 500, gmv: 50000 }],
    firedRules: ['conversion_boost'],
  };

  let bad = false;
  const fakeFetch = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      response_format?: unknown;
    };
    let content: string;
    if (body.response_format) {
      content = JSON.stringify({
        overview: '本场成交 500 单，GMV 50000 元。',
        conclusion: '第 16 分钟的转化助推带来 23 单增量。',
        suggestions: ['保持商品讲解节奏', '提前准备答题卡', '把优惠券前置'],
      });
    } else if (bad) {
      content = 'GMV 已经达到 99999 元。';
    } else {
      content = '在线人数下滑 25%，先抽奖把观众拉回来。';
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  const ai = createAiService({ apiKey: 'test-key', fetchImpl: fakeFetch });
  const explanation = await ai.explainDecision(explainInput);
  const review = await ai.generateReview(reviewInput);
  bad = true;
  const guarded = await ai.explainDecision(explainInput);
  const ok =
    explanation.source === 'llm' &&
    review.source === 'llm' &&
    guarded.source === 'template';

  const rankInput: CandidateRankingInput = {
    scenario: 'low_ctr',
    metrics: {
      online: 2200,
      gmv: 18000,
      orders: 160,
      danmakuRate: 0.31,
      elapsedMin: 15.6,
      remainingMin: 14.4,
      currentProduct: '手工红糖姜茶礼盒',
    },
    candidates: [
      {
        rule: 'retention_guard',
        ruleName: '留存保卫',
        priority: 100,
        triggerSummary: '在线人数 8% 下滑',
        actionLabels: ['无条件抽奖'],
        expectedEffect: '拉回在线',
      },
      {
        rule: 'conversion_boost',
        ruleName: '转化助推',
        priority: 80,
        triggerSummary: '点击率 0.4% 低于阈值 3%',
        actionLabels: ['推送商品', '商品福利抽奖'],
        expectedEffect: '缩短下单路径',
      },
    ],
    recentActions: [],
  };
  const rankFetch = (async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                rule: 'conversion_boost',
                reason: '点击率低于阈值，优先缩短下单路径。',
              }),
            },
          },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;
  const badRankFetch = (async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                rule: 'made_up_rule',
                reason: '不存在的规则',
              }),
            },
          },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;

  const rankAi = createAiService({ apiKey: 'test-key', fetchImpl: rankFetch });
  const badRankAi = createAiService({
    apiKey: 'test-key',
    fetchImpl: badRankFetch,
  });
  const ranking = await rankAi.rankCandidates(rankInput);
  const badRanking = await badRankAi.rankCandidates(rankInput);
  const rankOk =
    ranking?.rule === 'conversion_boost' &&
    ranking.source === 'llm' &&
    badRanking === null;

  console.log(
    ok
      ? 'PASS：LLM 理由解析 / 复盘 JSON / 数字防幻觉兜底'
      : 'FAIL：AI 适配层异常',
  );
  console.log(
    rankOk
      ? 'PASS：full 档候选重排 + 非法规则回退'
      : 'FAIL：候选重排异常',
  );
  return ok && rankOk;
}

async function smokeExperience(): Promise<boolean> {
  const library = createExperienceLibrary({ filePath: null, logger });
  await library.load();
  const cases: { query: string; rule?: RuleId; source?: 'review' | 'playbook' }[] = [
    {
      query: '在线人数骤降 25% 抽奖 卡片召回 流失',
      rule: 'retention_guard',
    },
    {
      query: '商品点击率 2.7% 推送商品 福利抽奖 下单',
      rule: 'conversion_boost',
    },
    {
      query: '冷场 弹幕率低 答题卡 签到',
      rule: 'atmosphere_activate',
    },
    {
      query: '剩余 5 分钟 GMV 不足 发券 公告 逼单',
      rule: 'closing_push',
    },
    {
      query: '开播前 5 分钟福利 SOP 知识库',
      source: 'playbook',
    },
  ];

  let ok = true;
  for (const test of cases) {
    const [top] = await library.search(test.query, 1);
    const hit = test.rule
      ? Boolean(top?.rules.includes(test.rule))
      : top?.source === test.source;
    console.log(
      `${hit ? 'PASS' : 'FAIL'}：经验检索「${test.query}」-> ${
        top ? `${top.title}（相似度 ${top.similarity}）` : '无匹配'
      }`,
    );
    if (!hit) ok = false;
  }
  return ok;
}

async function main(): Promise<void> {
  const experienceLibrary = createExperienceLibrary({
    filePath: null,
    logger,
  });

  const requestedLevel = process.env.HARNESS_AI_LEVEL;
  if (
    requestedLevel === 'off' ||
    requestedLevel === 'hybrid' ||
    requestedLevel === 'full'
  ) {
    store.updateStrategy({ aiLevel: requestedLevel });
  }

  start(
    {
      store,
      executeDecision: mockExecuteDecision,
      config,
    },
    { experienceLibrary, logger, intervalMs: 1000 },
  );

  console.log(
    `开始端到端回放：30 分钟虚拟直播，加速 300x（约 6~10 秒），智能档位 ${store.get().strategy.aiLevel}，无 key 时走模板`,
  );
  const done = waitForSessionEnd();
  simulator.start({ totalMin: 30, speed: 300, tickMs: 2, seed: 20261024 });
  await done;
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const report = await finalizeNow(true);
  if (!report) {
    console.error('FAIL：引擎未生成复盘报告');
    process.exitCode = 1;
    stopEngine();
    return;
  }

  printDecisions(report);

  console.log('\n=== 互动归因榜 ===');
  for (const item of report.leaderboard) {
    console.log(
      `第 ${item.startMin}–${item.endMin} 分钟 ${item.title} | 增量 ${item.incrementalOrders} 单 / ¥${item.incrementalGmv} | lift ${item.liftPct}% | ${item.confidence}`,
    );
  }

  console.log('\n=== 历史经验匹配 ===');
  for (const experience of report.experiences) {
    console.log(
      `[${experience.source}] ${experience.title} | 相似度 ${experience.similarity} | 优先级 ${experience.priority}`,
    );
  }

  console.log('\n=== 复盘 ===');
  console.log(`来源: ${report.source}`);
  console.log(`总览: ${report.overview}`);
  console.log(`最佳时段: ${report.bestWindow?.label ?? '无'}`);
  console.log(`归因结论: ${report.conclusion}`);
  console.log('建议:');
  for (const suggestion of report.suggestions) console.log(`- ${suggestion}`);

  const session: SessionExport = store.exportSession();
  const replay: ReplayResp = await generateReport(
    session,
    { store, config },
    {
      ai: createAiService({}),
      experienceLibrary: createExperienceLibrary({ filePath: null, logger }),
      logger,
    },
  );
  console.log('\n=== ReplayResp 兼容性 ===');
  console.log(`engine: ${replay.engine}`);
  console.log(`topActions: ${replay.structured?.topActions.length ?? 0}`);
  console.log(`report.review: ${replay.review ? '已附带完整复盘' : '缺失'}`);
  console.log(`报告首行: ${replay.report.split('\n')[0]}`);

  const decisions = store.get().decisions;
  const firedRules = new Set(
    decisions.map((decision) => decision.ruleId ?? decision.rule),
  );
  const missing = RULE_IDS.filter((rule) => !firedRules.has(rule));
  const executed = decisions.filter((decision) => decision.status === 'executed');
  const grouped = new Set(decisions.map((decision) => decision.groupId ?? decision.id));

  console.log('\n=== 自检 ===');
  console.log(
    `触发规则: ${RULE_IDS.filter((rule) => firedRules.has(rule))
      .map((rule) => RULE_META[rule].name)
      .join(' / ')}`,
  );
  const rulesOk = missing.length === 0;
  console.log(
    rulesOk
      ? 'PASS：5 条规则全部触发'
      : `FAIL：缺少 ${missing.map((rule) => RULE_META[rule].name).join(' / ')}`,
  );
  const executionOk = executed.length >= 5 && grouped.size >= 3;
  console.log(
    executionOk
      ? `PASS：动作执行 ${executed.length} 条 / 动作组 ${grouped.size} 个`
      : 'FAIL：动作执行链异常',
  );
  const reportOk =
    report.leaderboard.length > 0 &&
    report.experiences.length > 0 &&
    report.marks.length > 0;
  console.log(
    reportOk ? 'PASS：归因 / 经验库 / 曲线标记已生成' : 'FAIL：复盘数据异常',
  );
  const replayOk =
    replay.review !== undefined &&
    (replay.structured?.topActions.length ?? 0) > 0;
  console.log(
    replayOk ? 'PASS：ReplayResp 兼容' : 'FAIL：ReplayResp 结构异常',
  );

  const aiOk = await smokeAi();
  const expOk = await smokeExperience();
  stopEngine();
  if (!rulesOk || !executionOk || !reportOk || !replayOk || !aiOk || !expOk) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  stopEngine();
  process.exitCode = 1;
});
