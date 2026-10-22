/**
 * ControlBar —— 直播控制条：开始/停止模拟 + 现场加戏 + 运行状态
 * 对应 A-09 前半；模式与阈值在 StrategyPanel
 * 契约：POST /api/sim/start|stop、POST /api/sim/scenario（API.md v1.1）
 * 负责人：A · @since v0.2.0
 */
import { useState } from 'react';
import type { LiveState } from '@livepilot/shared';
import { DEMO_SIM_PARAMS, SCENARIO_LABELS } from '../lib/constants';
import { injectScenario, startSim, stopSim } from '../lib/api';
import { formatClock } from '../lib/format';

const SCENARIOS = Object.keys(SCENARIO_LABELS);

interface ControlBarProps {
  state: LiveState | null;
}

export function ControlBar({ state }: ControlBarProps) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const running = state?.running === true;

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

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3">
      {!running ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => run('开始直播（模拟）', () => startSim(DEMO_SIM_PARAMS))}
          className="rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
        >
          开始直播（模拟）
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => run('停止直播', stopSim)}
          className="rounded-md bg-danger-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-danger-800 disabled:opacity-50"
        >
          停止直播
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
