/**
 * HTTP 端到端冒烟测试（B 的联调工具）
 *
 * 前置：后端已启动（npm run dev:backend）
 * 用法：npm run smoke -w backend            # 默认 http://127.0.0.1:4000
 *       BASE=http://127.0.0.1:4000 npm run smoke -w backend
 *
 * 覆盖：健康检查 → 能力清单 → 启动模拟器 → 状态 → SSE 首帧 → 手动动作 → 模式/策略 →
 *       场景注入 → 事件流 → 复盘 → 会话导出 → Webhook 下播 → 参数校验，最后自动停掉模拟器。
 */
import { buildSign } from '../polyv/sign.ts';
import { config } from '../config.ts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4000';

/**
 * 按官方规则给回调签名。
 * 配了 appSecret 后 webhook 会强制验签，测试里的假回调必须自己签，否则会被丢弃。
 */
const signWebhook = (body: Record<string, unknown>): Record<string, unknown> => {
  if (!config.polyv.appSecret) return body;
  return { ...body, sign: buildSign(body as Record<string, string | number>, config.polyv.appSecret) };
};

let pass = 0;
let fail = 0;
const results: string[] = [];

const check = (name: string, ok: boolean, extra = ''): void => {
  if (ok) {
    pass += 1;
    results.push(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail += 1;
    results.push(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readOneSseFrame = async (): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${BASE}/api/stream`, { signal: controller.signal });
    const reader = res.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 注意：首个 \n\n 只是 "retry: 3000" 帧，要继续读到带 data: 的帧
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          await reader.cancel();
          return JSON.parse(dataLine.slice(6));
        }
        idx = buffer.indexOf('\n\n');
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const main = async (): Promise<void> => {
  console.log(`\n[smoke] 目标后端：${BASE}\n`);

  // 1. 健康检查
  const health = await call('GET', '/health');
  check('健康检查 /health', health.status === 200 && health.json.ok === true, `useReal=${health.json.useReal}`);

  // 2. 能力清单
  const caps = await call('GET', '/api/polyv/capabilities');
  check(
    '能力清单 8 个动作 + 真实接口路径',
    caps.json?.ok === true && caps.json.data.actions.length === 8 && caps.json.data.actions.every((a: any) => a.path.startsWith('/live/')),
    `${caps.json?.data?.actions?.length ?? 0} 个`,
  );

  // 3. 启动模拟器（加速 40x，便于快速验证）
  const started = await call('POST', '/api/sim/start', { totalMin: 30, speed: 40 });
  const sessionId = started.json?.data?.sessionId;
  check('启动模拟器 /api/sim/start', started.status === 200 && started.json?.data?.running === true, `session=${sessionId}`);

  // 4. 状态推进
  await sleep(1500);
  const s1 = await call('GET', '/api/state');
  const m1 = s1.json.metrics;
  check('状态推进（在线/观看/GMV 有值）', m1.online > 0 && m1.totalViewers > 0, `在线 ${m1.online} · 观看 ${m1.totalViewers} · GMV ¥${Math.round(m1.gmv)}`);
  check('时间轴有采样点', Array.isArray(s1.json.timeline) && s1.json.timeline.length > 0, `${s1.json.timeline.length} 点`);

  // 5. SSE 首帧
  const frame = await readOneSseFrame();
  check('SSE /api/stream 首帧即推完整 LiveState', frame?.metrics !== undefined && frame?.decisions !== undefined, `running=${frame?.running}`);

  // 6. 手动动作（走执行层 + 回执带 endpoint）
  const action = await call('POST', '/api/action', { action: 'bulletin', title: '冒烟测试公告' });
  check(
    '手动动作执行 + 回执含 endpoint',
    action.json?.data?.result?.ok === true && typeof action.json.data.result.endpoint === 'string',
    `${action.json?.data?.result?.endpoint ?? '无'}`,
  );
  check('动作回执标注 mock 真伪', action.json?.data?.result?.mock === false || action.json?.data?.result?.mock === true, `mock=${action.json?.data?.result?.mock}`);

  // 7. 模式 / 策略
  const mode = await call('POST', '/api/mode', { mode: 'semiauto' });
  check('切换模式 /api/mode', mode.json?.data?.mode === 'semiauto');
  const strat = await call('POST', '/api/strategy', { retentionDropPct: 0.12, gmvTarget: 100000 });
  check('更新策略 /api/strategy', strat.json?.data?.strategy?.retentionDropPct === 0.12);

  // 8. 场景注入
  const scen = await call('POST', '/api/sim/scenario', { name: 'cold_start' });
  check('现场加戏 /api/sim/scenario', scen.json?.ok === true && scen.json.data.scenario === 'cold_start');

  // 9. 事件流
  const events = await call('GET', '/api/events?type=decision');
  check('事件流 /api/events 可按类型过滤', events.json?.ok === true && Array.isArray(events.json.data), `${events.json?.data?.length ?? 0} 条 decision 事件`);

  // 10. 复盘
  const replay = await call('GET', '/api/replay');
  check('复盘 /api/replay 有内容', typeof replay.json?.report === 'string' && replay.json.report.length > 20, `engine=${replay.json?.engine}`);

  // 11. 会话导出
  const exp = await call('GET', '/api/session/export');
  check('会话导出 /api/session/export', exp.json?.sessionId === sessionId && Array.isArray(exp.json.timeline));

  // 12. Webhook 下播 + 僵尸 tick 检查
  // 频道号取自当前状态（.env 配了真实频道时不能硬编码，否则下播不会命中）
  const beforeEnd = await call('GET', '/api/state');
  const hookChannel = String(beforeEnd.json?.channelId ?? '1999999');
  await call('POST', '/polyv/webhook', signWebhook({ event: 'liveEnd', channelId: hookChannel }));
  await sleep(1200);
  const afterEnd = await call('GET', '/api/state');
  const gmvA = afterEnd.json.metrics.gmv;
  check('Webhook 下播生效', afterEnd.json.running === false);
  await sleep(1800);
  const afterWait = await call('GET', '/api/state');
  check('下播后指标不再增长（无僵尸 tick）', afterWait.json.metrics.gmv === gmvA, `GMV 保持 ¥${Math.round(gmvA)}`);

  // 13. 参数校验
  const badMode = await call('POST', '/api/mode', { mode: 'xxx' });
  check('非法 mode 返回 400', badMode.status === 400);
  const badScenario = await call('POST', '/api/sim/scenario', { name: 'nope' });
  check('非法场景返回 400', badScenario.status === 400);
  const badConfirm = await call('POST', '/api/decision/confirm', { id: 'dec_not_exist' });
  check('不存在的决策返回 404', badConfirm.status === 404);

  // 14. 模拟入口必须一直在（演示台 + 演练开关）
  const demoPage = await fetch(`${BASE}/demo/`);
  check('模拟演示台 /demo/ 可访问', demoPage.ok, `HTTP ${demoPage.status}`);
  const rootPage = await fetch(`${BASE}/`, { redirect: 'manual' });
  check(
    '根路径能进到页面（正式前端或自动跳模拟台）',
    rootPage.status === 302 || rootPage.ok,
    `HTTP ${rootPage.status}`,
  );
  const watchPage = await fetch(`${BASE}/watch/`);
  check('真实观看页 /watch/ 可访问', watchPage.ok, `HTTP ${watchPage.status}`);
  const watchHtml = await watchPage.text();
  check(
    '观看页是官方开源 SDK 产物（非占位页）',
    /assets\/js\/(index|chunk-vendors)/.test(watchHtml) || /polyv-live-watch-sdk/.test(watchHtml),
    `${watchHtml.length} bytes`,
  );
  const liteWatch = await fetch(`${BASE}/watch-lite/`);
  check('轻量观看页 /watch-lite/ 兜底可用', liteWatch.ok, `HTTP ${liteWatch.status}`);
  const channelInfo = await call('GET', '/api/polyv/channel');
  check('频道号接口可用', channelInfo.json?.ok === true, JSON.stringify(channelInfo.json?.data));
  const setChannel = await call('POST', '/api/polyv/channel', { channelId: '1234568' });
  check('运行时设置频道号生效', setChannel.json?.data?.channelId === '1234568');
  const stateAfter = await call('GET', '/api/state');
  check('频道号已同步进 LiveState', stateAfter.json?.channelId === '1234568', stateAfter.json?.channelId);
  const badChannel = await call('POST', '/api/polyv/channel', { channelId: 'a b/c' });
  check('非法频道号返回 400', badChannel.status === 400);
  await call('POST', '/api/polyv/channel', { channelId: '' });
  const polyvMode = await call('GET', '/api/polyv/mode');
  check('演练/真实模式接口可用', polyvMode.json?.ok === true, polyvMode.json?.data?.label);
  const backToMock = await call('POST', '/api/polyv/mode', { useReal: false });
  check('一键切回模拟演练', backToMock.json?.data?.dryRun === true);
  const badSwitch = await call('POST', '/api/polyv/mode', { useReal: 'yes' });
  check('非法 useReal 返回 400', badSwitch.status === 400);

  // 收尾
  await call('POST', '/api/sim/stop');

  console.log(results.join('\n'));
  console.log(`\n[smoke] 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) process.exitCode = 1;
  else console.log('[smoke] ✅ 后端接口全部正常，可以交给 A / C 联调\n');
};

void main().catch((err) => {
  console.error('[smoke] 执行异常：', (err as Error).message);
  console.error('[smoke] 请确认后端已启动：npm run dev:backend');
  process.exitCode = 1;
});
