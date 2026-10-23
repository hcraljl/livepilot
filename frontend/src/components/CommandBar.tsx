/**
 * CommandBar —— 指挥台：运营说一句，AI 解析并执行（人机协作主入口）
 *
 * 为什么要它：现在的"AI 运营"都是模型自己跑，运营只能事后看。
 * 但真实工作里最常见的是「人拍板，AI 执行」——嘴上说一句"5 分钟后发个签到"，
 * 剩下的时间计算、参数拼装、接口签发、到点下发都该由 AI 代劳。
 *
 * 交互链路：
 *   输入一句话 → POST /api/commands → AI 复述理解（"我理解为…"）
 *     ├ kind=executed  → 立即下发，回执带真实/模拟标记
 *     ├ kind=scheduled → 进待执行队列，显示倒计时，可取消
 *     └ kind=rejected  → 老实说没听懂，给出可用说法
 *   队列每 3 秒轮询一次（到点执行是后端定时器，前端只负责展示）。
 *
 * 契约：POST/GET/DELETE /api/commands（API.md §六）
 * 负责人：B · @since v0.7.0
 */
import { useCallback, useEffect, useState } from 'react';
import type { LiveState } from '@livepilot/shared';
import { cancelCommand, fetchCommands, sendCommand, type ScheduledCommandInfo, type SendCommandResult } from '../lib/api';

/** 一句话示例（点一下就填进输入框并发送，演示时不用打字） */
const EXAMPLES: string[] = [
  '5 分钟后发一个签到',
  '立刻发福利抽奖',
  '在线跌破 1000 就发抽奖',
  '2 分钟后推一下答题卡',
];

function countdown(dueAt: number, now: number): string {
  const left = Math.max(0, dueAt - now);
  const s = Math.round(left / 1000);
  if (s <= 0) return '即将执行';
  if (s < 60) return `${s} 秒后`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒后`;
}

const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

const STATUS_TONE: Record<string, string> = {
  pending: 'border-brand-200 bg-brand-50 text-brand-800',
  running: 'border-brand-200 bg-brand-50 text-brand-800',
  done: 'border-success-200 bg-success-50 text-success-800',
  failed: 'border-danger-200 bg-danger-50 text-danger-700',
  cancelled: 'border-gray-200 bg-gray-50 text-gray-500',
  expired: 'border-gray-200 bg-gray-50 text-gray-500',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  expired: '条件未命中',
};

interface CommandBarProps {
  state: LiveState | null;
}

export function CommandBar({ state }: CommandBarProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<SendCommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<ScheduledCommandInfo[]>([]);
  const [now, setNow] = useState(() => Date.now());

  /** 倒计时每秒刷新（只在本地算，不请求后端） */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchCommands();
      setCommands(res.commands);
    } catch {
      /* 后端未起/断连时静默：不打扰主看板 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const submit = async (raw?: string): Promise<void> => {
    const input = (raw ?? text).trim();
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    setReply(null);
    try {
      const result = await sendCommand(input);
      setReply(result);
      setText('');
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pending = commands.filter((c) => c.status === 'pending');
  const recent = commands.filter((c) => c.status !== 'pending').slice(0, 3);
  const online = state?.metrics.online ?? 0;

  return (
    <section aria-label="指挥台" className="rounded-lg bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-gray-700">指挥台 · 说一句就执行</h3>
        <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-800">人机协作</span>
        <span className="text-[11px] text-gray-400">
          运营负责判断和说，AI 负责算时间、拼参数、到点打接口
        </span>
        <span className="ml-auto text-[11px] text-gray-400">
          当前在线 <b className="font-medium text-gray-600">{online.toLocaleString('zh-CN')}</b>
          {state?.running ? ' · 直播中' : ' · 未开播'}
        </span>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="说一句话，例如：5 分钟后发一个签到 / 在线跌破 1000 就发抽奖"
          className="min-w-0 flex-1 rounded-md border border-gray-200 px-3 py-2 text-xs text-gray-800 placeholder:text-gray-400 focus:border-brand-400 focus:outline-none"
          aria-label="指令输入"
        />
        <button
          type="submit"
          disabled={busy || text.trim() === ''}
          className="shrink-0 rounded-md bg-brand-600 px-4 py-2 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-40"
        >
          {busy ? '解析中…' : '发送'}
        </button>
      </form>

      {/* 示例：演示时点一下即可，不用现场打字 */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-gray-400">试试：</span>
        {EXAMPLES.map((sample) => (
          <button
            key={sample}
            type="button"
            disabled={busy}
            onClick={() => void submit(sample)}
            className="rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500 hover:border-brand-200 hover:bg-brand-50 hover:text-brand-800 disabled:opacity-40"
          >
            {sample}
          </button>
        ))}
      </div>

      {error && <p className="mt-2 rounded bg-danger-50 px-2 py-1 text-[11px] text-danger-700">{error}</p>}

      {/* AI 回执：先复述理解，再报结果——这一步是"协作感"的关键 */}
      {reply && (
        <div className="mt-3 rounded-md border border-brand-100 bg-brand-50/60 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-brand-800">
              {reply.parsed.source === 'llm' ? 'DeepSeek 解析' : '规则解析'}
            </span>
            {reply.parsed.action && (
              <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-gray-600">
                动作：{reply.parsed.actionLabel}
              </span>
            )}
            {reply.parsed.condition && (
              <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-gray-600">
                条件：{reply.parsed.condition.label}
              </span>
            )}
            {!reply.parsed.condition && reply.parsed.delaySec > 0 && (
              <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-gray-600">
                时间：{clock(reply.parsed.dueAt ?? Date.now())}
              </span>
            )}
            <span className="ml-auto text-[10px] text-gray-400">
              置信度 {(reply.parsed.confidence * 100).toFixed(0)}%
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-gray-700">{reply.parsed.note}</p>
          <p className="mt-1 text-[11px]">
            {reply.kind === 'executed' && (
              <span className={reply.result.ok ? 'text-success-800' : 'text-danger-700'}>
                {reply.result.ok ? '✓ 已下发' : '✗ 下发失败'}（{reply.result.mock ? '模拟' : '真实'}）·{' '}
                {reply.result.message}
              </span>
            )}
            {reply.kind === 'scheduled' && (
              <span className="text-brand-800">
                ✓ 已排程，{reply.command.condition ? '等条件命中即执行' : `${clock(reply.command.dueAt)} 自动执行`}
              </span>
            )}
            {reply.kind === 'rejected' && <span className="text-warn-800">没有执行：这句话里没有我能落地的动作</span>}
          </p>
        </div>
      )}

      {/* 待执行队列 */}
      {(pending.length > 0 || recent.length > 0) && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-medium text-gray-500">
            指令队列{pending.length > 0 ? `（待执行 ${pending.length}）` : ''}
          </p>
          <ul className="flex flex-col gap-1">
            {[...pending, ...recent].map((cmd) => (
              <li
                key={cmd.id}
                className={`flex flex-wrap items-center gap-2 rounded border px-2.5 py-1.5 text-[11px] ${STATUS_TONE[cmd.status] ?? 'border-gray-200 bg-gray-50 text-gray-600'}`}
              >
                <span className="font-medium">{STATUS_LABEL[cmd.status] ?? cmd.status}</span>
                <span className="text-gray-700">{cmd.actionLabel}</span>
                <span className="text-gray-400">
                  {cmd.condition
                    ? `等到「${cmd.condition.label}」`
                    : clock(cmd.dueAt)}
                </span>
                {cmd.status === 'pending' && (
                  <span className="text-brand-800">{countdown(cmd.dueAt, now)}</span>
                )}
                <span className="max-w-[280px] truncate text-gray-400" title={cmd.text}>
                  「{cmd.text}」
                </span>
                {cmd.resultMessage && <span className="text-gray-400">{cmd.resultMessage}</span>}
                {cmd.status === 'pending' && (
                  <button
                    type="button"
                    onClick={() => void cancelCommand(cmd.id).then(refresh).catch(() => undefined)}
                    className="ml-auto rounded border border-gray-300 bg-white px-1.5 py-0.5 text-gray-500 hover:bg-gray-50"
                  >
                    取消
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
