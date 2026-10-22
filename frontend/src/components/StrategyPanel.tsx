/**
 * StrategyPanel —— 策略面板：三档智能 + 三档模式 + 5 条规则阈值配置
 * 契约：StrategyConfig（shared/types.ts v2：新增 aiLevel 三档智能 + experienceTopK）
 *       POST /api/mode、POST /api/strategy
 * 负责人：A · @since v0.2.0（A-09 后半；v0.3.0 补 aiLevel 三档智能）
 *
 * 说明：比率类字段契约存 0~1，界面按百分比展示；保存时只提交改动字段（局部更新）。
 * 表单以服务端策略值为 key 重置—— SSE 推来新值（他人修改）时自动同步，避免 200ms
 * 帧频覆盖用户输入。
 */
import { useState } from 'react';
import type { AiLevel, LiveState, Mode, StrategyConfig } from '@livepilot/shared';
import { AI_LEVEL_HINTS, AI_LEVEL_LABELS, MODE_LABELS } from '../lib/constants';
import { setMode, updateStrategy } from '../lib/api';

const MODES: Mode[] = ['suggest', 'semiauto', 'auto'];
const AI_LEVELS: AiLevel[] = ['off', 'hybrid', 'full'];

/** 表单字段定义：key + 展示变换 @since v0.2.0 */
interface FieldDef {
  key: keyof StrategyConfig;
  label: string;
  unit: string;
  kind: 'ratio' | 'int' | 'money';
  step?: string;
}

const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: '留存保卫（在线跌幅）',
    fields: [
      { key: 'retentionDropPct', label: '跌幅阈值', unit: '%', kind: 'ratio', step: '0.5' },
      { key: 'retentionWindowSec', label: '观察窗口', unit: '秒', kind: 'int' },
    ],
  },
  {
    title: '转化助推（商品点击率）',
    fields: [
      { key: 'conversionCtrThreshold', label: '点击率阈值', unit: '%', kind: 'ratio', step: '0.1' },
      { key: 'conversionWindowSec', label: '观察窗口', unit: '秒', kind: 'int' },
    ],
  },
  {
    title: '氛围激活（冷场）',
    fields: [
      { key: 'coldDanmakuRate', label: '弹幕率阈值', unit: '%', kind: 'ratio', step: '0.5' },
      { key: 'coldWindowSec', label: '持续窗口', unit: '秒', kind: 'int' },
    ],
  },
  {
    title: '逼单（GMV 目标）',
    fields: [
      { key: 'gmvTarget', label: 'GMV 目标', unit: '元', kind: 'money' },
      { key: 'pushWindowMin', label: '提前分钟', unit: '分钟', kind: 'int' },
    ],
  },
  {
    title: '防刷屏',
    fields: [{ key: 'cooldownSec', label: '同规则冷却', unit: '秒', kind: 'int' }],
  },
];

/** 契约值 → 输入框字符串 @since v0.2.0 */
const toInput = (v: number, kind: FieldDef['kind']): string =>
  kind === 'ratio' ? String(Math.round(v * 1000) / 10) : String(v);

/** 输入框字符串 → 契约值；非法返回 null @since v0.2.0 */
const fromInput = (s: string, kind: FieldDef['kind']): number | null => {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return kind === 'ratio' ? n / 100 : n;
};

/** 三档智能切换（off/hybrid/full，立即生效） @since v0.3.0 */
function AiLevelSwitcher({ level }: { level: AiLevel }) {
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-medium text-gray-600">智能档位</span>
        <span className="text-[11px] text-gray-400">{AI_LEVEL_HINTS[level]}</span>
      </div>
      <div className="flex rounded-md border border-gray-200 p-0.5">
        {AI_LEVELS.map((lv) => (
          <button
            key={lv}
            type="button"
            disabled={busy}
            title={AI_LEVEL_HINTS[lv]}
            onClick={async () => {
              setBusy(true);
              try {
                await updateStrategy({ aiLevel: lv });
              } finally {
                setBusy(false);
              }
            }}
            className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              level === lv ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {AI_LEVEL_LABELS[lv]}
          </button>
        ))}
      </div>
    </div>
  );
}

function ModeSwitcher({ mode }: { mode: Mode }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex rounded-md border border-gray-200 p-0.5">
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          disabled={busy}
          title={
            m === 'suggest' ? '只给建议，不自动执行' : m === 'semiauto' ? '预填动作，运营确认后执行' : 'AI 全自动执行'
          }
          onClick={async () => {
            setBusy(true);
            try {
              await setMode(m);
            } finally {
              setBusy(false);
            }
          }}
          className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
            mode === m ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'
          }`}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

function StrategyForm({ strategy }: { strategy: StrategyConfig }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      GROUPS.flatMap((g) => g.fields).map((f) => [f.key, toInput(strategy[f.key] as number, f.kind)]),
    ),
  );
  const [topK, setTopK] = useState(String(strategy.experienceTopK));
  const [enabled, setEnabled] = useState(strategy.enabled);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const handleSave = async (): Promise<void> => {
    const patch: Partial<StrategyConfig> = {};
    for (const f of GROUPS.flatMap((g) => g.fields)) {
      const next = fromInput(values[f.key] ?? '', f.kind);
      if (next === null) {
        setHint(`「${f.label}」不是合法数值`);
        return;
      }
      if (next !== strategy[f.key]) patch[f.key] = next as never;
    }
    const topKN = Number(topK);
    if (Number.isFinite(topKN) && topKN >= 1 && topKN <= 10 && topKN !== strategy.experienceTopK) {
      patch.experienceTopK = topKN;
    }
    if (enabled !== strategy.enabled) patch.enabled = enabled;
    if (Object.keys(patch).length === 0) {
      setHint('无改动');
      return;
    }
    setBusy(true);
    setHint(null);
    try {
      await updateStrategy(patch);
      setHint('已保存并生效');
    } catch (e) {
      setHint(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        引擎总开关（关闭后 AI 不再自动决策，人工接管）
      </label>
      <label className="flex items-center gap-1.5 text-xs text-gray-600">
        <span className="w-20 shrink-0 text-gray-400">经验候选数</span>
        <input
          type="number"
          min={1}
          max={10}
          value={topK}
          onChange={(e) => setTopK(e.target.value)}
          className="w-16 rounded border border-gray-200 px-2 py-1 text-xs"
        />
        <span className="text-gray-400">条（副驾经验库 TopK，1~10）</span>
      </label>
      {GROUPS.map((group) => (
        <fieldset key={group.title}>
          <legend className="mb-1 text-[11px] font-medium text-gray-500">{group.title}</legend>
          <div className="grid grid-cols-2 gap-2">
            {group.fields.map((f) => (
              <label key={f.key} className="flex items-center gap-1.5 text-xs text-gray-600">
                <span className="w-20 shrink-0 text-gray-400">{f.label}</span>
                <input
                  type="number"
                  min={0}
                  step={f.step ?? '1'}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="w-full rounded border border-gray-200 px-2 py-1 text-xs"
                />
                <span className="w-8 shrink-0 text-gray-400">{f.unit}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={handleSave}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {busy ? '保存中…' : '保存阈值'}
        </button>
        {hint && <span className="text-[11px] text-gray-500">{hint}</span>}
      </div>
    </div>
  );
}

interface StrategyPanelProps {
  state: LiveState | null;
}

export function StrategyPanel({ state }: StrategyPanelProps) {
  return (
    <section aria-label="策略面板" className="rounded-lg bg-white p-4">
      <h3 className="mb-3 text-sm font-medium text-gray-700">策略面板</h3>
      {state ? (
        <div className="flex flex-col gap-3">
          <AiLevelSwitcher level={state.strategy.aiLevel} />
          <ModeSwitcher mode={state.mode} />
          <StrategyForm key={JSON.stringify(state.strategy)} strategy={state.strategy} />
        </div>
      ) : (
        <p className="py-6 text-center text-xs text-gray-400">连接后端后显示策略配置</p>
      )}
    </section>
  );
}
