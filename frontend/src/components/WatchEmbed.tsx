/**
 * WatchEmbed —— 右屏：保利威真实观看页嵌入（iframe + sandbox）
 * 模拟模式下显示占位说明卡，不白屏；真实模式（source=polyv）嵌入 B 提供的
 * 官方观看 SDK 演示页（frontend/watch/index.html，vite 同源服务）。
 * 契约：LiveState.source / channelId（shared/types.ts v2）
 * 负责人：A · @since v0.2.0（A-12；v0.3.0 改嵌本地官方 SDK 观看页）
 */
import type { LiveState } from '@livepilot/shared';

/** 本地官方观看 SDK 演示页（B 提供，见 frontend/watch/index.html） @since v0.3.0 */
const WATCH_PAGE = '/watch/index.html';

interface WatchEmbedProps {
  state: LiveState | null;
}

export function WatchEmbed({ state }: WatchEmbedProps) {
  const isReal = state?.source === 'polyv';
  const channelId = state?.channelId ?? '';
  const embeddable = isReal && channelId.length > 0;

  return (
    <section aria-label="真实观看页" className="flex h-full flex-col rounded-lg bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">观众端 · 真实观看页</h3>
        <span className={`rounded px-1.5 py-0.5 text-[11px] ${isReal ? 'bg-success-50 text-success-800' : 'bg-gray-100 text-gray-500'}`}>
          {isReal ? '真实账号' : '模拟模式'}
        </span>
      </div>

      {embeddable ? (
        <iframe
          title="保利威直播观看页（官方观看 SDK）"
          src={`${WATCH_PAGE}?channelId=${encodeURIComponent(channelId)}`}
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-forms"
          referrerPolicy="no-referrer"
          className="min-h-0 flex-1 w-full rounded border border-gray-100"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded border border-dashed border-gray-200 p-6 text-center">
          <p className="text-xs text-gray-500">
            当前为模拟模式，右屏为占位。
            <br />
            接入真实 Polyv 账号后（后端 `USE_REAL_POLYV=true` + 密钥），
            <br />
            这里将嵌入官方观看 SDK 页（<code className="rounded bg-gray-100 px-1">/watch/index.html</code>），
            <br />
            AI 发起的抽奖 / 答题卡 / 公告将实时出现在观众端。
          </p>
        </div>
      )}
    </section>
  );
}
