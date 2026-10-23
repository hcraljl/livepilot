/**
 * 执行层（决策 → 真实/模拟动作）
 *
 * 引擎（C）只需：store.addDecision({...status:'pending_confirm'|'suggested'}) 后调用 executeDecision(id)，
 * 或直接调 executeAction()。状态回写、事件留存、时间轴打点都在这里，避免各层重复实现。
 */
import type { ActionType, Decision, PolyvCallResult } from '../../../shared/types.ts';
import { config } from '../config.ts';
import { store } from '../store/state.ts';
import { polyvClient } from './client.ts';

export interface ExecuteOutcome {
  ok: boolean;
  decision: Decision;
  result: PolyvCallResult;
}

/**
 * 真实模式下「缺账号侧资源」时的降级映射。
 *
 * 只做同目的的替换，语义不跑偏：
 *   push_card   （抽奖卡片召回）→ lottery  （直接发抽奖，召回效果更直接）
 *   answer_card （答题卡救冷场）→ checkin  （签到同样能激活公屏）
 *   push_product（推商品弹层）  → bulletin （用公告口播主推品）
 *   coupon      （发券逼单）    → bulletin （用公告逼单，券库存不受影响）
 *
 * 降级事实会写进决策理由与事件流，不会伪装成原动作成功。
 */
const DEGRADE_TO: Partial<Record<ActionType, ActionType>> = {
  push_card: 'lottery',
  answer_card: 'checkin',
  push_product: 'bulletin',
  coupon: 'bulletin',
};

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

  // —— 真实模式预检：资源缺失时做「同目的降级」，而不是把注定失败的请求打出去 ——
  let action = decision.action;
  let degradeNote = '';
  if (config.autoDegrade && polyvClient.isReal) {
    const missing = polyvClient.missingResources(action);
    const alt = DEGRADE_TO[action];
    if (missing.length > 0 && alt) {
      degradeNote = `（真实模式下缺少 ${missing.join('/')}，已降级为「${alt}」以保证互动真实下发）`;
      store.logEvent(
        'system',
        '动作降级',
        `${action} → ${alt}：缺 ${missing.join(' / ')}，改发不需要账号资源的等价动作`,
        decision.id,
      );
      action = alt;
    }
  }

  const result = await polyvClient.execute(action, {
    channelId: decision.channelId || undefined,
    params: decision.payload,
  });

  const updated = store.updateDecision(decision.id, {
    status: result.ok ? 'executed' : 'failed',
    executedAt: Date.now(),
    executedElapsedMin: store.get().metrics.elapsedMin,
    reason: degradeNote ? `${decision.reason}${degradeNote}` : decision.reason,
    result,
  }) as Decision;

  store.logEvent(
    'action',
    `${result.ok ? '已执行' : '执行失败'}：${decision.title ?? decision.rule}`,
    `${result.mock ? '[模拟] ' : '[真实] '}${result.endpoint ?? ''} · ${result.message}${degradeNote}`,
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
