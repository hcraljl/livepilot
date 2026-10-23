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

/**
 * 场次统计滞后窗口（30 分钟）
 *
 * 实测发现的硬事实：保利威的「场次汇总」接口在**直播过程中查不到进行中的场次**
 * （所有场次 endTime 都有值，推测要下播后才写库）。如果死等 endTime 为空的场次，
 * `find(!endTime)` 永远失败 → 整条链路一直走「归零分支」 → 看板在线人数永远是 0。
 * 所以放宽为：最近 30 分钟内开始或结束的场次，也认作当前场。
 */
const SESSION_LAG_MS = 30 * 60_000;

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
  private lastSnapshotAt = 0;
  /** 频道转 live 的时刻：由开播监听传入，用于计算真实开播时长（比场次 startTime 准） */
  private liveStartedAt = 0;
  /** 频道累计观看（pageView）缓存：场次统计滞后时的兜底口径，30s 刷新一次 */
  private pageView = 0;
  private pageViewAt = 0;

  get running(): boolean {
    return this.timer !== null;
  }

  /** 开始轮询（幂等）。liveStartedAt = 频道转 live 的时间戳，可省略 */
  start(liveStartedAt = 0): void {
    if (this.timer) return;
    this.sessionId = null;
    this.liveStartedAt = liveStartedAt;
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
    this.liveStartedAt = 0;
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
      // ① 实时在线人数：这是唯一真正实时的口径，独立于场次统计存在。
      //    即便场次汇总还没入库，这个值也必须如实上板 —— 否则开播后在线人数永远是 0。
      const onlineNow = Math.round(
        Number(viewers?.find((v) => String(v.channelId) === String(channelId))?.count ?? 0),
      );

      // ② 当前场次汇总：优先「进行中」（endTime 为空/0），否则退到「最近一场」
      const summary = await signedGet<{ contents?: SessionSummaryItem[] }>(
        '/live/v4/statistics/session-stats/summary/list',
        { channelId, pageSize: 5 },
      );
      const contents = summary?.contents ?? [];
      // 列表按开始时间降序，contents[0] 即最近一场
      const latest = contents[0] ?? null;
      const live = contents.find((s) => !s.endTime) ?? null;
      // 统计滞后兜底：官方场次汇总在直播中查不到「进行中」场次（实测：全部场次 endTime 都有值）。
      // 死等它会导致整条链路走归零分支、在线人数被抹成 0。因此最近 30 分钟内的场次也认。
      const recent =
        !live && latest
          ? Number(latest.endTime ?? 0) > 0 &&
            Date.now() - Number(latest.endTime) < SESSION_LAG_MS
            ? latest
            : Number(latest.startTime ?? 0) > 0 &&
                Math.abs(Date.now() - Number(latest.startTime)) < SESSION_LAG_MS
              ? latest
              : null
          : null;
      const cur = live ?? recent;
      if (cur) this.sessionId = cur.sessionId;

      if (!cur) {
        // 真·没有可认的场次（未开播或下播很久了）：累计类指标归零，
        // 但实时在线人数照实保留 —— 它是独立口径，不该被场次缺失连坐。
        store.patchMetrics(
          {
            online: onlineNow,
            totalViewers: 0,
            productClicks: 0,
            orders: 0,
            gmv: 0,
            danmakuRate: 0,
          },
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

      const uniqueViewer = cur.uniqueViewer ?? 0;
      const viewerCount = cur.viewerCount ?? 0;

      // ④ 累计观看兜底：本场数据要下播后才入库，直播中 uniqueViewer 恒为 0。
      //    此时退到频道维度的 pageView —— 它是真实且实时更新的
      //    （实测：新开一个观看页，pageView 立刻从 24 涨到 25），
      //    总比看板「明明有人在看，累计观看却显示 0」强。
      //    口径注意：pageView 是频道历史累计，跨场次累加，不是单场数据。
      if (Math.round(uniqueViewer || viewerCount) === 0 && Date.now() - this.pageViewAt > 30_000) {
        const basic = await signedGet<{ pageView?: number }>('/live/v3/channel/basic/get', {
          channelId,
        });
        this.pageViewAt = Date.now();
        if (typeof basic?.pageView === 'number') this.pageView = basic.pageView;
      }

      const clickNum = product?.productClickNum ?? 0;
      const clickViewers = product?.productClickViewers ?? 0;
      const orders = product?.saleQuantity ?? 0;
      const gmv = Number(product?.totalPayAmount ?? 0);

      // 开播时长：优先用「频道转 live」的时刻（由开播监听记录），
      // 场次 startTime 在统计滞后时会偏，且已结束场次会算成上一场的固定时长。
      const st = Number(cur.startTime ?? 0);
      const elapsedMin =
        this.liveStartedAt > 0
          ? (Date.now() - this.liveStartedAt) / 60_000
          : st > 0
            ? (Date.now() - st) / 60_000
            : store.get().metrics.elapsedMin;

      store.patchMetrics(
        {
          online: onlineNow > 0 ? onlineNow : Math.round(cur.maxConcurrencyCount ?? 0),
          totalViewers: Math.round(uniqueViewer || viewerCount || this.pageView),
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

      // 每 30s 打一次取数快照，方便现场排查「数据为什么是 0」
      if (Date.now() - this.lastSnapshotAt > 30_000) {
        this.lastSnapshotAt = Date.now();
        log(
          `在线 ${onlineNow} · 场次 ${cur.sessionId}${live ? '(进行中)' : '(滞后兜底)'} · ` +
            `观看 ${uniqueViewer}/${viewerCount}${this.pageView ? `(pageView ${this.pageView})` : ''} · ` +
            `点击 ${clickNum} · 下单 ${orders} · GMV ${gmv}`,
        );
      }
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
