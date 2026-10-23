/**
 * SplitView —— 演示分屏布局：左 = 实时看板 + AI 决策流，右侧栏可选
 * 负责人：A · @since v0.2.0（v0.6.0：sidebar 改为可选，观看页收进弹层后默认不占位）
 * 兼容：1920×1080 主设计，1280×720 不下溢（传了 sidebar 才固定 400px，未传则看板吃满宽度）
 */
import type { ReactNode } from 'react';

interface SplitViewProps {
  /** 左屏：看板 + AI 决策流 @since v0.2.0 */
  children: ReactNode;
  /** 右侧栏：需要常驻面板时传（v0.6.0 起观看页改为弹层，默认不传） @since v0.2.0 */
  sidebar?: ReactNode;
}

export function SplitView({ children, sidebar }: SplitViewProps) {
  return (
    <div className="flex h-full gap-3 p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">{children}</div>
      {sidebar != null && (
        <div className="flex w-[400px] shrink-0 flex-col gap-3 overflow-y-auto">{sidebar}</div>
      )}
    </div>
  );
}
