import type {
  Decision,
  ExperienceMatch,
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
}

export interface EngineLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}
