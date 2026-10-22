/**
 * 内存状态中心（LiveStore）
 *
 * 设计要点：
 * - 后端只有这一份真相：模拟器 / Webhook / 统计轮询 都往这里写，SSE 从这里读。
 * - 引擎（C）通过 onTick / subscribe 消费同一份状态，决策写回 decisions，前后端解耦。
 * - 事件流（events）与时间轴（timeline）全量留存，复盘归因直接读，无需另建库。
 * - 单场直播数据量很小（分钟级采样 + 数十条决策），内存足够；导出 JSON 供复盘留档。
 */
import type {
  Decision,
  Funnel,
  LiveEvent,
  LiveEventType,
  LiveState,
  Metrics,
  Mode,
  ProductRank,
  StrategyConfig,
  TimelinePoint,
} from '../../../shared/types.ts';
import { config } from '../config.ts';

const MAX_DECISIONS = 300;
const MAX_EVENTS = 3000;
/** 30 分钟演示场次在 speed=10/tick=800ms 下约 2250 点，需保留全量供复盘归因 */
const MAX_TIMELINE = 6000;

export const emptyMetrics = (totalMin: number): Metrics => ({
  online: 0,
  totalViewers: 0,
  productClicks: 0,
  orders: 0,
  gmv: 0,
  danmakuRate: 0,
  currentProduct: '',
  elapsedMin: 0,
  totalMin,
});

export const emptyFunnel = (): Funnel => ({ view: 0, interact: 0, click: 0, order: 0 });

type Listener = (state: LiveState) => void;
type TickHandler = (state: LiveState) => void;

export class LiveStore {
  private state: LiveState;
  private listeners = new Set<Listener>();
  private tickHandlers = new Set<TickHandler>();
  private decisionSeq = 0;
  private eventSeq = 0;
  private sessionSeq = 0;
  private createdAt = Date.now();

  constructor() {
    this.state = this.freshState();
  }

  private freshState(): LiveState {
    return {
      running: false,
      mode: 'auto',
      channelId: config.polyv.channelId,
      sessionId: '',
      startedAt: null,
      endedAt: null,
      metrics: emptyMetrics(config.simulator.totalMin),
      decisions: [],
      funnel: emptyFunnel(),
      productRanking: [],
      timeline: [],
      events: [],
      strategy: { ...config.defaultStrategy },
      scenario: null,
      source: 'simulator',
      updatedAt: Date.now(),
    };
  }

  /** 只读视图（不要在外部改写，写操作一律走下面的方法） */
  get(): LiveState {
    return this.state;
  }

  /** 给 SSE / REST 用的 JSON 安全快照（数组末尾截断，避免无限增长） */
  snapshot(): LiveState {
    const s = this.state;
    return {
      ...s,
      decisions: s.decisions.slice(-MAX_DECISIONS),
      events: s.events.slice(-MAX_EVENTS),
      timeline: s.timeline.slice(-MAX_TIMELINE),
      metrics: { ...s.metrics },
      funnel: { ...s.funnel },
      strategy: { ...s.strategy },
      productRanking: s.productRanking.map((p) => ({ ...p })),
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 引擎（C）挂在这里：每个模拟 tick 被调用一次 */
  onTick(fn: TickHandler): () => void {
    this.tickHandlers.add(fn);
    return () => this.tickHandlers.delete(fn);
  }

  private notify(): void {
    this.state.updatedAt = Date.now();
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch (err) {
        console.error('[store] listener 抛错：', (err as Error).message);
      }
    }
  }

  // ---------- 会话生命周期 ----------

  startSession(totalMin: number, source: LiveState['source'] = 'simulator'): LiveState {
    this.sessionSeq += 1;
    const sid = `s${Date.now().toString(36)}${this.sessionSeq}`;
    const prevMode = this.state.mode;
    const prevStrategy = { ...this.state.strategy };
    this.state = {
      ...this.freshState(),
      sessionId: sid,
      startedAt: Date.now(),
      running: true,
      source,
      mode: prevMode,
      strategy: prevStrategy,
      metrics: emptyMetrics(totalMin),
      channelId: config.polyv.channelId,
    };
    this.logEvent('session', '直播开始（模拟）', `计划时长 ${totalMin} 分钟 · 会话 ${sid}`);
    this.notify();
    return this.state;
  }

  stopSession(reason = '手动停止'): void {
    if (!this.state.running && this.state.endedAt) return;
    this.state.running = false;
    this.state.endedAt = Date.now();
    this.state.scenario = null;
    this.logEvent('session', '直播结束', reason);
    this.notify();
  }

  setRunning(running: boolean): void {
    this.state.running = running;
    this.notify();
  }

  setMode(mode: Mode): Mode {
    this.state.mode = mode;
    this.logEvent('system', '模式切换', `AI 副驾模式 → ${mode}`);
    this.notify();
    return mode;
  }

  getMode(): Mode {
    return this.state.mode;
  }

  updateStrategy(patch: Partial<StrategyConfig>): StrategyConfig {
    const next: StrategyConfig = { ...this.state.strategy };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null) continue;
      const key = k as keyof StrategyConfig;
      if (key === 'enabled') {
        if (typeof v === 'boolean') next.enabled = v;
        continue;
      }
      if (key === 'aiLevel') {
        if (v === 'off' || v === 'hybrid' || v === 'full') {
          next.aiLevel = v;
        }
        continue;
      }
      const n = Number(v);
      if (Number.isFinite(n)) (next[key] as number) = n;
    }
    this.state.strategy = next;
    this.logEvent('system', '策略阈值更新', JSON.stringify(patch));
    this.notify();
    return next;
  }

  // ---------- 指标 ----------

  patchMetrics(patch: Partial<Metrics>): Metrics {
    const next: Metrics = { ...this.state.metrics, ...patch };
    // 单调递增类指标做护栏，防止模拟器抖回去
    next.totalViewers = Math.max(this.state.metrics.totalViewers, next.totalViewers);
    // 数据完整性：累计观看人次不可能小于当前在线人数（开场冲人时最容易违反，前端会显示成"观看<在线"）
    next.totalViewers = Math.max(next.totalViewers, Math.round(next.online));
    next.productClicks = Math.max(this.state.metrics.productClicks, next.productClicks);
    next.orders = Math.max(this.state.metrics.orders, next.orders);
    next.gmv = Math.max(this.state.metrics.gmv, next.gmv);
    next.online = Math.max(0, Math.round(next.online));
    next.danmakuRate = Math.min(1, Math.max(0, next.danmakuRate));
    next.elapsedMin = Number(next.elapsedMin.toFixed(3));
    this.state.metrics = next;
    this.recomputeFunnel();
    return next;
  }

  setProductRanking(list: ProductRank[]): void {
    this.state.productRanking = list
      .slice()
      .sort((a, b) => b.gmv - a.gmv || b.orders - a.orders)
      .slice(0, 12);
  }

  private recomputeFunnel(): void {
    const m = this.state.metrics;
    this.state.funnel = {
      view: m.totalViewers,
      interact: Math.round(m.totalViewers * Math.min(1, 0.35 + m.danmakuRate * 0.5)),
      click: m.productClicks,
      order: m.orders,
    };
  }

  setScenario(name: string | null, detail?: string): void {
    if (this.state.scenario === name) return;
    this.state.scenario = name;
    if (name) this.logEvent('scenario', `场景注入：${name}`, detail);
    this.notify();
  }

  pushTimeline(point: TimelinePoint): void {
    this.state.timeline.push(point);
    if (this.state.timeline.length > MAX_TIMELINE) {
      this.state.timeline.splice(0, this.state.timeline.length - MAX_TIMELINE);
    }
  }

  /** 标记时间轴上最近一个点（互动事件打点） */
  markTimeline(): void {
    const last = this.state.timeline[this.state.timeline.length - 1];
    if (last) last.marked = true;
  }

  /** 模拟器每 tick 调用：推进时间、写采样点、触发引擎 + 广播 */
  tick(dtSec: number): void {
    const m = this.state.metrics;
    // 保留 3 位小数，避免浮点误差累积成 13.200000000000006 这种脏数字推给前端
    m.elapsedMin = Number(Math.min(m.totalMin, m.elapsedMin + dtSec / 60).toFixed(3));
    this.pushTimeline({
      t: Number(m.elapsedMin.toFixed(2)),
      online: m.online,
      gmv: Math.round(m.gmv),
      orders: m.orders,
      danmakuRate: Number(m.danmakuRate.toFixed(3)),
    });

    const snap = this.snapshot();
    for (const fn of this.tickHandlers) {
      try {
        fn(snap);
      } catch (err) {
        console.error('[store] tick handler 抛错：', (err as Error).message);
      }
    }
    this.notify();
  }

  // ---------- 决策 ----------

  addDecision(input: Omit<Decision, 'id' | 'ts' | 'channelId'> & Partial<Pick<Decision, 'id' | 'ts' | 'channelId'>>): Decision {
    this.decisionSeq += 1;
    const decision: Decision = {
      ...input,
      id: input.id ?? `dec_${Date.now().toString(36)}_${this.decisionSeq}`,
      ts: input.ts ?? Date.now(),
      channelId: input.channelId ?? this.state.channelId,
      snapshot: input.snapshot ?? { ...this.state.metrics },
    };
    this.state.decisions.push(decision);
    if (this.state.decisions.length > MAX_DECISIONS) {
      this.state.decisions.splice(0, this.state.decisions.length - MAX_DECISIONS);
    }
    this.markTimeline();
    this.logEvent('decision', `决策：${decision.title ?? decision.rule}`, decision.reason, decision.id);
    this.notify();
    return decision;
  }

  updateDecision(id: string, patch: Partial<Decision>): Decision | undefined {
    const d = this.state.decisions.find((x) => x.id === id);
    if (!d) return undefined;
    Object.assign(d, patch);
    this.notify();
    return d;
  }

  getDecision(id: string): Decision | undefined {
    return this.state.decisions.find((x) => x.id === id);
  }

  listPending(): Decision[] {
    return this.state.decisions.filter((d) => d.status === 'pending_confirm');
  }

  // ---------- 事件流 ----------

  logEvent(type: LiveEventType, title: string, detail?: string, decisionId?: string): LiveEvent {
    this.eventSeq += 1;
    const event: LiveEvent = {
      id: `ev_${Date.now().toString(36)}_${this.eventSeq}`,
      ts: Date.now(),
      type,
      title,
      detail,
      decisionId,
      metrics: { ...this.state.metrics },
    };
    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    }
    return event;
  }

  listEvents(sinceTs = 0, type?: LiveEventType): LiveEvent[] {
    return this.state.events.filter((e) => e.ts >= sinceTs && (!type || e.type === type));
  }

  // ---------- 复盘 / 导出 ----------

  /** 复盘用：本场完整数据包（C 的 attribution/report 直接消费） */
  exportSession() {
    const s = this.snapshot();
    return {
      sessionId: s.sessionId,
      channelId: s.channelId,
      mode: s.mode,
      source: s.source,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMin: Number(s.metrics.elapsedMin.toFixed(2)),
      metrics: s.metrics,
      funnel: s.funnel,
      decisions: s.decisions,
      timeline: s.timeline,
      events: s.events,
      products: s.productRanking,
      strategy: s.strategy,
    };
  }

  reset(): void {
    this.state = this.freshState();
    this.notify();
  }

  uptimeSec(): number {
    return Math.round((Date.now() - this.createdAt) / 1000);
  }
}

/** 全局单例：模拟器 / 路由 / 引擎（C）共用同一份状态 */
export const store = new LiveStore();
