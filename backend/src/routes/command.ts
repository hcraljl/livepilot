/**
 * 人工指令接口（运营说人话 → AI 解析 → 立即执行 / 定时执行）
 *
 * 这是"人机协作"最直观的一条链路：
 *   运营打字 → AI 复述理解 → 到点自动下发 → 决策流里出现该动作 → 观众端真收到。
 *
 * 契约（见 API.md §六）：
 *   POST   /api/commands      { text }            → { kind, parsed, command?, decision?, result? }
 *   GET    /api/commands                          → { commands: ScheduledCommand[] }
 *   DELETE /api/commands/:id                      → 取消待执行指令
 */
import { Router } from 'express';
import { store } from '../store/state.ts';
import { executeAction } from '../polyv/executor.ts';
import { parseCommand } from '../commands/parse.ts';
import { cancelCommand, listCommands, scheduleCommand } from '../commands/scheduler.ts';

export const commandRouter = Router();

const ok = (data: unknown) => ({ ok: true, data });
const fail = (error: string, code = 400) => ({ ok: false, error, code });

commandRouter.post('/commands', async (req, res) => {
  const raw = String((req.body ?? {}).text ?? '').trim();
  if (!raw) {
    res.status(400).json(fail('text 不能为空（例：5 分钟后发一个签到）'));
    return;
  }
  if (raw.length > 200) {
    res.status(400).json(fail('指令太长（最多 200 字），说重点就行'));
    return;
  }

  const ctx = {
    now: Date.now(),
    channelId: store.effectiveChannelId(),
    productNames: store.get().productRanking.map((p) => p.name),
  };

  // 运营原话先进事件流：复盘时能看到「人说了什么 → AI 做了什么」
  store.logEvent('decision', '收到人工指令', raw);

  const parsed = await parseCommand(raw, ctx);

  if (!parsed.action) {
    res.json(
      ok({
        kind: 'rejected',
        parsed,
        message: parsed.note,
      }),
    );
    return;
  }

  // 立即执行：不进排程表，直接打一条决策 + 下发
  if (!parsed.condition && parsed.delaySec <= 0) {
    const outcome = await executeAction(parsed.action, {
      channelId: store.effectiveChannelId() || undefined,
      rule: '人工指令',
      reason: `运营口头指令「${raw}」（AI 解析：${parsed.source === 'llm' ? 'DeepSeek' : '规则'}）`,
      title: `运营指令 · ${parsed.actionLabel}`,
    });
    res.json(
      ok({
        kind: 'executed',
        parsed,
        decision: outcome.decision,
        result: outcome.result,
      }),
    );
    return;
  }

  const command = scheduleCommand(parsed, { text: raw });
  res.json(ok({ kind: 'scheduled', parsed, command }));
});

commandRouter.get('/commands', (_req, res) => {
  res.json(ok({ commands: listCommands() }));
});

commandRouter.delete('/commands/:id', (req, res) => {
  const cancelled = cancelCommand(req.params.id);
  if (!cancelled) {
    res.status(404).json(fail('没找到该待执行指令（可能已执行或已取消）'));
    return;
  }
  res.json(ok({ command: cancelled }));
});
