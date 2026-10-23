/**
 * ControlBar —— 直播控制条：客户端开播 / AI 演示推流 + 模拟数据 + 现场加戏 + 运行状态
 * 对应 A-09 前半；模式与阈值在 StrategyPanel
 *
 * v0.9.0：开播主路径改为**保利威客户端**
 *   点「客户端开播」→ 确认对话框 → 浏览器跳
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
 * v0.9.2：唤起流程从「点按钮直接跳」升级为**带对话框的四步交互**——
 *   确认（讲清楚会发生什么）→ 唤起（手势内跳转 + 失焦判定）→ 等待（倒计时 + 后台轮询）
 *   → 落地（频道转 live 后在对话框里给确认 → 自动关闭 → 弹观众端）。
 *   状态全部收敛在本组件（唯一轮询方），对话框 ClientLaunchDialog 只负责呈现；
 *   关闭对话框≠取消等待：客户端什么时候转 live，观众端照样会弹出来。
 *
 * 契约：GET /api/broadcast、GET /api/broadcast/client、POST /api/broadcast/start|stop（API.md §七）；
 *       POST /api/sim/start|stop、POST /api/sim/scenario（API.md v1.1）
 * 负责人：A · @since v0.2.0（v0.8.0 真实推流 / v0.9.0 客户端开播 / v0.9.2 唤起对话框）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BroadcastStatus, ClientLaunchInfo, LiveState } from '@livepilot/shared';
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
import { formatClock, formatSec } from '../lib/format';
import { ClientLaunchDialog, maskScheme, type ClientLaunchPhase } from './ClientLaunchDialog';

const SCENARIOS = Object.keys(SCENARIO_LABELS);

/** 唤起客户端后最多等多久让频道变成 live（超时就不再追问，避免无意义轮询） */
const CLIENT_LIVE_TIMEOUT_MS = 3 * 60 * 1000;
/** 判定「客户端被唤起」的失焦观察窗口 */
const BLUR_WINDOW_MS = 2500;
/** 检测到客户端开播后，成功卡片停留多久（让人看清结论再自动收起） @since v0.9.2 */
const LIVE_CONFIRM_MS = 1500;

interface ControlBarProps {
  state: LiveState | null;
  /** 真实开播成功（官方判定 live）后回调：App 用来直接弹出观众端 */
  onLiveStarted?: () => void;
}

export function ControlBar({ state, onLiveStarted }: ControlBarProps) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [bc, setBc] = useState<BroadcastStatus | null>(null);

  /** 已唤起客户端，正在等频道变成 live */
  const [clientPending, setClientPending] = useState(false);
  const pendingSince = useRef(0);
  /** 本次挂载内是否已经因「客户端开播」自动弹过观众端（避免反复弹） */
  const autoOpened = useRef(false);

  /* ---- 以下为 v0.9.2 唤起对话框：本组件是唯一状态持有者，对话框只负责呈现 ---- */
  /** 对话框开关。注意：关闭对话框 ≠ 取消等待，clientPending 照常推进 */
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchPhase, setLaunchPhase] = useState<ClientLaunchPhase>('idle');
  /**
   * 预取好的唤起信息。
   * 必须先取到再触发跳转：自定义协议要求导航发生在**用户手势**的调用栈里，
   * 而 await 一次网络请求会让这份手势失效（浏览器会判定为脚本自发行为），
   * 所以「打开对话框即预取」，用户点确认时 scheme 已在手上，跳转同步发出。
   */
  const [launchInfo, setLaunchInfo] = useState<ClientLaunchInfo | null>(null);
  /** 对话框各阶段的一句话结论（比 hint 更贴近当前场景，hint 保留给控制条） */
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);
  /** waiting 阶段剩余秒数（每秒更新，驱动倒计时与进度条） */
  const [waitLeftSec, setWaitLeftSec] = useState(0);
  /** 预取请求的序号：只认最后一次打开的结果，避免旧响应覆盖新值 */
  const prefetchSeq = useRef(0);

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
   *
   * v0.9.2：先切到 live 让对话框显示成功卡片停留 1.5 秒（对话框开着时让人看清结论），
   * 再收起对话框并弹观众端；对话框已经关了也照样弹，后台等待不会白等。
   */
  useEffect(() => {
    if (!clientPending) return;
    if (!externalLive || autoOpened.current) return;

    autoOpened.current = true;
    setClientPending(false);
    setLaunchPhase('live');
    setLaunchMsg(null);
    setHint(`客户端已开播（频道 ${bc?.channelId ?? ''}）—— 观众端现在能看到你的摄像头画面`);
    const id = setTimeout(() => {
      setLaunchOpen(false);
      onLiveStarted?.();
    }, LIVE_CONFIRM_MS);
    return () => clearTimeout(id);
  }, [clientPending, externalLive, bc?.channelId, onLiveStarted]);

  /**
   * 倒计时与超时判定 @since v0.9.2
   *
   * 刻意用 1 秒 ticker 而不是跟着 /api/broadcast 的轮询走：后端不可达时轮询会静默失败，
   * 但用户看到的倒计时必须继续走完，否则对话框会永远停在「等待中」没有任何反馈。
   */
  useEffect(() => {
    if (!clientPending) return;
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      const leftMs = CLIENT_LIVE_TIMEOUT_MS - (Date.now() - pendingSince.current);
      if (leftMs <= 0) {
        setWaitLeftSec(0);
        setClientPending(false);
        setLaunchPhase('timeout');
        setLaunchMsg('若客户端里确实点了「开始直播」仍检测不到，多半是推到了别的频道');
        setHint('已等待 3 分钟仍未检测到频道开播。请在客户端里确认已点「开始直播」并选好摄像头/麦克风');
        return;
      }
      setWaitLeftSec(Math.ceil(leftMs / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [clientPending]);

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
   * 打开唤起对话框（点控制条「客户端开播」） @since v0.9.2
   *
   * 开场就把 scheme 预取到手：自定义协议的导航必须发生在**用户手势**的调用栈里，
   * 若等到点「打开保利威客户端」再去 fetch，await 会让手势失效，浏览器可能直接拦掉。
   * 每次打开都重取 —— 频道号可以在运行时被换掉（/api/polyv/channel），不用旧值。
   */
  const openLaunchDialog = useCallback((): void => {
    setLaunchOpen(true);
    // 已经在等待中的话回来得看到「等待」而不是又回到确认页 —— 这一轮唤起已经在路上
    setLaunchPhase(clientPending ? 'waiting' : 'idle');
    setLaunchMsg(null);

    const seq = ++prefetchSeq.current;
    fetchClientLaunch()
      .then((info) => {
        if (seq !== prefetchSeq.current) return;
        setLaunchInfo(info);
      })
      .catch((e: unknown) => {
        if (seq !== prefetchSeq.current) return;
        setLaunchPhase('error');
        setLaunchMsg(e instanceof Error ? e.message : String(e));
      });
  }, [clientPending]);

  /** 关闭对话框：只是收起界面，等待与轮询照旧 @since v0.9.2 */
  const closeLaunchDialog = useCallback((): void => {
    setLaunchOpen(false);
  }, []);

  /**
   * 真正唤起保利威客户端（对话框里点「打开保利威客户端」） @since v0.9.2
   *
   * 技术要点（沿用 v0.9.0 结论）：
   * 1. 自定义协议必须在**用户手势**的调用栈里触发，所以用 <a> 点击而不是 window.open；
   *    scheme 已在 openLaunchDialog 预取，这里同步点击、不经过 await；
   * 2. 浏览器无法查询「协议是否已注册」，只能靠页面失焦间接判断客户端窗口是否抢了焦点；
   *    但判定失败也不代表没装（有些系统不触发 blur），所以**无论是否失焦都继续等待**，
   *    只是结论文案不同 —— 真的开播了照样能自动弹观众端。
   */
  const launchClient = useCallback(async (): Promise<void> => {
    // 每一次新的唤起都重新校准「是否已自动弹过观众端」，否则第二次开播会不弹
    autoOpened.current = false;
    setLaunchPhase('launching');
    setLaunchMsg(null);

    // 预取失败/没取到时的兜底：这一路已经跨过了 await，只能在失败时如实报告
    let info = launchInfo;
    if (info === null) {
      try {
        info = await fetchClientLaunch();
        setLaunchInfo(info);
      } catch (e) {
        setLaunchPhase('error');
        setLaunchMsg(e instanceof Error ? e.message : String(e));
        return;
      }
    }

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
    setLaunchPhase('waiting');
    setLaunchMsg(
      focusLeft
        ? `${info.hint}。失焦已检测到客户端窗口，本窗口现在是后台跟随状态`
        : // 结论里要脱敏：scheme 带 passwd，截图/录屏时不该把密码露出去
          `已发送唤起请求（${maskScheme(info.scheme)}）。窗口没出现通常是本机未安装保利威直播伴侣，` +
            `或浏览器拦截了外部协议 —— 不排除另一种可能：客户端起来了只是没抢到焦点。仍在后台等待频道开播…`,
    );
    setHint(focusLeft ? info.hint : '已唤起客户端请求，等待频道转直播（可在控制条上跟进）');
  }, [launchInfo, running]);

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

  /** 退路：客户端路径走不通时改用后端 ffmpeg 推流（对话框里点「改用 AI 演示推流」） @since v0.9.2 */
  const useFallback = (): void => {
    setLaunchOpen(false);
    void onStartLive();
  };

  /** 超时后重新唤起：不再回到确认页，直接再发一次唤起请求 @since v0.9.2 */
  const retryLaunch = useCallback((): void => {
    void launchClient();
  }, [launchClient]);

  /** 主按钮文案跟随进度：不点开对话框也能看出当前处在唤起流程的哪一步 @since v0.9.2 */
  const launchLabel = externalLive
    ? '重新唤起客户端'
    : clientPending
      ? '客户端开播 · 跟进'
      : '客户端开播';

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3">
      {/* ① 客户端开播（主路径）：打开确认对话框，由对话框二次确认后才真的唤起 @since v0.9.2 */}
      <button
        type="button"
        disabled={bcActive}
        onClick={openLaunchDialog}
        title={
          bcActive
            ? '本机 ffmpeg 正在推流，同一频道不能两个推流端 —— 请先「停止推流」'
            : '唤起本机保利威客户端并直接进入当前频道的开播界面（地址带频道号与开播密码），在客户端里用摄像头 / 麦克风 / 屏幕共享开播'
        }
        className="flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        <span className="text-[11px] leading-none">▶</span>
        {launchLabel}
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
          {bc.startedAt !== null && <span className="font-normal tabular-nums">{formatSec(bc.uptimeSec)}</span>}
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

      {/* 已唤起客户端，等官方判定（带上倒计时：收起对话框后这里是唯一进度来源） @since v0.9.2 */}
      {clientPending && !externalLive && (
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1.5 rounded-md bg-warn-50 px-2 py-1 text-xs font-medium text-warn-800 hover:bg-warn-100"
          title="查看唤起进度与排查步骤"
          onClick={openLaunchDialog}
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn-500" />
          等待客户端开播…
          <span className="font-normal tabular-nums text-warn-700">{formatSec(waitLeftSec)}</span>
          {bc?.channelId && <span className="font-normal text-gray-500">频道 {bc.channelId}</span>}
        </button>
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

      {/* ⑤ 唤起对话框：portal 挂载到 body，与本组件的 section 层级无关 @since v0.9.2 */}
      <ClientLaunchDialog
        open={launchOpen}
        phase={launchPhase}
        info={launchInfo}
        channelId={bc?.channelId ?? ''}
        message={launchMsg}
        remainingSec={waitLeftSec}
        totalSec={Math.round(CLIENT_LIVE_TIMEOUT_MS / 1000)}
        onClose={closeLaunchDialog}
        onLaunch={() => void launchClient()}
        onRetry={retryLaunch}
        onUseFallback={useFallback}
      />
    </section>
  );
}
