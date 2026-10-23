import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';

/** Keeps a crash in one view from blanking the whole app. */
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('View crashed', error, info?.componentStack); }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="glass mx-auto max-w-xl rounded-3xl p-6 text-center">
        <AlertTriangle className="mx-auto mb-3 text-danger" size={28} />
        <h2 className="font-display text-lg font-semibold">This view hit an unexpected error</h2>
        <p className="mt-1 break-words text-sm text-fg-muted">{this.state.error.message}</p>
        <button className="btn btn-primary mt-4" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
