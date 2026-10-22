/**
 * REST 接口层（前端 A、引擎 C 都只认这一份契约，详见仓库根 API.md）
 *
 * 设计原则：
 * - 所有响应都是 { ok, data } / { ok:false, error } 风格，前端不用 try-catch 猜结构；
 * - 参数一律做白名单校验，非法输入返回 400 而不是把脏数据灌进状态机；
 * - 任何接口都不会返回密钥。
 */
import { Router } from 'express';
import type { ActionType, Mode, StrategyConfig } from '../../../shared/types.ts';
import { store } from '../store/state.ts';
import { simulator, type ScenarioName } from '../simulator/simulator.ts';
import { polyvClient } from '../polyv/client.ts';
import { executeAction, executeDecision } from '../polyv/executor.ts';
import { buildFallbackReplay } from '../services/replay-fallback.ts';
import { config } from '../config.ts';
import { copilotRouter } from './copilot.ts';

export const apiRouter = Router();

const MODES: Mode[] = ['suggest', 'semiauto', 'auto'];
const SCENARIOS: ScenarioName[] = ['online_drop', 'cold_start', 'low_ctr', 'endgame', 'stream_stall'];
const ACTIONS: ActionType[] = [
  'lottery',
  'welfare_lottery',
  'answer_card',
  'checkin',
  'push_card',
  'push_product',
  'bulletin',
  'coupon',
];

const ok = (data: unknown) => ({ ok: true, data });
const fail = (error: string, code = 400) => ({ ok: false, error, code });

/** GET /api/state —— 完整状态（前端首屏兜底，之后走 SSE） */
apiRouter.get('/state', (_req, res) => {
  res.json(store.snapshot());
});

/** POST /api/sim/start —— 启动模拟器 */
apiRouter.post('/sim/start', (req, res) => {
  const { totalMin, speed, seed } = (req.body ?? {}) as Record<string, unknown>;
  const state = simulator.start({
    totalMin: Number(totalMin) > 0 ? Number(totalMin) : undefined,
    speed: Number(speed) > 0 ? Number(speed) : undefined,
    seed: Number.isFinite(Number(seed)) && seed !== undefined ? Number(seed) : undefined,
  });
  res.json(ok({ ...state, sessionId: state.sessionId }));
});

/** POST /api/sim/stop —— 停止模拟器 */
apiRouter.post('/sim/stop', (_req, res) => {
  simulator.stop('运营手动停止模拟');
  res.json(ok({ running: false }));
});

/** POST /api/sim/scenario —— 现场加戏（不等剧本节点） */
apiRouter.post('/sim/scenario', (req, res) => {
  const name = String((req.body ?? {}).name ?? '');
  if (!SCENARIOS.includes(name as ScenarioName)) {
    res.status(400).json(fail(`name 必须是 ${SCENARIOS.join(' / ')}`));
    return;
  }
  if (!simulator.running) {
    res.status(409).json(fail('模拟器未运行，先调用 /api/sim/start'));
    return;
  }
  simulator.injectScenario(name as ScenarioName);
  res.json(ok({ scenario: name }));
});

/** POST /api/mode —— 切换 AI 副驾三档模式 */
apiRouter.post('/mode', (req, res) => {
  const mode = String((req.body ?? {}).mode ?? '') as Mode;
  if (!MODES.includes(mode)) {
    res.status(400).json(fail(`mode 必须是 ${MODES.join(' / ')}`));
    return;
  }
  res.json(ok({ mode: store.setMode(mode) }));
});

/** POST /api/strategy —— 更新策略阈值（前端策略面板） */
apiRouter.post('/strategy', (req, res) => {
  const body = (req.body ?? {}) as Partial<StrategyConfig>;
  const strategy = store.updateStrategy(body);
  res.json(ok({ strategy }));
});

/** GET /api/decisions —— 决策列表（可按状态过滤） */
apiRouter.get('/decisions', (req, res) => {
  const status = String(req.query.status ?? '');
  const list = store.snapshot().decisions;
  res.json(ok(status ? list.filter((d) => d.status === status) : list));
});

/** POST /api/decision/confirm —— 半自动模式：确认执行某条待确认决策 */
apiRouter.post('/decision/confirm', async (req, res) => {
  const id = String((req.body ?? {}).id ?? '');
  if (!id) {
    res.status(400).json(fail('缺少 id'));
    return;
  }
  const outcome = await executeDecision(id);
  if (!outcome) {
    res.status(404).json(fail(`未找到决策 ${id}`));
    return;
  }
  res.json(ok({ decision: outcome.decision, result: outcome.result }));
});

/** POST /api/action —— 运营手动触发一个动作（演示现场"人点一下"） */
apiRouter.post('/action', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = String(body.action ?? '') as ActionType;
  if (!ACTIONS.includes(action)) {
    res.status(400).json(fail(`action 必须是 ${ACTIONS.join(' / ')}`));
    return;
  }
  const outcome = await executeAction(action, {
    channelId: body.channelId ? String(body.channelId) : undefined,
    rule: body.rule ? String(body.rule) : undefined,
    reason: body.reason ? String(body.reason) : undefined,
    title: body.title ? String(body.title) : undefined,
    params: (body.params ?? undefined) as Record<string, unknown> | undefined,
  });
  res.json(ok({ decision: outcome.decision, result: outcome.result }));
});

/** GET /api/events —— 事件流（复盘 / 时间轴；支持 since + type 过滤） */
apiRouter.get('/events', (req, res) => {
  const since = Number(req.query.since ?? 0) || 0;
  const type = req.query.type ? String(req.query.type) : undefined;
  res.json(ok(store.listEvents(since, type as never)));
});

/** GET /api/replay —— 一键复盘（优先 C 的 AI 报告，缺位时走兜底） */
apiRouter.get('/replay', async (_req, res) => {
  try {
    // 动态加载 C 的复盘模块：C 一合并，这里自动切换到 AI 版，无需改本文件
    const spec = '../review/report.ts';
    const mod: any = await import(spec);
    const fn = mod?.generateReport ?? mod?.default ?? mod?.buildReport;
    if (typeof fn === 'function') {
      const payload = store.exportSession();
      const result = await fn(payload, { store, config });
      // 兼容 C 返回 string 或 ReplayResp
      if (typeof result === 'string') {
        res.json({ report: result, generatedAt: Date.now(), engine: 'ai' });
        return;
      }
      res.json(result);
      return;
    }
  } catch {
    // 未检测到 C 的模块 / LLM 调用失败 → 兜底
  }
  res.json(buildFallbackReplay());
});

/** GET /api/session/export —— 本场全量数据导出（留档 / 复盘 / 演示防翻车） */
apiRouter.get('/session/export', (req, res) => {
  const payload = store.exportSession();
  if (String(req.query.download ?? '') === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="livepilot-${payload.sessionId || 'empty'}.json"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  res.json(payload);
});

/** GET /api/polyv/capabilities —— 保利威能力清单（证明接口真接上了，路演可展示） */
apiRouter.get('/polyv/capabilities', (_req, res) => {
  res.json(ok(polyvClient.capabilities()));
});

// C 扩展：副驾候选 / 操作选择
apiRouter.use('/copilot', copilotRouter);
