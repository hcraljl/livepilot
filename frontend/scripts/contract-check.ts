/**
 * 跨端契约一致性自检
 *
 * 为什么需要：
 * A 的 useSSE 对每一帧做严格守卫 isLiveState()，任一字段不合规即整帧丢弃，
 * 界面会一直停在空态 —— 这是最隐蔽的集成故障（接口全 200，但界面没数据）。
 * 本脚本取后端真实 SSE 帧，直接调用 A 的守卫函数，逐层定位问题字段。
 *
 * 使用：先启动后端，再执行
 *   npm run contract:check
 */
import { isLiveState, isDecision, isMetrics } from '../src/lib/validate.ts';

const BASE = process.env.LP_BASE ?? 'http://127.0.0.1:4000';

/** 读取 SSE 第一个含 data 的帧（首个事件可能只是 `retry: 3000` 指令） */
const readFirstFrame = async (): Promise<unknown> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${BASE}/api/stream`, {
      headers: { Accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          await reader.cancel();
          return JSON.parse(line.slice(6));
        }
        idx = buf.indexOf('\n\n');
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const DECISION_STATUSES = ['suggested', 'pending_confirm', 'executed', 'failed'];

const STRATEGY_FIELDS = [
  'enabled',
  'aiLevel',
  'experienceTopK',
  'retentionDropPct',
  'retentionWindowSec',
  'conversionCtrThreshold',
  'conversionWindowSec',
  'coldDanmakuRate',
  'coldWindowSec',
  'gmvTarget',
  'pushWindowMin',
  'cooldownSec',
];

const main = async (): Promise<void> => {
  const frame = await readFirstFrame();
  if (!frame) {
    console.log('❌ 未取到 SSE 帧，确认后端已启动：npm run dev:backend');
    process.exit(1);
  }

  let failed = 0;
  const s = frame as Record<string, unknown>;

  const wholeOk = isLiveState(frame);
  console.log(`SSE 首帧整体守卫 isLiveState() → ${wholeOk ? '✅ 通过（界面能拿到数据）' : '❌ 不通过（界面会一直空）'}`);
  if (!wholeOk) failed += 1;

  const metrics = (s.metrics ?? {}) as Record<string, unknown>;
  const metricsOk = isMetrics(metrics);
  console.log(`  metrics 守卫 → ${metricsOk ? '✅' : '❌'}  keys=${Object.keys(metrics).join(',')}`);
  if (!metricsOk) failed += 1;

  const decs = (s.decisions as unknown[]) ?? [];
  const bad = decs.filter((d) => !isDecision(d));
  console.log(`  决策 ${decs.length} 条 → ${bad.length === 0 ? '✅ 全部合规' : `❌ ${bad.length} 条不合规`}`);
  if (bad.length > 0) failed += 1;
  for (const d of bad.slice(0, 3)) {
    const o = d as Record<string, unknown>;
    const miss: string[] = [];
    if (typeof o.channelId !== 'string') miss.push('channelId');
    if (typeof o.rule !== 'string') miss.push('rule');
    if (typeof o.reason !== 'string') miss.push('reason');
    if (!DECISION_STATUSES.includes(String(o.status))) miss.push(`status=${String(o.status)}`);
    console.log('    ↳ 异常字段:', miss.join(', ') || '(其他)', '| id=', String(o.id));
  }

  const strat = (s.strategy ?? {}) as Record<string, unknown>;
  const missStrat = STRATEGY_FIELDS.filter((k) => strat[k] === undefined);
  console.log(`  strategy 12 字段 → ${missStrat.length === 0 ? '✅' : `❌ 缺 ${missStrat.join(',')}`}`);
  if (missStrat.length > 0) failed += 1;

  console.log(
    `  timeline ${(s.timeline as unknown[])?.length ?? 0} 点 | events ${(s.events as unknown[])?.length ?? 0} 条 | ranking ${(s.productRanking as unknown[])?.length ?? 0} 条`,
  );
  console.log(
    `  source=${String(s.source)} | mode=${String(s.mode)} | running=${String(s.running)} | channelId=${JSON.stringify(s.channelId)}`,
  );

  if (failed > 0) {
    console.log(`\n❌ ${failed} 项不一致，前后端契约已漂移，请对齐 shared/types.ts`);
    process.exit(1);
  }
  console.log('\n✅ 前后端契约一致，A 的界面可以正常渲染');
};

void main();
