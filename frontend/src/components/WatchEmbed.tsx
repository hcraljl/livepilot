/**
 * WatchEmbed —— 右屏：保利威真实观看页（官方开源观看 SDK）
 *
 * 关键改动（v0.4.0，B）：
 * 1. 只要有频道号就嵌真实观看页，不再用「当前为模拟模式，右屏为占位」的空卡；
 *    模拟/真实只影响「AI 动作有没有真打频道」，不影响能不能看直播。
 * 2. 没有频道号时给出输入框，现场直接填 channelId 即可立刻拉流（走 /api/polyv/channel，
 *    后端运行时生效，不用改 .env 重启）。
 * 3. 内嵌页为官方开源观看页（gitee: polyv_ef/polyv-web-live-watch-sdk），
 *    播放器 / 聊天室 / 互动接收端（抽奖、答题卡、签到、卡片、公告）都由它渲染。
 *
 * 契约：LiveState.channelId / LiveState.source（shared/types.ts）
 */
import { useEffect, useState } from 'react';
import type { LiveState } from '@livepilot/shared';
import { fetchPolyvChannel, setPolyvChannel } from '../lib/api';

/** 官方开源观看页（后端托管于 /watch/） */
const WATCH_PAGE = '/watch/index.html';

interface WatchEmbedProps {
  state: LiveState | null;
}

export function WatchEmbed({ state }: WatchEmbedProps) {
  const isReal = state?.source === 'polyv';

  const [draft, setDraft] = useState('');
  /** 挂载时先拉一次频道号：SSE 首帧到达前也能立刻渲染观看页，不闪空态 */
  const [channelHint, setChannelHint] = useState('');
  const [channelSource, setChannelSource] = useState<'env' | 'runtime' | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** iframe 加载中提示，避免一片空白让人以为坏了 */
  const [frameLoaded, setFrameLoaded] = useState(false);

  const channelId = state?.channelId ?? channelHint;

  useEffect(() => {
    setFrameLoaded(false);
  }, [channelId]);

  useEffect(() => {
    let alive = true;
    fetchPolyvChannel()
      .then((info) => {
        if (!alive) return;
        setChannelSource(info.source);
        setChannelHint(info.channelId ?? '');
      })
      .catch(() => {
        /* 频道信息拿不到不影响观看页本身，静默 */
      });
    return () => {
      alive = false;
    };
  }, [channelId]);

  const apply = async (): Promise<void> => {
    const id = draft.trim();
    if (!id) {
      setErr('请输入频道号（保利威后台「频道管理」里的频道号）');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const info = await setPolyvChannel(id);
      setDraft('');
      setChannelSource('runtime');
      // 不等 SSE 下一帧，立刻切过去
      setChannelHint(info.channelId ?? id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '设置失败');
    } finally {
      setBusy(false);
    }
  };

  const watchUrl = channelId ? `${WATCH_PAGE}?channelId=${encodeURIComponent(channelId)}` : '';

  return (
    <section aria-label="真实观看页" className="flex h-full flex-col rounded-lg bg-white p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-gray-700">观众端 · 真实观看页</h3>
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              isReal ? 'bg-success-50 text-success-800' : 'bg-gray-100 text-gray-500'
            }`}
            title="真实 = AI 动作真的打到了保利威频道；模拟 = 只产生模拟回执"
          >
            {isReal ? '互动真实下发' : '互动模拟'}
          </span>
          {channelId && (
            <a
              href={watchUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-50"
              title="在新窗口打开观看页"
            >
              新窗口
            </a>
          )}
        </div>
      </div>

      {channelId ? (
        <div className="relative min-h-0 flex-1">
          <iframe
            key={channelId}
            title="保利威直播观看页（官方观看 SDK）"
            src={watchUrl}
            onLoad={() => setFrameLoaded(true)}
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-forms"
            referrerPolicy="no-referrer"
            allow="autoplay; fullscreen; picture-in-picture"
            className="h-full w-full rounded border border-gray-100"
          />
          {!frameLoaded && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-400">
              正在加载官方观看页…
            </div>
          )}
          <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
            频道 {channelId}
            {channelSource === 'runtime' ? ' · 运行时指定' : channelSource === 'env' ? ' · 来自 .env' : ''}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded border border-dashed border-gray-200 p-5 text-center">
          <p className="text-xs font-medium text-gray-600">还没有配置频道号</p>
          <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
            填入保利威频道号即可在此直接打开官方观看页
            <br />
            （播放器 / 聊天 / 抽奖 / 答题卡 / 公告 都由观看 SDK 渲染）
          </p>
          <div className="mt-3 flex w-full max-w-[240px] items-center gap-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void apply();
              }}
              placeholder="如 1234568"
              className="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-xs outline-none focus:border-brand-400"
            />
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy}
              className="shrink-0 rounded bg-brand-600 px-2.5 py-1 text-xs text-white disabled:opacity-50"
            >
              {busy ? '…' : '打开'}
            </button>
          </div>
          {err && <p className="mt-2 text-[11px] text-danger-600">{err}</p>}
        </div>
      )}
    </section>
  );
}
