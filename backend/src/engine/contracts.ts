import type {
  Decision,
  ExperienceMatch,
  ExperienceResult,
  LiveState,
  SessionExport,
} from '../../../shared/types.js';

export type DecisionInput = Omit<Decision, 'id' | 'ts' | 'channelId'> &
  Partial<Pick<Decision, 'id' | 'ts' | 'channelId'>>;

/** 引擎只依赖 store 的这 5 个能力，B 的 LiveStore 直接满足 */
export interface EngineStore {
  getState(): LiveState;
  addDecision(input: DecisionInput): Decision;
  updateDecision(id: string, patch: Partial<Decision>): Decision | undefined;
  getDecision(id: string): Decision | undefined;
  exportSession(): SessionExport;
}

/** B 的 executeDecision 适配器：入参是决策 id，状态/结果由执行层回写 */
export interface ActionExecutor {
  execute(decisionId: string): Promise<{ ok: boolean; detail?: string }>;
}

export interface DecisionExplanationInput {
  rule: string;
  ruleName: string;
  actionLabels: string[];
  triggerSummary: string;
  expectedEffect: string;
  metrics: {
    online: number;
    gmv: number;
    orders: number;
    danmakuRate: number;
    elapsedMin: number;
    remainingMin: number;
    currentProduct: string;
  };
  recentActions: string[];
}

export interface DecisionExplanation {
  text: string;
  source: 'llm' | 'template';
}

/** full 档：LLM 只允许在候选规则内重排，不能发明新动作 */
export interface CandidateRankingInput {
  scenario: string | null;
  metrics: {
    online: number;
    gmv: number;
    orders: number;
    danmakuRate: number;
    elapsedMin: number;
    remainingMin: number;
    currentProduct: string;
  };
  candidates: {
    rule: string;
    ruleName: string;
    priority: number;
    triggerSummary: string;
    actionLabels: string[];
    expectedEffect: string;
  }[];
  recentActions: string[];
}

export interface CandidateRankingResult {
  rule: string;
  reason: string;
  source: 'llm';
}

/** 副驾操作选择：人工从 TopK 经验里选，或让 LLM 在候选动作里挑一个 */
export interface ActionRecommendationInput {
  scenario: string | null;
  metrics: {
    online: number;
    gmv: number;
    orders: number;
    danmakuRate: number;
    elapsedMin: number;
    remainingMin: number;
    currentProduct: string;
  };
  experiences: ExperienceMatch[];
  actions: {
    experienceId: string;
    experienceTitle: string;
    action: string;
    label: string;
    similarity: number;
    priority: number;
    source: 'review' | 'playbook';
    result?: ExperienceResult;
  }[];
  recentActions: string[];
}

export interface ActionRecommendation {
  experienceId: string;
  action: string;
  reason: string;
  source: 'llm' | 'template';
}

export interface ReviewNarrativeInput {
  totalMin: number;
  peakOnline: number;
  finalOnline: number;
  totalViewers: number;
  finalOrders: number;
  finalGmv: number;
  actionCount: number;
  items: {
    rule: string;
    ruleName: string;
    action: string;
    minute: number;
    incrementalOrders: number;
    incrementalGmv: number;
    liftPct: number;
    confidence: string;
  }[];
  bestWindow: {
    startMin: number;
    endMin: number;
    incrementalGmv: number;
  } | null;
  productRanking: { name: string; orders: number; gmv: number }[];
  firedRules: string[];
  experiences?: ExperienceMatch[];
}

export interface ReviewNarrative {
  overview: string;
  conclusion: string;
  suggestions: string[];
}

export interface ReviewNarrativeResult extends ReviewNarrative {
  source: 'llm' | 'template';
}

export interface AiService {
  readonly enabled: boolean;
  explainDecision(input: DecisionExplanationInput): Promise<DecisionExplanation>;
  generateReview(input: ReviewNarrativeInput): Promise<ReviewNarrativeResult>;
  /** 返回 null = 无 key / 超时 / 输出不合法，由调用方回退规则优先级 */
  rankCandidates(
    input: CandidateRankingInput,
  ): Promise<CandidateRankingResult | null>;
  /** 返回 null = 无 key / 超时 / 输出不合法；副驾侧可回退人工选择 */
  recommendAction(
    input: ActionRecommendationInput,
  ): Promise<ActionRecommendation | null>;
}

export interface EngineLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}
