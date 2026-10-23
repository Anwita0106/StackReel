// Single API client. Every call has a timeout, parses the server's
// { ok, data | error } envelope, and throws ApiError with a message that is
// safe to show to the user. Nothing here ever fabricates a successful result.

// Empty base → same-origin requests through the Vite dev proxy (or the
// production server). Set VITE_API_URL only when the API lives elsewhere.
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', details, requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export const apiUrl = (path) => `${API_BASE}/api${path}`;

export async function request(path, { method = 'GET', body, timeoutMs = 15000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort);
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (controller.signal.aborted) {
      throw new ApiError(`The StackReel API did not respond within ${Math.round(timeoutMs / 1000)}s.`, { code: 'TIMEOUT' });
    }
    throw new ApiError('Cannot reach the StackReel API. Is the server running? Start everything with "npm run dev".', { code: 'BACKEND_UNREACHABLE' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  let payload = null;
  const text = await res.text();
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

  if (!res.ok || !payload?.ok) {
    if (!payload) {
      // Typically the dev proxy answering 502/504 because the API is down or on another port.
      throw new ApiError(
        res.status === 502 || res.status === 504 || res.status === 500
          ? 'The dev proxy could not reach the API server. Make sure it is running and that PORT in .env matches.'
          : `Unexpected response from the API (HTTP ${res.status}).`,
        { status: res.status, code: 'BAD_RESPONSE' },
      );
    }
    const e = payload.error || {};
    throw new ApiError(e.message || `Request failed (HTTP ${res.status}).`, { status: res.status, code: e.code, details: e.details || payload.data?.checks, requestId: payload.requestId });
  }
  return payload.data;
}

export const api = {
  health: () => request('/health', { timeoutMs: 5000 }),
  ready: () => request('/ready', { timeoutMs: 20000 }).catch((err) => { if (err.status === 503) return { ready: false, checks: err.details }; throw err; }),
  capabilities: (refresh) => request(`/capabilities${refresh ? '?refresh=1' : ''}`, { timeoutMs: 20000 }),
  stats: () => request('/stats'),
  startAnalysis: (body) => request('/analyses', { method: 'POST', body }),
  job: (id, opts) => request(`/jobs/${id}`, opts),
  jobs: (params = '') => request(`/jobs${params}`),
  cancelJob: (id) => request(`/jobs/${id}/cancel`, { method: 'POST' }),
  retryJob: (id) => request(`/jobs/${id}/retry`, { method: 'POST' }),
  projects: () => request('/projects'),
  project: (id) => request(`/projects/${id}`, { timeoutMs: 20000 }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
  startRender: (projectId, options) => request(`/projects/${projectId}/renders`, { method: 'POST', body: options }),
  renders: (projectId) => request(`/renders${projectId ? `?projectId=${projectId}` : ''}`),
  render: (id) => request(`/renders/${id}`),
  deleteRender: (id) => request(`/renders/${id}`, { method: 'DELETE' }),
};

export const renderFileUrl = (renderId, file, download = false) => apiUrl(`/renders/${renderId}/files/${file}${download ? '?download=1' : ''}`);
export const screenshotUrl = (projectId) => apiUrl(`/projects/${projectId}/screenshot`);
