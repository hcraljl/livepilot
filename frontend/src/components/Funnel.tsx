/**
 * Funnel —— 转化漏斗：观看 → 互动 → 点击 → 下单（每层转化率）
 * 契约：LiveState.funnel（shared/types.ts v1.1）
 * 负责人：A · @since v0.2.0（A-06）
 */
import type { Funnel as FunnelData } from '@livepilot/shared';
import { formatInt, formatPct } from '../lib/format';

const LAYERS: { key: keyof FunnelData; label: string }[] = [
  { key: 'view', label: '观看' },
  { key: 'interact', label: '互动参与' },
  { key: 'click', label: '商品点击' },
  { key: 'order', label: '下单' },
];

interface FunnelProps {
  funnel: FunnelData | null;
}

export function Funnel({ funnel }: FunnelProps) {
  const max = funnel ? Math.max(funnel.view, 1) : 1;

  return (
    <section aria-label="转化漏斗" className="rounded-lg bg-white p-4">
      <h3 className="mb-3 text-sm font-medium text-gray-700">转化漏斗</h3>
      {!funnel ? (
        <p className="py-6 text-center text-xs text-gray-400">等待数据…</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {LAYERS.map((layer, i) => {
            const value = funnel[layer.key];
            const prev = i === 0 ? null : funnel[LAYERS[i - 1].key];
            const rate = prev && prev > 0 ? value / prev : null;
            return (
              <li key={layer.key}>
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>{layer.label}</span>
                  <span>
                    <b className="font-medium text-gray-800">{formatInt(value)}</b>
                    {rate !== null && <span className="ml-2 text-gray-400">转化 {formatPct(rate)}</span>}
                  </span>
                </div>
                <div className="mt-1 h-6 w-full overflow-hidden rounded bg-gray-50">
                  <div
                    className="flex h-full items-center rounded bg-brand-400 transition-[width] duration-300"
                    style={{ width: `${Math.max((value / max) * 100, 1.5)}%` }}
                  >
                    {value / max > 0.12 && (
                      <span className="pl-2 text-[11px] font-medium text-white">{formatInt(value)}</span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
