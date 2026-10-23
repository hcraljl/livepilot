/**
 * ClientLaunchDialog —— 「唤起保利威客户端开播」对话框 @since v0.9.2
 *
 * 为什么要有这个对话框（而不是点一下按钮就默默跳转）：
 *   唤起本机客户端是一次**离开浏览器的动作**——中间隔着操作系统协议注册表、浏览器外部协议
 *   确认框、客户端自身的登录与设备选择，任何一环没成用户看到的都是「什么都没发生」。
 *   所以这里把整件事摊开：事前说清要点哪个按钮，事中给出倒计时与进度，事后区分
 *   「已开播 / 没拉起来 / 拉起来了但没点开播」三种结果并各自给出下一步。
 *
 * 状态机（由 ControlBar 驱动，本组件只负责呈现）：
 *   idle      等待确认 —— 展示频道、scheme 摘要与三步流程，用户点确认才真的跳转
 *   launching 已发出唤起请求 —— 2.5 秒失焦观察窗口内判定客户端窗口是否抢到焦点
 *   waiting   后台等待频道转 live —— 每秒倒计时（默认 3 分钟），关闭对话框不中断等待
 *   live      已在播 —— 展示成功卡片，1.5 秒后自动关闭并弹出观众端
 *   timeout   超时未转 live —— 给出排查步骤与两条退路（重试 / 改用 AI 演示推流）
 *   error     取唤起地址失败 —— 通常是后端未启动
 *
 * 交互约定（与 WatchEmbed 弹层保持一致 @since v0.6.0）：
 *   - createPortal 到 body，避免被上层 overflow 裁切；
 *   - 点遮罩 / 点关闭 / 按 Esc 均可关闭，打开期间锁背景滚动（v0.6.1 约定）；
 *   - launching 阶段不允许关闭，避免用户误以为被卡住而反复点击；
 *   - 关闭**不等于取消等待**：waiting/timeout 关闭后 ControlBar 仍在轮询，
 *     频道转 live 时照样会弹观众端（这点在对话框里明确写出来）。
 *
 * 密码边界 @since v0.9.1：scheme 里带频道开播密码，界面上出现的任何 scheme 摘要
 * 都必须先过 maskScheme 脱敏，截图/录屏不能泄露 passwd。
 *
 * 契约：GET /api/broadcast/client 返回的 ClientLaunchInfo（API.md §7.1）
 * 负责人：A · @since v0.9.2
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ClientLaunchInfo } from '@livepilot/shared';
import { formatSec } from '../lib/format';

/** 唤起流程的阶段（状态机的取值集合） @since v0.9.2 */
export type ClientLaunchPhase = 'idle' | 'launching' | 'waiting' | 'live' | 'timeout' | 'error';

/**
 * 把 scheme 里的 passwd 参数打码 @since v0.9.1
 *
 * 唤起地址必须带开播密码客户端才能直达该频道的开播界面，但这串密码出现在 DOM 里就会被
 * 截图带走。凡是展示用的地方都走这里：`passwd=xxx` → `passwd=***`。
 */
export const maskScheme = (scheme: string): string => scheme.replace(/([?&]passwd=)[^&]*/, '$1***');

interface ClientLaunchDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 当前阶段 */
  phase: ClientLaunchPhase;
  /** 后端下发的唤起信息；尚未取到时为 null */
  info: ClientLaunchInfo | null;
  /** /api/broadcast 最近一次返回的频道号：info 还没到时用它顶上展示 */
  channelId: string;
  /** 各阶段的一句话说明（由 ControlBar 生成，含可执行的下一步） */
  message: string | null;
  /** waiting 阶段剩余秒数（每秒递减） */
  remainingSec: number;
  /** waiting 阶段总时长（秒），用于画进度条；与 ControlBar 的超时阈值同源 */
  totalSec: number;
  /** 关闭对话框（不中断后台等待） */
  onClose: () => void;
  /** 点「打开保利威客户端」：真正触发 scheme 跳转 */
  onLaunch: () => void;
  /** 超时后重试唤起 */
  onRetry: () => void;
  /** 客户端路径走不通时的退路：后端 ffmpeg 推合成画面 */
  onUseFallback: () => void;
}

/** 阶段 → 头部徽章配色 @since v0.9.2 */
const PHASE_TONE: Record<ClientLaunchPhase, string> = {
  idle: 'bg-brand-50 text-brand-800',
  launching: 'bg-brand-50 text-brand-800',
  waiting: 'bg-warn-50 text-warn-800',
  live: 'bg-success-50 text-success-800',
  timeout: 'bg-warn-50 text-warn-800',
  error: 'bg-danger-50 text-danger-800',
};

const PHASE_LABEL: Record<ClientLaunchPhase, string> = {
  idle: '待确认',
  launching: '唤起中',
  waiting: '等待开播',
  live: '直播中',
  timeout: '唤起超时',
  error: '唤起失败',
};

/** 「等待 observed 时长」的进度条（0~1） @since v0.9.2 */
const ProgressBar = ({ ratio }: { ratio: number }) => (
  <div className="h-1 w-full overflow-hidden rounded-full bg-gray-100">
    <div
      className="h-full rounded-full bg-brand-500 transition-[width] duration-1000 ease-linear"
      style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
    />
  </div>
);

/** 旋转指示器（与控制条/官方页加载态同一套写法） @since v0.9.2 */
const Spinner = ({ tone = 'border-brand-500 border-t-white/80' }: { tone?: string }) => (
  <span className={`h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 ${tone}`} />
);

export function ClientLaunchDialog({
  open,
  phase,
  info,
  channelId,
  message,
  remainingSec,
  totalSec,
  onClose,
  onLaunch,
  onRetry,
  onUseFallback,
}: ClientLaunchDialogProps) {
  /**
   * Esc 关闭 + 打开期间锁背景滚动（沿用 WatchEmbed v0.6.1）。
   * launching 阶段例外：这一阶段只有 2.5 秒，允许关闭反而会让人以为失败可选，这里禁止。
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (phase === 'launching') return;
      onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, phase, onClose]);

  if (!open) return null;

  const busy = phase === 'launching';
  const shownChannel = info?.channelId ?? channelId;

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-gray-900/60 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="唤起保利威客户端开播"
      // launching 阶段屏蔽遮罩点击：这一屏是短暂的中间态，点了也只会让人不确定刚才发生了什么
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="flex max-h-[92vh] w-[min(560px,96vw)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹层头 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 px-4 py-2.5">
          <h3 className="text-sm font-medium text-gray-700">唤起保利威客户端开播</h3>
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${PHASE_TONE[phase]}`}>{PHASE_LABEL[phase]}</span>
          {shownChannel !== '' && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">频道 {shownChannel}</span>
          )}
          {info?.withPasswd === true && (
            <span
              className="rounded bg-success-50 px-1.5 py-0.5 text-[11px] text-success-800"
              title="唤起地址已带上该频道的开播密码，客户端会直接进入这个频道的开播界面（密码不会在此显示）"
            >
              已带开播密码
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="ml-auto rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-50 disabled:opacity-40"
            aria-label="关闭对话框"
          >
            关闭 ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* ① 待确认：把「点下去会发生什么」讲清楚再动手 */}
          {phase === 'idle' && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-gray-600">
                LivePilot 会把播放画面交给<b className="font-medium text-gray-800">保利威直播伴侣</b>（本机客户端）去推：
                摄像头、麦克风、屏幕共享、多场景切换都是客户端的原生能力，比后端合成的演示画面更贴近真实带货场景。
              </p>
              <ol className="space-y-1.5 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
                <li>
                  <b className="font-medium">1.</b> 点下方按钮 → 浏览器会问是否允许打开外部应用，选「打开」
                </li>
                <li>
                  <b className="font-medium">2.</b> 客户端自动进入当前频道的开播界面 → 选摄像头/麦克风 → 点「开始直播」
                </li>
                <li>
                  <b className="font-medium">3.</b> 频道转直播后，驾驶舱自动变「直播中 · 客户端推流」并弹出观众端
                </li>
              </ol>
              {info === null ? (
                <p className="flex items-center gap-1.5 text-xs text-gray-500">
                  <Spinner tone="border-gray-300 border-t-gray-500" />
                  正在向后端取唤起地址…
                </p>
              ) : (
                <div className="rounded-md border border-gray-200 px-2.5 py-2">
                  <p className="text-[11px] text-gray-500">唤起地址（密码已脱敏）</p>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-gray-700">{maskScheme(info.scheme)}</p>
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-gray-400">
                前置条件：本机已安装保利威直播伴侣。未安装时不会有窗口弹出，可改用控制条里的「AI 演示推流」。
              </p>
            </div>
          )}

          {/* ② 唤起中：短暂中间态，说清楚正在做什么 */}
          {phase === 'launching' && (
            <div className="flex items-start gap-2.5 rounded-md border border-brand-200 bg-brand-50 p-3">
              <Spinner />
              <div className="text-xs leading-relaxed text-brand-800">
                <p className="font-medium">已向操作系统发出唤起请求…</p>
                <p className="mt-1 text-[11px] text-brand-700">
                  若浏览器弹出「是否允许打开外部应用」的提示，请选择「打开」。
                </p>
              </div>
            </div>
          )}

          {/* ③ 等待开播：倒计时 + 进度 + 明确说明「关掉也不中断」 */}
          {phase === 'waiting' && (
            <div className="space-y-3">
              <div className="flex items-start gap-2.5 rounded-md border border-warn-200 bg-warn-50 p-3">
                <Spinner tone="border-warn-300 border-t-warn-600" />
                <div className="min-w-0 flex-1 text-xs leading-relaxed text-warn-800">
                  <p className="font-medium">
                    等待客户端推流… 剩余 <b className="tabular-nums">{formatSec(remainingSec)}</b>
                  </p>
                  <p className="mt-1 text-[11px] text-warn-700">
                    客户端里点「开始直播」后，这里会自动变成「直播中」并弹出观众端，不需要手动刷新。
                  </p>
                </div>
              </div>
              <ProgressBar ratio={remainingSec <= 0 ? 1 : 1 - remainingSec / totalSec} />
              <ol className="space-y-1 text-[11px] leading-relaxed text-gray-500">
                <li>· 客户端还没起来？确认已安装保利威直播伴侣，且浏览器允许了外部协议。</li>
                <li>· 客户端起来了但没画面？在客户端里选好摄像头/麦克风，点界面上的「开始直播」。</li>
                <li>· 关掉这个对话框不会中断等待 —— 控制条上的徽章会继续跟进。</li>
              </ol>
            </div>
          )}

          {/* ④ 已在播：给一句确认，随后自动关闭并弹观众端 */}
          {phase === 'live' && (
            <div className="flex items-start gap-2.5 rounded-md border border-success-200 bg-success-50 p-3">
              <span className="mt-0.5 text-xs font-medium text-success-700">✓</span>
              <div className="text-xs leading-relaxed text-success-800">
                <p className="font-medium">客户端已开播，观众端现在能看到你的画面</p>
                <p className="mt-1 text-[11px] text-success-700">正在打开观众端…</p>
              </div>
            </div>
          )}

          {/* ⑤ 超时：区分「没拉起来」与「拉起来但没点开播」，各给退路 */}
          {phase === 'timeout' && (
            <div className="space-y-2.5">
              <div className="rounded-md border border-warn-200 bg-warn-50 p-3 text-xs leading-relaxed text-warn-800">
                <p className="font-medium">3 分钟内没检测到频道转直播</p>
                <ul className="mt-1.5 space-y-1 text-[11px] text-warn-700">
                  <li>· 客户端没窗口弹出 → 本机多半未安装保利威直播伴侣，或浏览器拦截了外部协议</li>
                  <li>· 有窗口但没推流 → 记得在客户端里点「开始直播」，并确认选对了摄像头/麦克风</li>
                </ul>
              </div>
              <p className="text-[11px] text-gray-500">
                赶时间可以直接用「AI 演示推流」：后端 ffmpeg 推一路合成画面，无人值守也能让频道有画面。
              </p>
            </div>
          )}

          {/* ⑥ 取地址失败：绝大多数是后端没起 */}
          {phase === 'error' && (
            <div className="rounded-md border border-danger-200 bg-danger-50 p-3 text-xs leading-relaxed text-danger-800">
              <p className="font-medium">取唤起地址失败</p>
              <p className="mt-1 text-[11px] text-danger-700">
                通常是后端没起来（GET /api/broadcast/client 不通）。启动后端后重试即可。
              </p>
            </div>
          )}

          {/* 兜底：把 ControlBar 给出的可执行结论展示出来 */}
          {message !== null && message !== '' && phase !== 'idle' && (
            <p className="mt-2.5 break-words text-[11px] leading-relaxed text-gray-500">{message}</p>
          )}
        </div>

        {/* 底部操作：按阶段变化，任何时候都给出「下一步是什么」 */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-100 px-4 py-2.5">
          {phase === 'idle' && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={info === null}
                onClick={onLaunch}
                title={info === null ? '唤起地址尚未取到' : '唤起本机保利威客户端，并直接进入当前频道的开播界面'}
                className="flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                <span className="text-[10px] leading-none">▶</span>
                打开保利威客户端
              </button>
            </>
          )}

          {phase === 'waiting' && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              收起（后台继续等待）
            </button>
          )}

          {phase === 'timeout' && (
            <>
              <button
                type="button"
                onClick={onUseFallback}
                className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                title="后端 ffmpeg 推合成画面：无人值守也能让频道有画面"
              >
                改用 AI 演示推流
              </button>
              <button
                type="button"
                onClick={onRetry}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                重新唤起客户端
              </button>
            </>
          )}

          {phase === 'error' && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={onRetry}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                重试
              </button>
            </>
          )}

          {(phase === 'launching' || phase === 'live') && (
            <span className="text-[11px] text-gray-400">{phase === 'live' ? '正在打开观众端…' : '唤起中，请稍候…'}</span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
