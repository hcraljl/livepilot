/**
 * App —— LivePilot 运营驾驶舱根组件
 *
 * v0.2.0（M2/M3）：完成真实驾驶舱——分屏看板 + AI 决策流 + 右屏观看页 + 智能复盘页。
 * v0.6.0：观看页收进「观众端预览」弹层（SplitView 不再常驻右栏），看板吃满宽度。
 * 数据唯一来源：useSSE 订阅的后端全量 LiveState 帧；REST 动作走 lib/api.ts。
 * 负责人：A
 */
import { useState } from 'react';
import { useSSE } from './hooks/useSSE';
import { ConnectionBadge } from './components/ConnectionBadge';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SplitView } from './layout/SplitView';
import { ControlBar } from './components/ControlBar';
import { CommandBar } from './components/CommandBar';
import { MetricCards } from './components/MetricCards';
import { Funnel } from './components/Funnel';
import { InteractionPanel } from './components/InteractionPanel';
import { ProductRanking } from './components/ProductRanking';
import { InteractionTimeline } from './components/InteractionTimeline';
import { DecisionStream } from './components/DecisionStream';
import { StrategyPanel } from './components/StrategyPanel';
import { CopilotPanel } from './components/CopilotPanel';
import { WatchEmbed } from './components/WatchEmbed';
import { ReviewPage } from './components/ReviewPage';
import { MODE_LABELS } from './lib/constants';

type View = 'dashboard' | 'review';

const VIEW_TABS: { key: View; label: string }[] = [
  { key: 'dashboard', label: '实时看板' },
  { key: 'review', label: '智能复盘' },
];

export default function App() {
  const { state, status, error } = useSSE();
  const [view, setView] = useState<View>('dashboard');
  /** 真实开播成功后自增：WatchEmbed 见到变化就自动弹出观众端 @since v0.8.0 */
  const [watchOpenSignal, setWatchOpenSignal] = useState(0);

  return (
    <div className="flex h-screen flex-col bg-brand-50 text-gray-900">
      <header className="flex flex-wrap items-center gap-4 border-b border-gray-200 bg-white px-5 py-2.5">
        <h1 className="text-base font-medium">LivePilot · 智播副驾</h1>
        <nav className="flex rounded-md border border-gray-200 p-0.5">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setView(tab.key)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                view === tab.key ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        {state && (
          <span className="text-xs text-gray-500">
            模式：<b className="font-medium text-gray-700">{MODE_LABELS[state.mode]}</b>
            {state.running && <b className="ml-2 font-medium text-success-600">● 直播中</b>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* 观众端观看页改为弹层：平时不占版面，点这里弹出大窗 @since v0.6.0 */}
          {view === 'dashboard' && <WatchEmbed state={state} openSignal={watchOpenSignal} />}
          <ConnectionBadge status={status} />
        </div>
      </header>

      {status === 'error' && error && (
        <div className="border-b border-danger-100 bg-danger-50 px-5 py-1 text-xs text-danger-700">{error}</div>
      )}

      <main className="min-h-0 flex-1">
        {view === 'dashboard' ? (
          <ErrorBoundary key="dashboard" fallbackTitle="看板渲染异常，已降级（演示不中断）">
            <SplitView>
              <ControlBar state={state} onLiveStarted={() => setWatchOpenSignal((n) => n + 1)} />
              {/* 指挥台：运营说一句 → AI 解析 → 立即/定时执行 @since v0.7.0 */}
              <CommandBar state={state} />
              {/* 互动区：运营手动发起互动（首个能力：推送商品） @since v1.1.0 */}
              <InteractionPanel state={state} />
              <MetricCards state={state} />
              <div className="grid gap-3 lg:grid-cols-2">
                <Funnel funnel={state?.funnel ?? null} />
                <ProductRanking state={state} />
              </div>
              <InteractionTimeline state={state} />
              <DecisionStream state={state} />
              <StrategyPanel state={state} />
              <CopilotPanel />
            </SplitView>
          </ErrorBoundary>
        ) : (
          <ErrorBoundary key="review" fallbackTitle="复盘页渲染异常，已降级（演示不中断）">
            <ReviewPage />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
