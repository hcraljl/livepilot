/**
 * Express 入口（胶水层，B 负责）
 *
 * 挂载顺序即数据流：模拟器/Webhook → store → SSE → 前端；引擎（C）通过 store.onTick 消费同一份状态。
 * 单端口跑通：如果 frontend/dist 存在（npm run build 产物），后端会顺手托管静态站，
 * 现场演示只需开一个 http://localhost:4000，少一个失败点。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { config, describeEnv } from './config.ts';
import { store } from './store/state.ts';
import { polyvClient } from './polyv/client.ts';
import { executeAction, executeDecision } from './polyv/executor.ts';
import { apiRouter } from './routes/api.ts';
import { sseRouter } from './routes/sse.ts';
import { webhookRouter } from './routes/webhook.ts';
import { archiveSession } from './services/session-archive.ts';

const app = express();

// 场次结束自动落盘留档（防止进程重启 / 断网导致复盘数据丢失；同一会话只存一次）
let archivedSession = '';
store.subscribe((s) => {
  if (s.endedAt && s.sessionId && archivedSession !== s.sessionId) {
    archivedSession = s.sessionId;
    void archiveSession(store.exportSession());
  }
});

app.use(cors({ origin: true, credentials: false }));
// Polyv 回调可能是 application/json，也可能是 form；两种都收
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 访问日志（演示排障用；不打印任何请求体，避免密钥落日志）
app.use((req, _res, next) => {
  if (req.path !== '/api/stream') console.log(`[http] ${req.method} ${req.path}`);
  next();
});

/** 健康检查：前端启动时用它判断后端是否就绪 */
const health = (_req: express.Request, res: express.Response) => {
  res.json({
    ok: true,
    useReal: polyvClient.isReal,
    running: store.get().running,
    mode: store.get().mode,
    source: store.get().source,
    sessionId: store.get().sessionId,
    uptimeSec: store.uptimeSec(),
  });
};
app.get('/health', health);
app.get('/api/health', health);

// apiRouter 内的路径为相对路径（/state、/sim/start…），统一挂在 /api 下
app.use('/api', apiRouter);
app.use(sseRouter);
app.use(webhookRouter);

// 前端构建产物托管（存在才挂载，不影响纯前后端分离开发）
const distDir = path.resolve(process.cwd(), '..', 'frontend', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api|polyv|health).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  console.log(`[server] 已托管前端构建产物：${distDir}`);
}

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not Found', hint: '接口清单见仓库根目录 API.md' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server] 未捕获异常：', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

/**
 * 引擎自动挂载（C 的模块一合并就自动生效，B 不需要改代码）
 * 约定：backend/src/engine/orchestrator.ts 导出以下任一形式
 *   export function start(ctx: EngineContext): void | Promise<void>
 *   export function register(ctx: EngineContext): void
 *   export default { start | register }
 */
type EngineContext = {
  store: typeof store;
  polyvClient: typeof polyvClient;
  config: typeof config;
  executeAction: typeof executeAction;
  executeDecision: typeof executeDecision;
};

const mountEngine = async (): Promise<void> => {
  const ctx: EngineContext = { store, polyvClient, config, executeAction, executeDecision };
  try {
    const spec = './engine/orchestrator.ts';
    const mod: any = await import(spec);
    const target = mod?.default ?? mod;
    const fn = target?.start ?? target?.register ?? target?.default;
    if (typeof fn === 'function') {
      await fn(ctx);
      console.log('[engine] ✅ 已挂载 AI 编排引擎（成员 C）');
    } else {
      console.log('[engine] ⚠️ engine/orchestrator.ts 存在但没有导出 start/register，跳过挂载');
    }
  } catch {
    console.log('[engine] ℹ️ 未检测到 engine/orchestrator.ts —— 当前为「模拟器 + 手动动作」模式（C 合并后自动挂载）');
  }
};

const server = app.listen(config.port, () => {
  console.log('\n========== LivePilot 后端已启动 ==========');
  console.table(describeEnv());
  console.log(`  REST      http://localhost:${config.port}/api/state`);
  console.log(`  SSE       http://localhost:${config.port}/api/stream`);
  console.log(`  健康检查   http://localhost:${config.port}/health`);
  console.log(`  Polyv 能力 http://localhost:${config.port}/api/polyv/capabilities`);
  console.log(`  Webhook   http://localhost:${config.port}/polyv/webhook`);
  console.log('==========================================\n');
  void mountEngine();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${config.port} 被占用：改 .env 里的 PORT，或先关掉旧进程`);
  } else {
    console.error('[server] 启动失败：', err.message);
  }
  process.exit(1);
});

const shutdown = (signal: string) => {
  console.log(`\n[server] 收到 ${signal}，正在关闭…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
