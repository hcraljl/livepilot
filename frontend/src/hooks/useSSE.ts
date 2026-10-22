/**
 * useSSE —— 订阅后端 SSE 实时状态流（前端唯一数据入口）
 *
 * 契约依据：API.md §SSE（GET /api/stream，text/event-stream，每帧完整 LiveState JSON）
 *            shared/types.ts LiveState
 * 负责人：A · @since v0.1.0
 *
 * 健壮性设计（规范 §2.5）：
 *  - 断线兜底：EventSource 自动重连之外，readyState=CLOSED 时手动指数退避重连
 *    （1s→2s→4s→…→30s 封顶），恢复后清零计数
 *  - 帧校验：每帧经 isLiveState() 运行时守卫，非法帧丢弃 + console.warn，不 crash
 *  - 状态语义：idle / connecting / open / error 四态，顶部 ConnectionBadge 可见
 *  - StrictMode 双挂载安全：effect 清理时 close()，不泄漏并行连接
 *  - 全量替换：契约承诺每帧完整 LiveState，重连后不做增量合并，避免状态漂移
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveState } from '@livepilot/shared';
import { isLiveState } from '../lib/validate';

/** SSE 连接状态 @since v0.1.0 */
export type SSEStatus = 'idle' | 'connecting' | 'open' | 'error';

/** useSSE 返回值 @since v0.1.0 */
export interface UseSSEResult {
  /** 最新一帧全量状态；未收到过为 null */
  state: LiveState | null;
  /** 连接状态 */
  status: SSEStatus;
  /** 人类可读的错误提示（无错误为 null） */
  error: string | null;
  /** 手动重连（重置退避计数） */
  reconnect: () => void;
}

/** 退避序列：1s → 2s → 4s → … → 30s 封顶 @since v0.1.0 */
const backoffDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, 30_000);

const SSE_ENDPOINT = '/api/stream';

export function useSSE(): UseSSEResult {
  const [state, setState] = useState<LiveState | null>(null);
  const [status, setStatus] = useState<SSEStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  /** 关闭连接并清掉待执行的重连定时器 @since v0.1.0 */
  const close = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  /** 建立（或重建）SSE 连接 @since v0.1.0 */
  const connect = useCallback(() => {
    close();
    setStatus('connecting');

    const es = new EventSource(SSE_ENDPOINT);
    esRef.current = es;

    es.onopen = () => {
      attemptRef.current = 0;
      setError(null);
      setStatus('open');
    };

    es.onmessage = (ev: MessageEvent) => {
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data as string);
      } catch {
        console.warn('[useSSE] 帧不是合法 JSON，已丢弃：', ev.data);
        return;
      }
      if (!isLiveState(raw)) {
        console.warn('[useSSE] 帧不符合 LiveState 契约，已丢弃：', raw);
        return;
      }
      setState(raw);
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        // 连接已关闭：手动退避重连兜底
        setStatus('error');
        setError('实时连接断开，正在重连…');
        const delay = backoffDelay(attemptRef.current);
        attemptRef.current += 1;
        timerRef.current = setTimeout(connect, delay);
      } else {
        // CONNECTING：EventSource 自身正在重试，仅同步状态
        setStatus('connecting');
      }
    };
  }, [close]);

  useEffect(() => {
    connect();
    return close;
  }, [connect, close]);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    connect();
  }, [connect]);

  return { state, status, error, reconnect };
}
