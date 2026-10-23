/**
 * 保利威真机联调脚本
 *
 *   npm run polyv:live              # 只做连通性 + 签名校验（不会在频道里产生互动）
 *   npm run polyv:live -- --dry     # 打印 8 个动作的真实请求预览（连 sign 都算好，只是不发）
 *   npm run polyv:live -- --fire    # 真的逐个发一遍（会在真实频道里产生互动，慎用）
 *   npm run polyv:live -- --fire --only bulletin,coupon
 *   npm run polyv:live -- --fire --channel 1234568   # 临时指定频道，不改 .env
 *
 * 说明：--dry 与 --fire 走的是同一个 prepare()，保证「测的就是项目实际会发的请求」。
 */
import { config } from '../config.ts';
import { polyvClient } from '../polyv/client.ts';
import { REAL_SPECS } from '../polyv/endpoints.ts';
import type { ActionType } from '../../../shared/types.ts';

const args = process.argv.slice(2);
const has = (f: string): boolean => args.includes(f);
const val = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY = has('--dry');
const FIRE = has('--fire');
const CHANNEL = val('--channel');
if (CHANNEL) {
  polyvClient.setChannelId(CHANNEL);
  console.log(`\n[参数] 频道号已临时切换为 ${CHANNEL}`);
}
const ONLY = val('--only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean) as ActionType[] | undefined;

const mask = (s: string): string => (s ? `${s.slice(0, 4)}****${s.slice(-2)}` : '未配置');
const line = (n = 72): void => console.log('─'.repeat(n));

console.log('\n=========== 保利威真实账号联调 ===========');
line();
console.log(`API 域名        ${config.polyv.apiBase}`);
console.log(`appId           ${mask(config.polyv.appId)}`);
console.log(`appSecret       ${mask(config.polyv.appSecret)}`);
console.log(`channelId       ${polyvClient.channelId || '未配置'}`);
console.log(`USE_REAL_POLYV  ${config.useRealPolyv}`);
console.log(`真实调用可用     ${polyvClient.credentialsReady ? '✅ 是' : '❌ 否'}`);
line();

const status = polyvClient.resourceStatus();
console.log('账号侧资源（真实模式下必需）：');
console.log(`  答题卡 questionId   ${status.questionId ? '✅' : '❌ 缺失'}`);
console.log(`  卡片   cardPushId   ${status.cardPushId ? '✅' : '❌ 缺失'}`);
console.log(`  商品   productId    ${status.productId ? '✅' : '❌ 缺失'}`);
console.log(`  优惠券 couponIds    ${status.couponIds ? '✅' : '❌ 缺失'} ${config.polyv.resources.couponIds.join(',')}`);
line();

if (!polyvClient.credentialsReady) {
  console.log('\n⚠️  当前无法发起真实调用，检查 backend/.env：');
  console.log('    POLYV_APP_ID / POLYV_APP_SECRET / POLYV_CHANNEL_ID 三项必须齐备');
  console.log('    USE_REAL_POLYV=true');
  console.log('\n   提示：本脚本在缺密钥时也能跑 --dry，用来看每个动作会发什么请求。\n');
}

const actions = (Object.keys(REAL_SPECS) as ActionType[]).filter((a) => !ONLY || ONLY.includes(a));

// ---------- 1. 请求预览（不发请求） ----------
console.log('\n【请求预览】按官方契约构造出的真实请求');
line();
for (const action of actions) {
  const spec = REAL_SPECS[action];
  try {
    const req = polyvClient.prepare(action, { params: {}, tolerant: true });
    console.log(`\n${action}  ·  ${spec.label}`);
    console.log(`  ${req.preview}`);
  } catch (err) {
    console.log(`\n${action}  ·  ${spec.label}`);
    console.log(`  ⚠️ 无法构造：${(err as Error).message}`);
  }
}
line();

if (!FIRE) {
  console.log('\n（仅为预览，未发送任何请求）');
  console.log('真机发送：npm run polyv:live -- --fire');
  console.log('只发某几个：npm run polyv:live -- --fire --only bulletin,coupon\n');
  if (!DRY) {
    console.log('　本脚本的连通性校验需要真实请求，请加 --fire 或 --dry 明确意图。\n');
  }
  process.exit(0);
}

// ---------- 2. 真的发 ----------
if (!polyvClient.credentialsReady) {
  console.error('❌ 未配置真实账号，--fire 中止（避免误以为打过真实接口）');
  process.exit(1);
}

console.log('\n【真机发送】这些请求会真的作用在频道 ' + polyvClient.channelId + ' 上');
line();

let okCount = 0;
let failCount = 0;

for (const action of actions) {
  const spec = REAL_SPECS[action];
  const res = await polyvClient.execute(action, { params: {} });
  if (res.ok) okCount += 1;
  else failCount += 1;
  const flag = res.ok ? '✅' : '❌';
  console.log(`${flag} ${action.padEnd(16)} ${spec.path}`);
  console.log(`   code=${res.code}  ${res.message}  (${res.latencyMs ?? 0}ms)`);
  if (!res.ok) console.log(`   回执数据：${JSON.stringify(res.data ?? null).slice(0, 200)}`);
}

line();
console.log(`结果：成功 ${okCount} / 失败 ${failCount} / 共 ${actions.length}`);
if (failCount) {
  console.log('\n常见原因：');
  console.log('  1097 非法的频道ID        → POLYV_CHANNEL_ID 不对，或频道不属于该 appId');
  console.log('  10001 xxx不能为null      → 账号侧资源 ID 没配（见上方资源清单）');
  console.log('  10002 / invalid signature → appSecret 不对，或参数参与签名的范围不对');
  console.log('  20001 application not found → appId 不对');
}
console.log('');
process.exit(failCount ? 1 : 0);
