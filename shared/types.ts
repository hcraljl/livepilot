/**
 * LivePilot · 智播副驾 —— 前后端共享类型契约
 *
 * 维护：成员 B（后端 / 集成）
 * 规则：任何字段变更必须三方同步（A 前端 / B 后端 / C 引擎），否则前后端对不上。
 * 依据：API.md（本文件为其 TypeScript 落地版，二者需保持一致）
 */

/** AI 副驾三档模式：建议 / 半自动（确认执行） / 全自动 */
export type Mode = 'suggest' | 'semiauto' | 'auto';

/** 智能档位：无 AI / 规则决策 + LLM 文案 / LLM 在候选内重排 */
export type AiLevel = 'off' | 'hybrid' | 'full';

/** 直播核心指标（看板 6 张卡 + 上下文） */
export interface Metrics {
  /** 当前在线人数 */
  online: number;
  /** 累计观看人次 */
  totalViewers: number;
  /** 商品累计点击 */
  productClicks: number;
  /** 累计下单笔数 */
  orders: number;
  /** 累计成交金额（元） */
  gmv: number;
  /** 弹幕 / 互动率 0~1，用于判断冷场 */
  danmakuRate: number;
  /** 当前商品点击率（点击/曝光），模拟器 / 统计接口写入；无数据时缺省 */
  productCtr?: number;
  /** 当前讲解商品名 */
  currentProduct: string;
  /** 已播分钟（可为小数） */
  elapsedMin: number;
  /** 计划总时长（分钟） */
  totalMin: number;
}

/**
 * AI 可程序化触发的 7 个动作（均对应保利威服务端 OpenAPI）
 *
 * 已下线：coupon（发放优惠券）。
 * 业务决定「不发放优惠券」，因此从动作集合中彻底移除——
 * 逼单场景改用 bulletin（公告）+ lottery（抽奖）维持紧迫感，
 * 不依赖券库存，也不会在观众端产生未预期的优惠。
 */
export type ActionType =
  | 'lottery'
  | 'welfare_lottery'
  | 'answer_card'
  | 'checkin'
  | 'push_card'
  | 'push_product'
  | 'bulletin';

/** 决策状态：建议 / 待确认（半自动） / 已执行 / 执行失败 */
export type DecisionStatus = 'suggested' | 'pending_confirm' | 'executed' | 'failed';

/** 调用保利威（或模拟器）后的回执，前端可据此展示"已真实触达" */
export interface PolyvCallResult {
  ok: boolean;
  /** true = 走模拟器返回，未真正打保利威服务器 */
  mock: boolean;
  code: number;
  message: string;
  /** 真实请求命中的接口路径（演示能力清单取证用） */
  endpoint?: string;
  latencyMs?: number;
  data?: unknown;
}

/** 一条 AI 决策（前端决策流 / 复盘归因的最小单元） */
export interface Decision {
  id: string;
  /** 毫秒时间戳 */
  ts: number;
  /** 触发规则名，如"留存保卫"（前端展示用中文） */
  rule: string;
  /** 规则内部 id，如 retention_guard（归因 / 经验库用） */
  ruleId?: string;
  action: ActionType;
  /** LLM / 模板生成的中文决策理由，前端直接渲染 */
  reason: string;
  mode: Mode;
  status: DecisionStatus;
  channelId: string;
  /** 展示标题，如"发起无条件抽奖" */
  title?: string;
  /** 动作参数（抽奖时长、商品 ID、公告内容等） */
  payload?: Record<string, unknown>;
  /** 决策时点的指标快照，复盘归因用 */
  snapshot?: Partial<Metrics>;
  executedAt?: number;
  result?: PolyvCallResult;
  /** 同一次规则触发的多个动作共享 groupId，复盘按组归因 */
  groupId?: string;
  /** 规则预期效果，前端决策卡展示 */
  expectedEffect?: string;
  /** 理由来源：LLM 或模板兜底 */
  reasonSource?: 'llm' | 'template';
  /** 执行时的直播进度（分钟），归因窗口起点 */
  executedElapsedMin?: number;
  /** 执行后 3 分钟回算的实测增量 */
  outcome?: DecisionOutcome;
}

/** 动作执行后的实测增量（决策卡闭环展示） */
export interface DecisionOutcome {
  windowSec: number;
  incrementalOrders: number;
  incrementalGmv: number;
  liftPct: number;
  confidence: 'high' | 'medium' | 'low';
}

/** 商品转化榜单项 */
export interface ProductRank {
  name: string;
  clicks: number;
  orders: number;
  gmv: number;
}

/** 转化漏斗：观看 → 互动 → 点击 → 下单 */
export interface Funnel {
  view: number;
  interact: number;
  click: number;
  order: number;
}

/** 时间轴采样点（在线曲线 + 互动标记的底座） */
export interface TimelinePoint {
  /** 已播分钟 */
  t: number;
  online: number;
  gmv: number;
  orders: number;
  danmakuRate: number;
  /** 该时刻是否有互动事件（前端打点） */
  marked?: boolean;
}

export type LiveEventType =
  | 'session'   // 开播 / 下播 / 暂停
  | 'metric'    // 指标采样
  | 'scenario'  // 模拟器场景注入（留存下跌 / 冷场 / 逼单…）
  | 'decision'  // 引擎产出决策
  | 'action'    // 动作执行结果（真实 / 模拟）
  | 'webhook'   // 保利威回调
  | 'system';   // 其他

/** 全量事件流（复盘与时间轴共用，B 负责留存） */
export interface LiveEvent {
  id: string;
  ts: number;
  type: LiveEventType;
  title: string;
  detail?: string;
  decisionId?: string;
  /** 事件发生时指标快照 */
  metrics?: Partial<Metrics>;
}

/** 可配置策略阈值（前端策略面板 → POST /api/strategy） */
export interface StrategyConfig {
  /** 总开关：关掉后引擎不再自动决策（人工接管） */
  enabled: boolean;
  /** 智能档位：off=纯规则+TF-IDF；hybrid=规则决策+LLM 文案；full=LLM 在候选内重排 */
  aiLevel: AiLevel;
  /** 复盘 / 副驾展示的经验候选条数（1~10） */
  experienceTopK: number;
  /** 留存保卫：窗口内在线跌幅阈值（0.15 = 15%） */
  retentionDropPct: number;
  /** 留存保卫：观察窗口（秒） */
  retentionWindowSec: number;
  /** 转化助推：商品点击率低于该值触发（0.03 = 3%） */
  conversionCtrThreshold: number;
  /** 转化助推：观察窗口（秒） */
  conversionWindowSec: number;
  /** 氛围激活：弹幕率低于该值视为冷场 */
  coldDanmakuRate: number;
  /** 氛围激活：冷场持续窗口（秒） */
  coldWindowSec: number;
  /** 逼单：GMV 目标（元） */
  gmvTarget: number;
  /** 逼单：剩余多少分钟开始逼单 */
  pushWindowMin: number;
  /** 同一规则冷却时间（秒），防刷屏 */
  cooldownSec: number;
}

/** 后端推给前端的唯一状态对象（SSE 每帧完整推送） */
export interface LiveState {
  running: boolean;
  mode: Mode;
  channelId: string;
  sessionId: string;
  startedAt: number | null;
  endedAt: number | null;
  metrics: Metrics;
  decisions: Decision[];
  funnel: Funnel;
  productRanking: ProductRank[];
  timeline: TimelinePoint[];
  events: LiveEvent[];
  strategy: StrategyConfig;
  /** 当前生效的模拟场景，如 online_drop / cold_start / stream_stall */
  scenario: string | null;
  /** 数据源：simulator | polyv */
  source: 'simulator' | 'polyv';
  updatedAt: number;
}

/** 手动 / 引擎发起一次动作 */
export interface ActionReq {
  action: ActionType;
  channelId?: string;
  rule?: string;
  reason?: string;
  params?: Record<string, unknown>;
}

/** 启动模拟器请求 */
export interface StartSimReq {
  /** 总时长（分钟），默认 30 */
  totalMin?: number;
  /** 加速倍数：1 秒真实时间 = speed 秒直播时间，默认 10 */
  speed?: number;
  /** 随机种子，保证演示可复现 */
  seed?: number;
  /** tick 间隔（毫秒），仅自动化自检用，正常演示不用传 */
  tickMs?: number;
}

/** 健康检查 */
export interface HealthResp {
  ok: boolean;
  useReal: boolean;
  running: boolean;
  mode: Mode;
  source: 'simulator' | 'polyv';
  sessionId: string;
  uptimeSec: number;
}

/** 本场完整数据包（store.exportSession()），C 的复盘直接消费 */
export interface SessionExport {
  sessionId: string;
  channelId: string;
  mode: Mode;
  source: 'simulator' | 'polyv';
  startedAt: number | null;
  endedAt: number | null;
  durationMin: number;
  metrics: Metrics;
  funnel: Funnel;
  decisions: Decision[];
  timeline: TimelinePoint[];
  events: LiveEvent[];
  products: ProductRank[];
  strategy: StrategyConfig;
}

/** 一次 AI 动作组的归因结果（多动作组合共用一个窗口） */
export interface AttributionItem {
  /** 组内主决策 id，便于前端跳转 */
  decisionId: string;
  groupId: string;
  rule: string;
  ruleName: string;
  title: string;
  action: ActionType;
  startMin: number;
  endMin: number;
  windowSec: number;
  windowOrders: number;
  windowGmv: number;
  baselineOrders: number;
  baselineGmv: number;
  incrementalOrders: number;
  incrementalGmv: number;
  liftPct: number;
  confidence: 'high' | 'medium' | 'low';
}

/** 复盘经验库条目：真实复盘 + 知识库 SOP 共用 */
export interface ExperienceResult {
  incrementalOrders: number;
  incrementalGmv: number;
  liftPct: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface ExperienceEntry {
  id: string;
  source: 'review' | 'playbook';
  createdAt: number;
  /** 来源场次，避免复盘检索到自己的历史记录 */
  sessionId?: string;
  title: string;
  scenario: string;
  rules: string[];
  actions: string[];
  result?: ExperienceResult;
  takeaways: string[];
}

export interface ExperienceMatch extends ExperienceEntry {
  similarity: number;
  priority: number;
}

/** 副驾候选动作：来自 TopK 历史经验，人工选择或 AI 推荐 */
export interface CopilotActionOption {
  experienceId: string;
  experienceTitle: string;
  action: ActionType;
  label: string;
  similarity: number;
  priority: number;
  source: 'review' | 'playbook';
  result?: ExperienceResult;
  /** 官方 API 常量（来自 polyv/api-catalog.ts，不属于经验数据） */
  method?: 'GET' | 'POST';
  path?: string;
  docUrl?: string;
  requiredParams?: string[];
}

export interface CopilotRecommendation {
  experienceId: string;
  action: ActionType;
  reason: string;
  source: 'llm' | 'template';
}

export interface CopilotCandidatesResp {
  aiLevel: AiLevel;
  topK: number;
  query: string;
  experiences: ExperienceMatch[];
  actions: CopilotActionOption[];
  recommendation: CopilotRecommendation | null;
}

export interface ReviewMark {
  t: number;
  label: string;
  rule: string;
  action: ActionType;
  decisionId: string;
}

/** C 的完整复盘报告（A 可渲染曲线标记 / 归因榜 / 历史经验） */
export interface ReviewReport {
  generatedAt: number;
  source: 'llm' | 'template';
  sessionId: string;
  live: {
    totalMin: number;
    peakOnline: number;
    finalOnline: number;
    totalViewers: number;
    finalOrders: number;
    finalGmv: number;
    actionCount: number;
  };
  overview: string;
  leaderboard: AttributionItem[];
  bestWindow: {
    startMin: number;
    endMin: number;
    incrementalGmv: number;
    label: string;
  } | null;
  conclusion: string;
  suggestions: string[];
  experiences: ExperienceMatch[];
  productRanking: ProductRank[];
  timeline: TimelinePoint[];
  marks: ReviewMark[];
}

/** 复盘请求 / 响应（C 的 report.ts 产出，B 的兜底产出结构一致） */
export interface ReplayResp {
  report: string;
  /** 结构化复盘（前端可渲染图表）；C 实现后优先返回 */
  structured?: {
    summary: string;
    keyMetrics: Partial<Metrics>;
    topActions: { decisionId: string; title: string; rule: string; gmvDelta: number; orderDelta: number }[];
    bestWindow?: { from: number; to: number; note: string };
    suggestions: string[];
    /** C 扩展：完整归因榜与历史经验，A 可直接渲染 */
    leaderboard?: AttributionItem[];
    experiences?: ExperienceMatch[];
  };
  generatedAt: number;
  /** ai = DeepSeek 生成；template = 无 key 模板兜底 */
  engine: 'ai' | 'template';
  /** C 扩展：完整复盘报告 */
  review?: ReviewReport;
}
