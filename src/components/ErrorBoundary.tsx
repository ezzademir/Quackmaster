import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Surfaces render/runtime errors instead of a blank root (common after upgrades or bad data). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Quackmaster] UI error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 px-6 py-12 text-center">
          <div className="max-w-md rounded-xl border border-red-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-semibold text-red-700">Something went wrong</p>
            <p className="mt-2 text-xs text-gray-600 break-words">{this.state.error.message}</p>
            <button
              type="button"
              className="mt-4 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
