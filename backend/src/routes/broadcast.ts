/**
 * 真实开播接口 —— 让「开始直播」按钮真的把流推到保利威频道
 *
 * 契约（见 API.md §七）：
 *   GET  /api/broadcast         → BroadcastStatus
 *   POST /api/broadcast/start   → BroadcastStatus（真推流，等官方确认 live）
 *   POST /api/broadcast/stop    → BroadcastStatus（停止推流，频道回落为未开播）
 *
 * 与 /api/sim/start 的区别（很重要，演示时别搞混）：
 *   sim/start   → 起「虚拟观众」数据流，驾驶舱的在线人数/GMV 曲线会动，但频道里没有画面
 *   broadcast   → 真的往保利威推流，观众端能看见画面；驾驶舱指标需要 sim/start 才有数据
 * start 默认把两者一起拉起来（withSimulator=true），一键得到「有画面 + 有数据」的真实直播。
 *
 * 负责人：B（后端/集成）· @since v0.8.0
 */
import { Router } from 'express';
import { broadcast } from '../services/broadcast.ts';
import { simulator } from '../simulator/simulator.ts';
import { store } from '../store/state.ts';
import { polyvClient } from '../polyv/client.ts';

export const broadcastRouter = Router();

const ok = (data: unknown) => ({ ok: true, data });
const fail = (error: string, code = 400) => ({ ok: false, error, code });

/** GET /api/broadcast —— 当前推流状态（含官方回读的 channelLive） */
broadcastRouter.get('/broadcast', async (_req, res) => {
  const st = broadcast.status();
  if (st.active) await broadcast.refreshChannelLive();
  res.json(ok(broadcast.status()));
});

/** POST /api/broadcast/start —— 真实开播 */
broadcastRouter.post('/broadcast/start', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const file = typeof body.file === 'string' ? body.file.trim() : '';
  const withSimulator = body.withSimulator !== false;

  // 已经在推流：幂等返回，不重复起进程
  if (broadcast.status().active) {
    res.json(ok({ ...broadcast.status(), alreadyRunning: true }));
    return;
  }

  if (!polyvClient.credentialsReady) {
    res
      .status(409)
      .json(
        fail(
          '真实开播需要真实模式（USE_REAL_POLYV=true）且 appId / appSecret / 频道号齐备；当前是模拟演练模式',
          409,
        ),
      );
    return;
  }

  const st = await broadcast.start({ file: file || undefined });

  if (st.phase === 'error' && !st.active) {
    res.status(502).json(fail(st.error ?? '推流失败', 502));
    return;
  }

  // 推流成功后按需拉起虚拟观众数据流，让驾驶舱同时有数据
  let simStarted = false;
  if (withSimulator && st.active && !simulator.running) {
    simulator.start({});
    simStarted = true;
  }

  res.json(ok({ ...st, simStarted, sessionId: store.get().sessionId }));
});

/** POST /api/broadcast/stop —— 停止推流 */
broadcastRouter.post('/broadcast/stop', async (_req, res) => {
  const st = await broadcast.stop();
  res.json(ok(st));
});
