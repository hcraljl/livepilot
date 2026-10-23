/**
 * ControlBar —— 直播控制条：客户端开播 / AI 演示推流 + 模拟数据 + 现场加戏 + 运行状态
 * 对应 A-09 前半；模式与阈值在 StrategyPanel
 *
 * v0.9.0：开播主路径改为**保利威客户端**
 *   点「客户端开播」→ 浏览器跳
 *     polyvlive://start?pdn=api.polyv.net&channelId=<频道号>&passwd=<频道开播密码>
 *   → 操作系统唤起本机直播伴侣，**直接进入该频道的开播界面**（免去在客户端里找频道）
 *   → 在客户端里选摄像头 / 麦克风 / 屏幕共享开播（保利威自己的工具，场景最丰富、最贴合生态）。
 *   地址里的 channelId / passwd 由后端 GET /api/broadcast/client 拼好下发（v0.9.1），
 *   前端不硬编码频道号，也不保存密码。
 *   唤起后本组件会持续回读官方 get-streams，频道一旦 live 就自动弹出观众端 ——
 *   所以「客户端开播」这件事在驾驶舱里也是可见、可追踪的，不是一次性的跳出。
 *
 * 两种开播方式的定位（别搞混）：
 *   客户端开播（primary）  → 真人在客户端播摄像头/麦克风，画面真实；适合正式演示与带货
 *   AI 演示推流（fallback） → 后端 ffmpeg 推合成画面，无人值守也能让频道有画面；适合彩排
 *   两者占同一个频道，不能同时推流（客户端在播时本服务的推流按钮会禁用）。
 *
 * 契约：GET /api/broadcast、GET /api/broadcast/client、POST /api/broadcast/start|stop（API.md §七）；
 *       POST /api/sim/start|stop、POST /api/sim/scenario（API.md v1.1）
 * 负责人：A · @since v0.2.0（v0.8.0 真实推流 / v0.9.0 客户端开播）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BroadcastStatus, LiveState } from '@livepilot/shared';
import { DEMO_SIM_PARAMS, SCENARIO_LABELS } from '../lib/constants';
import {
  fetchBroadcast,
  fetchClientLaunch,
  injectScenario,
  startBroadcast,
  startSim,
  stopBroadcast,
  stopSim,
} from '../lib/api';
import { formatClock } from '../lib/format';

const SCENARIOS = Object.keys(SCENARIO_LABELS);

/** 唤起客户端后最多等多久让频道变成 live（超时就不再追问，避免无意义轮询） */
const CLIENT_LIVE_TIMEOUT_MS = 3 * 60 * 1000;
/** 判定「客户端被唤起」的失焦观察窗口 */
const BLUR_WINDOW_MS = 2500;

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

  /** 已唤起客户端，正在等频道变成 live */
  const [clientPending, setClientPending] = useState(false);
  const pendingSince = useRef(0);
  /** 本次挂载内是否已经因「客户端开播」自动弹过观众端（避免反复弹） */
  const autoOpened = useRef(false);

  const running = state?.running === true;
  const bcActive = bc?.active === true;
  const bcStarting = bc?.phase === 'starting';
  const bcError = bc?.phase === 'error' ? bc.error : null;
  const externalLive = bc?.externalLive === true;

  /** 推流 / 客户端状态轮询：有动静时 3 秒一次，全空闲 10 秒一次 */
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
    const fast = bcActive || clientPending || externalLive;
    const id = setInterval(() => void tick(), fast ? 3000 : 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [bcActive, clientPending, externalLive]);

  /**
   * 客户端开播的落地检测：唤起客户端后，频道由客户端推流，
   * 官方 get-streams 会变成 live=true 而本服务 ffmpeg 依然 active=false。
   * 一旦观察到这个状态，就说明「人真的在客户端里开播了」。
   */
  useEffect(() => {
    if (!clientPending) return;

    if (externalLive && !autoOpened.current) {
      autoOpened.current = true;
      setClientPending(false);
      setHint(`客户端已开播（频道 ${bc?.channelId ?? ''}）—— 观众端现在能看到你的摄像头画面`);
      onLiveStarted?.();
      return;
    }

    if (Date.now() - pendingSince.current > CLIENT_LIVE_TIMEOUT_MS) {
      setClientPending(false);
      setHint('已等待 3 分钟仍未检测到频道开播。请在客户端里确认已点「开始直播」并选好摄像头/麦克风');
    }
  }, [clientPending, externalLive, bc?.channelId, onLiveStarted]);

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

  /**
   * 唤起保利威客户端开播。
   *
   * 技术要点：
   * 1. 自定义协议必须在**用户手势**的调用栈里触发，所以用 <a> 点击而不是 window.open；
   * 2. 浏览器无法查询「协议是否已注册」，只能靠页面失焦间接判断客户端窗口是否抢了焦点；
   *    但判定失败也不代表没装（有些系统不触发 blur），所以**无论是否失焦都继续轮询**，
   *    只是提示文案不同 —— 真的开播了照样能自动弹观众端。
   */
  const onLaunchClient = useCallback(async (): Promise<void> => {
    setBusy(true);
    setHint(null);
    autoOpened.current = false;

    try {
      const info = await fetchClientLaunch();

      let focusLeft = false;
      const markLeft = (): void => {
        focusLeft = true;
      };
      window.addEventListener('blur', markLeft);
      document.addEventListener('visibilitychange', markLeft);

      const a = document.createElement('a');
      a.href = info.scheme;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();

      // 顺手拉起虚拟观众数据：客户端只管推画面，驾驶舱的在线人数/GMV 还得有数据
      if (!running) void startSim(DEMO_SIM_PARAMS).catch(() => undefined);

      await new Promise((r) => setTimeout(r, BLUR_WINDOW_MS));
      window.removeEventListener('blur', markLeft);
      document.removeEventListener('visibilitychange', markLeft);

      pendingSince.current = Date.now();
      setClientPending(true);
      setHint(
        focusLeft
          ? `${info.hint}。开播后这里会自动变成「直播中」并弹出观众端`
          : // 提示里要脱敏：scheme 带 passwd，截图/录屏时不该把密码露出去
            `已发送唤起请求（${info.scheme.replace(/([?&]passwd=)[^&]*/, '$1***')}）。` +
              `如果客户端窗口没出现，通常是本机未安装保利威直播伴侣，或浏览器拦截了外部协议 —— ` +
              `可改用「AI 演示推流」。仍在后台等待频道开播…`,
      );
    } catch (e) {
      setHint(`唤起客户端失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [running]);

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
      setHint('已停止本机推流。若客户端还在播，请到客户端里停止');
    } catch (e) {
      setHint(`停止推流失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3">
      {/* ① 客户端开播（主路径）：唤起保利威直播伴侣，用真实摄像头/麦克风播 */}
      <button
        type="button"
        disabled={busy || bcActive}
        onClick={() => void onLaunchClient()}
        title={
          bcActive
            ? '本机 ffmpeg 正在推流，同一频道不能两个推流端 —— 请先「停止推流」'
            : '唤起本机保利威客户端并直接进入当前频道的开播界面（地址带频道号与开播密码），在客户端里用摄像头 / 麦克风 / 屏幕共享开播'
        }
        className="flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        <span className="text-[11px] leading-none">▶</span>
        {busy ? '唤起中…' : externalLive ? '重新唤起客户端' : '客户端开播'}
      </button>

      {/* ② 备用：后端 ffmpeg 推合成画面（无人值守 / 彩排用） */}
      {bcActive ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onStopLive()}
          className="flex items-center gap-1.5 rounded-md border border-danger-200 px-3 py-1.5 text-sm font-medium text-danger-700 hover:bg-danger-50 disabled:opacity-50"
        >
          <span className="text-[10px] leading-none">■</span>
          停止推流
        </button>
      ) : (
        <button
          type="button"
          disabled={busy || externalLive}
          onClick={() => void onStartLive()}
          title={
            externalLive
              ? '客户端正在推流，同一频道不能两个推流端'
              : '备用方案：后端 ffmpeg 推一路合成画面，无人值守也能让频道有画面'
          }
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        >
          AI 演示推流
        </button>
      )}

      {/* ③ 状态徽章 */}
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

      {/* 客户端 / 其他推流端在播：ffmpeg 没跑但频道确实 live */}
      {externalLive && (
        <span
          className="flex items-center gap-1.5 rounded-md bg-brand-50 px-2 py-1 text-xs font-medium text-brand-800"
          title="频道正在直播，但推流端不是本服务（典型情况：保利威客户端）"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
          直播中 · 客户端推流
          <span className="font-normal text-gray-500">频道 {bc?.channelId}</span>
        </span>
      )}

      {/* 已唤起客户端，等官方判定 */}
      {clientPending && !externalLive && (
        <span className="flex items-center gap-1.5 rounded-md bg-warn-50 px-2 py-1 text-xs font-medium text-warn-800">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn-500" />
          等待客户端开播…
          {bc?.channelId && <span className="font-normal text-gray-500">频道 {bc.channelId}</span>}
        </span>
      )}

      {bcError && !bcActive && <span className="text-xs text-danger-600">推流不可用：{bcError}</span>}

      <span className="mx-1 h-5 w-px bg-gray-200" />

      {/* ④ 模拟数据流（只跑虚拟观众，不推流） */}
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
        {hint && <span className="max-w-[420px] text-gray-600">{hint}</span>}
      </div>
    </section>
  );
}
