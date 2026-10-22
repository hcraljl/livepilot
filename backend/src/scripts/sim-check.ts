/**
 * 无界面流水线自检（不启 HTTP，不依赖前端）
 *
 * 用途：改完模拟器 / store 后，一条命令验证「跑完整场直播 → 指标合理 → 场景都触发 → 事件流完整」。
 * 用法：npm run sim:check -w backend
 */
import { store } from '../store/state.ts';
import { simulator } from '../simulator/simulator.ts';

const run = async (): Promise<void> => {
  const seenScenarios = new Set<string>();

  const done = new Promise<void>((resolve) => {
    const unsub = store.subscribe((s) => {
      for (const e of s.events) {
        if (e.type === 'scenario') seenScenarios.add(e.title.replace('场景注入：', ''));
      }
      if (s.startedAt && !s.running && s.endedAt) {
        unsub();
        resolve();
      }
    });
  });

  console.log('[check] 启动模拟器：30 分钟场次，加速 300x（约 5~8 秒跑完）');
  simulator.start({ totalMin: 30, speed: 300, tickMs: 2 });

  await done;

  const s = store.snapshot();
  const m = s.metrics;
  const executed = s.decisions.filter((d) => d.status === 'executed');

  console.log('\n========== 模拟场次结果 ==========');
  console.log(`会话        ${s.sessionId}（${s.source} / ${s.mode}）`);
  console.log(`时长        ${m.elapsedMin.toFixed(1)} / ${m.totalMin} 分钟`);
  console.log(`峰值在线    ${Math.max(...s.timeline.map((p) => p.online), 0)} 人`);
  console.log(`累计观看    ${m.totalViewers}`);
  console.log(`下单 / GMV  ${m.orders} 单 / ¥${Math.round(m.gmv)}`);
  console.log(`商品点击    ${m.productClicks}`);
  console.log(`漏斗        ${JSON.stringify(s.funnel)}`);
  console.log(`决策        ${s.decisions.length} 条（已执行 ${executed.length}）`);
  console.log(`场景触发    ${[...seenScenarios].join(' / ') || '无'}`);
  console.log(`事件        ${s.events.length} 条 · 时间轴 ${s.timeline.length} 点`);
  console.log(`商品榜 Top3 ${s.productRanking.slice(0, 3).map((p) => `${p.name}(¥${Math.round(p.gmv)})`).join(' | ')}`);
  console.log('=================================\n');

  const okShape =
    s.timeline.length > 20 &&
    m.totalViewers > 100 &&
    m.orders > 0 &&
    m.gmv > 0 &&
    seenScenarios.size >= 3 &&
    s.events.length > 5;

  if (okShape) {
    console.log('✅ 流水线自检通过：指标 / 场景 / 事件流都在正常产出');
  } else {
    console.error('❌ 自检未通过：请检查模拟器场景排布或 store 写入');
    process.exitCode = 1;
  }
};

void run();
