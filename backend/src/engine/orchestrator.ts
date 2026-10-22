/**
 * AI 编排器（成员 C）
 *
 * 与 B 的集成方式：
 * - B 的 index.ts 自动 import 本文件并调用 start(ctx)；
 * - B 的 store 是唯一状态源，引擎每个 tick 读 LiveState / 策略阈值；
 * - 动作通过 ctx.executeDecision(id) 落地，状态 / 结果由 B 的执行层回写；
 * - 下播时用 store.exportSession() 生成复盘，并沉淀到经验库。
 *
 * 演示稳定性设计：
 * - 规则硬触发，LLM 只异步补理由，不阻塞动作；
 * - 多动作共享 groupId，归因按组计算；
 * - 冷却 + 全局动作间隔 + 单场次数上限，避免刷屏。
 */
import type {
  Decision,
  LiveState,
  ReviewReport,
  SessionExport,
} from '../../../shared/types.js';
import type {
  ActionExecutor,
  AiService,
  CandidateRankingInput,
  DecisionExplanationInput,
  DecisionInput,
  EngineLogger,
  EngineStore,
} from './contracts.js';
import {
  evaluateRules,
  RULE_META,
  type RuleCandidate,
  type RuleContext,
  type RuleId,
} from './rules.js';
import { createAiService, templateExplain } from './ai.js';
import {
  attributeDecisions,
  DEFAULT_BASELINE_MIN,
  DEFAULT_WINDOW_MIN,
} from '../review/attribution.js';
import { buildReviewReport } from '../review/report.js';
import {
  getDefaultExperienceLibrary,
  type ExperienceLibrary,
} from '../experience/store.js';

const WARMUP_SEC = 30;
const MIN_ACTION_GAP_SEC = 15;
const MAX_ACTIONS_PER_SESSION = 20;

const RULE_MAX_PER_SESSION: Record<RuleId, number> = {
  retention_guard: 3,
  conversion_boost: 3,
  atmosphere_activate: 3,
  closing_push: 1,
  anomaly_fallback: 2,
};

/** 模拟场景与规则的一一对应：同一场景只触发一次，避免长场景刷屏 */
const SCENARIO_RULE: Record<string, RuleId> = {
  online_drop: 'retention_guard',
  low_ctr: 'conversion_boost',
  cold_start: 'atmosphere_activate',
  stream_stall: 'anomaly_fallback',
  endgame: 'closing_push',
};

const DEFAULT_LOGGER: EngineLogger = {
  info: (message, meta) => console.log(`[engine] ${message}`, meta ?? ''),
  warn: (message, meta) => console.warn(`[engine] ${message}`, meta ?? ''),
};

export interface EngineContext {
  store: {
    get(): LiveState;
    addDecision(input: DecisionInput): Decision;
    updateDecision(id: string, patch: Partial<Decision>): Decision | undefined;
    getDecision(id: string): Decision | undefined;
    exportSession(): SessionExport;
    onTick?(fn: () => void): () => void;
  };
  executeDecision: (id: string) => Promise<unknown>;
  config: {
    deepseek: {
      apiKey?: string;
      base?: string;
      model?: string;
    };
  };
}

export interface EngineOptions {
  ai?: AiService;
  experienceLibrary?: ExperienceLibrary;
  logger?: EngineLogger;
  intervalMs?: number;
  windowMin?: number;
  baselineMin?: number;
}

export interface Orchestrator {
  start(): void;
  stop(): void;
  tick(): void;
  finalize(options?: { force?: boolean }): Promise<ReviewReport>;
  getLastReport(): ReviewReport | null;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

function virtualNow(state: LiveState): number {
  return Math.max(0, Math.round(state.metrics.elapsedMin * 60000));
}

export function createOrchestrator(
  ctx: EngineContext,
  options: EngineOptions = {},
): Orchestrator {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const ai =
    options.ai ??
    createAiService({
      apiKey: ctx.config.deepseek.apiKey,
      baseUrl: ctx.config.deepseek.base,
      model: ctx.config.deepseek.model,
      logger,
    });
  /** off 档专用：无 key 的纯模板服务，保证一次 LLM 调用都不发 */
  const templateOnlyAi = createAiService({});
  const experienceLibrary =
    options.experienceLibrary ?? getDefaultExperienceLibrary();
  const windowMin = options.windowMin ?? DEFAULT_WINDOW_MIN;
  const baselineMin = options.baselineMin ?? DEFAULT_BASELINE_MIN;
  const intervalMs = options.intervalMs ?? 1000;

  const executor: ActionExecutor = {
    async execute(decisionId: string) {
      try {
        const outcome = (await ctx.executeDecision(decisionId)) as
          | { ok?: boolean; result?: { message?: string } }
          | undefined;
        return {
          ok: outcome?.ok ?? false,
          detail: outcome?.result?.message,
        };
      } catch (error) {
        return { ok: false, detail: (error as Error).message };
      }
    },
  };

  const store: EngineStore = {
    getState: () => ctx.store.get(),
    addDecision: (input) => ctx.store.addDecision(input),
    updateDecision: (id, patch) => ctx.store.updateDecision(id, patch),
    getDecision: (id) => ctx.store.getDecision(id),
    exportSession: () => ctx.store.exportSession(),
  };

  const onlineSamples: { ts: number; online: number }[] = [];
  const danmakuSamples: { ts: number; rate: number }[] = [];
  const recentActions: { action: string; ts: number }[] = [];
  const nextRuleAllowed = new Map<string, number>();
  const ruleFireCounts = new Map<RuleId, number>();
  const pendingExecutions = new Set<Promise<void>>();

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastActionTs = -Infinity;
  let actionCount = 0;
  let groupSeq = 0;
  let lastSessionId = '';
  let lastScenario: string | null = null;
  let wasRunning = false;
  let lastReport: ReviewReport | null = null;
  let finalizePromise: Promise<ReviewReport> | null = null;
  let lastOutcomeCheckMin = -Infinity;
  let retentionSuppressedUntil = 0;
  let rerankInFlight = false;
  const firedInScenario = new Set<RuleId>();

  function resetRuntime(): void {
    onlineSamples.length = 0;
    danmakuSamples.length = 0;
    recentActions.length = 0;
    nextRuleAllowed.clear();
    ruleFireCounts.clear();
    pendingExecutions.clear();
    lastActionTs = -Infinity;
    actionCount = 0;
    groupSeq = 0;
    lastReport = null;
    finalizePromise = null;
    lastOutcomeCheckMin = -Infinity;
    lastScenario = null;
    retentionSuppressedUntil = 0;
    rerankInFlight = false;
    firedInScenario.clear();
  }

  function recordSamples(state: LiveState, now: number): void {
    onlineSamples.push({ ts: now, online: state.metrics.online });
    danmakuSamples.push({ ts: now, rate: state.metrics.danmakuRate });

    const onlineCutoff = now - 180_000;
    while (onlineSamples.length > 0 && onlineSamples[0].ts < onlineCutoff) {
      onlineSamples.shift();
    }
    const danmakuCutoff = now - 120_000;
    while (danmakuSamples.length > 0 && danmakuSamples[0].ts < danmakuCutoff) {
      danmakuSamples.shift();
    }
    const actionCutoff = now - 600_000;
    while (recentActions.length > 0 && recentActions[0].ts < actionCutoff) {
      recentActions.shift();
    }
  }

  function onlineChangePct(
    windowSec: number,
    now: number,
    currentOnline: number,
  ): number | null {
    if (onlineSamples.length === 0) return null;
    const target = now - windowSec * 1000;
    let nearest = onlineSamples[0];
    for (const sample of onlineSamples) {
      if (Math.abs(sample.ts - target) < Math.abs(nearest.ts - target)) {
        nearest = sample;
      }
    }
    if (Math.abs(nearest.ts - target) > Math.max(15_000, windowSec * 250)) {
      return null;
    }
    if (nearest.online <= 0) return null;
    return (currentOnline - nearest.online) / nearest.online;
  }

  function averageDanmaku(windowSec: number, now: number): number {
    const cutoff = now - windowSec * 1000;
    const samples = danmakuSamples.filter((sample) => sample.ts >= cutoff);
    if (samples.length === 0) return store.getState().metrics.danmakuRate;
    return (
      samples.reduce((sum, sample) => sum + sample.rate, 0) / samples.length
    );
  }

  function buildContext(state: LiveState, now: number): RuleContext {
    const elapsedSec = Math.max(0, state.metrics.elapsedMin * 60);
    const remainingSec = Math.max(
      0,
      state.metrics.totalMin * 60 - elapsedSec,
    );
    const streamHealthy =
      state.scenario !== 'stream_stall' &&
      !(state.metrics.online <= 0 && elapsedSec > 60);

    return {
      now,
      elapsedSec,
      remainingSec,
      online: state.metrics.online,
      onlineChangePct: onlineChangePct(
        state.strategy.retentionWindowSec,
        now,
        state.metrics.online,
      ),
      gmv: state.metrics.gmv,
      gmvTarget: state.strategy.gmvTarget,
      orders: state.metrics.orders,
      danmakuRate: averageDanmaku(state.strategy.coldWindowSec, now),
      productCtr:
        typeof state.metrics.productCtr === 'number'
          ? state.metrics.productCtr
          : null,
      currentProduct: state.metrics.currentProduct,
      streamHealthy,
      recentActions: recentActions.map((item) => item.action),
    };
  }

  function eligibleCandidates(
    candidates: RuleCandidate[],
    state: LiveState,
    now: number,
  ): RuleCandidate[] {
    if (actionCount >= MAX_ACTIONS_PER_SESSION) return [];
    if (now - lastActionTs < MIN_ACTION_GAP_SEC * 1000) return [];

    const scenarioRule = state.scenario
      ? SCENARIO_RULE[state.scenario]
      : undefined;

    return candidates.filter((candidate) => {
      if (
        (ruleFireCounts.get(candidate.rule) ?? 0) >=
        RULE_MAX_PER_SESSION[candidate.rule]
      ) {
        return false;
      }
      if (
        candidate.rule === 'retention_guard' &&
        now < retentionSuppressedUntil
      ) {
        return false;
      }
      if (
        scenarioRule === candidate.rule &&
        firedInScenario.has(candidate.rule)
      ) {
        return false;
      }
      const allowedAt = nextRuleAllowed.get(candidate.dedupeKey) ?? -Infinity;
      return now >= allowedAt;
    });
  }

  function buildExplanationInput(
    candidate: RuleCandidate,
    ctxRule: RuleContext,
  ): DecisionExplanationInput {
    return {
      rule: candidate.rule,
      ruleName: RULE_META[candidate.rule].name,
      actionLabels: candidate.actions.map((action) => action.label),
      triggerSummary: candidate.triggerSummary,
      expectedEffect: candidate.expectedEffect,
      metrics: {
        online: Math.round(ctxRule.online),
        gmv: Math.round(ctxRule.gmv),
        orders: Math.round(ctxRule.orders),
        danmakuRate: round1(ctxRule.danmakuRate * 100) / 100,
        elapsedMin: round1(ctxRule.elapsedSec / 60),
        remainingMin: Math.max(0, Math.round(ctxRule.remainingSec / 60)),
        currentProduct: ctxRule.currentProduct,
      },
      recentActions: ctxRule.recentActions.slice(-3),
    };
  }

  function buildRankingInput(
    candidates: RuleCandidate[],
    state: LiveState,
    ctxRule: RuleContext,
  ): CandidateRankingInput {
    return {
      scenario: state.scenario,
      metrics: {
        online: Math.round(ctxRule.online),
        gmv: Math.round(ctxRule.gmv),
        orders: Math.round(ctxRule.orders),
        danmakuRate: round1(ctxRule.danmakuRate * 100) / 100,
        elapsedMin: round1(ctxRule.elapsedSec / 60),
        remainingMin: Math.max(0, Math.round(ctxRule.remainingSec / 60)),
        currentProduct: ctxRule.currentProduct,
      },
      candidates: candidates.map((candidate) => ({
        rule: candidate.rule,
        ruleName: RULE_META[candidate.rule].name,
        priority: candidate.priority,
        triggerSummary: candidate.triggerSummary,
        actionLabels: candidate.actions.map((action) => action.label),
        expectedEffect: candidate.expectedEffect,
      })),
      recentActions: ctxRule.recentActions.slice(-5),
    };
  }

  /** full 档：LLM 只在已通过阈值/冷却的候选里选一个，失败立即回退 */
  function startRerank(
    candidates: RuleCandidate[],
    state: LiveState,
    ctxRule: RuleContext,
  ): void {
    const capturedSession = state.sessionId;
    const capturedLastActionTs = lastActionTs;
    const input = buildRankingInput(candidates, state, ctxRule);
    rerankInFlight = true;

    void ai
      .rankCandidates(input)
      .then((result) => {
        if (lastSessionId !== capturedSession) return;
        if (!store.getState().running) return;
        if (lastActionTs !== capturedLastActionTs) return;
        const current = store.getState();
        if ((current.strategy.aiLevel ?? 'hybrid') !== 'full') return;
        const chosen =
          (result &&
            candidates.find((candidate) => candidate.rule === result.rule)) ??
          candidates[0];
        const reasonOverride = result
          ? { text: result.reason, source: 'llm' as const }
          : undefined;
        fire(
          chosen,
          current,
          buildContext(current, virtualNow(current)),
          reasonOverride,
        );
      })
      .catch((error) => {
        logger.warn('AI 候选排序失败，回退规则优先级', { error });
        if (lastSessionId !== capturedSession) return;
        if (!store.getState().running) return;
        if (lastActionTs !== capturedLastActionTs) return;
        const current = store.getState();
        fire(
          candidates[0],
          current,
          buildContext(current, virtualNow(current)),
        );
      })
      .finally(() => {
        rerankInFlight = false;
      });
  }

  async function executeOne(decision: Decision): Promise<void> {
    const result = await executor.execute(decision.id);
    const updated = store.getDecision(decision.id);
    if (
      updated &&
      updated.status === 'executed' &&
      typeof updated.executedElapsedMin !== 'number'
    ) {
      store.updateDecision(decision.id, {
        executedElapsedMin: store.getState().metrics.elapsedMin,
      });
    }
    if (!result.ok) {
      logger.warn('动作执行失败', {
        decisionId: decision.id,
        detail: result.detail,
      });
    }
  }

  function scheduleExecution(decision: Decision): void {
    const promise = executeOne(decision);
    pendingExecutions.add(promise);
    void promise.finally(() => pendingExecutions.delete(promise));
  }

  function fire(
    candidate: RuleCandidate,
    state: LiveState,
    ctxRule: RuleContext,
    reasonOverride?: { text: string; source: 'llm' | 'template' },
  ): void {
    const now = ctxRule.now;
    const groupId = `${state.sessionId || 'live'}-g${++groupSeq}`;
    const mode = state.mode;
    const aiLevel = state.strategy.aiLevel ?? 'hybrid';
    const selectedActions =
      mode === 'auto' ? candidate.actions : [candidate.actions[0]];
    const explanationInput = buildExplanationInput(candidate, ctxRule);
    const reason =
      reasonOverride?.text ?? templateExplain(explanationInput);
    const reasonSource = reasonOverride?.source ?? 'template';

    const decisions = selectedActions.map((action) =>
      store.addDecision({
        rule: RULE_META[candidate.rule].name,
        ruleId: candidate.rule,
        action: action.action,
        reason,
        mode,
        status:
          mode === 'auto'
            ? 'suggested'
            : mode === 'semiauto'
              ? 'pending_confirm'
              : 'suggested',
        title: action.label,
        payload: action.payload,
        snapshot: { ...state.metrics },
        groupId,
        expectedEffect: candidate.expectedEffect,
        reasonSource,
      }),
    );

    nextRuleAllowed.set(
      candidate.dedupeKey,
      now + candidate.cooldownSec * 1000,
    );
    lastActionTs = now;
    actionCount += 1;
    ruleFireCounts.set(
      candidate.rule,
      (ruleFireCounts.get(candidate.rule) ?? 0) + 1,
    );
    if (state.scenario && SCENARIO_RULE[state.scenario] === candidate.rule) {
      firedInScenario.add(candidate.rule);
    }
    if (candidate.rule === 'anomaly_fallback') {
      retentionSuppressedUntil = now + 180_000;
    }
    for (const action of candidate.actions) {
      recentActions.push({ action: action.action, ts: now });
    }

    if (!reasonOverride && aiLevel !== 'off') {
      void ai
        .explainDecision(explanationInput)
        .then((result) => {
          for (const decision of decisions) {
            store.updateDecision(decision.id, {
              reason: result.text,
              reasonSource: result.source,
            });
          }
        })
        .catch((error) => {
          logger.warn('决策理由回填失败，保留模板理由', {
            groupId,
            error,
          });
        });
    }

    if (mode === 'auto') {
      for (const decision of decisions) scheduleExecution(decision);
    }
  }

  function processOutcomes(
    state: LiveState,
    now: number,
    force: boolean,
  ): void {
    if (!state.decisions.some((decision) => decision.status === 'executed')) {
      return;
    }
    const currentMin = state.metrics.elapsedMin;
    if (!force && currentMin - lastOutcomeCheckMin < 0.5) return;
    lastOutcomeCheckMin = currentMin;

    const items = attributeDecisions(state.decisions, state.timeline, {
      windowMin,
      baselineMin,
      liveEndMin: currentMin,
      force,
    });

    for (const item of items) {
      for (const decision of state.decisions) {
        if ((decision.groupId ?? decision.id) !== item.groupId) continue;
        if (decision.status !== 'executed') continue;
        if (!force && decision.outcome) continue;
        store.updateDecision(decision.id, {
          outcome: {
            windowSec: item.windowSec,
            incrementalOrders: item.incrementalOrders,
            incrementalGmv: item.incrementalGmv,
            liftPct: item.liftPct,
            confidence: item.confidence,
          },
        });
      }
    }
  }

  function tick(): void {
    try {
      const state = store.getState();
      const now = virtualNow(state);

      if (state.sessionId !== lastSessionId) {
        resetRuntime();
        lastSessionId = state.sessionId;
        wasRunning = state.running;
      }

      if (state.scenario !== lastScenario) {
        lastScenario = state.scenario;
        firedInScenario.clear();
      }

      recordSamples(state, now);
      processOutcomes(state, now, false);

      if (wasRunning && !state.running) {
        wasRunning = false;
        void finalize();
        return;
      }
      wasRunning = state.running;

      if (!state.running) return;
      if (!state.strategy.enabled) return;
      if (now < WARMUP_SEC * 1000) return;

      const ctxRule = buildContext(state, now);
      const eligible = eligibleCandidates(
        evaluateRules(ctxRule, state.strategy),
        state,
        now,
      );
      if (eligible.length === 0) return;

      const aiLevel = state.strategy.aiLevel ?? 'hybrid';
      if (aiLevel === 'full' && eligible.length > 1) {
        if (rerankInFlight) return;
        startRerank(eligible, state, ctxRule);
        return;
      }
      fire(eligible[0], state, ctxRule);
    } catch (error) {
      logger.warn('编排器 tick 异常', { error });
    }
  }

  function finalize(
    options_: { force?: boolean } = {},
  ): Promise<ReviewReport> {
    const force = options_.force ?? false;
    if (finalizePromise) return finalizePromise;
    if (lastReport && !force) return Promise.resolve(lastReport);

    finalizePromise = (async () => {
      await Promise.allSettled([...pendingExecutions]);
      const state = store.getState();
      processOutcomes(state, virtualNow(state), true);

      const reviewState = store.getState();
      const reviewAi =
        (reviewState.strategy.aiLevel ?? 'hybrid') === 'off'
          ? templateOnlyAi
          : ai;
      const report = await buildReviewReport({
        session: store.exportSession(),
        ai: reviewAi,
        experienceLibrary,
        logger,
        windowMin,
        baselineMin,
      });

      for (const item of report.leaderboard) {
        for (const decision of store.getState().decisions) {
          if ((decision.groupId ?? decision.id) !== item.groupId) continue;
          if (decision.status !== 'executed') continue;
          store.updateDecision(decision.id, {
            outcome: {
              windowSec: item.windowSec,
              incrementalOrders: item.incrementalOrders,
              incrementalGmv: item.incrementalGmv,
              liftPct: item.liftPct,
              confidence: item.confidence,
            },
          });
        }
      }

      try {
        await experienceLibrary.addFromReport(report);
      } catch (error) {
        logger.warn('经验库写入失败', { error });
      }

      lastReport = report;
      logger.info('复盘报告已生成', {
        source: report.source,
        experiences: report.experiences.length,
      });
      return report;
    })().finally(() => {
      finalizePromise = null;
    });

    return finalizePromise;
  }

  return {
    start(): void {
      if (timer) return;
      tick();
      timer = setInterval(tick, intervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tick,
    finalize,
    getLastReport(): ReviewReport | null {
      return lastReport;
    },
  };
}

let currentEngine: Orchestrator | null = null;
let currentUnsubscribe: (() => void) | null = null;

/** B 的 index.ts 自动调用 */
export function start(
  ctx: EngineContext,
  options: EngineOptions = {},
): void {
  if (currentEngine) return;
  const engine = createOrchestrator(ctx, options);
  currentEngine = engine;
  currentUnsubscribe = ctx.store.onTick?.(() => engine.tick()) ?? null;
  engine.start();
  console.log('[engine] AI 编排引擎已启动');
}

export function stopEngine(): void {
  currentUnsubscribe?.();
  currentUnsubscribe = null;
  currentEngine?.stop();
  currentEngine = null;
}

export function getLastReport(): ReviewReport | null {
  return currentEngine?.getLastReport() ?? null;
}

export async function finalizeNow(
  force = true,
): Promise<ReviewReport | null> {
  if (!currentEngine) return null;
  return currentEngine.finalize({ force });
}
