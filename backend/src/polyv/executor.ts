/**
 * 执行层（决策 → 真实/模拟动作）
 *
 * 引擎（C）只需：store.addDecision({...status:'pending_confirm'|'suggested'}) 后调用 executeDecision(id)，
 * 或直接调 executeAction()。状态回写、事件留存、时间轴打点都在这里，避免各层重复实现。
 */
import type { ActionType, Decision, PolyvCallResult } from '../../../shared/types.ts';
import { store } from '../store/state.ts';
import { polyvClient } from './client.ts';

export interface ExecuteOutcome {
  ok: boolean;
  decision: Decision;
  result: PolyvCallResult;
}

/** 执行一条已存在的决策（半自动确认 / 全自动落地都走这里） */
export async function executeDecision(decisionId: string): Promise<ExecuteOutcome | undefined> {
  const decision = store.getDecision(decisionId);
  if (!decision) return undefined;
  if (decision.status === 'executed') {
    return {
      ok: decision.result?.ok ?? true,
      decision,
      result: decision.result ?? { ok: true, mock: true, code: 200, message: '已执行过（幂等跳过）' },
    };
  }

  const result = await polyvClient.execute(decision.action, {
    channelId: decision.channelId || undefined,
    params: decision.payload,
  });

  const updated = store.updateDecision(decision.id, {
    status: result.ok ? 'executed' : 'failed',
    executedAt: Date.now(),
    result,
  }) as Decision;

  store.logEvent(
    'action',
    `${result.ok ? '已执行' : '执行失败'}：${decision.title ?? decision.rule}`,
    `${result.mock ? '[模拟] ' : '[真实] '}${result.endpoint ?? ''} · ${result.message}`,
    decision.id,
  );
  store.markTimeline();

  return { ok: result.ok, decision: updated, result };
}

/** 运营手动触发 / 演示现场"人点一下"的入口 */
export async function executeAction(
  action: ActionType,
  opts: {
    channelId?: string;
    rule?: string;
    reason?: string;
    title?: string;
    params?: Record<string, unknown>;
  } = {},
): Promise<ExecuteOutcome> {
  const decision = store.addDecision({
    rule: opts.rule ?? '手动触发',
    action,
    reason: opts.reason ?? '运营在驾驶舱手动触发（非 AI 决策）',
    mode: store.getMode(),
    status: 'suggested',
    channelId: opts.channelId ?? store.get().channelId,
    title: opts.title,
    payload: opts.params,
  });
  const outcome = await executeDecision(decision.id);
  return outcome ?? { ok: false, decision, result: { ok: false, mock: true, code: 500, message: '执行器异常' } };
}
