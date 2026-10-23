/**
 * 真实指标轮询器 —— 把看板数据从「模拟」换成「保利威真实数据」
 *
 * 为什么要单独一个文件：
 *   看板原先只有一条数据链路（模拟器）。客户端开播后频道真的在播，
 *   看板却还在显示模拟曲线，等于「真播了但数据还是假的」。
 *   本模块负责在频道转 live 后，改从保利威官方统计接口取数喂给同一个 store，
 *   让看板、AI 决策、复盘全部吃到真实数据。
 *
 * 三个官方接口（路径与字段均按官方文档实测确认）：
 *   1. GET /live/v2/statistics/get-realtime-viewers?channelIds=xxx
 *      → data: [{ channelId, time: 'HH:mm:ss', count }]，15 条按时间降序，count = 实时在线人数
 *   2. GET /live/v4/statistics/session-stats/summary/list?channelId=xxx
 *      → data.contents: [{ sessionId, startTime, endTime, viewerCount, uniqueViewer,
 *                          maxConcurrencyCount, playCount, totalPlayDuration }]
 *   3. GET /live/v4/channel/product/stats/summary?channelId=xxx[&sessionId=xxx]
 *      → data: { productClickNum, productClickViewers, payPageNum, payViewers,
 *                saleQuantity, totalPayAmount }
 *
 * 取数纪律：
 *   - 只在真实模式（isReal）且频道确实 live 时工作；模拟模式下完全不介入
 *   - 任何一次失败都不抛、不影响主流程，只在日志里留下痕迹
 *   - 场次已结束（endTime 有值）的数据**不采用**，避免把上一场的旧数据当成当前场
 */
import { config } from '../config.ts';
import { store } from '../store/state.ts';
import { signParams } from '../polyv/sign.ts';

/** 轮询间隔：官方统计有秒级~分钟级延迟，5s 足够灵敏又不至于打爆频率限制 */
const POLL_MS = 5_000;

interface RealtimeViewerPoint {
  channelId: string | number;
  time: string;
  count: number;
}

interface SessionSummaryItem {
  sessionId: string;
  name?: string;
  startTime: number;
  endTime: number;
  viewerCount?: number;
  uniqueViewer?: number;
  maxConcurrencyCount?: number;
  playCount?: number;
}

interface ProductStatsSummary {
  productClickNum?: number;
  productClickViewers?: number;
  payPageNum?: number;
  payViewers?: number;
  saleQuantity?: number;
  totalPayAmount?: number;
}

interface PolyvEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

const log = (msg: string): void => {
  console.log(`[metrics] ${msg}`);
};

/** 带签名的 GET，失败返回 null（绝不抛，绝不阻塞主流程） */
async function signedGet<T>(
  path: string,
  params: Record<string, string | number>,
): Promise<T | null> {
  try {
    const query = signParams(params) as Record<string, string | number>;
    const url = `${config.polyv.apiBase}${path}?${new URLSearchParams(
      Object.entries(query).map(([k, v]) => [k, String(v)]),
    ).toString()}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(config.polyv.timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as PolyvEnvelope<T> | null;
    if (!json) return null;
    const ok = json.code === 200 || json.code === 0;
    if (!ok) {
      log(`✗ ${path} code=${json.code} ${json.message ?? ''}`);
      return null;
    }
    return (json.data ?? null) as T | null;
  } catch (err) {
    log(`✗ ${path} ${(err as Error).message}`);
    return null;
  }
}

class RealMetricsPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** 当前锁定的场次：一旦锁定就不跟着历史列表漂移 */
  private sessionId: string | null = null;
  private lastErrorAt = 0;

  get running(): boolean {
    return this.timer !== null;
  }

  /** 开始轮询（幂等） */
  start(): void {
    if (this.timer) return;
    this.sessionId = null;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    log('✅ 已切换到保利威真实数据（每 5s 轮询官方统计接口）');
  }

  /** 停止轮询（幂等） */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.sessionId = null;
    log('⏹ 已停止真实数据轮询');
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const channelId = store.get().channelId || config.polyv.channelId;
      if (!channelId) return;

      // ① 实时在线人数
      const viewers = await signedGet<RealtimeViewerPoint[]>(
        '/live/v2/statistics/get-realtime-viewers',
        { channelIds: channelId },
      );
      const online = viewers?.find((v) => String(v.channelId) === String(channelId))?.count;

      // ② 当前场次汇总：优先锁定正在进行中的场次（endTime 为空/0）
      const summary = await signedGet<{ contents?: SessionSummaryItem[] }>(
        '/live/v4/statistics/session-stats/summary/list',
        { channelId, pageSize: 5 },
      );
      const contents = summary?.contents ?? [];
      // 只认「正在进行中」的场次（endTime 为空/0）。
      // 已结束的历史场次绝不当作当前场 —— 否则没开播时会把上一场的数据/时长显示成当前的。
      const live = contents.find((s) => !s.endTime) ?? null;
      if (live) this.sessionId = live.sessionId;
      if (!live) {
        // 没有进行中的场次：把看板归零后返回（未开播或刚下播，真实数据就是 0）
        store.patchMetrics(
          { online: 0, totalViewers: 0, productClicks: 0, orders: 0, gmv: 0, danmakuRate: 0 },
          { allowDecrease: true },
        );
        store.setMetricsOrigin('real');
        return;
      }

      // ③ 商品统计（带上场次 ID，拿到的是本场数据而不是频道历史累计）
      const productParams: Record<string, string | number> = { channelId };
      if (this.sessionId) productParams.sessionId = this.sessionId;
      const product = await signedGet<ProductStatsSummary>(
        '/live/v4/channel/product/stats/summary',
        productParams,
      );

      const uniqueViewer = live?.uniqueViewer ?? 0;
      const viewerCount = live?.viewerCount ?? 0;
      const clickNum = product?.productClickNum ?? 0;
      const clickViewers = product?.productClickViewers ?? 0;
      const orders = product?.saleQuantity ?? 0;
      const gmv = Number(product?.totalPayAmount ?? 0);
      const elapsedMin = live?.startTime
        ? (Date.now() - live.startTime) / 60_000
        : store.get().metrics.elapsedMin;

      store.patchMetrics(
        {
          online: Math.round(online ?? live?.maxConcurrencyCount ?? 0),
          totalViewers: Math.round(uniqueViewer || viewerCount),
          productClicks: clickNum,
          orders,
          gmv,
          // 真实数据没有「弹幕率」，用真实的「商品点击人数 / 独立观众」作为互动率近似
          danmakuRate: uniqueViewer > 0 ? Math.min(1, clickViewers / uniqueViewer) : 0,
          productCtr: viewerCount > 0 ? clickNum / viewerCount : undefined,
          elapsedMin: Number(Math.max(0, elapsedMin).toFixed(3)),
        },
        // 切换数据源时允许指标回落（模拟的几十万 → 真实的真实值），否则单调递增护栏会把旧数锁死
        { allowDecrease: true },
      );
      store.setMetricsOrigin('real');
    } catch (err) {
      // 真实取数失败不能影响看板：只做节流日志
      if (Date.now() - this.lastErrorAt > 30_000) {
        this.lastErrorAt = Date.now();
        log(`轮询异常：${(err as Error).message}`);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

export const realMetrics = new RealMetricsPoller();
