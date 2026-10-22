/**
 * SSE 实时推送（前端 A 的唯一实时数据入口）
 *
 * 契约（见 API.md）：`GET /api/stream` 每次推送一帧完整 LiveState JSON，前端用 EventSource 订阅。
 * 细节处理：
 * - 连接立刻推一帧当前状态，避免前端首屏空白；
 * - 状态变化做 200ms 节流（模拟器 tick 800ms，高频决策时也不会把浏览器打爆）；
 * - 15s 心跳注释防代理断连（比赛现场常用代理/内网，必须做）。
 */
import { Router } from 'express';
import { store } from '../store/state.ts';

export const sseRouter = Router();

const THROTTLE_MS = 200;
const HEARTBEAT_MS = 15000;

sseRouter.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const send = () => {
    try {
      res.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
    } catch {
      /* 连接已断，交给 close 清理 */
    }
  };

  send();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = store.subscribe(() => {
    if (timer) return; // 节流窗口内合并
    timer = setTimeout(() => {
      timer = null;
      send();
    }, THROTTLE_MS);
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* ignore */
    }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    unsubscribe();
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    timer = null;
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
});
