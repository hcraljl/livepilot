/**
 * 自然语言指令解析（运营说人话 → 结构化意图）
 *
 * 为什么需要：演示里最打动人的不是"AI 自动跑"，而是"运营说一句，AI 就办"。
 * 例如输入「五分钟后发一个签到」，系统应理解成：3 分钟后给当前频道发一次 checkin。
 *
 * 双通道设计：
 *  - LLM 通道（有 DEEPSEEK_API_KEY 时）：把用户原话 + 动作白名单交给模型，要求返回 JSON；
 *  - 规则通道（永远可用）：中文数字归一化 + 动作词典 + 时间/条件正则。
 * 二者都产出同一个 ParsedCommand 结构，谁先成功用谁；LLM 结果必须过白名单校验，
 * 解析不出来就老实说解析不出来，不猜、不瞎执行（演示翻车成本太高）。
 *
 * 约束：
 *  - 只解析**不执行**，执行在 scheduler / route 层，便于单测与人工确认；
 *  - 时间上限 1 小时，超过直接拒绝（避免演示中"3 天后发签到"这种无意义排程）。
 */
import type { ActionType } from '../../../shared/types.ts';

/** 动作词典：按词长降序匹配，保证「福利抽奖」不会被「抽奖」抢先 */
const ACTION_WORDS: { action: ActionType; words: string[] }[] = [
  { action: 'welfare_lottery', words: ['福利抽奖', '免费抽奖', '福袋抽奖', '福利福袋'] },
  { action: 'push_product', words: ['推商品', '商品卡', '商品弹窗', '上链接', '主推商品'] },
  { action: 'answer_card', words: ['答题卡', '答题活动', '答题', '问答卡', '互动题', '出个题'] },
  { action: 'push_card', words: ['推送卡片', '召回卡', '互动卡', '卡片'] },
  { action: 'lottery', words: ['抽奖', '福袋', '抽个奖', '发福利', '抽一波'] },
  { action: 'checkin', words: ['签到', '打卡', '报个到'] },
  { action: 'bulletin', words: ['公告', '口播', '播报', '通知', '提醒一下', '喊一声'] },
];

/**
 * 弱动词：只有强词典完全没命中时才启用。
 * 否则「推一下答题卡」会被「推一下(=推商品)」抢走——泛动词必须让位于具体动作名。
 */
const WEAK_ACTION_WORDS: { action: ActionType; words: string[] }[] = [
  { action: 'push_product', words: ['推一下', '推一推', '推个', '带一下货'] },
];

export const ACTION_LABELS_ZH: Record<ActionType, string> = {
  lottery: '抽奖',
  welfare_lottery: '福利抽奖',
  answer_card: '答题卡',
  checkin: '签到',
  push_card: '卡片推送',
  push_product: '商品推送',
  bulletin: '公告',
};

/** 条件型指令的超时（到点还没命中就放弃，避免无人机挂着） */
export const CONDITION_TIMEOUT_SEC = 1800;
/** 排程上限 */
export const MAX_DELAY_SEC = 3600;

export interface CommandCondition {
  kind: 'online_below' | 'online_above';
  value: number;
  label: string;
}

export interface ParsedCommand {
  /** 解析出的动作；null = 没听懂（此时 note 里写原因） */
  action: ActionType | null;
  actionLabel: string;
  /** 相对延迟秒数；0 = 立即 */
  delaySec: number;
  /** 绝对执行时间（条件型为超时时间） */
  dueAt: number | null;
  condition: CommandCondition | null;
  /** 给人看的解析说明（前端直接渲染） */
  note: string;
  /** 0~1，规则命中多个关键词时更高 */
  confidence: number;
  source: 'llm' | 'rule';
  text: string;
  /** 命中的动作词 / 时间词（用于回执里高亮"我抓住了什么"） */
  matchedActionWord: string;
  matchedTimeWord: string;
}

export interface ParseContext {
  now: number;
  /** 当前频道号，用于回执文案 */
  channelId: string;
  /** 在售商品名（识别「推一下 XX」里的商品） */
  productNames: string[];
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文数字 → 阿拉伯数字（覆盖 1~999；「半」单独处理） */
export function cnToNumber(raw: string): number | null {
  if (/^[0-9]+$/.test(raw)) return Number(raw);
  if (!raw) return null;
  let total = 0;
  let section = 0;
  let num: number | null = null;
  for (const ch of raw) {
    if (CN_DIGITS[ch] !== undefined) {
      num = CN_DIGITS[ch];
      continue;
    }
    if (ch === '十') {
      section += (num ?? 1) * 10;
      num = null;
      continue;
    }
    if (ch === '百') {
      section += (num ?? 1) * 100;
      num = null;
      continue;
    }
    return null;
  }
  total = section + (num ?? 0);
  return total > 0 ? total : null;
}

/** 把句子里的中文数字串替换成阿拉伯数字（「二十五分钟后」→「25分钟后」） */
function normalizeNumbers(text: string): string {
  return text.replace(/[零〇一二两三四五六七八九十百]+/g, (m) => {
    const n = cnToNumber(m);
    return n === null ? m : String(n);
  });
}

/** 全角 → 半角（现场输入法经常打出全角数字/冒号） */
function normalizeWidth(text: string): string {
  return text.replace(/[０-９：]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function matchWords(text: string, table: { action: ActionType; words: string[] }[]) {
  let best: { action: ActionType; word: string } | null = null;
  for (const entry of table) {
    for (const word of entry.words) {
      if (text.includes(word) && (!best || word.length > best.word.length)) {
        best = { action: entry.action, word };
      }
    }
  }
  return best;
}

function matchAction(text: string): { action: ActionType; word: string } | null {
  return matchWords(text, ACTION_WORDS) ?? matchWords(text, WEAK_ACTION_WORDS);
}

interface TimeSpec {
  delaySec: number;
  dueAt: number | null;
  label: string;
  word: string;
}

/** 时间表达解析：立即 / N 秒后 / N 分钟后 / N 小时后 / 半小时后 / 15:30 */
function parseTime(raw: string, now: number): TimeSpec | null {
  const text = normalizeNumbers(raw);

  // 半（个）小时
  const half = text.match(/半\s*(?:个)?\s*(?:小时|钟头)/);
  if (half && /(后|之后|以后|再)/.test(text)) {
    return { delaySec: 1800, dueAt: now + 1800_000, label: '30 分钟后', word: half[0] };
  }

  // N 秒 / 分钟 / 小时 后
  const rel = text.match(/(\d+(?:\.\d+)?)\s*(秒|s|分钟|分|min|小时|钟头|h)\s*(?:之后|以后|后|再)/i);
  if (rel) {
    const value = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const factor = /^(秒|s)$/.test(unit) ? 1 : /^(分钟|分|min)$/.test(unit) ? 60 : 3600;
    const delaySec = Math.round(value * factor);
    return {
      delaySec,
      dueAt: now + delaySec * 1000,
      label: unitLabel(delaySec),
      word: rel[0],
    };
  }

  // 绝对时间：15:30 / 15点30分 / 15点半
  const abs = text.match(/(\d{1,2})\s*[:：点]\s*(半|\d{1,2})?\s*分?/);
  if (abs) {
    const hour = Number(abs[1]);
    const minute = abs[2] === '半' ? 30 : abs[2] ? Number(abs[2]) : 0;
    if (hour <= 23 && minute <= 59) {
      const d = new Date(now);
      d.setHours(hour, minute, 0, 0);
      let dueAt = d.getTime();
      // 已过点 → 视为明天此刻（直播场景基本不会用到，但语义上比"负延迟"合理）
      if (dueAt <= now) dueAt += 24 * 3600_000;
      const delaySec = Math.round((dueAt - now) / 1000);
      return { delaySec, dueAt, label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}（${unitLabel(delaySec)}后）`, word: abs[0] };
    }
  }

  // 立即
  const immediate = text.match(/(马上|立刻|立即|现在就|现在|赶紧|直接)/);
  if (immediate) {
    return { delaySec: 0, dueAt: null, label: '立即', word: immediate[0] };
  }

  return null;
}

function unitLabel(delaySec: number): string {
  if (delaySec < 60) return `${delaySec} 秒后`;
  if (delaySec < 3600) {
    const m = Math.round(delaySec / 60);
    return `${m} 分钟后`;
  }
  const h = Math.round((delaySec / 3600) * 10) / 10;
  return `${h} 小时后`;
}

/** 条件表达：在线跌破 1000 / 在线超过 3000 */
function parseCondition(text: string): CommandCondition | null {
  const t = normalizeNumbers(text);
  if (!/(在线|人气|人氣|人数|观众|觀眾)/.test(t)) return null;
  const below = t.match(/(?:跌破|低于|少于|不到|掉到|降到)\s*(\d+)/);
  if (below) {
    const value = Number(below[1]);
    return { kind: 'online_below', value, label: `在线人数跌破 ${value}` };
  }
  const above = t.match(/(?:超过|高于|突破|涨到)\s*(\d+)/);
  if (above) {
    const value = Number(above[1]);
    return { kind: 'online_above', value, label: `在线人数超过 ${value}` };
  }
  return null;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 规则解析主入口（同步、确定性，永远可用） */
export function parseCommandWithRules(raw: string, ctx: ParseContext): ParsedCommand {
  const text = normalizeWidth(raw).trim();
  const actionHit = matchAction(text);
  const timeHit = parseTime(text, ctx.now);
  const condition = parseCondition(text);

  const action = actionHit?.action ?? null;
  const actionLabel = action ? ACTION_LABELS_ZH[action] : '—';

  // 商品名命中（「推一下山野茶油」）——只写进说明，不改写请求参数
  const matchedProduct = ctx.productNames.find((name) => {
    if (!name) return false;
    if (text.includes(name)) return true;
    const head = name.slice(0, 4);
    return head.length >= 3 && text.includes(head);
  });

  let delaySec = timeHit?.delaySec ?? 0;
  let dueAt = timeHit?.dueAt ?? null;

  if (action === null) {
    return {
      action: null,
      actionLabel,
      delaySec,
      dueAt,
      condition,
      note: `没听懂要做什么。现在支持：${Object.values(ACTION_LABELS_ZH).join(' / ')}。可以这样说：「5 分钟后发一个签到」。`,
      confidence: 0,
      source: 'rule',
      text,
      matchedActionWord: '',
      matchedTimeWord: timeHit?.word ?? '',
    };
  }

  if (delaySec > MAX_DELAY_SEC) {
    return {
      action: null,
      actionLabel,
      delaySec,
      dueAt,
      condition,
      note: `时间太长了（${unitLabel(delaySec)}），最多支持 1 小时后。改短一点我再排程。`,
      confidence: 0.2,
      source: 'rule',
      text,
      matchedActionWord: actionHit!.word,
      matchedTimeWord: timeHit!.word,
    };
  }

  // 条件型：dueAt 作为兜底超时
  if (condition) {
    dueAt = ctx.now + CONDITION_TIMEOUT_SEC * 1000;
    delaySec = 0;
  }

  const parts: string[] = [];
  if (condition) {
    parts.push(`等到「${condition.label}」时`);
    parts.push(`给频道 ${ctx.channelId} 发一次「${actionLabel}」`);
    parts.push(`（最多等 ${Math.round(CONDITION_TIMEOUT_SEC / 60)} 分钟，没触发就作废）`);
  } else if (delaySec === 0) {
    parts.push(`现在就给频道 ${ctx.channelId} 发一次「${actionLabel}」`);
  } else {
    parts.push(`${timeHit?.label ?? unitLabel(delaySec)}（${formatClock(dueAt!)}）给频道 ${ctx.channelId} 发一次「${actionLabel}」`);
  }
  if (matchedProduct) parts.push(`，带上商品「${matchedProduct}」`);

  const confidence = Math.min(
    1,
    0.55 + (actionHit ? 0.25 : 0) + (timeHit || condition ? 0.2 : 0),
  );

  return {
    action,
    actionLabel,
    delaySec,
    dueAt,
    condition,
    note: `我理解为：${parts.join('')}。`,
    confidence: Number(confidence.toFixed(2)),
    source: 'rule',
    text,
    matchedActionWord: actionHit!.word,
    matchedTimeWord: timeHit?.word ?? (condition ? condition.label : ''),
  };
}

/**
 * LLM 解析（可选通道）
 *
 * 只在配置了 DEEPSEEK_API_KEY 时生效；模型输出必须是 JSON，且 action 必须在白名单里，
 * 否则整体判为失败，交回规则通道——宁可"笨但准"，不要"聪明但乱来"。
 */
export async function parseCommandWithLlm(raw: string, ctx: ParseContext): Promise<ParsedCommand | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null;

  const baseUrl = (process.env.DEEPSEEK_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
  const allowed = Object.keys(ACTION_LABELS_ZH);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              '你是直播运营指令解析器。把运营的中文口语指令解析成 JSON，不要解释。',
              `action 只能取：${allowed.join(' / ')}；不需要动作时填 null。`,
              'delaySec 是相对延迟秒数（"5分钟后"=300，"马上"=0）。',
              'condition 只有两种：{"kind":"online_below","value":1000} 或 {"kind":"online_above","value":3000}，没有就填 null。',
              '输出格式：{"action":"checkin","delaySec":300,"condition":null,"note":"一句中文复述"}',
            ].join('\n'),
          },
          { role: 'user', content: raw },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content) as {
      action?: unknown;
      delaySec?: unknown;
      condition?: { kind?: unknown; value?: unknown } | null;
      note?: unknown;
    };

    const action =
      typeof parsed.action === 'string' && allowed.includes(parsed.action)
        ? (parsed.action as ActionType)
        : null;
    if (!action) return null;

    const delaySec = Math.max(0, Math.min(MAX_DELAY_SEC, Math.round(Number(parsed.delaySec) || 0)));
    const cond =
      parsed.condition &&
      typeof parsed.condition.kind === 'string' &&
      (parsed.condition.kind === 'online_below' || parsed.condition.kind === 'online_above') &&
      Number.isFinite(Number(parsed.condition.value))
        ? {
            kind: parsed.condition.kind as 'online_below' | 'online_above',
            value: Number(parsed.condition.value),
            label: `${parsed.condition.kind === 'online_below' ? '在线人数跌破' : '在线人数超过'} ${Number(parsed.condition.value)}`,
          }
        : null;

    const dueAt = cond ? ctx.now + CONDITION_TIMEOUT_SEC * 1000 : delaySec > 0 ? ctx.now + delaySec * 1000 : null;

    return {
      action,
      actionLabel: ACTION_LABELS_ZH[action],
      delaySec: cond ? 0 : delaySec,
      dueAt,
      condition: cond,
      note:
        typeof parsed.note === 'string' && parsed.note.length > 0
          ? `我理解为：${parsed.note}`
          : `我理解为：${cond ? `等到「${cond.label}」时` : delaySec > 0 ? unitLabel(delaySec) : '现在'}给频道 ${ctx.channelId} 发一次「${ACTION_LABELS_ZH[action]}」。`,
      confidence: 0.9,
      source: 'llm',
      text: raw.trim(),
      matchedActionWord: action,
      matchedTimeWord: cond ? cond.label : delaySec > 0 ? unitLabel(delaySec) : '立即',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 组合解析：LLM 优先，失败退回规则 */
export async function parseCommand(raw: string, ctx: ParseContext): Promise<ParsedCommand> {
  const byLlm = await parseCommandWithLlm(raw, ctx);
  if (byLlm) return byLlm;
  return parseCommandWithRules(raw, ctx);
}
