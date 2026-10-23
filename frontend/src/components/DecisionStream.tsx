/**
 * DecisionStream —— AI 决策流面板：四态徽章 + 半自动确认执行 + 触发理由
 * 契约：Decision / DecisionStatus / PolyvCallResult（shared/types.ts v1.1）
 *       POST /api/decision/confirm（API.md v1.1）
 * 负责人：A · @since v0.2.0（A-08）
 */
import { useState } from 'react';
import type { Decision, LiveState } from '@livepilot/shared';
import { ACTION_LABELS, DECISION_STATUS_LABELS } from '../lib/constants';
import { confirmDecision } from '../lib/api';

const STATUS_STYLE: Record<Decision['status'], string> = {
  suggested: 'bg-brand-50 text-brand-800',
  pending_confirm: 'bg-warn-50 text-warn-800',
  executed: 'bg-success-50 text-success-800',
  failed: 'bg-danger-50 text-danger-800',
};

/** 单条决策（半自动态的确认交互在这里） @since v0.2.0 */
function DecisionItem({
  decision,
  onConfirmed,
}: {
  decision: Decision;
  onConfirmed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await confirmDecision(decision.id);
      onConfirmed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-md border border-gray-100 bg-white p-3">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[decision.status]}`}>
          {DECISION_STATUS_LABELS[decision.status]}
        </span>
        <b className="text-xs font-medium text-gray-800">{decision.title || decision.rule}</b>
        <span className="text-[11px] text-gray-400">{ACTION_LABELS[decision.action]}</span>
        <span className="ml-auto text-[11px] text-gray-400">
          {new Date(decision.ts).toLocaleTimeString('zh-CN')}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-gray-600">{decision.reason}</p>
      {decision.expectedEffect && (
        <p className="mt-1 text-[11px] text-gray-400">预期：{decision.expectedEffect}</p>
      )}
      {decision.outcome && (
        <p className="mt-1 text-[11px] text-success-600">
          归因增量：下单 +{decision.outcome.incrementalOrders} · GMV +¥{decision.outcome.incrementalGmv} · 提升{' '}
          {(decision.outcome.liftPct * 100).toFixed(0)}%（信心{decision.outcome.confidence === 'high' ? '高' : decision.outcome.confidence === 'medium' ? '中' : '低'}）
        </p>
      )}
      {decision.result && (
        <p className="mt-1 text-[11px] text-gray-400">
          {decision.result.mock ? '模拟执行' : '真实调用'} · code {decision.result.code}
          {decision.result.endpoint ? ` · ${decision.result.endpoint}` : ''}
        </p>
      )}
      {decision.status === 'pending_confirm' && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleConfirm}
            className="rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {busy ? '执行中…' : '确认执行'}
          </button>
          {error && <span className="text-[11px] text-danger-600">{error}</span>}
        </div>
      )}
    </li>
  );
}

interface DecisionStreamProps {
  state: LiveState | null;
}

export function DecisionStream({ state }: DecisionStreamProps) {
  const decisions = [...(state?.decisions ?? [])].reverse().slice(0, 50);

  return (
    <section aria-label="AI 决策流" className="rounded-lg bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">AI 决策流</h3>
        <span className="text-[11px] text-gray-400">共 {state?.decisions.length ?? 0} 条</span>
      </div>
      {decisions.length === 0 ? (
        <p className="py-8 text-center text-xs text-gray-400">
          等待 AI 决策…（引擎接入后，规则触发将实时出现在此）
        </p>
      ) : (
        /* 列表限高内部滚动；section 保持自然高度——
           严禁在可滚动 flex 列里用 flex-1 min-h-0（视窗变矮时会被压成只剩表头） */
        <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {decisions.map((d) => (
            <DecisionItem key={d.id} decision={d} onConfirmed={() => undefined} />
          ))}
        </ul>
      )}
    </section>
  );
}
