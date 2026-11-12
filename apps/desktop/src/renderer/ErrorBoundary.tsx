import { Component, type ReactNode } from 'react';
import { Icon } from './ui';
import { tr } from './i18n';

export type BoundaryScope = 'app' | 'area' | 'tab' | 'panel';

export interface ErrorBoundaryProps {
  /** What this boundary guards, in the player's words ("Items", "Wealth", "the stats sidebar"). */
  label: string;
  scope: BoundaryScope;
  /** When this changes the boundary tries again (another tab, another build). */
  resetKey?: unknown;
  /** A second way out besides Try again. */
  back?: { label: string; run: () => void };
  /** Drawn instead of the panel (the assistant keeps to a one-line notice so it never covers the build). */
  fallback?: (retry: () => void) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one broken screen from taking the window with it. A tab that throws shows this panel in its place and every
 * other tab, the title bar and the assistant keep working; nothing is written to the build.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // The one place a crash is reported: the console, so it reaches the log and a bug report.
    console.error(`[${this.props.scope}:${this.props.label}]`, error);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { label, scope, back, fallback } = this.props;
    if (fallback) return fallback(this.retry);
    const body = (
      <div className="later" role="alert" data-error-boundary={scope}>
        <Icon name="warning" size={28} style={{ color: 'var(--negative-text)' }} />
        <span className="eyebrow">{tr('ErrorBoundary.touppercase_could_not_be_shown', { label: label.toUpperCase() })}</span>
        <h2>{tr('ErrorBoundary.something_went_wrong_here')}</h2>
        <p>
          {scope === 'app' ? tr('ErrorBoundary.path_of_mastery_hit_a') : tr('ErrorBoundary.label_stopped_working_on_this', { label })} {tr('ErrorBoundary.the_rest_of_the_app')}
        </p>
        <span style={{ color: 'var(--text-faint)', fontSize: 12.5, maxWidth: 560, overflowWrap: 'anywhere' }}>{error.message}</span>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button type="button" className="btn gold" onClick={scope === 'app' ? () => window.location.reload() : this.retry}>
            <Icon name="refresh" size={16} />
            {scope === 'app' ? tr('ErrorBoundary.reload') : tr('ErrorBoundary.try_again')}
          </button>
          {back && (
            <button type="button" className="btn" data-lg="control" onClick={back.run}>
              {back.label}
            </button>
          )}
        </div>
      </div>
    );
    if (scope === 'panel') return <div className="eb-panel">{body}</div>;
    if (scope === 'tab') {
      return (
        <div className="tabroot" data-screen-label={`${label} / Tab / Error`}>
          <div className="panel" data-lg="panel">
            {body}
          </div>
        </div>
      );
    }
    return (
      <div style={{ position: 'absolute', inset: scope === 'app' ? 0 : '52px 12px 12px' }}>
        <div className="panel" data-lg="panel">
          {body}
        </div>
      </div>
    );
  }
}
