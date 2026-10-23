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
import {
  POLYV_API_OPERATIONS,
  POLYV_COMMON_AUTH_PARAMS,
} from '../polyv/api-catalog.ts';

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

/**
 * GET /api/polyv/capabilities —— 客户可见的官方能力清单
 * 只暴露官方 method/path/docUrl；B 的内部执行路径/默认参数留在 client.ts，不对外。
 */
apiRouter.get('/polyv/capabilities', (_req, res) => {
  const operationMap = new Map(
    POLYV_API_OPERATIONS.map((operation) => [operation.action, operation]),
  );
  // 官方目录（method/path/docUrl）+ 执行层的真实可用状态（资源是否齐备）
  const runtime = polyvClient.capabilities();

  res.json(
    ok({
      useReal: polyvClient.isReal,
      channelId: config.polyv.channelId,
      apiBase: config.polyv.apiBase,
      source: 'official',
      /** 账号侧资源齐备情况：决定哪些动作在真实模式下真的能打 */
      resources: runtime.resources,
      actions: runtime.actions.map((action) => {
        const operation = operationMap.get(action.action);
        return {
          action: action.action,
          label: operation?.label ?? action.label,
          method: action.method,
          path: action.path,
          docUrl: operation?.docUrl ?? action.docUrl,
          /** 官方必填的业务/资源参数 */
          requiredParams: operation?.requiredParams ?? [],
          /** 真实模式是否可直接执行 */
          ready: action.ready,
          missing: action.missing,
        };
      }),
      webhook: POLYV_API_OPERATIONS.find(
        (operation) => operation.action === 'webhook',
      )?.path,
      statsPath: POLYV_API_OPERATIONS.find(
        (operation) => operation.action === 'stats',
      )?.path,
      /** 演练 / 真实 的运行时状态（现场可在界面上一键切换） */
      dryRun: polyvClient.dryRun,
      credentialsReady: polyvClient.credentialsReady,
    }),
  );
});

/**
 * GET /api/polyv/mode —— 当前是「模拟演练」还是「真实频道」
 * POST /api/polyv/mode { useReal: boolean } —— 运行时切换
 *
 * 存在意义：账号密钥配好之后仍然要能跑纯模拟（彩排、反复演示不污染真实直播间）。
 */
apiRouter.get('/polyv/mode', (_req, res) => {
  res.json(
    ok({
      useReal: polyvClient.isReal,
      dryRun: polyvClient.dryRun,
      credentialsReady: polyvClient.credentialsReady,
      channelId: config.polyv.channelId || null,
      label: polyvClient.isReal ? `真实频道 ${config.polyv.channelId}` : '模拟演练（不发真实请求）',
    }),
  );
});

apiRouter.post('/polyv/mode', (req, res) => {
  const raw = (req.body ?? {}) as Record<string, unknown>;
  if (typeof raw.useReal !== 'boolean') {
    res.status(400).json(fail('useReal 必须是布尔值'));
    return;
  }
  const wantReal = raw.useReal;
  const accepted = polyvClient.setDryRun(!wantReal);

  if (wantReal && !accepted) {
    res.status(409).json(
      fail('缺少 appId / appSecret / channelId，无法切到真实模式；已在模拟演练模式'),
    );
    return;
  }

  store.logEvent(
    'action',
    accepted && wantReal ? '切换为真实调用' : '切换为模拟演练',
    accepted && wantReal
      ? `后续动作将真实请求频道 ${config.polyv.channelId}`
      : '后续动作只产生模拟回执，不会打到保利威频道',
  );
  res.json(
    ok({
      useReal: polyvClient.isReal,
      dryRun: polyvClient.dryRun,
      label: polyvClient.isReal ? `真实频道 ${config.polyv.channelId}` : '模拟演练（不发真实请求）',
    }),
  );
});

/**
 * GET  /api/polyv/channel —— 当前生效频道号 + 是否来自运行时指定
 * POST /api/polyv/channel { channelId } —— 运行时切换频道（演示现场换频道不必重启）
 *
 * 只切换「看哪个频道 / 往哪个频道发互动」，不涉及任何密钥。
 * 传空字符串即恢复 .env 的 POLYV_CHANNEL_ID。
 */
apiRouter.get('/polyv/channel', (_req, res) => {
  res.json(
    ok({
      channelId: store.effectiveChannelId() || null,
      source: store.effectiveChannelId() === config.polyv.channelId ? 'env' : 'runtime',
      embeddable: Boolean(store.effectiveChannelId()),
    }),
  );
});

apiRouter.post('/polyv/channel', (req, res) => {
  const raw = (req.body ?? {}) as Record<string, unknown>;
  if (typeof raw.channelId !== 'string') {
    res.status(400).json(fail('channelId 必须是字符串（传空字符串表示恢复默认）'));
    return;
  }
  const id = raw.channelId.trim();
  if (id !== '' && !/^[0-9A-Za-z_-]{1,64}$/.test(id)) {
    res.status(400).json(fail('channelId 只允许数字/字母/下划线/连字符，长度 1-64'));
    return;
  }
  const applied = store.setChannelId(id);
  polyvClient.setChannelId(id);
  res.json(
    ok({
      channelId: applied || null,
      source: id ? 'runtime' : 'env',
      embeddable: Boolean(applied),
    }),
  );
});

/** GET /api/polyv/operations —— 官方 API 常量目录（不是经验数据） */
apiRouter.get('/polyv/operations', (_req, res) => {
  res.json(
    ok({
      auth: POLYV_COMMON_AUTH_PARAMS,
      operations: POLYV_API_OPERATIONS,
    }),
  );
});

// C 扩展：副驾候选 / 操作选择
apiRouter.use('/copilot', copilotRouter);
