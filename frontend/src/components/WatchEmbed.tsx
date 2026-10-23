/**
 * WatchEmbed —— 右屏：观众端视图（播放器槽位 + 观众侧互动流）
 *
 * 结构（v0.5.0 重构）：
 *  ┌ 标题 / 状态徽章 / 切换频道
 *  ├ 播放器槽位：有频道号 → 嵌 B 的官方观看 SDK 页（/watch/index.html?channelId=…）
 *  │              无频道号 → 模拟画面占位（LIVE 角标 + 在线人数 + 当前讲解商品）
 *  └ 观众侧互动流：执行态决策 → 抽奖 / 答题卡 / 公告 / 商品推送
 *
 * 关键修复（v0.5.0）：嵌入条件从 `source === 'polyv' && channelId` 改为**只看 channelId**。
 * 后端 `LiveState.source` 默认就是 'simulator'（只有以 source='polyv' 开会话才是 'polyv'），
 * 而 `channelId` 取的是 effectiveChannelId（.env 或运行时覆盖）——真实频道 + 模拟动作的
 * 演示组合下，旧条件会把右屏错误退回模拟占位，丢掉真实直播画面（B 已反馈该现象）。
 *
 * 频道号以 GET /api/polyv/channel 为准（含 embeddable 判定），并支持运行时切换
 * （POST /api/polyv/channel，演示现场换频道不必重启后端）。
 *
 * 契约：LiveState.channelId / decisions / metrics；PolyvChannelInfo（API.md v2）
 * 负责人：A · @since v0.2.0（A-12；v0.3.0 嵌官方 SDK 页；v0.4.0 模拟观众端；v0.5.0 频道判定与切换）
 */
import { useEffect, useState } from 'react';
import type { Decision, LiveState } from '@livepilot/shared';
import { ACTION_LABELS } from '../lib/constants';
import { formatInt } from '../lib/format';
import { fetchPolyvChannel, setPolyvChannel, type PolyvChannelInfo } from '../lib/api';

/** 本地官方观看 SDK 演示页（B 提供，见 frontend/watch/index.html） @since v0.3.0 */
const WATCH_PAGE = '/watch/index.html';

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

/** 播放器槽位：有频道号即嵌官方观看页（不看 source） @since v0.5.0 */
function PlayerSlot({ channel, online, currentProduct }: { channel: string; online: number; currentProduct: string }) {
  if (channel !== '') {
    return (
      /* 官方观看页是完整页面（非纯播放器），16:9 会裁掉下半截按钮，故用视口比例给足高度 @since v0.5.0 */
      <div className="h-[38vh] max-h-[420px] min-h-[200px] w-full shrink-0 overflow-hidden rounded-md border border-gray-100 bg-gray-900">
        <iframe
          title="保利威直播观看页（官方观看 SDK）"
          src={`${WATCH_PAGE}?channelId=${encodeURIComponent(channel)}`}
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-forms"
          referrerPolicy="no-referrer"
          className="h-full w-full"
        />
      </div>
    );
  }
  return (
    <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-md bg-gradient-to-br from-gray-800 to-gray-900">
      <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded bg-danger-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
        <span className="h-1.5 w-1.5 rounded-full bg-white" />
        直播中
      </div>
      <div className="absolute right-2 top-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
        {formatInt(online)} 人在线
      </div>
      <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
        <p className="text-xs font-medium text-white/90">模拟直播画面</p>
        <p className="px-4 text-[10px] leading-relaxed text-white/50">
          {currentProduct ? `正在讲解：${currentProduct}` : '配置频道号后将嵌入官方观看页'}
        </p>
      </div>
    </div>
  );
}

/** 观众侧互动流 @since v0.4.0（v0.5.0 从 SimViewer 抽出，两种模式共用） */
function ViewerFeed({ state }: { state: LiveState | null }) {
  const decisions = (state?.decisions ?? []).filter(visible).slice(-8).reverse();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="mb-1 shrink-0 text-[11px] font-medium text-gray-500">观众端 · 互动流</p>
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
              className={`rounded-md border px-2.5 py-2 ${ACTION_TONE[d.action] ?? 'border-gray-200 bg-gray-50'}`}
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
    <div className="shrink-0 rounded-md border border-gray-100 bg-gray-50 p-2">
      <div className="flex items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="频道号（留空=恢复 .env 配置）"
          className="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-[11px]"
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

  /** 接口不可用（或首屏未返回）时退回 SSE 帧里的 channelId @since v0.5.0 */
  const channel = info ? (info.channelId ?? '') : (state?.channelId ?? '');
  const isRealFeed = channel !== '';

  return (
    <section aria-label="观众端视图" className="flex h-full min-h-0 flex-col gap-2 rounded-lg bg-white p-4">
      <div className="flex shrink-0 items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">观众端 · 真实观看页</h3>
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              isRealFeed ? 'bg-success-50 text-success-800' : 'bg-gray-100 text-gray-500'
            }`}
          >
            {isRealFeed ? '真实频道' : '模拟观众端'}
          </span>
          <button
            type="button"
            onClick={() => setSwitching((v) => !v)}
            className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-50"
            title="运行时切换频道（不必重启后端）"
          >
            {switching ? '收起' : '换频道'}
          </button>
        </div>
      </div>

      {switching && (
        <ChannelSwitcher
          current={channel}
          onApplied={(v) => {
            setInfo(v);
            setSwitching(false);
          }}
        />
      )}

      <PlayerSlot
        channel={channel}
        online={state?.metrics.online ?? 0}
        currentProduct={state?.metrics.currentProduct ?? ''}
      />
      {isRealFeed && <p className="shrink-0 text-[10px] text-gray-400">频道 {channel}</p>}
      <ViewerFeed state={state} />
    </section>
  );
}
