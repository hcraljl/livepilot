/**
 * 账号侧互动资源盘点 —— 填 .env 前先跑一次，直接告诉你有哪些 ID 可用
 *
 * 用法：
 *   npm run polyv:res -w backend
 *   npm run polyv:res -w backend -- --channel 8659539
 *
 * 输出四类资源的真实清单（商品 / 优惠券 / 推送卡片 / 抽奖活动），
 * 以及在 .env 里该填成什么样；为空会明确说明「该动作只能降级」。
 */
import { config } from '../config.ts';
import { polyvClient } from '../polyv/client.ts';
import { signParams } from '../polyv/sign.ts';

const args = process.argv.slice(2);
const val = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const channelId = val('--channel') ?? polyvClient.channelId;
if (!channelId) {
  console.error('❌ 没有频道号：请配置 POLYV_CHANNEL_ID 或用 --channel 指定');
  process.exit(1);
}
if (!polyvClient.credentialsReady) {
  console.error('❌ 未配置 appId / appSecret，无法盘点（请先填 backend/.env）');
  process.exit(1);
}

const LINE = '─'.repeat(72);

interface Probe {
  label: string;
  path: string;
  params: Record<string, string>;
  envKey: string;
  /** 从返回 JSON 里取出 [{ id, name }] */
  extract: (data: unknown) => { id: string; name: string }[];
}

const pickArray = (data: unknown): unknown[] => {
  if (Array.isArray(data)) return data;
  const d = data as { contents?: unknown[]; list?: unknown[] } | null;
  return d?.contents ?? d?.list ?? [];
};

const PROBES: Probe[] = [
  {
    label: '商品库商品',
    path: '/live/v3/channel/product/list',
    params: { channelId, page: '1', pageSize: '50' },
    envKey: 'POLYV_PRODUCT_ID',
    extract: (d) =>
      pickArray(d).map((x) => {
        const o = x as { productId?: number | string; id?: number | string; name?: string; title?: string };
        return { id: String(o.productId ?? o.id ?? ''), name: String(o.name ?? o.title ?? '') };
      }),
  },
  {
    label: '推送卡片',
    path: '/live/v4/channel/card-push/list',
    params: { channelId, page: '1', pageSize: '50' },
    envKey: 'POLYV_CARD_PUSH_ID',
    extract: (d) =>
      pickArray(d).map((x) => {
        const o = x as { id?: number | string; cardPushId?: number | string; title?: string; name?: string };
        return { id: String(o.cardPushId ?? o.id ?? ''), name: String(o.title ?? o.name ?? '') };
      }),
  },
  {
    label: '抽奖活动（不含答题卡）',
    path: '/live/v4/channel/lottery-activity/list',
    params: { channelId, pageNumber: '1', pageSize: '20' },
    envKey: '',
    extract: (d) =>
      pickArray(d).map((x) => {
        const o = x as { id?: number | string; activityName?: string; lotteryCondition?: string };
        return { id: String(o.id ?? ''), name: `${o.activityName ?? ''}（${o.lotteryCondition ?? ''}）` };
      }),
  },
];

async function call(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(
    Object.entries(signParams(params) as Record<string, string>).map(([k, v]) => [k, String(v)]),
  ).toString();
  const res = await fetch(`${config.polyv.apiBase}${path}?${qs}`, {
    signal: AbortSignal.timeout(config.polyv.timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as { code?: number; data?: unknown; error?: { desc?: string } };
  return { ok: res.status === 200, code: json.code ?? res.status, data: json.data, err: json.error?.desc };
}

console.log(`\n${LINE}\n账号侧互动资源盘点 · 频道 ${channelId}\n${LINE}`);

const summary: string[] = [];

for (const p of PROBES) {
  const r = await call(p.path, p.params);
  if (!r.ok) {
    console.log(`\n${p.label}  ❌ 查询失败（code=${r.code} ${r.err ?? ''}）`);
    continue;
  }
  const items = p.extract(r.data).filter((x) => x.id);
  if (items.length === 0) {
    console.log(`\n${p.label}  ⚠️  空（0 条）`);
    if (p.envKey) summary.push(`${p.envKey} 无可用值 → 相关动作会降级`);
    continue;
  }
  console.log(`\n${p.label}  ✅ ${items.length} 条`);
  for (const it of items.slice(0, 8)) console.log(`    ${it.id.padEnd(12)} ${it.name}`);
  if (items.length > 8) console.log(`    … 其余 ${items.length - 8} 条省略`);
  if (p.envKey) {
    const ids = items.map((x) => x.id);
    const v = p.envKey === 'POLYV_COUPON_IDS' ? ids.join(',') : ids[0];
    summary.push(`${p.envKey}=${v}`);
  }
}

console.log(`\n${LINE}`);
if (summary.length) {
  console.log('可直接粘进 backend/.env：\n');
  for (const s of summary) console.log(`  ${s}`);
} else {
  console.log('账号里还没有可用的商品 / 优惠券 / 卡片，真实模式下这三个动作会自动降级。');
}
console.log(`${LINE}\n`);
process.exit(0);
