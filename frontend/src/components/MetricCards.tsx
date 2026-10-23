/**
 * MetricCards —— 6 张核心指标卡（在线/累计观看/商品点击/下单/GMV/互动率）
 * 带迷你趋势线（取 state.timeline，无序列字段自动省略）与 1 分钟环比
 * 契约：Metrics + TimelinePoint（shared/types.ts v1.1）
 * 负责人：A · @since v0.2.0（A-05）
 */
import type { LiveState, Metrics, TimelinePoint } from '@livepilot/shared';
import { formatGMV, formatInt, formatPct } from '../lib/format';

interface CardDef {
  key: string;
  label: string;
  value: (m: Metrics) => number;
  format: (n: number) => string;
  /** timeline 中对应的序列字段；无则不画趋势线 @since v0.2.0 */
  series?: (p: TimelinePoint) => number;
}

const CARDS: CardDef[] = [
  { key: 'online', label: '在线人数', value: (m) => m.online, format: formatInt, series: (p) => p.online },
  { key: 'totalViewers', label: '累计观看', value: (m) => m.totalViewers, format: formatInt },
  { key: 'productClicks', label: '商品点击', value: (m) => m.productClicks, format: formatInt },
  { key: 'orders', label: '下单笔数', value: (m) => m.orders, format: formatInt, series: (p) => p.orders },
  { key: 'gmv', label: 'GMV', value: (m) => m.gmv, format: formatGMV, series: (p) => p.gmv },
  { key: 'danmakuRate', label: '互动率', value: (m) => m.danmakuRate, format: (n) => formatPct(n), series: (p) => p.danmakuRate },
];

/** 迷你趋势线（纯 SVG，不引图表库） @since v0.2.0 */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="h-[32px]" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * 100},${30 - ((v - min) / span) * 28 - 1}`)
    .join(' ');
  const lastX = 100;
  const lastY = 30 - ((points[points.length - 1] - min) / span) * 28 - 1;
  return (
    <svg viewBox="0 0 100 30" className="h-[32px] w-full" preserveAspectRatio="none" aria-hidden="true">
      <path d={path} fill="none" stroke="#378ADD" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} r="2" fill="#185FA5" />
    </svg>
  );
}

/** 1 分钟环比：取 timeline 中距当前约 1 分钟的点做基线 @since v0.2.0 */
function trendDelta(card: CardDef, state: LiveState): { pct: number } | null {
  if (!card.series || state.timeline.length < 2) return null;
  const target = state.metrics.elapsedMin - 1;
  let past: TimelinePoint | undefined;
  for (const p of state.timeline) {
    if (p.t <= target) past = p;
    else break;
  }
  if (!past) return null;
  const before = card.series(past);
  const now = card.value(state.metrics);
  if (before === 0) return now > 0 ? { pct: 100 } : null;
  return { pct: ((now - before) / Math.abs(before)) * 100 };
}

function MetricCard({ card, state }: { card: CardDef; state: LiveState | null }) {
  const current = state ? card.value(state.metrics) : null;
  const series =
    state && card.series
      ? state.timeline.slice(-60).map(card.series as (p: TimelinePoint) => number)
      : [];
  const trend = state ? trendDelta(card, state) : null;

  return (
    <div className="rounded-lg bg-white p-4 shadow-[0_0_0_0.5px_rgba(0,0,0,0.06)]">
      <p className="text-xs text-gray-500">{card.label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <b className="text-2xl font-medium text-gray-900">{current === null ? '—' : card.format(current)}</b>
        {trend && (
          /* whitespace-nowrap：1280 宽下「▲ 89%」曾被挤成两行（v0.4.0） */
          <span
            className={`whitespace-nowrap text-xs font-medium ${
              trend.pct >= 0 ? 'text-success-600' : 'text-danger-600'
            }`}
          >
            {trend.pct >= 0 ? '▲' : '▼'} {Math.abs(trend.pct).toFixed(0)}%
          </span>
        )}
      </div>
      <div className="mt-2">
        <Sparkline points={series} />
      </div>
      <p className="mt-1 text-[11px] text-gray-400">较 1 分钟前</p>
    </div>
  );
}

interface MetricCardsProps {
  state: LiveState | null;
}

export function MetricCards({ state }: MetricCardsProps) {
  return (
    <section aria-label="核心指标" className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      {CARDS.map((card) => (
        <MetricCard key={card.key} card={card} state={state} />
      ))}
    </section>
  );
}
