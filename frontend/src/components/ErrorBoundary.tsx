/**
 * ErrorBoundary —— 组件树崩溃降级（演示不白屏的第一道防线）
 * 负责人：A · @since v0.2.0
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 降级提示标题 @since v0.2.0 */
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] 捕获渲染异常：', error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="m-4 rounded-lg border border-danger-200 bg-danger-50 p-6" role="alert">
        <h2 className="text-sm font-medium text-danger-800">
          {this.props.fallbackTitle ?? '看板渲染异常，已降级'}
        </h2>
        <p className="mt-2 text-xs text-danger-600">{error.message}</p>
        <button
          type="button"
          onClick={this.handleRetry}
          className="mt-3 rounded-md border border-danger-200 bg-white px-3 py-1 text-xs text-danger-800 hover:bg-danger-50"
        >
          重试渲染
        </button>
      </div>
    );
  }
}
