import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../App.jsx';

const scenes = ['overview', 'frontend', 'request-flow', 'backend', 'security', 'summary'].map((key, i) => ({
  id: i + 1, key, title: `Scene ${i + 1}`, subtitle: 'sub', narration: 'It uses Next.js for rendering. This is observed.', focusNodeIds: [], bullets: [], panel: { title: 'p', lines: [] }, snippet: { title: 's', language: 'json', code: '{}', illustrative: false },
}));
const project = {
  id: 'prj_aaaaaaaaaaaaaaaa', createdAt: new Date().toISOString(), url: 'https://x.example/', finalUrl: 'https://x.example/', site: { host: 'x.example' },
  hasScreenshot: false, browser: { ok: true }, unavailable: [], technologies: [], integrations: [], evidence: [],
  graph: { layers: [], nodes: [{ id: 'client', label: 'Visitor browser', layer: 'client', status: 'observed', confidence: 1, description: '', technologies: [], evidenceIds: [], limitations: [], details: {} }], edges: [] },
  security: { findings: [], summary: { concerns: 0, passes: 0, bySeverity: {} }, disclaimer: '' },
  script: { provider: 'deterministic', targetDurationSec: 120, scenes }, llm: { used: false },
};
const tl = { duration: 60, intro: { start: 0, end: 4.5 }, outro: { start: 54, end: 60 }, transition: 0.6, captions: [{ start: 5, end: 9, text: 'It uses Next.js for rendering.', sceneIndex: 0 }],
  scenes: scenes.map((s, i) => ({ index: i, id: s.id, key: s.key, title: s.title, start: 4.5 + i * 8.25, end: 4.5 + (i + 1) * 8.25, speechStart: 5, speechEnd: 9, thumbnail: `thumb-${i + 1}.jpg` })) };
const renderRec = { id: 'rnd_bbbbbbbbbbbbbbbb', projectId: project.id, host: 'x.example', createdAt: new Date().toISOString(), durationSec: 60, width: 1280, height: 720, fps: 30, sizeBytes: 5e6,
  tts: { provider: 'mespeak', voice: 'en-us' }, audio: { final: { peakDb: -1.2, rmsDb: -19.5, speechCoverage: 0.71 } }, timeline: tl, waveform: Array(90).fill(0.3), probe: { video: { codec: 'h264', width: 1280, height: 720 }, audio: { codec: 'aac', sampleRate: 48000 } }, renderSeconds: 40 };

const ok = (data) => Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));
function mock() {
  vi.stubGlobal('fetch', vi.fn((url) => {
    const p = String(url).replace(/^.*\/api/, '');
    if (p === '/health') return ok({ status: 'ok' });
    if (p === '/ready') return ok({ ready: true, checks: {} });
    if (p.startsWith('/capabilities')) return ok({ browser: { available: true }, media: { ffmpeg: { available: true }, ffprobe: { available: true } }, tts: { default: 'mespeak', providers: [{ id: 'mespeak', label: 'meSpeak', available: true, voices: [], cost: 'free' }] }, llm: {} });
    if (p === '/projects') return ok([{ id: project.id, site: project.site, createdAt: project.createdAt, counts: {}, topTechnologies: [] }]);
    if (p === `/projects/${project.id}`) return ok(project);
    if (p.startsWith('/renders?projectId')) return ok([renderRec]);
    if (p === `/renders/${renderRec.id}`) return ok(renderRec);
    if (p === '/renders') return ok([renderRec]);
    if (p === '/stats') return ok({ analyses: 1, videos: 1, videoSeconds: 60, componentsMapped: 1, topTechnologies: [] });
    if (p.startsWith('/jobs')) return ok([]);
    return Promise.resolve(new Response('{}', { status: 404 }));
  }));
}

describe('Video studio', () => {
  it('loads the verified render, tracks real media time and exposes downloads', async () => {
    mock();
    window.location.hash = `#/studio/${project.id}`;
    render(<App />);
    const video = await screen.findByTestId('video-player');
    expect(video.getAttribute('src')).toContain(`/api/renders/${renderRec.id}/files/video.mp4`);
    Object.defineProperty(video, 'duration', { value: 61, configurable: true });
    fireEvent.loadedMetadata(video);
    Object.defineProperty(video, 'currentTime', { value: 6, configurable: true, writable: true });
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(screen.getByTestId('time-display')).toHaveTextContent('0:06 / 1:01'));
    expect(screen.getByTestId('subtitle-preview')).toHaveTextContent('It uses Next.js for rendering.');
    expect(screen.getByTestId('download-mp4').getAttribute('href')).toMatch(/video\.mp4\?download=1$/);
    expect(screen.getByTestId('render-list')).toHaveTextContent('1:00');
    expect(screen.getByTestId('audio-check')).toHaveTextContent('speech in 71% of the video');
    fireEvent.change(screen.getByTestId('volume'), { target: { value: '0.4' } });
    expect(video.volume).toBeCloseTo(0.4);
  });

  it('explains a failed video with the real server response instead of a generic error', async () => {
    mock();
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url, init) => (String(url).includes('/files/video.mp4')
      ? Promise.resolve(new Response(JSON.stringify({ ok: false, error: { code: 'FILE_UNREADABLE', message: 'The file could not be read from disk (ENOENT).' } }), { status: 404 }))
      : orig(url, init))));
    window.location.hash = `#/studio/${project.id}`;
    render(<App />);
    const video = await screen.findByTestId('video-player');
    fireEvent.error(video);
    expect(await screen.findByText(/HTTP 404: The file could not be read from disk/)).toBeInTheDocument();
  });

  it('shows an honest placeholder when a thumbnail cannot be loaded', async () => {
    mock();
    window.location.hash = `#/studio/${project.id}`;
    render(<App />);
    await screen.findByTestId('video-player');
    const thumbs = screen.getByTestId('timeline').querySelectorAll('img');
    expect(thumbs.length).toBe(6);
    fireEvent.error(thumbs[0]);
    expect(await screen.findAllByText('thumbnail unavailable')).toHaveLength(1);
  });

  it('shows the live preview with an explicit "estimated, no audio" label when nothing is rendered', async () => {
    mock();
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url, init) => (String(url).includes('/renders?projectId') ? ok([]) : orig(url, init))));
    window.location.hash = `#/studio/${project.id}`;
    render(<App />);
    expect(await screen.findByTestId('preview-canvas')).toBeInTheDocument();
    expect(screen.getByText(/no sound · render the video to hear the narrator/)).toBeInTheDocument();
    expect(screen.getByText(/no audio yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('download-mp4')).toBeNull();
  });
});
