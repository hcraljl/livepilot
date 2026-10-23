/**
 * WatchEmbed —— 观众端真实观看页：**触发按钮 + 全屏弹层**（v0.6.0）
 *
 * 为什么改（v0.6.0）：
 *   右屏常驻 400px 宽 + 38vh 高，官方观看页（播放器 + 聊天区 + 商品面板）根本放不下，
 *   观众实际看到的排版被裁得七零八落，演示时反而显得"不真实"。
 *   改为：平时完全收起，让看板吃满整个宽度；需要核对观众视角时点右上角按钮弹出大窗，
 *   弹窗按 96vw × 92vh 给足空间，iframe 内是官方原版页面，所见即观众所见。
 *
 * 结构：
 *  ┌ 触发器（header 右上，显示真实/模拟状态）
 *  └ 弹层（createPortal → body，避免被 header 的 overflow 裁切）
 *     ├ 标题 / 频道徽章 / 换频道 / 新窗口打开 / 关闭
 *     ├ 左：官方观看页 iframe（/watch/?channelId=…，撑满弹层左半区）
 *     └ 右：观众侧互动流（执行态决策 → 抽奖 / 答题卡 / 公告 / 商品推送）
 *
 * 与 v0.5.1 的合并（rebase 到 9fc1a8e 后）：
 *  - 保留 v0.5.1 的地址修正：`/watch/` 由**后端**托管并决定用官方页还是兜底页，
 *    dev 下 Vite 已代理 /watch，不再写死 `/watch/index.html`（那样 dev 会命中兜底页）；
 *  - 保留 v0.5.1 的「按 PC 逻辑宽渲染 + 等比缩放」思路：官方页不随 iframe 宽度收缩
 *    （实测逻辑宽约 1080px），弹层在 1280 屏上仍可能窄于它，故窄于 1080 时等比缩放，
 *    并让 iframe 逻辑高度 = 容器高 / scale，保证缩放后正好铺满、页面自身仍可滚动；
 *  - v0.5.1 的「全屏打开」在弹层里升级为「新窗口打开」（1:1 尺寸核对时用）。
 *
 * 交互约定：
 *  - 点遮罩、点关闭、按 Esc 均可关闭；
 *  - 弹层**每次打开重新挂载** iframe：确保拿到最新直播状态，且关闭后不会有残留声音；
 *  - 有频道号嵌官方页，无频道号退化为模拟画面占位（判定只看 channelId，v0.5.0 结论）。
 *
 * 频道号以 GET /api/polyv/channel 为准（含 embeddable 判定），并支持运行时切换
 * （POST /api/polyv/channel，演示现场换频道不必重启后端）。
 *
 * 契约：LiveState.channelId / decisions / metrics；PolyvChannelInfo（API.md v2）
 * 负责人：A · @since v0.2.0（v0.3.0 嵌官方 SDK 页；v0.4.0 模拟观众端；v0.5.0 频道判定与切换；
 *                      v0.5.1 地址与缩放；v0.6.0 弹层化）
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Decision, LiveState } from '@livepilot/shared';
import { ACTION_LABELS } from '../lib/constants';
import { formatInt } from '../lib/format';
import { fetchPolyvChannel, setPolyvChannel, type PolyvChannelInfo } from '../lib/api';

/**
 * 官方观看页地址（沿用 v0.5.1 修正）
 *
 * 由**后端**托管并决定用哪一份：`/watch/` 优先官方开源观看页构建产物
 * （frontend/watch-sdk，Vue2 + @polyv/live-watch-sdk，带播放器/聊天室/互动接收端），
 * 没有产物时回退轻量页（frontend/watch），另有 `/watch-lite/` 可强制兜底。
 * 因此这里**不要**写死成 `/watch/index.html`：那样 dev 下会绕过后端、直接命中
 * Vite 静态目录里的轻量页，造成「开发看兜底页、生产看官方页」的不一致。
 *
 * @since v0.3.0（v0.5.1 改指向后端托管的 /watch/）
 */
const WATCH_PAGE = '/watch/';

/**
 * 官方观看页的逻辑宽度 @since v0.5.1（v0.6.1 由 1080 修正为 1180）
 *
 * 实测依据：容器 1134px 时页面 `scrollWidth=1147 / clientWidth=1119`，即该页有约
 * **1147px 的最小内容宽**（播放区 + 聊天区 + 商品面板的固定宽度之和），不随 iframe 收缩。
 * 因此逻辑宽必须 ≥ 1147 才不会出现横向滚动条；取 1180 留 30px 余量。
 */
const OFFICIAL_LOGICAL_W = 1180;

/** 观众端互动卡片的配色（按动作类型区分，弱化但可辨） @since v0.4.0 */
const ACTION_TONE: Record<string, string> = {
  lottery: 'border-warn-200 bg-warn-50',
  welfare_lottery: 'border-warn-200 bg-warn-50',
  answer_card: 'border-brand-200 bg-brand-50',
  checkin: 'border-brand-200 bg-brand-50',
  push_card: 'border-brand-200 bg-brand-50',
  push_product: 'border-success-200 bg-success-50',
  bulletin: 'border-gray-200 bg-gray-50',
};

/** 观众端只关心「已经发生」的互动（建议态观众看不到） @since v0.4.0 */
const visible = (d: Decision): boolean => d.status === 'executed';

/**
 * 官方观看页 iframe：撑满容器；窄于逻辑宽时等比缩放（不出现横向滚动） @since v0.5.1（v0.6.0 改为铺满弹层）
 */
function OfficialFrame({ channel }: { channel: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      if (r.width > 0 && r.height > 0) setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * 容器比逻辑宽更宽 → 不缩放；否则按宽度等比缩，高度同步放大以保证缩放后铺满。
   * 逻辑宽取 OFFICIAL_LOGICAL_W（含最小内容宽余量），因此缩放过后的 iframe 内部
   * 不会再出现横向滚动条（v0.6.1 修复）。
   */
  const scale = box.w === 0 ? 1 : Math.min(box.w / OFFICIAL_LOGICAL_W, 1);
  const frameStyle =
    box.w === 0
      ? { width: '100%', height: '100%', border: 0 }
      : {
          width: box.w / scale,
          height: box.h / scale,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          border: 0,
        };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-900">
      {!loaded && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-gray-900">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
          <p className="text-[11px] text-white/50">官方观看页加载中…</p>
        </div>
      )}
      <iframe
        title="保利威直播观看页（官方开源观看 SDK）"
        src={`${WATCH_PAGE}?channelId=${encodeURIComponent(channel)}`}
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-forms"
        referrerPolicy="no-referrer"
        onLoad={(e) => {
          setLoaded(true);
          /**
           * 官方页内用了 100vw 布局，含纵向滚动条宽度 → 任何容器下都会多出约 15px
           * 横向溢出（真实观众直接访问时同样如此）。这里只是在**嵌入层**隐藏这条
           * 纯装饰性横向滚动条，不改 vendor 产物；逻辑宽已按 1180 留过余量，
           * 不会被裁掉真实内容。失败（跨域/沙箱限制）时静默忽略。
           * @since v0.6.1
           */
          try {
            const doc = e.currentTarget.contentDocument;
            if (doc) doc.documentElement.style.overflowX = 'hidden';
          } catch {
            /* 拿不到 contentDocument 时保持原样 */
          }
        }}
        style={frameStyle}
      />
    </div>
  );
}

/** 播放器槽位：有频道号即嵌官方观看页（不看 source） @since v0.5.0 */
function PlayerSlot({
  channel,
  online,
  currentProduct,
  heightClass,
}: {
  channel: string;
  online: number;
  currentProduct: string;
  heightClass: string;
}) {
  if (channel !== '') {
    return (
      <div className={heightClass}>
        <OfficialFrame channel={channel} />
      </div>
    );
  }

  return (
    <div
      className={`relative w-full overflow-hidden rounded-lg bg-gradient-to-br from-gray-800 to-gray-900 ${heightClass}`}
    >
      <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded bg-danger-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
        <span className="h-1.5 w-1.5 rounded-full bg-white" />
        直播中
      </div>
      <div className="absolute right-2 top-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
        {formatInt(online)} 人在线
      </div>
      <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm font-medium text-white/90">模拟直播画面</p>
        <p className="px-6 text-[11px] leading-relaxed text-white/50">
          {currentProduct ? `正在讲解：${currentProduct}` : '配置频道号后这里将嵌入官方观看页'}
        </p>
      </div>
    </div>
  );
}

/** 观众侧互动流 @since v0.4.0（v0.5.0 从 SimViewer 抽出，两种模式共用） */
function ViewerFeed({ state }: { state: LiveState | null }) {
  const decisions = (state?.decisions ?? []).filter(visible).slice(-20).reverse();

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-gray-100 bg-gray-50/60 p-2.5">
      <div className="mb-1.5 flex shrink-0 items-center justify-between">
        <p className="text-[11px] font-medium text-gray-500">观众端 · 互动流</p>
        {decisions.length > 0 && <span className="text-[10px] text-gray-400">{decisions.length} 条</span>}
      </div>
      {decisions.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded border border-dashed border-gray-200 p-4 text-center">
          <p className="text-[11px] leading-relaxed text-gray-400">
            AI 发起互动后，
            <br />
            观众会在这里看到抽奖 / 答题卡 / 公告 / 商品推送
          </p>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
          {decisions.map((d) => (
            <li
              key={d.id}
              className={`shrink-0 rounded-md border px-2.5 py-2 ${ACTION_TONE[d.action] ?? 'border-gray-200 bg-gray-50'}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-white/70 px-1 py-0.5 text-[10px] font-medium text-gray-600">
                  {ACTION_LABELS[d.action] ?? d.action}
                </span>
                <span className="ml-auto text-[10px] text-gray-400">
                  {new Date(d.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-gray-700">{d.title || d.rule}</p>
              {d.result && (
                <p className="mt-0.5 text-[10px] text-gray-400">{d.result.mock ? '模拟下发' : '真实下发'}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 运行时换频道（演示现场不必重启后端） @since v0.5.0 */
function ChannelSwitcher({
  current,
  onApplied,
}: {
  current: string;
  onApplied: (info: PolyvChannelInfo) => void;
}) {
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const apply = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const info = await setPolyvChannel(draft.trim());
      onApplied(info);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 rounded-md border border-gray-200 bg-gray-50 p-2">
      <div className="flex items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="频道号（留空=恢复 .env 配置）"
          className="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-[11px]"
          aria-label="频道号"
        />
        <button
          type="button"
          disabled={busy}
          onClick={apply}
          className="shrink-0 rounded bg-brand-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {busy ? '切换中…' : '切换'}
        </button>
      </div>
      {err && <p className="mt-1 text-[10px] text-danger-600">{err}</p>}
    </div>
  );
}

interface WatchEmbedProps {
  state: LiveState | null;
}

export function WatchEmbed({ state }: WatchEmbedProps) {
  /** 后端权威频道信息（首屏拉一次，切换后以接口返回为准） @since v0.5.0 */
  const [info, setInfo] = useState<PolyvChannelInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPolyvChannel()
      .then((v) => {
        if (!cancelled) setInfo(v);
      })
      .catch(() => {
        /* 后端未起时静默降级：用 state.channelId 兜底 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Esc 关闭弹层 + 打开期间锁背景滚动（v0.6.1：弹层盖住整页时背景仍能滚动，滚轮会穿透） @since v0.6.0 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  /** 接口不可用（或首屏未返回）时退回 SSE 帧里的 channelId @since v0.5.0 */
  const channel = info ? (info.channelId ?? '') : (state?.channelId ?? '');
  const isReal = channel !== '';

  return (
    <>
      {/* 触发器：常驻 header，平时只占一个小按钮 @since v0.6.0 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
          isReal
            ? 'border-success-200 bg-success-50 text-success-800 hover:bg-success-100'
            : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
        }`}
        title={isReal ? `打开官方观看页（频道 ${channel}）` : '未配置频道号，将显示模拟画面'}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${isReal ? 'bg-success-500' : 'bg-gray-300'}`} />
        观众端预览
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/60 p-4 backdrop-blur-[2px]"
            role="dialog"
            aria-modal="true"
            aria-label="观众端实时观看页"
            onClick={() => setOpen(false)}
          >
            <div
              className="flex h-[min(900px,92vh)] w-[min(1480px,96vw)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* 弹层头 */}
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2.5">
                <h3 className="text-sm font-medium text-gray-700">观众端 · 真实观看页</h3>
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] ${
                    isReal ? 'bg-success-50 text-success-800' : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {isReal ? `频道 ${channel}` : '模拟观众端'}
                </span>
                <button
                  type="button"
                  onClick={() => setSwitching((v) => !v)}
                  className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-50"
                  title="运行时切换频道（不必重启后端）"
                >
                  {switching ? '收起' : '换频道'}
                </button>
                {isReal && (
                  <a
                    href={`${WATCH_PAGE}?channelId=${encodeURIComponent(channel)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-50"
                    title="在独立窗口 1:1 打开官方观看页"
                  >
                    新窗口打开 ↗
                  </a>
                )}
                <span className="ml-auto hidden text-[11px] text-gray-400 lg:inline">
                  与观众访问观看页所见一致（官方开源观看 SDK）
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-50"
                  aria-label="关闭预览"
                >
                  关闭 ✕
                </button>
              </div>

              {switching && (
                <div className="shrink-0 px-4 pt-3">
                  <ChannelSwitcher
                    current={channel}
                    onApplied={(v) => {
                      setInfo(v);
                      setSwitching(false);
                    }}
                  />
                </div>
              )}

              {/* 弹层主体：左 = 官方观看页（撑满），右 = 观众侧互动流 */}
              <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:flex-row">
                <div className="min-h-[220px] flex-1">
                  <PlayerSlot
                    channel={channel}
                    online={state?.metrics.online ?? 0}
                    currentProduct={state?.metrics.currentProduct ?? ''}
                    heightClass="h-full"
                  />
                </div>
                <div className="flex h-[180px] shrink-0 flex-col lg:h-auto lg:w-[300px]">
                  <ViewerFeed state={state} />
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
