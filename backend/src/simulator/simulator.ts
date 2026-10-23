/**
 * 直播模拟器（演示主数据源）
 *
 * 为什么需要它：现场不可能等真实直播跑 30 分钟，也不能靠真实流量"恰好"制造留存下跌 / 冷场 / 逼单。
 * 所以模拟器按"剧本"生成一条可复现的直播曲线，把 5 条 AI 规则需要的场景都安排上：
 *   1) 留存保卫 → 中途一次在线人数断崖（online_drop）
 *   2) 氛围激活 → 一段弹幕冷场（cold_start）
 *   3) 转化助推 → 一段商品点击停滞（low_ctr）
 *   4) 逼单     → 末段剩余时间不足且 GMV 未达标（endgame）
 *   5) 异常兜底 → 一次"推流抖动"（stream_stall）
 *
 * 设计：每 tick 推进 dtSec 秒直播时间（可用 speed 加速），写 store，由 store 通知 SSE 与引擎。
 * 随机数用种子化 PRNG，保证彩排与现场演示曲线一致（评委看到的"AI 自动发抽奖"每次都在同一位置）。
 */
import type { LiveState, ProductRank, StartSimReq } from '../../../shared/types.ts';
import { config } from '../config.ts';
import { store } from '../store/state.ts';

/** 私域品牌自播常见品类（商品名/单价用于 GMV 计算） */
export const PRODUCTS = [
  { name: '山野茶油 500ml', price: 89, weight: 0.24 },
  { name: '手工红糖姜茶礼盒', price: 59, weight: 0.18 },
  { name: '古法酿造酱油 2 瓶装', price: 69, weight: 0.16 },
  { name: '农家土蜂蜜 500g', price: 129, weight: 0.14 },
  { name: '现摘赣南脐橙 5 斤', price: 49, weight: 0.16 },
  { name: '非遗手作腐竹 1kg', price: 39, weight: 0.12 },
];

export type ScenarioName = 'online_drop' | 'cold_start' | 'low_ctr' | 'endgame' | 'stream_stall';

const SCENARIO_LABEL: Record<ScenarioName, string> = {
  online_drop: '在线人数断崖（触发留存保卫）',
  cold_start: '弹幕冷场（触发氛围激活）',
  low_ctr: '商品点击停滞（触发转化助推）',
  endgame: '末段 GMV 未达标（触发逼单）',
  stream_stall: '推流抖动（触发异常兜底）',
};

interface Beat {
  /** 在第几分钟触发 */
  atMin: number;
  name: ScenarioName;
  /** 持续多少直播秒 */
  durationSec: number;
}

/** 种子化随机数（mulberry32）：同一 seed 的曲线完全一致，演示可复现 */
const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export class LiveSimulator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private rand: () => number = Math.random;
  private totalMin = config.simulator.totalMin;
  private speed = config.simulator.speed;
  private tickMs = config.simulator.tickMs;
  private beats: Beat[] = [];
  /** 手动注入的临时场景（覆盖剧本） */
  private manual: { name: ScenarioName; untilSec: number } | null = null;
  private activeLabel: ScenarioName | null = null;
  private liveSec = 0;
  private productIndex = 0;
  private productSwitchAt = 0;
  private ranks = new Map<string, ProductRank>();
  private lastMetricLogSec = 0;
  private tickCount = 0;
  /** 小数累加器：单 tick 的点击/下单可能不足 1，直接取整会让 GMV 恒为 0（加速演示时尤其明显） */
  private acc = { viewers: 0, clicks: 0, orders: 0, gmv: 0 };
  /**
   * AI 动作效果：模拟器对已执行动作做出响应（在线回升 / 点击回升 / 转化上浮），
   * 让演示形成"AI 动作 → 指标回升 → 复盘增量"的闭环，而不是动作与数据两条平行线。
   */
  private handledDecisions = new Set<string>();
  private actionEffect: {
    untilSec: number;
    onlineMul: number;
    ctrMul: number;
    convAdd: number;
    danmakuAdd: number;
  } | null = null;

  get running(): boolean {
    return this.timer !== null;
  }

  /** 启动：重置状态 → 排剧本 → 开始定时 tick */
  start(req: StartSimReq = {}): LiveState {
    if (this.timer) this.stop('重新开始，先停止上一场');

    this.totalMin = req.totalMin && req.totalMin > 0 ? req.totalMin : config.simulator.totalMin;
    this.speed = req.speed && req.speed > 0 ? req.speed : config.simulator.speed;
    this.tickMs = req.tickMs && req.tickMs > 0 ? req.tickMs : config.simulator.tickMs;
    this.rand = mulberry32(req.seed ?? config.simulator.seed);
    this.liveSec = 0;
    this.tickCount = 0;
    this.manual = null;
    this.activeLabel = null;
    this.productIndex = 0;
    this.productSwitchAt = 0;
    this.lastMetricLogSec = 0;
    this.ranks.clear();
    this.acc = { viewers: 0, clicks: 0, orders: 0, gmv: 0 };
    this.handledDecisions.clear();
    this.actionEffect = null;
    for (const p of PRODUCTS) this.ranks.set(p.name, { name: p.name, clicks: 0, orders: 0, gmv: 0 });

    this.beats = this.buildBeats(this.totalMin);

    const state = store.startSession(this.totalMin, 'simulator');
    store.patchMetrics({ currentProduct: PRODUCTS[0].name, online: 20, totalViewers: 30 });
    store.setProductRanking([...this.ranks.values()]);
    store.logEvent(
      'system',
      '模拟器已启动',
      `时长 ${this.totalMin} 分钟 · 加速 ${this.speed}x · 剧本节点：${this.beats
        .map((b) => `${b.atMin.toFixed(1)}min/${b.name}`)
        .join('、')}`,
    );

    this.timer = setInterval(() => this.tick(), this.tickMs);
    return state;
  }

  stop(reason = '模拟器停止'): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    store.setScenario(null);
    store.stopSession(reason);
  }

  /** 现场手动加戏：不必等剧本节点 */
  injectScenario(name: ScenarioName, durationSec = 75): void {
    if (!this.running) return;
    this.manual = { name, untilSec: this.liveSec + durationSec };
    store.setScenario(name, `${SCENARIO_LABEL[name]}（手动注入，持续约 ${durationSec}s）`);
  }

  /** 剧本：按总时长的比例布点，换 totalMin 也能用 */
  private buildBeats(totalMin: number): Beat[] {
    return [
      { atMin: totalMin * 0.11, name: 'online_drop', durationSec: Math.max(40, totalMin * 2.4) },
      { atMin: totalMin * 0.3, name: 'cold_start', durationSec: Math.max(45, totalMin * 2.6) },
      { atMin: totalMin * 0.52, name: 'low_ctr', durationSec: Math.max(60, totalMin * 3.2) },
      { atMin: totalMin * 0.82, name: 'stream_stall', durationSec: Math.max(25, totalMin * 1.2) },
      // 末段冲刺：B 已写好 endgame 分支，但原剧本漏排；没有它，自然流量下滑会吃掉逼单增量
      {
        atMin: Math.max(0, totalMin - config.defaultStrategy.pushWindowMin),
        name: 'endgame',
        durationSec: config.defaultStrategy.pushWindowMin * 60,
      },
    ];
  }

  /** 当前生效场景（含逼单时段，逼单由"剩余时间 + GMV 差"自然产生，不强行注水） */
  private currentScenario(elapsedMin: number): ScenarioName | null {
    if (this.manual && this.liveSec < this.manual.untilSec) return this.manual.name;
    if (this.manual) this.manual = null;
    for (const b of this.beats) {
      const durationMin = b.durationSec / 60;
      if (elapsedMin >= b.atMin && elapsedMin < b.atMin + durationMin) return b.name;
    }
    return null;
  }

  /** 扫描新执行的 AI 动作，设置指标增益 + 对应场景提前恢复 */
  private scanActionEffects(elapsedMin: number): void {
    const current = this.currentScenario(elapsedMin);
    for (const decision of store.get().decisions) {
      if (decision.status !== 'executed') continue;
      if (this.handledDecisions.has(decision.id)) continue;
      this.handledDecisions.add(decision.id);

      const action = decision.action;
      let effect:
        | {
            onlineMul: number;
            ctrMul: number;
            convAdd: number;
            danmakuAdd: number;
            relief?: ScenarioName;
          }
        | null = null;

      if (action === 'lottery' || action === 'push_card') {
        effect = {
          onlineMul: 1.06,
          ctrMul: 1.15,
          convAdd: 0.01,
          danmakuAdd: 0.08,
          relief: 'online_drop',
        };
      } else if (action === 'push_product' || action === 'welfare_lottery') {
        effect = {
          onlineMul: 1.02,
          ctrMul: 2.4,
          convAdd: 0.03,
          danmakuAdd: 0.05,
          relief: 'low_ctr',
        };
      } else if (action === 'answer_card' || action === 'checkin') {
        effect = {
          onlineMul: 1.02,
          ctrMul: 1.2,
          convAdd: 0.02,
          danmakuAdd: 0.15,
          relief: 'cold_start',
        };
      } else if (action === 'bulletin') {
        effect = {
          onlineMul: 1.01,
          ctrMul: 1,
          convAdd: 0,
          danmakuAdd: 0.02,
          relief: current === 'stream_stall' ? 'stream_stall' : undefined,
        };
      }
      if (!effect) continue;

      const untilSec = this.liveSec + 90;
      if (this.actionEffect && this.actionEffect.untilSec > this.liveSec) {
        this.actionEffect = {
          untilSec: Math.max(this.actionEffect.untilSec, untilSec),
          onlineMul: Math.max(this.actionEffect.onlineMul, effect.onlineMul),
          ctrMul: Math.max(this.actionEffect.ctrMul, effect.ctrMul),
          convAdd: Math.max(this.actionEffect.convAdd, effect.convAdd),
          danmakuAdd: Math.max(this.actionEffect.danmakuAdd, effect.danmakuAdd),
        };
      } else {
        this.actionEffect = {
          untilSec,
          onlineMul: effect.onlineMul,
          ctrMul: effect.ctrMul,
          convAdd: effect.convAdd,
          danmakuAdd: effect.danmakuAdd,
        };
      }

      if (effect.relief && current === effect.relief) {
        // 直接从剧本里移除该场景，保证动作生效后不会在场景尾部"复活"
        this.beats = this.beats.filter(
          (item) => item.name !== effect.relief,
        );
        if (this.manual?.name === effect.relief) this.manual = null;
        store.logEvent(
          'system',
          `AI 动作生效：${decision.title ?? decision.action}`,
          `场景 ${effect.relief} 提前恢复`,
        );
      }
    }
  }

  /** 基础在线人数曲线（无场景干扰时） */
  private baseOnline(elapsedMin: number): number {
    const t = elapsedMin;
    const total = this.totalMin;
    if (t < 2) return 300 + (2600 * t) / 2; // 开场冲人
    if (t < total * 0.25) return 2900 + ((t - 2) / Math.max(0.1, total * 0.25 - 2)) * 400; // 爬坡到峰值
    const rest = Math.max(0.1, total - total * 0.25);
    return 3300 - ((t - total * 0.25) / rest) * 1500; // 缓慢自然流失
  }

  private tick(): void {
    // 外部（Webhook / REST / 引擎）把场次停掉后，别再往状态里灌数据
    if (!store.get().running) {
      this.stop('场次已被外部关闭，模拟器自动退出');
      return;
    }
    const dtSec = this.speed * (this.tickMs / 1000);
    this.liveSec += dtSec;
    this.tickCount += 1;

    const m = store.get().metrics;
    const elapsedMin = m.elapsedMin;
    this.scanActionEffects(elapsedMin);
    const scenario = this.currentScenario(elapsedMin);
    const activeEffect =
      this.actionEffect && this.liveSec < this.actionEffect.untilSec
        ? this.actionEffect
        : null;

    if (scenario !== this.activeLabel) {
      this.activeLabel = scenario;
      store.setScenario(scenario, scenario ? SCENARIO_LABEL[scenario] : '恢复正常');
    }

    // ---- 在线人数：向目标平滑逼近 + 噪声 ----
    let target = this.baseOnline(elapsedMin);
    if (scenario === 'online_drop') target *= 0.74;
    if (scenario === 'stream_stall') target *= 0.9;
    if (scenario === 'endgame') target *= 1.06;
    if (activeEffect) target *= activeEffect.onlineMul;
    const noise = 1 + (this.rand() - 0.5) * 0.05;
    const online = m.online + (target - m.online) * 0.28;
    const nextOnline = Math.max(30, Math.round(online * noise));

    // ---- 累计观看（小数累加，避免单 tick 不足 1 人时被取整吃掉） ----
    this.acc.viewers += (nextOnline * 0.55 * dtSec) / 60 * (0.85 + this.rand() * 0.3);
    const newViewers = Math.floor(this.acc.viewers);
    this.acc.viewers -= newViewers;

    // ---- 弹幕 / 互动率 ----
    let danmakuRate = 0.4 + Math.sin(elapsedMin * 1.7) * 0.06 + (this.rand() - 0.5) * 0.05;
    if (scenario === 'cold_start') danmakuRate = 0.03 + this.rand() * 0.03;
    if (scenario === 'stream_stall') danmakuRate = 0.01;
    if (scenario === 'endgame') danmakuRate = Math.min(0.85, danmakuRate + 0.2);
    if (activeEffect) danmakuRate += activeEffect.danmakuAdd;
    danmakuRate = Math.min(0.95, Math.max(0.01, danmakuRate));

    // ---- 商品点击：随讲解节奏波动，low_ctr 场景断崖 ----
    const baseCtr = 0.075 + Math.sin(elapsedMin * 0.9) * 0.015;
    let ctr = baseCtr;
    if (scenario === 'low_ctr') ctr = 0.004;
    if (scenario === 'endgame') ctr = baseCtr * 1.7;
    if (activeEffect) ctr = Math.min(0.6, ctr * activeEffect.ctrMul);
    const clicksF = ((nextOnline * ctr * dtSec) / 60) * (0.8 + this.rand() * 0.5);

    // ---- 下单：点击转化率随互动热度上浮（互动越热，转化越好，这是复盘归因的故事基础） ----
    let conv = 0.055 + danmakuRate * 0.14 + (scenario === 'endgame' ? 0.06 : 0);
    if (activeEffect) conv += activeEffect.convAdd;
    const product = PRODUCTS[this.productIndex];

    this.acc.clicks += clicksF;
    const clicks = Math.floor(this.acc.clicks);
    this.acc.clicks -= clicks;

    this.acc.orders += clicksF * conv;
    const orders = Math.floor(this.acc.orders);
    this.acc.orders -= orders;

    this.acc.gmv += orders * product.price;
    const gmvDelta = Math.floor(this.acc.gmv);
    this.acc.gmv -= gmvDelta;
    const gmv = gmvDelta;

    // ---- 商品切换（每 4~6 分钟换讲解品） ----
    if (elapsedMin >= this.productSwitchAt) {
      this.productIndex = this.pickNextProduct();
      this.productSwitchAt = elapsedMin + 4 + this.rand() * 2;
      store.logEvent('system', `切换讲解商品：${PRODUCTS[this.productIndex].name}`, `第 ${elapsedMin.toFixed(1)} 分钟`);
    }

    // ---- 写回 store ----
    store.patchMetrics({
      online: nextOnline,
      totalViewers: m.totalViewers + newViewers,
      productClicks: m.productClicks + clicks,
      orders: m.orders + orders,
      gmv: m.gmv + gmv,
      danmakuRate: Number(danmakuRate.toFixed(3)),
      productCtr: Number(ctr.toFixed(4)),
      currentProduct: PRODUCTS[this.productIndex].name,
    });

    // ---- 商品榜累积 ----
    const rank = this.ranks.get(product.name);
    if (rank) {
      rank.clicks += clicks;
      rank.orders += orders;
      rank.gmv += gmv;
      store.setProductRanking([...this.ranks.values()]);
    }

    // ---- 每 60 直播秒留一条指标采样事件（复盘可回放） ----
    if (this.liveSec - this.lastMetricLogSec >= 60) {
      this.lastMetricLogSec = this.liveSec;
      const cur = store.get().metrics;
      store.logEvent(
        'metric',
        `第 ${cur.elapsedMin.toFixed(0)} 分钟采样`,
        `在线 ${cur.online} · 累计观看 ${cur.totalViewers} · GMV ¥${Math.round(cur.gmv)} · 互动率 ${(cur.danmakuRate * 100).toFixed(0)}%`,
      );
    }

    // ---- 推进时间轴 + 通知引擎与 SSE ----
    store.tick(dtSec);

    // ---- 场次结束 ----
    if (store.get().metrics.elapsedMin >= this.totalMin - 1e-6) {
      this.finish();
    }
  }

  private pickNextProduct(): number {
    const totalWeight = PRODUCTS.reduce((s, p) => s + p.weight, 0);
    let r = this.rand() * totalWeight;
    for (let i = 0; i < PRODUCTS.length; i += 1) {
      r -= PRODUCTS[i].weight;
      if (r <= 0) {
        // 避免连续重复讲解同一款
        return i === this.productIndex ? (i + 1) % PRODUCTS.length : i;
      }
    }
    return (this.productIndex + 1) % PRODUCTS.length;
  }

  private finish(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const m = store.get().metrics;
    store.setScenario(null);
    store.stopSession(
      `模拟直播跑完设定时长 · 在线 ${m.online} · 累计观看 ${m.totalViewers} · 下单 ${m.orders} 单 · GMV ¥${Math.round(m.gmv)}`,
    );
  }
}

/** 全局单例：路由层直接调用 */
export const simulator = new LiveSimulator();
