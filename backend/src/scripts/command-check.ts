/**
 * 指令解析自检（不依赖网络、不依赖 LLM Key）
 *
 * 用法：npm run cmd:check -w backend
 * 目的：改了词典/正则后，5 秒内确认常见说法没有回归——演示现场不能靠"应该没问题"。
 */
import { parseCommandWithRules, type ParseContext } from '../commands/parse.ts';

const ctx: ParseContext = {
  now: new Date('2026-10-24T14:00:00+08:00').getTime(),
  channelId: '8659539',
  productNames: ['山野茶油 500ml', '现摘赣南脐橙 5 斤', '古法酿造酱油 2 瓶装'],
};

interface Case {
  text: string;
  action: string | null;
  delaySec?: number;
  condition?: string | null;
}

const CASES: Case[] = [
  { text: '五分钟后发一个签到', action: 'checkin', delaySec: 300 },
  { text: '5分钟后发签到', action: 'checkin', delaySec: 300 },
  { text: '半小时后发一个福利抽奖', action: 'welfare_lottery', delaySec: 1800 },
  { text: '马上发个抽奖', action: 'lottery', delaySec: 0 },
  { text: '两分钟后推一下答题卡', action: 'answer_card', delaySec: 120 },
  { text: '10 分钟后推一下山野茶油', action: 'push_product', delaySec: 600 },
  { text: '立刻发公告提醒大家领券', action: 'bulletin', delaySec: 0 },
  { text: '在线跌破1000就发抽奖', action: 'lottery', condition: 'online_below' },
  { text: '人氣超过 3000 的时候发福袋', action: 'lottery', condition: 'online_above' },
  { text: '１５分钟后发打卡', action: 'checkin', delaySec: 900 },
  { text: '今天天气不错', action: null },
  { text: '3 小时后发签到', action: null },
];

let pass = 0;
const failures: string[] = [];

for (const item of CASES) {
  const parsed = parseCommandWithRules(item.text, ctx);
  const okAction = (parsed.action ?? null) === item.action;
  const okDelay = item.delaySec === undefined || parsed.delaySec === item.delaySec;
  const okCond = item.condition === undefined || (parsed.condition?.kind ?? null) === item.condition;
  if (okAction && okDelay && okCond) {
    pass += 1;
    console.log(`✓ ${item.text}  →  ${parsed.actionLabel}${parsed.condition ? `〔${parsed.condition.label}〕` : ''} · delay=${parsed.delaySec}s`);
  } else {
    failures.push(
      `✗ ${item.text}  →  action=${parsed.action} delay=${parsed.delaySec} cond=${parsed.condition?.kind ?? 'null'}｜${parsed.note}`,
    );
  }
}

console.log('');
if (failures.length > 0) {
  console.log(failures.join('\n'));
  console.error(`\n❌ 指令解析自检失败：${pass}/${CASES.length} 通过`);
  process.exit(1);
}
console.log(`✅ 指令解析自检通过：${pass}/${CASES.length}`);
