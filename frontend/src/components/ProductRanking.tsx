/**
 * ProductRanking —— 商品转化榜（点击/下单/GMV/点击转化率，高亮当前讲解商品）
 * 契约：LiveState.productRanking: ProductRank[]（shared/types.ts v1.1，含 gmv）
 * 负责人：A · @since v0.2.0（A-10，补齐分工地图缺口的组件）
 */
import type { LiveState } from '@livepilot/shared';
import { formatGMV, formatInt, formatPct } from '../lib/format';

interface ProductRankingProps {
  state: LiveState | null;
}

export function ProductRanking({ state }: ProductRankingProps) {
  const rows = state?.productRanking ?? [];
  const current = state?.metrics.currentProduct ?? '';

  return (
    <section aria-label="商品转化榜" className="rounded-lg bg-white p-4">
      <h3 className="mb-3 text-sm font-medium text-gray-700">商品转化榜</h3>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-gray-400">等待数据…</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-gray-400">
              <th className="pb-2 font-normal">#</th>
              <th className="pb-2 font-normal">商品</th>
              <th className="pb-2 text-right font-normal">点击</th>
              <th className="pb-2 text-right font-normal">下单</th>
              <th className="pb-2 text-right font-normal">GMV</th>
              <th className="pb-2 text-right font-normal">点击转化</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const active = row.name === current;
              return (
                <tr key={`${row.name}-${i}`} className={active ? 'bg-brand-50' : ''}>
                  <td className="py-1.5 text-gray-400">{i + 1}</td>
                  <td className="py-1.5">
                    <span className={active ? 'font-medium text-brand-800' : 'text-gray-700'}>{row.name}</span>
                    {active && <span className="ml-1 rounded bg-brand-100 px-1 text-[10px] text-brand-800">讲解中</span>}
                  </td>
                  <td className="py-1.5 text-right text-gray-700">{formatInt(row.clicks)}</td>
                  <td className="py-1.5 text-right text-gray-700">{formatInt(row.orders)}</td>
                  <td className="py-1.5 text-right text-gray-700">{formatGMV(row.gmv)}</td>
                  <td className="py-1.5 text-right text-gray-500">
                    {row.clicks > 0 ? formatPct(row.orders / row.clicks) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
