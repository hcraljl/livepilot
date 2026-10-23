/**
 * WatchEmbed —— 右屏：观众端视图
 *
 * 两种形态（按 LiveState.source 自动切换）：
 *  1. source === 'polyv'  → 嵌入 B 提供的官方观看 SDK 页（frontend/watch/index.html）
 *  2. source === 'simulator'（演示主模式）→ 渲染「模拟观众端」：画面占位 + 在线人数
 *     + AI 互动在观众侧的呈现（抽奖 / 答题卡 / 公告 / 商品推送 / 优惠券）
 *
 * 为什么模拟模式必须渲染内容（v0.4.0 修复）：
 * 分屏演示时右屏若只是一段说明文字，等于浪费半屏；而产品故事恰恰是
 * 「左屏 AI 决策 → 右屏观众立刻看到互动」，所以模拟态也要把观众视角画出来。
 *
 * 契约：LiveState.source / channelId / decisions / metrics（shared/types.ts v2）
 * 负责人：A · @since v0.2.0（A-12；v0.3.0 改嵌官方 SDK 观看页；v0.4.0 补模拟观众端）
 */
import type { Decision, LiveState } from '@livepilot/shared';
import { ACTION_LABELS } from '../lib/constants';
import { formatInt } from '../lib/format';

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
  coupon: 'border-danger-200 bg-danger-50',
};

/** 观众端只关心「已经发生」的互动（建议态观众看不到） @since v0.4.0 */
const visible = (d: Decision): boolean => d.status === 'executed';

function SimViewer({ state }: { state: LiveState | null }) {
  const decisions = (state?.decisions ?? []).filter(visible).slice(-8).reverse();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 直播画面占位：告诉观众"这是直播间"，不是后台 */}
      <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-md bg-gradient-to-br from-gray-800 to-gray-900">
        <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded bg-danger-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-white" />
          直播中
        </div>
        {state && (
          <div className="absolute right-2 top-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
            {formatInt(state.metrics.online)} 人在线
          </div>
        )}
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
          <p className="text-xs font-medium text-white/90">模拟直播画面</p>
          <p className="px-4 text-[10px] leading-relaxed text-white/50">
            {state?.metrics.currentProduct
              ? `正在讲解：${state.metrics.currentProduct}`
              : '接入真实账号后此处为保利威播放器'}
          </p>
        </div>
      </div>

      {/* 观众侧互动流：AI 发起的动作在观众眼里长什么样 */}
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
                  <p className="mt-0.5 text-[10px] text-gray-400">
                    {d.result.mock ? '模拟下发' : '真实下发'}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface WatchEmbedProps {
  state: LiveState | null;
}

export function WatchEmbed({ state }: WatchEmbedProps) {
  const isReal = state?.source === 'polyv';
  const channelId = state?.channelId ?? '';
  const embeddable = isReal && channelId.length > 0;

  return (
    <section aria-label="观众端视图" className="flex h-full min-h-0 flex-col rounded-lg bg-white p-4">
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">观众端 · 真实观看页</h3>
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] ${
            isReal ? 'bg-success-50 text-success-800' : 'bg-gray-100 text-gray-500'
          }`}
        >
          {isReal ? '真实账号' : '模拟观众端'}
        </span>
      </div>

      {embeddable ? (
        <iframe
          title="保利威直播观看页（官方观看 SDK）"
          src={`${WATCH_PAGE}?channelId=${encodeURIComponent(channelId)}`}
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-forms"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 rounded border border-gray-100"
        />
      ) : (
        <SimViewer state={state} />
      )}
    </section>
  );
}
