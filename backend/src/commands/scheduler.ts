/**
 * 指令排程器（人工指令 → 到点自动执行）
 *
 * 职责边界：
 *  - 解析不在这里（见 parse.ts），执行也不在这里（复用 polyv/executor.executeAction）；
 *  - 这里只负责"什么时候该执行"，以及把结果写回任务列表 + 事件流；
 *  - 进程内存实现：直播演示场景不需要持久化，重启即清空（比落库更省事，且不会残留幽灵任务）。
 *
 * 支持两种触发：
 *  1. 定时：delaySec 后执行（「5 分钟后发签到」）
 *  2. 条件：在线人数跌破/超过阈值时执行，超时作废（「在线跌破 1000 就发抽奖」）
 */
import type { ActionType } from '../../../shared/types.ts';
import { store } from '../store/state.ts';
import { executeAction } from '../polyv/executor.ts';
import type { CommandCondition, ParsedCommand } from './parse.ts';

export type CommandStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';

export interface ScheduledCommand {
  id: string;
  /** 运营原话 */
  text: string;
  action: ActionType;
  actionLabel: string;
  title: string;
  /** 生效时间（条件型为超时时间） */
  dueAt: number;
  createdAt: number;
  condition: CommandCondition | null;
  status: CommandStatus;
  note: string;
  source: 'llm' | 'rule';
  firedAt?: number;
  decisionId?: string;
  resultMessage?: string;
}

const MAX_KEEP = 40;
const CONDITION_CHECK_MS = 1000;

const tasks = new Map<string, ScheduledCommand>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let seq = 0;
let conditionTimer: ReturnType<typeof setInterval> | null = null;

function newId(): string {
  seq += 1;
  return `cmd_${Date.now().toString(36)}_${seq}`;
}

/** 公开展示用（pending 在前，其余按时间倒序） */
export function listCommands(): ScheduledCommand[] {
  const all = [...tasks.values()];
  const pending = all.filter((t) => t.status === 'pending').sort((a, b) => a.dueAt - b.dueAt);
  const history = all
    .filter((t) => t.status !== 'pending')
    .sort((a, b) => (b.firedAt ?? b.createdAt) - (a.firedAt ?? a.createdAt));
  return [...pending, ...history].slice(0, MAX_KEEP);
}

export function cancelCommand(id: string): ScheduledCommand | null {
  const task = tasks.get(id);
  if (!task || task.status !== 'pending') return null;
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  task.status = 'cancelled';
  store.logEvent('system', '指令已取消', `「${task.text}」不再执行`);
  return task;
}

/** 清理过期历史，防止内存无限增长 */
function prune(): void {
  const finished = [...tasks.values()]
    .filter((t) => t.status !== 'pending' && t.status !== 'running')
    .sort((a, b) => (b.firedAt ?? b.createdAt) - (a.firedAt ?? a.createdAt));
  for (const stale of finished.slice(MAX_KEEP)) {
    tasks.delete(stale.id);
  }
}

async function fire(task: ScheduledCommand, trigger: string): Promise<void> {
  if (task.status !== 'pending') return;
  task.status = 'running';
  try {
    store.logEvent('decision', `执行人工指令：${task.actionLabel}`, `${trigger}｜原话「${task.text}」`);
    const outcome = await executeAction(task.action, {
      channelId: store.effectiveChannelId() || undefined,
      rule: '人工指令',
      reason: `运营口头指令「${task.text}」${trigger}`,
      title: `运营指令 · ${task.actionLabel}`,
    });
    task.status = outcome.ok ? 'done' : 'failed';
    task.firedAt = Date.now();
    task.decisionId = outcome.decision.id;
    task.resultMessage = outcome.result.message;
    store.logEvent(
      'action',
      `${outcome.ok ? '指令已完成' : '指令执行失败'}：${task.actionLabel}`,
      `${outcome.result.mock ? '[模拟] ' : '[真实] '}${outcome.result.message}`,
      outcome.decision.id,
    );
  } catch (err) {
    task.status = 'failed';
    task.firedAt = Date.now();
    task.resultMessage = err instanceof Error ? err.message : String(err);
    store.logEvent('system', '指令执行异常', task.resultMessage);
  } finally {
    prune();
  }
}

/** 条件型任务检查（有任务才开定时器，省得空转） */
function ensureConditionWatcher(): void {
  const hasCondition = [...tasks.values()].some((t) => t.status === 'pending' && t.condition);
  if (!hasCondition) {
    if (conditionTimer) clearInterval(conditionTimer);
    conditionTimer = null;
    return;
  }
  if (conditionTimer) return;
  conditionTimer = setInterval(() => {
    // 未开播时不做条件判断：此时 online≈0，「跌破 1000」会被瞬间命中，属于误触发
    if (!store.get().running) return;

    const online = store.get().metrics.online;
    for (const task of tasks.values()) {
      if (task.status !== 'pending' || !task.condition) continue;
      const { kind, value } = task.condition;
      const hit = kind === 'online_below' ? online < value : online > value;
      if (hit) {
        void fire(task, `条件命中（当前在线 ${online}，阈值 ${value}）`);
      } else if (Date.now() >= task.dueAt) {
        task.status = 'expired';
        task.firedAt = Date.now();
        store.logEvent('system', '指令已失效', `「${task.text}」等待条件「${task.condition.label}」超时`);
      }
    }
    ensureConditionWatcher();
  }, CONDITION_CHECK_MS);
}

/** 登记一条已解析的指令 */
export function scheduleCommand(
  parsed: ParsedCommand,
  opts: { text: string; title?: string } = { text: '' },
): ScheduledCommand {
  if (!parsed.action) throw new Error('解析结果没有可执行动作');

  const now = Date.now();
  const task: ScheduledCommand = {
    id: newId(),
    text: opts.text || parsed.text,
    action: parsed.action,
    actionLabel: parsed.actionLabel,
    title: opts.title ?? `运营指令 · ${parsed.actionLabel}`,
    dueAt: parsed.condition ? parsed.dueAt ?? now + 30 * 60_000 : parsed.dueAt ?? now,
    createdAt: now,
    condition: parsed.condition,
    status: 'pending',
    note: parsed.note,
    source: parsed.source,
  };
  tasks.set(task.id, task);

  store.logEvent(
    'decision',
    `已排程人工指令：${task.actionLabel}`,
    `${parsed.note}（来源：${parsed.source === 'llm' ? 'DeepSeek 解析' : '规则解析'}）`,
  );

  if (parsed.condition) {
    ensureConditionWatcher();
    return task;
  }

  const delayMs = Math.max(0, task.dueAt - now);
  if (delayMs === 0) {
    // 立即执行：不阻塞调用方，异常已在 fire 内部兜住
    void fire(task, '立即执行');
    return task;
  }

  const timer = setTimeout(() => {
    timers.delete(task.id);
    void fire(task, `定时到达（${new Date(task.dueAt).toLocaleTimeString('zh-CN', { hour12: false })}）`);
  }, delayMs);
  timers.set(task.id, timer);
  return task;
}

/** 进程退出时清掉定时器（tsx 热重启场景） */
export function disposeScheduler(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (conditionTimer) clearInterval(conditionTimer);
  conditionTimer = null;
}
