/**
 * ReviewPage —— 智能复盘页：渲染 ReplayResp（文本报告 + 结构化五段 + C 的完整归因报告）
 * 契约：GET /api/replay → ReplayResp（v2：report / structured / review: ReviewReport）
 *       GET /api/session/export?download=1（全量数据下载）
 * 负责人：A · @since v0.2.0（A-11；v0.3.0 补 ReviewReport 归因榜渲染）
 */
import { useCallback, useEffect, useState } from 'react';
import type { AttributionItem, ExperienceMatch, ReplayResp } from '@livepilot/shared';
import { fetchReplay, sessionExportUrl } from '../lib/api';
import { formatGMV, formatInt } from '../lib/format';
import { ProductRankingTable } from './ProductRanking';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: ReplayResp };

/** 归因信心中文名 @since v0.3.0 */
const CONFIDENCE_LABELS: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** 归因榜（C 的时间窗口归因：窗口增量 − 自然基线） @since v0.3.0 */
function Leaderboard({ items }: { items: AttributionItem[] }) {
  if (items.length === 0) {
    return <p className="text-xs text-gray-400">本场无 AI 互动</p>;
  }
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="text-gray-400">
          <th className="pb-2 font-normal">互动</th>
          <th className="pb-2 font-normal">规则</th>
          <th className="pb-2 text-right font-normal">窗口 GMV</th>
          <th className="pb-2 text-right font-normal">增量下单</th>
          <th className="pb-2 text-right font-normal">增量 GMV</th>
          <th className="pb-2 text-right font-normal">提升</th>
          <th className="pb-2 text-right font-normal">信心</th>
        </tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={a.decisionId}>
            <td className="py-1.5 text-gray-700">{a.title}</td>
            <td className="py-1.5 text-gray-500">{a.ruleName || a.rule}</td>
            <td className="py-1.5 text-right text-gray-700">{formatGMV(a.windowGmv)}</td>
            <td className="py-1.5 text-right text-gray-700">+{formatInt(a.incrementalOrders)}</td>
            <td className="py-1.5 text-right text-gray-700">{formatGMV(a.incrementalGmv)}</td>
            <td className="py-1.5 text-right text-success-600">+{(a.liftPct * 100).toFixed(0)}%</td>
            <td className="py-1.5 text-right text-gray-500">{CONFIDENCE_LABELS[a.confidence] ?? a.confidence}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 可复用历史经验（TF-IDF 匹配） @since v0.3.0 */
function ExperienceList({ items }: { items: ExperienceMatch[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((e) => (
        <li key={e.id} className="rounded-md border border-gray-100 p-2.5">
          <div className="flex items-center gap-2">
            <b className="text-xs font-medium text-gray-700">{e.title}</b>
            <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-500">
              {e.source === 'review' ? '复盘沉淀' : '运营手册'}
            </span>
            <span className="ml-auto text-[11px] text-gray-400">相似度 {(e.similarity * 100).toFixed(0)}%</span>
          </div>
          {e.result && (
            <p className="mt-1 text-[11px] text-gray-400">
              效果：下单 +{e.result.incrementalOrders} · GMV +¥{e.result.incrementalGmv} · 提升{' '}
              {(e.result.liftPct * 100).toFixed(0)}%
            </p>
          )}
          <ul className="mt-1 flex flex-col gap-0.5">
            {e.takeaways.map((t, i) => (
              <li key={i} className="text-[11px] leading-relaxed text-gray-500">
                · {t}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function ReviewPage() {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    fetchReplay()
      .then((data) => {
        if (!cancelled) setLoad({ kind: 'ready', data });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <header className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-medium text-gray-800">智能复盘</h2>
          <button
            type="button"
            onClick={reload}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          >
            重新生成
          </button>
          <a
            href={sessionExportUrl}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          >
            导出本场数据（JSON）
          </a>
          {load.kind === 'ready' && (
            <span className="ml-auto flex items-center gap-2 text-[11px] text-gray-400">
              <span className={`rounded px-1.5 py-0.5 ${load.data.engine === 'ai' ? 'bg-brand-50 text-brand-800' : 'bg-gray-100 text-gray-500'}`}>
                {load.data.engine === 'ai' ? 'DeepSeek 生成' : '模板兜底'}
              </span>
              {new Date(load.data.generatedAt).toLocaleString('zh-CN')}
            </span>
          )}
        </header>

        {load.kind === 'loading' && <p className="py-16 text-center text-xs text-gray-400">复盘生成中…</p>}
        {load.kind === 'error' && (
          <div className="rounded-lg border border-danger-200 bg-danger-50 p-4 text-xs text-danger-700">
            复盘获取失败：{load.message}（请确认后端已启动）
          </div>
        )}

        {load.kind === 'ready' && (
          <>
            {/* 文本报告（兜底或 AI 版都先渲染它） */}
            <section className="rounded-lg bg-white p-4">
              <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-gray-700">
                {load.data.report}
              </pre>
            </section>

            {/* C 的完整归因报告（优先渲染） */}
            {load.data.review ? (
              <>
                <section className="rounded-lg bg-white p-4">
                  <h3 className="mb-2 text-sm font-medium text-gray-700">本场速览</h3>
                  <div className="flex flex-wrap gap-2">
                    {[
                      ['峰值在线', formatInt(load.data.review.live.peakOnline)],
                      ['末场在线', formatInt(load.data.review.live.finalOnline)],
                      ['累计观看', formatInt(load.data.review.live.totalViewers)],
                      ['下单', formatInt(load.data.review.live.finalOrders)],
                      ['GMV', formatGMV(load.data.review.live.finalGmv)],
                      ['AI 互动', `${load.data.review.live.actionCount} 次`],
                    ].map(([k, v]) => (
                      <span key={k} className="rounded bg-gray-50 px-2.5 py-1.5 text-xs text-gray-600">
                        {k} <b className="font-medium text-gray-800">{v}</b>
                      </span>
                    ))}
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-gray-600">{load.data.review.overview}</p>
                </section>

                <section className="rounded-lg bg-white p-4">
                  <h3 className="mb-2 text-sm font-medium text-gray-700">互动效果榜（时间窗口归因）</h3>
                  <Leaderboard items={load.data.review.leaderboard} />
                </section>

                {/* 商品转化榜（v0.4.0：复盘的最后一问"哪款卖动了"） */}
                {load.data.review.productRanking && load.data.review.productRanking.length > 0 && (
                  <section className="rounded-lg bg-white p-4">
                    <h3 className="mb-2 text-sm font-medium text-gray-700">本场商品转化榜</h3>
                    <ProductRankingTable rows={load.data.review.productRanking} emptyText="本场无商品数据" />
                  </section>
                )}

                {load.data.review.bestWindow && (
                  <section className="rounded-lg bg-white p-4">
                    <h3 className="mb-2 text-sm font-medium text-gray-700">最佳互动时段</h3>
                    <p className="text-xs text-gray-600">
                      第 {Math.round(load.data.review.bestWindow.startMin)}′ –{' '}
                      {Math.round(load.data.review.bestWindow.endMin)}′ ·{' '}
                      {load.data.review.bestWindow.label} · 增量 GMV{' '}
                      {formatGMV(load.data.review.bestWindow.incrementalGmv)}
                    </p>
                  </section>
                )}

                <section className="rounded-lg bg-white p-4">
                  <h3 className="mb-2 text-sm font-medium text-gray-700">归因结论</h3>
                  <p className="text-xs leading-relaxed text-gray-600">{load.data.review.conclusion}</p>
                </section>

                <section className="rounded-lg bg-white p-4">
                  <h3 className="mb-2 text-sm font-medium text-gray-700">下次优化建议</h3>
                  <ul className="flex flex-col gap-1.5">
                    {load.data.review.suggestions.map((s, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed text-gray-600">
                        <span className="text-brand-600">{i + 1}.</span>
                        {s}
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="rounded-lg bg-white p-4">
                  <h3 className="mb-2 text-sm font-medium text-gray-700">可复用经验（已入经验库）</h3>
                  <ExperienceList items={load.data.review.experiences} />
                </section>
              </>
            ) : (
              /* 兜底/旧版结构化（B 的 replay-fallback 形状） */
              load.data.structured && (
                <>
                  <section className="rounded-lg bg-white p-4">
                    <h3 className="mb-2 text-sm font-medium text-gray-700">结论摘要</h3>
                    <p className="text-xs leading-relaxed text-gray-600">{load.data.structured.summary}</p>
                  </section>

                  <section className="rounded-lg bg-white p-4">
                    <h3 className="mb-2 text-sm font-medium text-gray-700">本场关键指标</h3>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(load.data.structured.keyMetrics).map(([k, v]) =>
                        typeof v === 'number' ? (
                          <span key={k} className="rounded bg-gray-50 px-2 py-1 text-xs text-gray-600">
                            {k}: {k === 'gmv' ? formatGMV(v) : formatInt(v)}
                          </span>
                        ) : null,
                      )}
                    </div>
                  </section>

                  <section className="rounded-lg bg-white p-4">
                    <h3 className="mb-2 text-sm font-medium text-gray-700">互动效果榜</h3>
                    <Leaderboard items={load.data.structured.leaderboard ?? []} />
                  </section>

                  {load.data.structured.bestWindow && (
                    <section className="rounded-lg bg-white p-4">
                      <h3 className="mb-2 text-sm font-medium text-gray-700">最佳互动时段</h3>
                      <p className="text-xs text-gray-600">
                        {Math.round(load.data.structured.bestWindow.from / 60000)}′ –{' '}
                        {Math.round(load.data.structured.bestWindow.to / 60000)}′ ·{' '}
                        {load.data.structured.bestWindow.note}
                      </p>
                    </section>
                  )}

                  <section className="rounded-lg bg-white p-4">
                    <h3 className="mb-2 text-sm font-medium text-gray-700">下次优化建议</h3>
                    <ul className="flex flex-col gap-1.5">
                      {load.data.structured.suggestions.map((s, i) => (
                        <li key={i} className="flex gap-2 text-xs leading-relaxed text-gray-600">
                          <span className="text-brand-600">{i + 1}.</span>
                          {s}
                        </li>
                      ))}
                    </ul>
                  </section>

                  {load.data.structured.experiences && load.data.structured.experiences.length > 0 && (
                    <section className="rounded-lg bg-white p-4">
                      <h3 className="mb-2 text-sm font-medium text-gray-700">可复用经验</h3>
                      <ExperienceList items={load.data.structured.experiences} />
                    </section>
                  )}
                </>
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}
