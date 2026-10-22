import type {
  ActionRecommendation,
  ActionRecommendationInput,
  AiService,
  CandidateRankingInput,
  CandidateRankingResult,
  DecisionExplanation,
  DecisionExplanationInput,
  EngineLogger,
  ReviewNarrative,
  ReviewNarrativeInput,
  ReviewNarrativeResult,
} from './contracts.js';

export interface AiConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  explainTimeoutMs?: number;
  reviewTimeoutMs?: number;
  logger?: EngineLogger;
  fetchImpl?: typeof fetch;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

function normalizeNumbers(text: string): string {
  return text.replace(/(\d),(?=\d{3})/g, '$1');
}

function numbersIn(text: string): string[] {
  return normalizeNumbers(text).match(/\d+(?:\.\d+)?/g) ?? [];
}

function allowedNumberTokens(input: unknown): Set<string> {
  const allowed = new Set<string>();
  const values = numbersIn(JSON.stringify(input))
    .map(Number)
    .filter((value) => Number.isFinite(value));
  for (const value of values) {
    allowed.add(String(value));
    allowed.add(String(Math.round(value)));
    allowed.add(String(Math.floor(value)));
    allowed.add(String(Math.ceil(value)));
    allowed.add(String(Math.round(value * 10) / 10));
  }
  return allowed;
}

/**
 * 轻量防幻觉校验：大于 12 的数字必须是输入数据中的值或它的四舍五入形式。
 * 1~12 放行，避免误伤“3 分钟”“前 3 名”这类自然表达。
 */
function hasInventedNumber(text: string, input: unknown): boolean {
  const allowed = allowedNumberTokens(input);
  for (const token of numbersIn(text)) {
    const parsed = Number(token);
    if (!Number.isFinite(parsed) || parsed <= 12) continue;
    if (!allowed.has(token) && !allowed.has(String(parsed))) return true;
  }
  return false;
}

function clampText(text: string, max = 82): string {
  const clean = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[“"']+|[”"']+$/g, '');
  if (clean.length <= max) return clean;
  const clipped = clean.slice(0, max);
  const lastPunctuation = Math.max(
    clipped.lastIndexOf('。'),
    clipped.lastIndexOf('，'),
    clipped.lastIndexOf('；'),
  );
  return `${lastPunctuation > max * 0.5 ? clipped.slice(0, lastPunctuation) : clipped}…`;
}

export function templateExplain(input: DecisionExplanationInput): string {
  const labels = input.actionLabels.join(' + ');
  switch (input.rule) {
    case 'retention_guard':
      return `${input.triggerSummary}，先用${labels}拉回注意力，再承接回流。`;
    case 'conversion_boost':
      return `${input.triggerSummary}，用${labels}缩短下单路径，把兴趣转成成交。`;
    case 'atmosphere_activate':
      return `${input.triggerSummary}，用${labels}把公屏节奏带起来。`;
    case 'closing_push':
      return `${input.triggerSummary}，用${labels}制造紧迫感，冲刺最后一波。`;
    case 'anomaly_fallback':
      return '检测到直播流异常，先发公告安抚并提示重连，避免观众集中流失。';
    default:
      return `${input.triggerSummary}，执行${labels}。`;
  }
}

export function templateReviewNarrative(
  input: ReviewNarrativeInput,
): ReviewNarrative {
  const experienceCount = input.experiences?.length ?? 0;
  const overview = `本场直播 ${Math.round(input.totalMin)} 分钟，峰值在线 ${Math.round(
    input.peakOnline,
  )} 人，累计观看 ${Math.round(input.totalViewers)}，成交 ${Math.round(
    input.finalOrders,
  )} 单 / ¥${Math.round(input.finalGmv)}。AI 共执行 ${Math.round(
    input.actionCount,
  )} 次自动动作。${
    experienceCount > 0 ? `历史经验库匹配到 ${experienceCount} 条相似案例。` : ''
  }`;

  const best = [...input.items]
    .filter((item) => item.incrementalGmv > 0)
    .sort((a, b) => b.incrementalGmv - a.incrementalGmv)[0];

  const conclusion = best
    ? `第 ${Math.round(best.minute)} 分钟的「${best.ruleName}」带来 ${Math.round(
        best.incrementalOrders,
      )} 单增量（约 ¥${Math.round(
        best.incrementalGmv,
      )}），是本场最强互动。`
    : '本场自动动作未观察到明确增量，建议下次延长归因窗口或增加互动频次。';

  const suggestionMap: Record<string, string> = {
    retention_guard: '开播前 5 分钟安排一次固定福利，缓冲突发掉线带来的流失。',
    conversion_boost: '商品讲解每 2 分钟补一次弹层，别等点击率跌穿阈值再推。',
    atmosphere_activate: '提前准备答题卡/签到素材，冷场 60 秒内接管公屏。',
    closing_push: '把优惠券前置到剩余 8 分钟，避免最后 5 分钟才逼单。',
    anomaly_fallback: '准备备用推流和安抚公告模板，异常时先稳住观众。',
  };

  const suggestions: string[] = [];
  for (const rule of input.firedRules) {
    const suggestion = suggestionMap[rule];
    if (suggestion && !suggestions.includes(suggestion)) suggestions.push(suggestion);
    if (suggestions.length >= 3) break;
  }
  if (suggestions.length === 0) {
    suggestions.push('下一场至少配置 3 类自动动作，持续积累归因样本。');
    suggestions.push('把高转化商品安排在开播后 10 分钟内讲解。');
    suggestions.push('固定每 5 分钟一次轻互动，保持公屏热度。');
  }

  const topExperience = input.experiences?.[0];
  const experienceTakeaway = topExperience?.takeaways[0];
  if (topExperience && experienceTakeaway) {
    const label = topExperience.source === 'playbook' ? '知识库' : '历史复盘';
    const suggestion = `参考${label}「${topExperience.title}」：${experienceTakeaway}`;
    const duplicateIndex = suggestions.findIndex((item) =>
      item.includes(experienceTakeaway),
    );
    if (duplicateIndex >= 0) suggestions.splice(duplicateIndex, 1);
    suggestions.unshift(suggestion);
  }

  return { overview, conclusion, suggestions: suggestions.slice(0, 3) };
}

export function createAiServiceFromEnv(
  config: Omit<AiConfig, 'apiKey' | 'baseUrl' | 'model'> = {},
): AiService {
  return createAiService({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE,
    model: process.env.DEEPSEEK_MODEL,
    ...config,
  });
}

export function createAiService(config: AiConfig = {}): AiService {
  const apiKey = config.apiKey?.trim() ?? '';
  const baseUrl = (config.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = config.model ?? 'deepseek-chat';
  const explainTimeoutMs = config.explainTimeoutMs ?? 3000;
  const reviewTimeoutMs = config.reviewTimeoutMs ?? 15000;
  const logger = config.logger;
  const request = config.fetchImpl ?? fetch;

  async function chat(
    messages: ChatMessage[],
    options: { timeoutMs: number; maxTokens: number; json?: boolean },
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await request(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.3,
            max_tokens: options.maxTokens,
            ...(options.json ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) return null;
          continue;
        }
        const data = (await response.json()) as ChatResponse;
        const content = data.choices?.[0]?.message?.content?.trim();
        if (content) return content;
      } catch {
        // timeout / network：重试一次后交给模板兜底
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  return {
    enabled: apiKey.length > 0,

    async explainDecision(
      input: DecisionExplanationInput,
    ): Promise<DecisionExplanation> {
      const fallback = templateExplain(input);
      if (!apiKey) return { text: fallback, source: 'template' };

      const content = await chat(
        [
          {
            role: 'system',
            content:
              '你是私域直播运营副驾，为运营看板写一句中文决策理由。要求：1) 只输出一句话，不超过 60 字；2) 只能引用用户消息 JSON 中出现的数字，禁止编造；3) 说清楚为什么现在做、做了什么、期望什么；4) 不要输出引号、前缀或解释。',
          },
          {
            role: 'user',
            content: JSON.stringify(input),
          },
        ],
        { timeoutMs: explainTimeoutMs, maxTokens: 120 },
      );

      if (!content) {
        logger?.warn('LLM 决策理由生成失败，使用模板兜底', { rule: input.rule });
        return { text: fallback, source: 'template' };
      }

      const text = clampText(content);
      if (!text || hasInventedNumber(text, input)) {
        logger?.warn('LLM 决策理由包含未知数字，使用模板兜底', {
          rule: input.rule,
          text,
        });
        return { text: fallback, source: 'template' };
      }
      return { text, source: 'llm' };
    },

    async generateReview(
      input: ReviewNarrativeInput,
    ): Promise<ReviewNarrativeResult> {
      const fallback = templateReviewNarrative(input);
      if (!apiKey) return { ...fallback, source: 'template' };

      const content = await chat(
        [
          {
            role: 'system',
            content:
              '你是私域直播复盘分析师。只依据用户消息 JSON 中的归因结果撰写复盘，禁止编造任何新数字。experiences 是历史参考，只用于写建议，不要把历史案例的数字当作本场结果。输出严格 JSON，格式为 {"overview":"本场总览，1~2句","conclusion":"转化归因结论，1~2句，点出贡献最大的互动","suggestions":["建议1","建议2","建议3"]}。每段不超过 100 字，建议必须可执行。',
          },
          {
            role: 'user',
            content: JSON.stringify(input),
          },
        ],
        { timeoutMs: reviewTimeoutMs, maxTokens: 700, json: true },
      );

      if (!content) {
        logger?.warn('LLM 复盘生成失败，使用模板兜底');
        return { ...fallback, source: 'template' };
      }

      try {
        const cleaned = content
          .replace(/^```(?:json)?/i, '')
          .replace(/```$/, '')
          .trim();
        const parsed = JSON.parse(cleaned) as Partial<ReviewNarrative>;
        const overview =
          typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
        const conclusion =
          typeof parsed.conclusion === 'string' ? parsed.conclusion.trim() : '';
        const suggestions = Array.isArray(parsed.suggestions)
          ? parsed.suggestions
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter(Boolean)
              .slice(0, 3)
          : [];
        const narrative = [overview, conclusion, ...suggestions].join(' ');
        if (!overview || !conclusion || suggestions.length < 2) {
          return { ...fallback, source: 'template' };
        }
        if (hasInventedNumber(narrative, input)) {
          logger?.warn('LLM 复盘包含未知数字，使用模板兜底');
          return { ...fallback, source: 'template' };
        }
        return { overview, conclusion, suggestions, source: 'llm' };
      } catch {
        logger?.warn('LLM 复盘 JSON 解析失败，使用模板兜底');
        return { ...fallback, source: 'template' };
      }
    },

    async rankCandidates(
      input: CandidateRankingInput,
    ): Promise<CandidateRankingResult | null> {
      if (!apiKey || input.candidates.length <= 1) return null;

      const content = await chat(
        [
          {
            role: 'system',
            content:
              '你是直播运营策略排序器。只能从 candidates 中选择一个 rule，禁止创造新 rule。根据当前指标、场景和触发原因，选择此刻最值得执行的动作。只输出 JSON：{"rule":"<candidate rule>","reason":"一句话中文理由，最多60字，只能引用输入中的数字"}。',
          },
          { role: 'user', content: JSON.stringify(input) },
        ],
        { timeoutMs: 1500, maxTokens: 220, json: true },
      );
      if (!content) return null;

      try {
        const cleaned = content
          .replace(/^```(?:json)?/i, '')
          .replace(/```$/, '')
          .trim();
        const parsed = JSON.parse(cleaned) as Partial<CandidateRankingResult>;
        const rule = typeof parsed.rule === 'string' ? parsed.rule : '';
        const reason =
          typeof parsed.reason === 'string'
            ? clampText(parsed.reason, 82)
            : '';
        if (!input.candidates.some((item) => item.rule === rule)) return null;
        if (!reason || hasInventedNumber(reason, input)) return null;
        return { rule, reason, source: 'llm' };
      } catch {
        logger?.warn('LLM 候选排序 JSON 解析失败，回退规则优先级');
        return null;
      }
    },

    async recommendAction(
      input: ActionRecommendationInput,
    ): Promise<ActionRecommendation | null> {
      if (!apiKey || input.actions.length === 0) return null;

      const content = await chat(
        [
          {
            role: 'system',
            content:
              '你是直播运营副驾。只能从 actions 列表中选一个操作，禁止创造新动作或新经验。根据当前指标、场景和历史经验，选择此刻最值得执行的一个；输出 JSON：{"experienceId":"...","action":"...","reason":"一句话中文理由，最多60字，只能引用输入中的数字"}。',
          },
          { role: 'user', content: JSON.stringify(input) },
        ],
        { timeoutMs: 1500, maxTokens: 240, json: true },
      );
      if (!content) return null;

      try {
        const cleaned = content
          .replace(/^```(?:json)?/i, '')
          .replace(/```$/, '')
          .trim();
        const parsed = JSON.parse(cleaned) as Partial<ActionRecommendation>;
        const experienceId =
          typeof parsed.experienceId === 'string'
            ? parsed.experienceId
            : '';
        const action =
          typeof parsed.action === 'string' ? parsed.action : '';
        const reason =
          typeof parsed.reason === 'string'
            ? clampText(parsed.reason, 82)
            : '';
        const match = input.actions.find(
          (item) =>
            item.experienceId === experienceId && item.action === action,
        );
        if (!match || !reason || hasInventedNumber(reason, input)) return null;
        return {
          experienceId,
          action,
          reason,
          source: 'llm',
        };
      } catch {
        logger?.warn('LLM 副驾操作推荐 JSON 解析失败，回退人工选择');
        return null;
      }
    },
  };
}
