/**
 * ControlBar —— 直播控制条：真实开播 / 停止推流 + 模拟数据 + 现场加戏 + 运行状态
 * 对应 A-09 前半；模式与阈值在 StrategyPanel
 *
 * v0.8.0 新增「真实开播」：这是整个项目里唯一**真的把画面推到保利威频道**的按钮。
 *   真实开播（/api/broadcast）  → 取官方推流地址 + 本机 ffmpeg 推流 → 观众端真能看见画面
 *   模拟数据（/api/sim）        → 只跑虚拟观众，让看板的在线人数/GMV 曲线动起来
 * 两者独立：开播按钮默认顺手把模拟数据也拉起来（withSimulator），一键得到「有画面 + 有数据」。
 *
 * 契约：POST /api/broadcast/start|stop、GET /api/broadcast（API.md §七）；
 *       POST /api/sim/start|stop、POST /api/sim/scenario（API.md v1.1）
 * 负责人：A · @since v0.2.0（v0.8.0 接入真实开播）
 */
import { useEffect, useState } from 'react';
import type { BroadcastStatus, LiveState } from '@livepilot/shared';
import { DEMO_SIM_PARAMS, SCENARIO_LABELS } from '../lib/constants';
import { fetchBroadcast, injectScenario, startBroadcast, startSim, stopBroadcast, stopSim } from '../lib/api';
import { formatClock } from '../lib/format';

const SCENARIOS = Object.keys(SCENARIO_LABELS);

interface ControlBarProps {
  state: LiveState | null;
  /** 真实开播成功（官方判定 live）后回调：App 用来直接弹出观众端 */
  onLiveStarted?: () => void;
}

/** 秒 → mm:ss / hh:mm:ss */
const fmtSec = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
};

export function ControlBar({ state, onLiveStarted }: ControlBarProps) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [bc, setBc] = useState<BroadcastStatus | null>(null);
  const running = state?.running === true;

  /** 推流状态轮询：开播中 3 秒一次，空闲 10 秒一次（只为让按钮文字保持准确） */
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const s = await fetchBroadcast();
        if (!cancelled) setBc(s);
      } catch {
        /* 后端未起时静默：不打扰演播现场 */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), bc?.active ? 3000 : 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [bc?.active]);

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setHint(null);
    try {
      await fn();
      setHint(`${label}：已执行`);
    } catch (e) {
      setHint(`${label}失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onStartLive = async (): Promise<void> => {
    setBusy(true);
    setHint(null);
    try {
      const s = await startBroadcast({ withSimulator: true });
      setBc(s);
      if (s.phase === 'live') {
        setHint(`已真实开播（频道 ${s.channelId}），观众端现在能看到画面`);
        onLiveStarted?.();
      } else if (s.phase === 'error') {
        setHint(`开播失败：${s.error ?? '未知原因'}`);
      } else {
        setHint('推流已建立，等保利威判定直播中（通常 5~15 秒）…');
      }
    } catch (e) {
      setHint(`开播失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onStopLive = async (): Promise<void> => {
    setBusy(true);
    setHint(null);
    try {
      const s = await stopBroadcast();
      setBc(s);
      setHint('已停止推流，频道回落为未开播');
    } catch (e) {
      setHint(`停止推流失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const bcActive = bc?.active === true;
  const bcStarting = bc?.phase === 'starting';
  const bcError = bc?.phase === 'error' ? bc.error : null;

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3">
      {/* ① 真实开播：会真的把画面推到保利威频道 */}
      {!bcActive ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onStartLive()}
          title="取官方推流地址 + 本机 ffmpeg 推流，观众端真的能看见画面"
          className="flex items-center gap-1.5 rounded-md bg-success-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-success-800 disabled:opacity-50"
        >
          <span className="text-[10px] leading-none">●</span>
          {busy ? '开播中…' : '真实开播'}
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onStopLive()}
          className="flex items-center gap-1.5 rounded-md bg-danger-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-danger-800 disabled:opacity-50"
        >
          <span className="text-[10px] leading-none">■</span>
          停止推流
        </button>
      )}

      {/* ② 推流状态徽章 */}
      {bcActive && (
        <span
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${
            bcStarting ? 'bg-warn-50 text-warn-800' : 'bg-success-50 text-success-800'
          }`}
          title={bc.pushHost ? `推流地址主机：${bc.pushHost}（推流凭证不下发前端）` : undefined}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              bcStarting ? 'animate-pulse bg-warn-500' : 'animate-pulse bg-success-500'
            }`}
          />
          {bcStarting ? '推流启动中' : '直播中'}
          {bc.startedAt !== null && <span className="font-normal tabular-nums">{fmtSec(bc.uptimeSec)}</span>}
          <span className="font-normal text-gray-500">{bc.profile}</span>
          {bc.channelLive === false && !bcStarting && <span className="font-normal text-warn-800">· 官方判定中</span>}
        </span>
      )}
      {bcError && !bcActive && <span className="text-xs text-danger-600">推流不可用：{bcError}</span>}

      <span className="mx-1 h-5 w-px bg-gray-200" />

      {/* ③ 模拟数据流（原「开始/停止直播」按钮，语义收窄为只跑虚拟观众） */}
      {!running ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => run('开始跑模拟数据', () => startSim(DEMO_SIM_PARAMS))}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          title="只启动虚拟观众数据（在线人数 / GMV / 弹幕曲线），不推流"
        >
          跑模拟数据
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => run('停止模拟数据', stopSim)}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          停止模拟数据
        </button>
      )}

      <span className="mx-1 h-5 w-px bg-gray-200" />

      <span className="text-xs text-gray-500">现场加戏：</span>
      {SCENARIOS.map((name) => (
        <button
          key={name}
          type="button"
          disabled={busy || !running}
          title={running ? `注入「${SCENARIO_LABELS[name]}」场景` : '需先开始直播'}
          onClick={() => run(`加戏「${SCENARIO_LABELS[name]}」`, () => injectScenario(name))}
          className="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        >
          {SCENARIO_LABELS[name]}
        </button>
      ))}

      <div className="ml-auto flex items-center gap-3 text-xs text-gray-500">
        {state && (
          <>
            <span>
              已播 <b className="font-medium text-gray-800">{formatClock(state.metrics.elapsedMin)}</b> / {state.metrics.totalMin} 分钟
            </span>
            <span className="rounded bg-gray-100 px-2 py-0.5">
              {state.scenario ? `场景：${SCENARIO_LABELS[state.scenario] ?? state.scenario}` : '无注入场景'}
            </span>
          </>
        )}
        {hint && <span className="text-gray-600">{hint}</span>}
      </div>
    </section>
  );
}
