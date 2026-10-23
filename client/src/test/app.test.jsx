import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { validateUrlInput } from '../lib/validateUrl.js';
import { request, ApiError } from '../lib/api.js';
import { toFlow } from '../components/explorer/graphModel.js';
import { ThemeProvider, useTheme } from '../context/ThemeContext.jsx';
import { AppProvider } from '../context/AppContext.jsx';
import AnalyzeForm from '../components/dashboard/AnalyzeForm.jsx';
import DashboardView from '../components/dashboard/DashboardView.jsx';
import { StatusBadge, TypingTerminal } from '../components/common/ui.jsx';

const ok = (data, status = 200) => Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'content-type': 'application/json' } }));
const fail = (status, code, message) => Promise.resolve(new Response(JSON.stringify({ ok: false, error: { code, message } }), { status }));
const caps = { browser: { available: true }, media: { ffmpeg: { available: true }, ffprobe: { available: true } }, tts: { default: 'mespeak', providers: [] }, llm: { ready: false } };

function mockApi(overrides = {}) {
  const calls = [];
  const fetchMock = vi.fn((url, init = {}) => {
    const path = String(url).replace(/^.*\/api/, '');
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    for (const [prefix, handler] of Object.entries(overrides)) if (path.startsWith(prefix)) return handler(path, init);
    if (path === '/health') return ok({ status: 'ok' });
    if (path === '/ready') return ok({ ready: true, checks: {} });
    if (path.startsWith('/capabilities')) return ok(caps);
    if (path === '/projects') return ok([]);
    if (path === '/renders') return ok([]);
    if (path === '/stats') return ok({ analyses: 0, videos: 0, videoSeconds: 0, componentsMapped: 0, topTechnologies: [] });
    if (path.startsWith('/jobs')) return ok([]);
    return fail(404, 'NOT_FOUND', 'nope');
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}
const wrap = (ui) => render(<ThemeProvider><AppProvider pollMs={20}>{ui}</AppProvider></ThemeProvider>);

beforeEach(() => { document.documentElement.className = ''; delete document.documentElement.dataset.theme; vi.unstubAllGlobals(); });

describe('URL validation', () => {
  it('accepts domains with or without scheme and ports', () => {
    expect(validateUrlInput('stripe.com')).toMatchObject({ ok: true, url: 'https://stripe.com/' });
    expect(validateUrlInput('http://example.com:8080/x').ok).toBe(true);
  });
  it('rejects empty, local, private, single-label and non-http input', () => {
    for (const bad of ['', 'localhost', 'http://127.0.0.1', '192.168.0.1', 'intranet', 'ftp://x.com', 'javascript:alert(1)', 'a b.com', 'https://u:p@x.com']) {
      expect(validateUrlInput(bad).ok, bad).toBe(false);
    }
  });
});

describe('API client', () => {
  it('unwraps the success envelope', async () => {
    mockApi({ '/x': () => ok({ a: 1 }) });
    await expect(request('/x')).resolves.toEqual({ a: 1 });
  });
  it('surfaces server errors with code and message', async () => {
    mockApi({ '/x': () => fail(422, 'TARGET_NOT_ALLOWED', 'Local hostnames cannot be analyzed.') });
    await expect(request('/x')).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED', status: 422, message: 'Local hostnames cannot be analyzed.' });
  });
  it('reports an unreachable backend instead of inventing data', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const err = await request('/projects').catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('BACKEND_UNREACHABLE');
  });
  it('explains a proxy failure (non-JSON 502)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('Bad gateway', { status: 502 }))));
    await expect(request('/projects')).rejects.toThrow(/PORT in .env/);
  });
});

describe('Analyze form', () => {
  it('shows a validation error and does not submit invalid input', async () => {
    const calls = mockApi();
    wrap(<AnalyzeForm />);
    await userEvent.type(screen.getByTestId('url-input'), 'localhost:3000');
    await userEvent.click(screen.getByTestId('analyze-button'));
    expect(screen.getByTestId('url-error')).toHaveTextContent(/Local and private/);
    expect(calls.some(c => c.path === '/analyses')).toBe(false);
  });

  it('submits a valid URL with the selected options', async () => {
    const calls = mockApi({ '/analyses': () => ok({ job: { id: 'job_1', type: 'analysis', status: 'queued', stages: [], logs: [], progress: 0, meta: { host: 'stripe.com' }, createdAt: new Date().toISOString() }, deduplicated: false }, 202) });
    wrap(<AnalyzeForm />);
    await userEvent.type(screen.getByTestId('url-input'), 'stripe.com');
    await userEvent.selectOptions(screen.getByTestId('duration-select'), '120');
    await userEvent.click(screen.getByTestId('analyze-button'));
    await waitFor(() => expect(calls.find(c => c.path === '/analyses')).toBeTruthy());
    expect(calls.find(c => c.path === '/analyses').body).toMatchObject({ url: 'stripe.com', browser: true, autoRender: true, targetDurationSec: 120 });
  });

  it('shows the server error message when the request is rejected', async () => {
    mockApi({ '/analyses': () => fail(422, 'TARGET_NOT_ALLOWED', '"example.org" resolves to a non-public address.') });
    wrap(<AnalyzeForm />);
    await userEvent.type(screen.getByTestId('url-input'), 'example.org');
    await userEvent.click(screen.getByTestId('analyze-button'));
    expect(await screen.findByTestId('submit-error')).toHaveTextContent(/non-public address/);
  });
});

describe('Dashboard', () => {
  it('shows an honest empty state and no stats on a fresh install', async () => {
    mockApi();
    wrap(<DashboardView />);
    expect(await screen.findByText('No analyses yet')).toBeInTheDocument();
    expect(screen.queryByTestId('stats')).toBeNull();
  });

  it('shows job progress with real stages and log lines while running', async () => {
    let n = 0;
    const job = (status, progress) => ({ id: 'job_abc', type: 'analysis', status, stage: 'Fetching document & headers', stageIndex: 2, stages: ['Validating URL & destination', 'Checking robots.txt', 'Fetching document & headers'], progress, logs: [{ t: new Date().toISOString(), msg: 'GET https://stripe.com/' }], meta: { host: 'stripe.com' }, createdAt: new Date().toISOString(), error: status === 'failed' ? { message: 'Could not connect to stripe.com: ECONNREFUSED.' } : null });
    mockApi({
      '/analyses': () => ok({ job: job('queued', 0), deduplicated: false }, 202),
      '/jobs/job_abc': () => ok(++n < 2 ? job('running', 25) : job('failed', 25)),
    });
    wrap(<DashboardView />);
    await userEvent.type(screen.getByTestId('url-input'), 'stripe.com');
    await userEvent.click(screen.getByTestId('analyze-button'));
    expect(await screen.findByText('GET https://stripe.com/')).toBeInTheDocument();
    expect(await screen.findByText(/ECONNREFUSED/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('marks the API offline when the backend cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    wrap(<DashboardView />);
    expect(await screen.findByText(/The API is offline/)).toBeInTheDocument();
    expect(screen.getByTestId('analyze-button')).toBeDisabled();
  });
});

describe('Theme', () => {
  function Probe() { const { theme, toggleTheme } = useTheme(); return <button onClick={toggleTheme}>{theme}</button>; }
  it('respects the system preference on first visit', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({ matches: q.includes('light'), media: q, addEventListener() {}, removeEventListener() {} }));
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByRole('button')).toHaveTextContent('light');
  });
  it('toggles, applies the class to <html>, and persists the choice', async () => {
    document.documentElement.dataset.theme = 'dark';
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await userEvent.click(screen.getByRole('button'));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(localStorage.getItem('stackreel.theme')).toBe('light');
  });
});

describe('Architecture graph model', () => {
  const graph = {
    layers: [],
    nodes: [
      { id: 'client', label: 'Visitor browser', layer: 'client', status: 'observed', confidence: 1, description: '', technologies: [], evidenceIds: [], limitations: [], details: {} },
      { id: 'fe-nextjs', label: 'Next.js', layer: 'frontend', status: 'observed', confidence: 1, description: 'framework', technologies: ['nextjs'], evidenceIds: [], limitations: [], details: {} },
      { id: 'be-unknown', label: 'Backend services', layer: 'backend', status: 'unknown', confidence: 0, description: '', technologies: [], evidenceIds: [], limitations: [], details: {} },
      { id: 'sec-headers', label: 'Policy', layer: 'security', status: 'observed', confidence: 1, description: '', technologies: [], evidenceIds: [], limitations: [], details: {} },
    ],
    edges: [
      { id: 'e1', source: 'client', target: 'fe-nextjs', label: 'loads', explanation: '', status: 'observed', evidenceIds: [] },
      { id: 'e2', source: 'fe-nextjs', target: 'be-unknown', label: '?', explanation: '', status: 'unknown', evidenceIds: [] },
    ],
  };
  it('lays out layers left-to-right with lanes and bands, styling edges by status', () => {
    const f = toFlow(graph);
    const arch = Object.fromEntries(f.nodes.filter(n => n.type === 'arch').map(n => [n.id, n]));
    expect(arch.client.position.x).toBeLessThan(arch['fe-nextjs'].position.x);
    expect(arch['fe-nextjs'].position.x).toBeLessThan(arch['be-unknown'].position.x);
    expect(f.nodes.some(n => n.id === 'band-security')).toBe(true);
    expect(f.edges.find(e => e.id === 'e1').animated).toBe(true);
    expect(f.edges.find(e => e.id === 'e2').style.strokeDasharray).toBe('2 5');
  });
  it('search and status filters dim non-matching nodes; selection highlights neighbours', () => {
    const f = toFlow(graph, { search: 'next' });
    expect(f.nodes.find(n => n.id === 'client').data.dimmed).toBe(true);
    expect(f.nodes.find(n => n.id === 'fe-nextjs').data.dimmed).toBe(false);
    const s = toFlow(graph, { selectedId: 'fe-nextjs' });
    expect(s.nodes.find(n => n.id === 'client').data.highlighted).toBe(true);
    expect(s.nodes.find(n => n.id === 'sec-headers').data.dimmed).toBe(true);
    expect(s.edges.find(e => e.id === 'e1').label).toBe('loads');
    const u = toFlow(graph, { statuses: new Set(['unknown']) });
    expect(u.nodes.find(n => n.id === 'client').data.dimmed).toBe(true);
  });
});

describe('UI primitives', () => {
  it('status badges explain what each status means', () => {
    render(<StatusBadge status="inferred" />);
    expect(screen.getByTitle(/Plausible/)).toHaveTextContent('Inferred');
  });
  it('typing terminal eventually shows all lines', async () => {
    vi.useFakeTimers();
    render(<TypingTerminal title="t" lines={['server: nginx', 'x-powered-by: Express']} />);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('x-powered-by: Express')).toBeInTheDocument();
    vi.useRealTimers();
  });
});
