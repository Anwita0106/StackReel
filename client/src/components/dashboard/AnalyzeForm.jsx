import { useState } from 'react';
import { ArrowRight, Globe, Loader2, Video, MonitorPlay } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { validateUrlInput } from '../../lib/validateUrl.js';

const EXAMPLES = ['github.com', 'vercel.com', 'wikipedia.org', 'stripe.com'];

export default function AnalyzeForm() {
  const { startAnalysis, backend } = useApp();
  const caps = backend.capabilities;
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [useBrowser, setUseBrowser] = useState(true);
  const [autoRender, setAutoRender] = useState(true);
  const [duration, setDuration] = useState(180);

  const validation = validateUrlInput(url);
  const showError = touched && !validation.ok;
  const browserAvailable = caps ? caps.browser.available : true;
  const renderAvailable = caps ? caps.media.ffmpeg.available && Boolean(caps.tts.default) : true;

  async function onSubmit(e) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (!validation.ok) return;
    setSubmitting(true);
    try {
      await startAnalysis({ url: url.trim(), browser: useBrowser && browserAvailable, autoRender: autoRender && renderAvailable, targetDurationSec: duration });
      setUrl('');
      setTouched(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="w-full" aria-label="Analyze a website">
      <div className={`glass-strong flex flex-col gap-2 rounded-2xl p-2 sm:flex-row sm:items-center ${showError ? 'border-danger/50' : ''}`}>
        <label className="flex min-w-0 flex-1 items-center gap-3 px-3">
          <Globe size={18} className="shrink-0 text-fg-subtle" aria-hidden />
          <span className="sr-only">Website URL</span>
          <input
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(null); }}
            onBlur={() => setTouched(Boolean(url))}
            placeholder="Enter any public website — e.g. stripe.com"
            className="w-full min-w-0 bg-transparent py-3 text-[15px] text-fg outline-none placeholder:text-fg-subtle"
            inputMode="url" autoComplete="url" spellCheck={false}
            aria-invalid={showError} aria-describedby="url-help"
            data-testid="url-input"
          />
        </label>
        <button type="submit" className="btn btn-primary !px-5 !py-3.5" disabled={submitting || backend.state === 'offline'} data-testid="analyze-button">
          {submitting ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
          {submitting ? 'Starting…' : 'Analyze'}
        </button>
      </div>

      <div id="url-help" className="mt-2 min-h-5 px-1 text-sm" aria-live="polite">
        {showError && <span className="text-danger" data-testid="url-error">{validation.error}</span>}
        {error && <span className="text-danger" role="alert" data-testid="submit-error">{error}</span>}
        {!showError && !error && backend.state === 'offline' && <span className="text-danger">The API is offline — start it with <code className="kbd">npm run dev</code>.</span>}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-sm text-fg-muted">
        <label className={`flex items-center gap-2 ${browserAvailable ? '' : 'opacity-60'}`} title={browserAvailable ? 'Load the page in an isolated headless Chromium to capture DOM and network activity' : caps?.browser.reason}>
          <input type="checkbox" className="accent-[var(--accent)]" checked={useBrowser && browserAvailable} disabled={!browserAvailable} onChange={(e) => setUseBrowser(e.target.checked)} />
          <MonitorPlay size={14} aria-hidden /> Render in sandboxed browser
        </label>
        <label className={`flex items-center gap-2 ${renderAvailable ? '' : 'opacity-60'}`} title={renderAvailable ? 'Render a narrated MP4 automatically after analysis' : 'FFmpeg or a narration voice is unavailable — see API status'}>
          <input type="checkbox" className="accent-[var(--accent)]" checked={autoRender && renderAvailable} disabled={!renderAvailable} onChange={(e) => setAutoRender(e.target.checked)} data-testid="auto-render" />
          <Video size={14} aria-hidden /> Generate video
        </label>
        <label className="flex items-center gap-2">
          Length
          <select className="rounded-lg border border-line bg-inset px-2 py-1 text-sm text-fg" value={duration} onChange={(e) => setDuration(Number(e.target.value))} data-testid="duration-select">
            <option value={90}>~1.5 min</option><option value={120}>~2 min</option><option value={180}>~3 min</option><option value={240}>~4 min</option>
          </select>
        </label>
        <span className="hidden text-fg-subtle sm:inline">·</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-fg-subtle">Try</span>
          {EXAMPLES.map((ex) => (
            <button type="button" key={ex} className="chip hover:border-line-strong hover:text-fg" onClick={() => { setUrl(ex); setTouched(false); }}>{ex}</button>
          ))}
        </span>
      </div>
    </form>
  );
}
