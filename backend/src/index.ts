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
    dryRun: polyvClient.dryRun,
    credentialsReady: polyvClient.credentialsReady,
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

/**
 * 真实观看页 = 官方开源观看页（polyv_ef/polyv-web-live-watch-sdk）
 *
 * frontend/watch-sdk  —— 官方 UI 层构建产物（Vue2 + @polyv/live-watch-sdk），
 *                        自带播放器 / 聊天 / 互动接收端（抽奖·答题卡·签到·卡片·公告）
 * frontend/watch       —— 轻量兜底页（B 手写，只依赖 logic SDK UMD，可离线）
 *
 * 优先用官方页；产物缺失时自动退回轻量页，保证「右屏一定打得开」。
 */
const officialWatchDir = path.resolve(process.cwd(), '..', 'frontend', 'watch-sdk');
const liteWatchDir = path.resolve(process.cwd(), '..', 'frontend', 'watch');
const hasOfficialWatch = existsSync(path.join(officialWatchDir, 'index.html'));
const hasLiteWatch = existsSync(path.join(liteWatchDir, 'index.html'));
const watchDir = hasOfficialWatch ? officialWatchDir : liteWatchDir;
const watchKind = hasOfficialWatch ? 'official' : 'lite';
if (existsSync(watchDir)) {
  app.use('/watch', express.static(watchDir));
}
// 轻量页永远单独可访问，便于排查「官方页挂了但我还想看播放器」的情况
if (hasLiteWatch) {
  app.use('/watch-lite', express.static(liteWatchDir));
}

/**
 * 模拟演示台：源码在 frontend/demo，**不进 dist**，
 * 这样 A 的前端一旦 build 也不会把它覆盖掉 —— 模拟入口永远是稳的。
 */
const demoDir = path.resolve(process.cwd(), '..', 'frontend', 'demo');
const demoIndex = path.join(demoDir, 'index.html');
const hasDemo = existsSync(demoIndex);
if (hasDemo) {
  app.use('/demo', express.static(demoDir));
}

// 前端构建产物托管（存在才挂载，不影响纯前后端分离开发）
const distDir = path.resolve(process.cwd(), '..', 'frontend', 'dist');
const distIndex = path.join(distDir, 'index.html');
const hasDist = existsSync(distIndex);
if (hasDist) {
  app.use(express.static(distDir));
}

// 根路径：有正式前端就进正式前端，没有就自动进模拟演示台（不再让人找不到入口）
app.get('/', (_req, res) => {
  if (hasDist) {
    res.sendFile(distIndex);
    return;
  }
  if (hasDemo) {
    res.redirect('/demo/');
    return;
  }
  res.status(404).json({
    ok: false,
    error: '未找到前端页面',
    hint: '跑模拟演示台请用 /demo/；接口清单见 API.md',
  });
});

if (hasDist) {
  app.get(/^\/(?!api|polyv|health|watch|demo).*/, (_req, res) => res.sendFile(distIndex));
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
  const base = `http://localhost:${config.port}`;
  console.log('  —— 页面入口 ——');
  if (hasDist) console.log(`  前端（A 的正式界面） ${base}/`);
  if (hasDemo) console.log(`  模拟演示台（B 的看板）${hasDist ? '' : ' ← 根路径自动跳这里'} ${base}/demo/`);
  console.log(
    `  真实观看页（${watchKind === 'official' ? '官方开源 SDK 观看页' : '轻量兜底页'}）${base}/watch/`,
  );
  if (hasLiteWatch) console.log(`  轻量观看页（兜底排查） ${base}/watch-lite/`);
  console.log('  —— 接口 ——');
  console.log(`  REST      ${base}/api/state`);
  console.log(`  SSE       ${base}/api/stream`);
  console.log(`  健康检查   ${base}/health`);
  console.log(`  Polyv 能力 ${base}/api/polyv/capabilities`);
  console.log(`  Polyv 模式 ${base}/api/polyv/mode  （模拟演练 / 真实频道，可运行时切换）`);
  console.log(`  Webhook   ${base}/polyv/webhook`);
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
