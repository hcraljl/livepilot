/**
 * SplitView —— 演示分屏布局：左 = 实时看板 + AI 决策流，右 = 保利威真实观看页
 * 负责人：A · @since v0.2.0
 * 兼容：1920×1080 主设计，1280×720 不下溢（右屏 400px 固定，左屏自适应）
 */
import type { ReactNode } from 'react';

interface SplitViewProps {
  /** 左屏：看板 + AI 决策流 @since v0.2.0 */
  children: ReactNode;
  /** 右屏：观看页嵌入等 @since v0.2.0 */
  sidebar: ReactNode;
}

export function SplitView({ children, sidebar }: SplitViewProps) {
  return (
    <div className="flex h-full gap-3 p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">{children}</div>
      <div className="flex w-[400px] shrink-0 flex-col gap-3 overflow-y-auto">{sidebar}</div>
    </div>
  );
}
