/**
 * ConnectionBadge —— SSE 连接状态徽章
 * 演示现场一眼判断「实时数据是否在线」；断线时配合 useSSE 自动重连
 * 负责人：A · @since v0.1.0
 */
import type { SSEStatus } from '../hooks/useSSE';
import { cn } from '../lib/cn';

const LABEL: Record<SSEStatus, string> = {
  idle: '未连接',
  connecting: '连接中…',
  open: '实时同步中',
  error: '连接断开 · 重连中',
};

const CONTAINER_TONE: Record<SSEStatus, string> = {
  idle: 'bg-gray-100 text-gray-600',
  connecting: 'bg-warn-50 text-warn-600',
  open: 'bg-success-50 text-success-600',
  error: 'bg-danger-50 text-danger-600',
};

const DOT_TONE: Record<SSEStatus, string> = {
  idle: 'bg-gray-400',
  connecting: 'bg-warn-400',
  open: 'bg-success-400',
  error: 'bg-danger-400',
};

export function ConnectionBadge({ status }: { status: SSEStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium',
        CONTAINER_TONE[status],
      )}
    >
      <span className={cn('h-2 w-2 rounded-full', DOT_TONE[status])} />
      {LABEL[status]}
    </span>
  );
}
