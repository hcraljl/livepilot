/**
 * CopilotPanel —— AI 副驾：经验候选（TF-IDF TopK）+ AI 推荐 + 预览/二次确认执行
 * 契约：GET /api/copilot/candidates、POST /api/copilot/apply（API.md v2 §12，C 扩展）
 * 负责人：A · @since v0.3.0
 *
 * 流程：获取候选 → 选经验 → 选动作（白名单）→ 预览（confirm=false）→ 确认执行（confirm=true）。
 * 这是"人机协同"档位的演示主界面：AI 给建议，人拍板。
 */
import { useState } from 'react';
import type {
  ActionType,
  CopilotActionOption,
  CopilotCandidatesResp,
} from '@livepilot/shared';
import { ACTION_LABELS, AI_LEVEL_LABELS } from '../lib/constants';
import { applyCopilot, fetchCopilotCandidates, type CopilotPreviewPayload } from '../lib/api';

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: CopilotCandidatesResp };

export function CopilotPanel() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [expId, setExpId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionType | null>(null);
  const [preview, setPreview] = useState<CopilotPreviewPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setBusy(true);
    setPhase({ kind: 'loading' });
    setExpId(null);
    setAction(null);
    setPreview(null);
    setHint(null);
    try {
      const data = await fetchCopilotCandidates();
      setPhase({ kind: 'ready', data });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const runApply = async (confirm: boolean): Promise<void> => {
    if (!expId || !action) return;
    setBusy(true);
    setHint(null);
    try {
      const out = await applyCopilot({ experienceId: expId, action, confirm });
      if ('requiresConfirm' in out && out.requiresConfirm) {
        // 预览形状：{ requiresConfirm, preview }——无 decision，不可按 decision 渲染
        setPreview(out.preview);
        setHint('预览已生成，确认后执行');
      } else if ('decision' in out) {
        setHint(`已执行：${out.decision.title || out.decision.rule}（${out.result.mock ? '模拟' : '真实'}）`);
        setPreview(null);
      }
    } catch (e) {
      setHint(`失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const data = phase.kind === 'ready' ? phase.data : null;
  const options: CopilotActionOption[] =
    data?.actions.filter((a) => (expId ? a.experienceId === expId : true)) ?? [];

  return (
    <section aria-label="AI 副驾" className="rounded-lg bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">AI 副驾 · 经验候选</h3>
        <button
          type="button"
          disabled={busy}
          onClick={load}
          className="rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {busy ? '加载中…' : '获取副驾建议'}
        </button>
      </div>

      {phase.kind === 'idle' && (
        <p className="py-4 text-center text-xs text-gray-400">
          点击「获取副驾建议」：按当前直播态势检索历史经验（TF-IDF），AI 按智能档位给出推荐
        </p>
      )}
      {phase.kind === 'loading' && <p className="py-4 text-center text-xs text-gray-400">检索经验库…</p>}
      {phase.kind === 'error' && <p className="py-4 text-center text-xs text-danger-600">{phase.message}</p>}

      {data && (
        <div className="flex flex-col gap-3">
          {/* AI 推荐（off 档为 null） */}
          <div className="rounded-md border border-gray-100 bg-gray-50 p-3 text-xs">
            {data.recommendation ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-800">
                    AI 推荐 · {data.recommendation.source === 'llm' ? 'DeepSeek' : '模板'}
                  </span>
                  <b className="font-medium text-gray-800">
                    {ACTION_LABELS[data.recommendation.action] ?? data.recommendation.action}
                  </b>
                  <span className="ml-auto text-[11px] text-gray-400">档位：{AI_LEVEL_LABELS[data.aiLevel]}</span>
                </div>
                <p className="mt-1 leading-relaxed text-gray-600">{data.recommendation.reason}</p>
              </>
            ) : (
              <p className="text-gray-500">
                当前为「{AI_LEVEL_LABELS[data.aiLevel]}」档，AI 不推荐——请人工从下方经验中选择。
              </p>
            )}
          </div>

          {/* 经验候选列表 */}
          <div>
            <p className="mb-1 text-[11px] font-medium text-gray-500">
              历史经验 Top{data.experiences.length}（相似度排序，点击选择）
            </p>
            <ul className="flex flex-col gap-1.5">
              {data.experiences.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setExpId(e.id);
                      setAction(null);
                      setPreview(null);
                      const first = data.actions.find((a) => a.experienceId === e.id);
                      if (first) setAction(first.action);
                    }}
                    className={`w-full rounded-md border p-2 text-left text-xs transition-colors ${
                      expId === e.id ? 'border-brand-200 bg-brand-50' : 'border-gray-100 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <b className="font-medium text-gray-700">{e.title}</b>
                      <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-500">
                        {e.source === 'review' ? '复盘沉淀' : '运营手册'}
                      </span>
                      <span className="ml-auto text-[11px] text-gray-400">
                        相似度 {(e.similarity * 100).toFixed(0)}%
                      </span>
                    </div>
                    {e.result && (
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        历史效果：下单 +{e.result.incrementalOrders} · GMV +¥{e.result.incrementalGmv} · 提升{' '}
                        {(e.result.liftPct * 100).toFixed(0)}%
                      </p>
                    )}
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-gray-500">{e.takeaways.join('；')}</p>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* 动作白名单 + 预览/执行 */}
          {expId && (
            <div className="flex flex-col gap-2 rounded-md border border-gray-100 p-3">
              <p className="text-[11px] font-medium text-gray-500">可复用动作（白名单）</p>
              <div className="flex flex-wrap gap-1.5">
                {options.map((o) => (
                  <button
                    key={`${o.experienceId}-${o.action}`}
                    type="button"
                    onClick={() => {
                      setAction(o.action);
                      setPreview(null);
                    }}
                    className={`rounded px-2 py-1 text-xs transition-colors ${
                      action === o.action
                        ? 'bg-brand-600 text-white'
                        : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {o.label || ACTION_LABELS[o.action] || o.action}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy || !action}
                  onClick={() => runApply(false)}
                  className="rounded-md border border-gray-200 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  预览
                </button>
                <button
                  type="button"
                  disabled={busy || !action || !preview}
                  title={preview ? '二次确认后执行' : '请先预览'}
                  onClick={() => runApply(true)}
                  className="rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-40"
                >
                  确认执行
                </button>
                {hint && <span className="text-[11px] text-gray-500">{hint}</span>}
              </div>
              {preview && (
                <div className="rounded bg-gray-50 p-2 text-[11px] text-gray-600">
                  <b className="text-gray-700">
                    {preview.label} · 复用「{preview.experienceTitle}」
                  </b>
                  {preview.path && (
                    <p className="mt-0.5 text-gray-400">
                      {preview.method} {preview.path}
                    </p>
                  )}
                  <pre className="mt-1 overflow-auto text-gray-400">
                    {JSON.stringify(preview.payload, null, 1)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
