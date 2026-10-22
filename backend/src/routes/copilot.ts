/**
 * AI 副驾候选 / 操作选择（C 扩展）
 *
 * 流程：
 * 1) TF-IDF 返回 TopK 历史经验（不是只给一条）；
 * 2) 前端展示经验与可选动作，人工选择；
 * 3) 或让 LLM 在候选动作里推荐一个（白名单 + 数字校验，失败回退模板）；
 * 4) 执行前必须 confirm=true，预览阶段绝不落地动作。
 */
import { Router } from 'express';
import type {
  ActionType,
  CopilotActionOption,
  CopilotCandidatesResp,
  CopilotRecommendation,
} from '../../../shared/types.js';
import { config } from '../config.js';
import { store } from '../store/state.js';
import { executeAction } from '../polyv/executor.js';
import { createAiService } from '../engine/ai.js';
import type {
  ActionRecommendationInput,
  AiService,
  EngineLogger,
} from '../engine/contracts.js';
import { attributeDecisions } from '../review/attribution.js';
import {
  getDefaultExperienceLibrary,
  isUsefulExperience,
} from '../experience/store.js';
import {
  ACTION_LABELS,
  buildExperienceQuery,
} from '../experience/query.js';
import { buildActionPayload } from '../experience/actions.js';

export const copilotRouter = Router();

const LOGGER: EngineLogger = {
  info: (message, meta) => console.log(`[copilot] ${message}`, meta ?? ''),
  warn: (message, meta) => console.warn(`[copilot] ${message}`, meta ?? ''),
};

let aiService: AiService | null = null;

function getAi(): AiService {
  if (!aiService) {
    aiService = createAiService({
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.base,
      model: config.deepseek.model,
      logger: LOGGER,
    });
  }
  return aiService;
}

const ok = (data: unknown) => ({ ok: true, data });
const fail = (error: string, code = 400) => ({ ok: false, error, code });

function clampTopK(value: number, fallback: number): number {
  const parsed = Number.isFinite(value) && value > 0 ? value : fallback;
  return Math.min(10, Math.max(1, Math.round(parsed)));
}

function buildActionOptions(
  experiences: CopilotCandidatesResp['experiences'],
): CopilotActionOption[] {
  const seen = new Set<string>();
  const options: CopilotActionOption[] = [];
  for (const experience of experiences) {
    for (const rawAction of experience.actions) {
      const action = rawAction as ActionType;
      if (!Object.prototype.hasOwnProperty.call(ACTION_LABELS, action)) {
        continue;
      }
      const key = `${experience.id}:${action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        experienceId: experience.id,
        experienceTitle: experience.title,
        action,
        label: ACTION_LABELS[action],
        similarity: experience.similarity,
        priority: experience.priority,
        source: experience.source,
        result: experience.result,
      });
    }
  }
  return options;
}

function templateRecommendation(
  experiences: CopilotCandidatesResp['experiences'],
  actions: CopilotActionOption[],
): CopilotRecommendation | null {
  const top = experiences[0];
  if (!top) return null;
  const option =
    actions.find(
      (item) =>
        item.experienceId === top.id &&
        item.action === (top.actions[0] as ActionType),
    ) ?? actions.find((item) => item.experienceId === top.id);
  if (!option) return null;
  return {
    experienceId: option.experienceId,
    action: option.action,
    reason: `历史相似度最高，建议确认后复用「${top.title}」`,
    source: 'template',
  };
}

copilotRouter.get('/candidates', async (req, res) => {
  try {
    const state = store.get();
    const topK = clampTopK(
      Number(req.query.topK),
      state.strategy.experienceTopK ?? 5,
    );
    const leaderboard = attributeDecisions(
      state.decisions,
      state.timeline,
      {
        liveEndMin: state.metrics.elapsedMin,
        force: true,
      },
    ).sort((a, b) => b.incrementalGmv - a.incrementalGmv);
    const query = buildExperienceQuery({
      metrics: state.metrics,
      leaderboard,
      productRanking: state.productRanking,
    });
    const experiences = (
      await getDefaultExperienceLibrary().search(query, topK + 3)
    )
      .filter(
        (item) =>
          item.source !== 'review' || item.sessionId !== state.sessionId,
      )
      .filter(isUsefulExperience)
      .slice(0, topK);
    const actions = buildActionOptions(experiences);

    let recommendation: CopilotRecommendation | null = null;
    if (state.strategy.aiLevel !== 'off' && actions.length > 0) {
      const input: ActionRecommendationInput = {
        scenario: state.scenario,
        metrics: {
          online: state.metrics.online,
          gmv: Math.round(state.metrics.gmv),
          orders: state.metrics.orders,
          danmakuRate: state.metrics.danmakuRate,
          elapsedMin: state.metrics.elapsedMin,
          remainingMin: Math.max(
            0,
            Math.round(state.metrics.totalMin - state.metrics.elapsedMin),
          ),
          currentProduct: state.metrics.currentProduct,
        },
        experiences,
        actions: actions.map((item) => ({
          experienceId: item.experienceId,
          experienceTitle: item.experienceTitle,
          action: item.action,
          label: item.label,
          similarity: item.similarity,
          priority: item.priority,
          source: item.source,
          result: item.result,
        })),
        recentActions: state.decisions
          .filter((decision) => decision.status === 'executed')
          .slice(-5)
          .map((decision) => decision.title ?? decision.action),
      };
      const aiRecommendation = await getAi().recommendAction(input);
      recommendation = aiRecommendation
        ? {
            ...aiRecommendation,
            action: aiRecommendation.action as ActionType,
          }
        : templateRecommendation(experiences, actions);
    }

    const data: CopilotCandidatesResp = {
      aiLevel: state.strategy.aiLevel,
      topK,
      query,
      experiences,
      actions,
      recommendation,
    };
    res.json(ok(data));
  } catch (error) {
    LOGGER.warn('副驾候选生成失败', { error });
    res.status(500).json(fail((error as Error).message, 500));
  }
});

copilotRouter.post('/apply', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const experienceId = String(body.experienceId ?? '');
  const action = String(body.action ?? '') as ActionType;
  const confirm = body.confirm === true || body.confirm === 'true';

  if (!experienceId || !action) {
    res.status(400).json(fail('缺少 experienceId / action'));
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(ACTION_LABELS, action)) {
    res.status(400).json(fail(`未知动作 ${action}`));
    return;
  }

  const library = getDefaultExperienceLibrary();
  await library.load();
  const experience = library
    .all()
    .find((item) => item.id === experienceId);
  if (!experience) {
    res.status(404).json(fail(`未找到经验 ${experienceId}`, 404));
    return;
  }
  if (!experience.actions.includes(action)) {
    res
      .status(400)
      .json(fail(`经验「${experience.title}」不包含动作 ${action}`));
    return;
  }

  const state = store.get();
  const label = ACTION_LABELS[action];
  const payload = buildActionPayload(action, state);

  if (!confirm) {
    res.json(
      ok({
        requiresConfirm: true,
        preview: {
          experienceId,
          experienceTitle: experience.title,
          action,
          label,
          payload,
        },
      }),
    );
    return;
  }

  if (!state.running) {
    res.status(409).json(fail('直播未开始，确认后也无法执行动作', 409));
    return;
  }

  const outcome = await executeAction(action, {
    rule: '经验库复用',
    reason: `复用历史经验「${experience.title}」`,
    title: label,
    params: payload,
  });
  res.json(
    ok({
      decision: outcome.decision,
      result: outcome.result,
    }),
  );
});
