/**
 * InteractionTimeline —— 互动时间轴：在线人数曲线 + AI 决策事件标记（点开看触发理由）
 * 契约：LiveState.timeline / decisions / startedAt（shared/types.ts v1.1）
 * 负责人：A · @since v0.2.0（A-07）
 *
 * 说明：横轴=已播分钟，纵轴=在线人数；决策标记按 (ts - startedAt) 换算分钟位，
 * 纵坐标对 timeline 线性插值，保证标记贴在曲线上。
 *
 * v0.4.0 修复：viewBox 宽度改为按容器实测宽度（ResizeObserver），高度固定 220px。
 * 旧实现固定 viewBox 720×200 + w-full，在 1920 宽屏上等比放大到约 400px 高，
 * 把「AI 决策流」整块挤出首屏；现在宽高比跟随容器，文字也不再被横向拉伸。
 */
import { useEffect, useRef, useState } from 'react';
import type { Decision, LiveState, TimelinePoint } from '@livepilot/shared';
import { ACTION_LABELS, DECISION_STATUS_LABELS } from '../lib/constants';
import { formatClock, formatInt } from '../lib/format';

/** 固定高度 220px；宽度取容器实测值 @since v0.4.0 */
const H = 220;
const MIN_W = 320;
const PAD = { l: 44, r: 14, t: 14, b: 26 };

/** 线性插值：取目标分钟处的在线人数 @since v0.2.0 */
function onlineAt(points: TimelinePoint[], minute: number): number {
  if (points.length === 0) return 0;
  if (minute <= points[0].t) return points[0].online;
  for (let i = 1; i < points.length; i++) {
    if (points[i].t >= minute) {
      const span = points[i].t - points[i - 1].t || 1;
      const k = (minute - points[i - 1].t) / span;
      return points[i - 1].online + (points[i].online - points[i - 1].online) * k;
    }
  }
  return points[points.length - 1].online;
}

/** 纵轴上限取整到好看的数量级 @since v0.2.0 */
function niceCeil(v: number): number {
  if (v <= 10) return 10;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
}

const STATUS_COLOR: Record<Decision['status'], string> = {
  suggested: '#185FA5',
  pending_confirm: '#BA7517',
  executed: '#1D9E75',
  failed: '#E24B4A',
};

function DecisionDetail({ decision }: { decision: Decision }) {
  return (
    <div className="mt-2 rounded-md border border-gray-100 bg-gray-50 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[11px] font-medium text-white"
          style={{ background: STATUS_COLOR[decision.status] }}
        >
          {DECISION_STATUS_LABELS[decision.status]}
        </span>
        <b className="font-medium text-gray-800">{decision.title || decision.rule}</b>
        <span className="text-gray-400">{ACTION_LABELS[decision.action]}</span>
        <span className="ml-auto text-gray-400">{new Date(decision.ts).toLocaleTimeString('zh-CN')}</span>
      </div>
      <p className="mt-1.5 leading-relaxed text-gray-600">{decision.reason}</p>
      {decision.result && (
        <p className="mt-1 text-[11px] text-gray-400">
          {decision.result.mock ? '模拟执行' : '真实调用'} · code {decision.result.code}
          {decision.result.endpoint ? ` · ${decision.result.endpoint}` : ''}
        </p>
      )}
    </div>
  );
}

interface InteractionTimelineProps {
  state: LiveState | null;
}

export function InteractionTimeline({ state }: InteractionTimelineProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);

  /** 跟随容器宽度（1:1 像素映射，避免等比放大把图拉高） @since v0.4.0 */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) > 1 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const points = state?.timeline ?? [];
  const decisions = state?.decisions ?? [];

  if (!state || points.length === 0) {
    return (
      <section aria-label="互动时间轴" className="rounded-lg bg-white p-4">
        <h3 className="mb-2 text-sm font-medium text-gray-700">互动时间轴</h3>
        <p className="py-10 text-center text-xs text-gray-400">开始直播后，这里显示在线曲线与 AI 互动标记</p>
      </section>
    );
  }

  const W = Math.max(width, MIN_W);
  const xMax = Math.max(state.metrics.totalMin, points[points.length - 1].t, 1);
  const yMax = niceCeil(Math.max(...points.map((p) => p.online), 10));
  const x = (t: number) => PAD.l + (t / xMax) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / yMax) * (H - PAD.t - PAD.b);

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.online).toFixed(1)}`).join(' ');
  const area = `${path} L${x(points[points.length - 1].t).toFixed(1)},${H - PAD.b} L${PAD.l},${H - PAD.b} Z`;

  const markers = state.startedAt
    ? decisions.map((d) => {
        const minute = (d.ts - (state.startedAt as number)) / 60000;
        return { decision: d, cx: x(Math.min(Math.max(minute, 0), xMax)), cy: y(onlineAt(points, minute)) };
      })
    : [];

  const selected = decisions.find((d) => d.id === selectedId) ?? null;

  return (
    <section aria-label="互动时间轴" className="rounded-lg bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">互动时间轴</h3>
        <span className="text-[11px] text-gray-400">点击曲线上的标记查看 AI 触发理由</span>
      </div>
      <div ref={wrapRef} className="w-full">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ height: H }}
          className="w-full"
          role="img"
          aria-label="在线人数曲线与 AI 互动标记"
        >
          <title>在线人数曲线与 AI 互动标记</title>
          {/* 网格与坐标 */}
          <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="#D3D1C7" strokeWidth="0.5" />
          <line x1={PAD.l} y1={y(yMax / 2)} x2={W - PAD.r} y2={y(yMax / 2)} stroke="#EEEDE8" strokeWidth="0.5" />
          <text x={PAD.l - 6} y={y(yMax)} textAnchor="end" fontSize="10" fill="#888780" dominantBaseline="central">
            {formatInt(yMax)}
          </text>
          <text x={PAD.l - 6} y={y(yMax / 2)} textAnchor="end" fontSize="10" fill="#888780" dominantBaseline="central">
            {formatInt(yMax / 2)}
          </text>
          <text x={PAD.l} y={H - 8} fontSize="10" fill="#888780">
            0′
          </text>
          <text x={W - PAD.r} y={H - 8} textAnchor="end" fontSize="10" fill="#888780">
            {xMax}′
          </text>
          {/* 面积 + 曲线 */}
          <path d={area} fill="#E6F1FB" />
          <path d={path} fill="none" stroke="#185FA5" strokeWidth="1.5" />
          {/* 决策标记 */}
          {markers.map(({ decision, cx, cy }) => (
            <g
              key={decision.id}
              className="cursor-pointer"
              onClick={() => setSelectedId(selectedId === decision.id ? null : decision.id)}
            >
              <circle cx={cx} cy={cy} r="9" fill="transparent" />
              <circle
                cx={cx}
                cy={cy}
                r={selectedId === decision.id ? 5.5 : 4}
                fill={STATUS_COLOR[decision.status]}
                stroke="#FFFFFF"
                strokeWidth="1.5"
              />
              <title>{`${decision.title || decision.rule}（${DECISION_STATUS_LABELS[decision.status]}）`}</title>
            </g>
          ))}
        </svg>
      </div>
      <div className="mt-1 flex items-center gap-3 text-[11px] text-gray-400">
        <span>曲线末端：在线 {formatInt(points[points.length - 1].online)}</span>
        <span>已播 {formatClock(state.metrics.elapsedMin)}</span>
        <span>决策标记 {markers.length} 个</span>
      </div>
      {selected && <DecisionDetail decision={selected} />}
    </section>
  );
}
