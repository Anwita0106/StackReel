import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Play, Pause, Volume2, VolumeX, Maximize, Captions, Download, Trash2, Clapperboard, Film, FileText, Mic, AlertTriangle, Loader2 } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { ProjectGate, ProjectHeader } from '../explorer/ExplorerView.jsx';
import JobProgress from '../jobs/JobProgress.jsx';
import { EmptyState, ErrorPanel, SafeImg } from '../common/ui.jsx';
import { api, renderFileUrl, screenshotUrl } from '../../lib/api.js';
import { formatBytes, formatDuration, timeAgo } from '../../lib/format.js';
import { buildTimeline, estimateSpeechSeconds, captionAt } from '@shared/scene/timeline.js';
import { createVideoModel, drawFrame } from '@shared/scene/renderer.js';

// ── live waveform from the real audio element (Web Audio AnalyserNode) ─────
function useAnalyser(mediaRef, enabled) {
  const ref = useRef(null);
  // Routing a <video> through Web Audio is irreversible: if the AudioContext is
  // suspended (browser autoplay policy) the video would play SILENTLY. So we
  // only connect once the context is confirmed running; otherwise the video
  // keeps its normal audio path and the meter simply stays idle.
  const connect = useCallback(async () => {
    if (!mediaRef.current || !window.AudioContext) return;
    if (ref.current) {
      if (ref.current.ctx.state === 'suspended') await ref.current.ctx.resume().catch(() => {});
      return;
    }
    let ctx;
    try {
      ctx = new AudioContext();
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      if (ctx.state !== 'running') { await ctx.close().catch(() => {}); return; }
      const src = ctx.createMediaElementSource(mediaRef.current);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      ref.current = { ctx, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
    } catch { ref.current = null; await ctx?.close().catch(() => {}); }
  }, [mediaRef]);
  useEffect(() => () => { ref.current?.ctx.close().catch(() => {}); ref.current = null; }, []);
  return { connect, get: () => (enabled ? ref.current : null) };
}

/** Explains why media failed by asking the server directly. */
async function diagnoseMedia(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1' } });
    if (res.ok) {
      const type = res.headers.get('content-type') || 'unknown';
      return /video\/mp4/.test(type) ? 'The file downloaded but this browser could not decode it. Try Download MP4 and open it in a media player.' : `The server sent "${type}" instead of video/mp4.`;
    }
    const body = await res.json().catch(() => null);
    return `The server answered HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}.`;
  } catch {
    return 'The API could not be reached while loading the video.';
  }
}

function LiveBars({ analyserApi, playing }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    let raf;
    const draw = () => {
      const c = canvasRef.current;
      const a = analyserApi.get();
      const g = c?.getContext('2d');
      if (g) {
        const w = c.width, h = c.height;
        g.clearRect(0, 0, w, h);
        const bars = 32;
        const styles = getComputedStyle(document.documentElement);
        const grad = g.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, styles.getPropertyValue('--accent').trim() || '#8b5cf6');
        grad.addColorStop(1, styles.getPropertyValue('--accent-2').trim() || '#22d3ee');
        g.fillStyle = grad;
        if (a && playing) a.analyser.getByteFrequencyData(a.data);
        for (let i = 0; i < bars; i += 1) {
          const v = a && playing ? a.data[Math.floor((i / bars) * a.data.length * 0.7)] / 255 : 0.04;
          const bh = Math.max(2, v * h);
          g.fillRect(i * (w / bars) + 1, h - bh, w / bars - 2, bh);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyserApi, playing]);
  return <canvas ref={canvasRef} width={160} height={28} className="h-7 w-40" aria-label={playing ? 'Live audio level' : 'Audio idle'} />;
}

// ── timeline with scenes, thumbnails, real waveform and playhead ────────────
function Timeline({ timeline, scenes, time, onSeek, waveform, thumbs }) {
  const ref = useRef(null);
  const dur = timeline.duration;
  const seekFromEvent = (e) => {
    const r = ref.current.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur)));
  };
  const segments = [
    { key: 'intro', label: 'Title', start: 0, end: timeline.intro.end },
    ...timeline.scenes.map((s, i) => ({ key: s.key, label: `${i + 1}. ${scenes[i].title}`, start: s.start, end: s.end, thumb: thumbs?.[i] })),
    { key: 'outro', label: 'Summary map', start: timeline.outro.start, end: timeline.outro.end },
  ];
  return (
    <div className="glass rounded-2xl p-3" data-testid="timeline">
      <div ref={ref} className="relative cursor-pointer select-none" onClick={seekFromEvent} role="slider" aria-label="Timeline" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(time)} tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'ArrowRight') onSeek(Math.min(dur, time + 5)); if (e.key === 'ArrowLeft') onSeek(Math.max(0, time - 5)); }}>
        <div className="flex h-16 gap-1">
          {segments.map((s) => {
            const active = time >= s.start && time < s.end;
            return (
              <div key={s.key} className={`relative overflow-hidden rounded-lg border transition-colors ${active ? 'border-accent/70' : 'border-line'}`} style={{ width: `${((s.end - s.start) / dur) * 100}%` }} title={s.label}>
                {s.thumb ? <SafeImg src={s.thumb} className="absolute inset-0 h-full w-full object-cover opacity-80" label="thumbnail unavailable" /> : <div className="absolute inset-0 bg-surface-3" />}
                <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">{s.label}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex h-10 items-center gap-px overflow-hidden rounded-md bg-inset px-1" aria-hidden>
          {waveform
            ? waveform.filter((_, i) => i % 3 === 0).map((v, i, arr) => (
              <span key={i} className={`flex-1 rounded-full ${i / arr.length <= time / dur ? 'bg-accent' : 'bg-line-strong'}`} style={{ height: `${Math.max(6, Math.min(100, v * 140))}%` }} />
            ))
            : <span className="w-full text-center font-mono text-[11px] text-fg-subtle">no audio yet — render to generate narration</span>}
        </div>
        <div className="pointer-events-none absolute -top-1 bottom-0 w-0.5 rounded bg-accent-2 shadow-[0_0_12px_var(--accent-2)]" style={{ left: `${(time / dur) * 100}%` }} />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[11px] text-fg-subtle"><span>{formatDuration(time)}</span><span>{formatDuration(dur)}</span></div>
    </div>
  );
}

// ── canvas preview (no audio, estimated timings) ─────────────────────────────
function PreviewCanvas({ model, time }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!ctx || !model) return;
    drawFrame(ctx, model, time);
  }, [model, time]);
  return <canvas ref={ref} width={model.width} height={model.height} className="block h-auto w-full" aria-label="Video preview" data-testid="preview-canvas" />;
}

function usePreviewClock(duration) {
  // Start on a representative frame (t=0 is the fully transparent start of the fade-in).
  const [time, setTime] = useState(3);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return undefined;
    let raf; let last = performance.now();
    const tick = (now) => {
      setTime((t) => { const n = t + (now - last) / 1000; if (n >= duration) { setPlaying(false); return duration; } return n; });
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);
  return { time, setTime, playing, setPlaying };
}

function RenderPanel({ project, onRendered }) {
  const { backend, startRender, jobs } = useApp();
  const caps = backend.capabilities;
  const providers = caps?.tts.providers || [];
  const [opts, setOpts] = useState({ resolution: '720p', fps: 24, ttsProvider: 'auto', voice: '', rate: 0, burnCaptions: true });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const effectiveProvider = opts.ttsProvider === 'auto' ? caps?.tts.default : opts.ttsProvider;
  const provider = providers.find(p => p.id === effectiveProvider);
  const job = Object.values(jobs).filter(j => j.type === 'render' && j.meta?.projectId === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const active = job && (job.status === 'queued' || job.status === 'running');
  const lastDone = useRef(null);
  useEffect(() => { if (job?.status === 'completed' && lastDone.current !== job.id) { lastDone.current = job.id; onRendered(job.result.renderId); } }, [job, onRendered]);

  const ffmpegOk = caps?.media.ffmpeg.available;
  async function go() {
    setError(null); setBusy(true);
    try {
      const body = { ...opts }; if (!body.voice) delete body.voice;
      await startRender(project.id, body);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const set = (k) => (e) => setOpts(o => ({ ...o, [k]: e.target.type === 'checkbox' ? e.target.checked : ['fps', 'rate'].includes(k) ? Number(e.target.value) : e.target.value, ...(k === 'ttsProvider' ? { voice: '' } : {}) }));

  return (
    <section className="glass rounded-3xl p-4" aria-label="Render settings" data-testid="render-panel">
      <div className="mb-3 flex items-center gap-2"><Clapperboard size={16} className="text-accent-strong" /><h3 className="font-display font-semibold">Render MP4</h3></div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1"><span className="text-xs text-fg-subtle">Resolution</span>
          <select className="input !py-2 text-sm" value={opts.resolution} onChange={set('resolution')}><option value="480p">480p (fastest)</option><option value="720p">720p HD</option><option value="1080p">1080p Full HD</option></select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-fg-subtle">Frame rate</span>
          <select className="input !py-2 text-sm" value={opts.fps} onChange={set('fps')}><option value={24}>24 fps (faster render)</option><option value={30}>30 fps (smoother)</option></select></label>
        <label className="col-span-2 flex flex-col gap-1"><span className="text-xs text-fg-subtle">Narration voice provider</span>
          <select className="input !py-2 text-sm" value={opts.ttsProvider} onChange={set('ttsProvider')} data-testid="tts-provider">
            <option value="auto">Auto ({caps?.tts.default || '…'})</option>
            {providers.map(p => <option key={p.id} value={p.id} disabled={!p.available}>{p.label}{p.available ? ` — ${p.cost}` : ` — ${p.reason}`}</option>)}
          </select></label>
        {provider?.voices?.length > 0 && (
          <label className="flex flex-col gap-1"><span className="text-xs text-fg-subtle">Voice</span>
            <select className="input !py-2 text-sm" value={opts.voice} onChange={set('voice')}><option value="">Default</option>{provider.voices.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label>
        )}
        <label className="flex flex-col gap-1"><span className="text-xs text-fg-subtle">Speech pace</span>
          <select className="input !py-2 text-sm" value={opts.rate} onChange={set('rate')}><option value={-2}>Slower</option><option value={0}>Normal</option><option value={2}>Faster</option></select></label>
        <label className="col-span-2 flex items-center gap-2 text-sm text-fg-muted"><input type="checkbox" className="accent-[var(--accent)]" checked={opts.burnCaptions} onChange={set('burnCaptions')} /> Burn captions into the video (soft VTT/SRT are always exported)</label>
      </div>
      {!ffmpegOk && caps && <p className="mt-3 flex gap-2 text-xs text-danger"><AlertTriangle size={14} /> FFmpeg unavailable: {caps.media.ffmpeg.error}</p>}
      {error && <p className="mt-3 text-xs text-danger" role="alert" data-testid="render-error">{error}</p>}
      <button className="btn btn-primary mt-4 w-full" onClick={go} disabled={busy || active || !ffmpegOk || !provider?.available} data-testid="render-button">
        {busy || active ? <Loader2 size={15} className="animate-spin" /> : <Film size={15} />} {active ? 'Rendering…' : 'Render video'}
      </button>
      <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">Rendering runs in a separate process. A video is only listed after FFmpeg finishes and ffprobe verifies its streams and duration.</p>
      {job && <div className="mt-4"><JobProgress job={job} compact={job.status === 'completed'} /></div>}
    </section>
  );
}

export default function StudioView() {
  return <ProjectGate>{(project) => <Studio key={project.id} project={project} />}</ProjectGate>;
}

function Studio({ project }) {
  const { toast, refreshRenders } = useApp();
  const [renders, setRenders] = useState({ status: 'loading', items: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [render, setRender] = useState(null);
  const [renderError, setRenderError] = useState(null);
  const videoRef = useRef(null);
  const [vt, setVt] = useState({ time: 0, playing: false, duration: null, muted: false });
  const [captionsOn, setCaptionsOn] = useState(false);
  const analyser = useAnalyser(videoRef, true);

  const loadRenders = useCallback(async (selectId) => {
    try {
      const items = await api.renders(project.id);
      setRenders({ status: 'ready', items });
      setSelectedId((cur) => selectId || cur || items[0]?.id || null);
    } catch (err) { setRenders({ status: 'error', items: [], error: err.message }); }
  }, [project.id]);
  useEffect(() => { loadRenders(); }, [loadRenders]);
  useEffect(() => {
    if (!selectedId) { setRender(null); return; }
    setRender(null); setRenderError(null);
    api.render(selectedId).then(setRender).catch((err) => setRenderError(err.message));
  }, [selectedId]);

  // Preview model (estimated timing) — used until a real render is selected.
  const [screenshot, setScreenshot] = useState(null);
  useEffect(() => {
    if (!project.hasScreenshot) return;
    const img = new Image();
    img.onload = () => setScreenshot(img);
    img.src = screenshotUrl(project.id);
  }, [project]);
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => { document.fonts?.ready.then(() => setFontsReady(true)); }, []);
  const estTimeline = useMemo(() => buildTimeline(project.script.scenes, project.script.scenes.map(s => estimateSpeechSeconds(s.narration))), [project]);
  const previewModel = useMemo(() => createVideoModel({ project, script: project.script, timeline: estTimeline, width: 1280, height: 720, assets: { screenshot } }), [project, estTimeline, screenshot, fontsReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = usePreviewClock(estTimeline.duration);

  const usingVideo = Boolean(render);
  const timeline = usingVideo ? render.timeline : estTimeline;
  const time = usingVideo ? vt.time : preview.time;
  const playing = usingVideo ? vt.playing : preview.playing;
  const duration = usingVideo ? (vt.duration ?? render.durationSec) : estTimeline.duration;
  const cue = captionAt(timeline, time);
  const sceneIdx = timeline.scenes.findIndex(s => time >= s.start && time < s.end);

  const seek = (t) => {
    if (usingVideo && videoRef.current) videoRef.current.currentTime = t;
    else preview.setTime(t);
  };
  const togglePlay = async () => {
    if (usingVideo) {
      const v = videoRef.current; if (!v || renderError) return;
      if (!v.paused) { v.pause(); return; }
      await analyser.connect();
      v.play().catch((err) => { if (err.name !== 'AbortError') toast('Playback failed', err.message, 'error'); });
    } else preview.setPlaying(p => !p);
  };
  const thumbs = usingVideo ? render.timeline.scenes.map(s => renderFileUrl(render.id, s.thumbnail)) : null;

  return (
    <div className="mx-auto max-w-[1500px]">
      <ProjectHeader project={project} right={
        <div className="flex flex-wrap gap-2">
          {render && <a className="btn btn-primary" href={renderFileUrl(render.id, 'video.mp4', true)} data-testid="download-mp4"><Download size={15} /> Download MP4</a>}
        </div>
      } />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <div className="glass-strong overflow-hidden rounded-3xl">
            <div className="relative aspect-video bg-black">
              {usingVideo ? (
                <video
                  key={render.id}
                  ref={videoRef}
                  className="h-full w-full"
                  src={renderFileUrl(render.id, 'video.mp4')}
                  poster={renderFileUrl(render.id, 'poster.jpg')}
                  preload="metadata"
                  crossOrigin="anonymous"
                  onTimeUpdate={(e) => { const time = e.currentTarget.currentTime; setVt(s => ({ ...s, time })); }}
                  onPlay={() => setVt(s => ({ ...s, playing: true }))}
                  onPause={() => setVt(s => ({ ...s, playing: false }))}
                  onEnded={() => setVt(s => ({ ...s, playing: false }))}
                  onLoadedMetadata={(e) => { const duration = e.currentTarget.duration; setVt(s => ({ ...s, duration })); }}
                  onVolumeChange={(e) => { const muted = e.currentTarget.muted; setVt(s => ({ ...s, muted })); }}
                  onError={async (e) => { const src = e.currentTarget.currentSrc || e.currentTarget.src; setRenderError(`The video could not be loaded. ${await diagnoseMedia(src)}`); }}
                  onClick={togglePlay}
                  data-testid="video-player"
                >
                  <track kind="captions" src={renderFileUrl(render.id, 'captions.vtt')} srcLang="en" label="English" default={captionsOn} />
                </video>
              ) : (
                <div className="relative h-full w-full cursor-pointer" onClick={togglePlay}>
                  <PreviewCanvas model={previewModel} time={preview.time} />
                  <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 font-mono text-[10.5px] text-white/85">PREVIEW · no sound · render the video to hear the narrator</span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
              <button className="btn btn-ghost btn-sm !px-2.5" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} data-testid="play-toggle">{playing ? <Pause size={15} /> : <Play size={15} />}</button>
              <span className="font-mono text-xs text-fg-muted" data-testid="time-display">{formatDuration(time)} / {formatDuration(duration)}</span>
              {usingVideo && (
                <>
                  <button className="btn btn-ghost btn-sm !px-2.5" onClick={() => { if (videoRef.current) videoRef.current.muted = !videoRef.current.muted; }} aria-label={vt.muted ? 'Unmute' : 'Mute'}>{vt.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
                  <input type="range" min="0" max="1" step="0.05" defaultValue="1" aria-label="Volume" className="w-20 accent-[var(--accent)]" data-testid="volume" onChange={(e) => { if (videoRef.current) { videoRef.current.volume = Number(e.target.value); videoRef.current.muted = Number(e.target.value) === 0; } }} />
                  <button className={`btn btn-ghost btn-sm !px-2.5 ${captionsOn ? '!text-accent-2' : ''}`} aria-pressed={captionsOn} onClick={() => {
                    setCaptionsOn(c => { const next = !c; const tr = videoRef.current?.textTracks?.[0]; if (tr) tr.mode = next ? 'showing' : 'hidden'; return next; });
                  }} aria-label="Toggle soft captions"><Captions size={15} /></button>
                  <button className="btn btn-ghost btn-sm !px-2.5" onClick={() => videoRef.current?.requestFullscreen?.()} aria-label="Fullscreen"><Maximize size={15} /></button>
                  <LiveBars analyserApi={analyser} playing={vt.playing} />
                </>
              )}
              <span className="ml-auto truncate text-xs text-fg-muted">{sceneIdx >= 0 ? `Scene ${sceneIdx + 1} · ${project.script.scenes[sceneIdx].title}` : time < timeline.intro.end ? 'Title sequence' : 'Final architecture map'}</span>
            </div>
          </div>

          <div className="glass min-h-14 rounded-2xl px-4 py-3 text-center text-sm" aria-live="off" data-testid="subtitle-preview">
            <span className="mr-2 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">subtitle</span>
            {cue ? <span>{cue.text}</span> : <span className="text-fg-subtle">—</span>}
          </div>

          <Timeline timeline={timeline} scenes={project.script.scenes} time={time} onSeek={seek} waveform={usingVideo ? render.waveform : null} thumbs={thumbs} />
          {renderError && <ErrorPanel title="Video unavailable" message={renderError} onRetry={() => loadRenders()} />}

          <section aria-label="Scenes">
            <h3 className="mb-3 font-display text-lg font-semibold">Six-scene script</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {project.script.scenes.map((s, i) => {
                const tl = timeline.scenes[i];
                const active = i === sceneIdx;
                return (
                  <motion.button key={s.id} onClick={() => seek(tl.start + 0.01)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
                    className={`glass card-hover rounded-2xl p-4 text-left ${active ? '!border-accent/60 shadow-glow' : ''}`} data-testid={`scene-${i + 1}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-accent-2">{String(i + 1).padStart(2, '0')}</span>
                      <span className="font-semibold">{s.title}</span>
                      <span className="ml-auto font-mono text-[11px] text-fg-subtle">{formatDuration(tl.start)} · {Math.round(tl.end - tl.start)}s{usingVideo ? '' : ' est.'}</span>
                    </div>
                    <div className="mt-1 text-xs text-fg-subtle">{s.subtitle}</div>
                    <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-fg-muted">{s.narration}</p>
                    <div className="mt-2 font-mono text-[10.5px] text-fg-subtle">{s.narration.split(/\s+/).length} words · snippet: {s.snippet.illustrative ? 'illustrative' : 'from evidence'}</div>
                  </motion.button>
                );
              })}
            </div>
          </section>
        </div>

        <div className="space-y-4">
          <RenderPanel project={project} onRendered={(id) => { loadRenders(id); refreshRenders(); }} />

          <section className="glass rounded-3xl p-4" aria-label="Narration">
            <div className="mb-2 flex items-center gap-2"><Mic size={15} className="text-accent-strong" /><h3 className="font-display font-semibold">Narration</h3></div>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl bg-inset p-2"><dt className="text-fg-subtle">Script</dt><dd className="font-semibold">{project.script.provider === 'deterministic' ? 'Deterministic (evidence templates)' : `LLM-polished (${project.script.provider})`}</dd></div>
              <div className="rounded-xl bg-inset p-2"><dt className="text-fg-subtle">Words</dt><dd className="font-semibold">{project.script.scenes.reduce((a, s) => a + s.narration.split(/\s+/).length, 0)}</dd></div>
              <div className="rounded-xl bg-inset p-2"><dt className="text-fg-subtle">Target length</dt><dd className="font-semibold">{formatDuration(project.script.targetDurationSec)}</dd></div>
              <div className="rounded-xl bg-inset p-2"><dt className="text-fg-subtle">{usingVideo ? 'Actual length' : 'Estimated'}</dt><dd className="font-semibold">{formatDuration(duration)}</dd></div>
              {render && <div className="col-span-2 rounded-xl bg-inset p-2"><dt className="text-fg-subtle">Voice</dt><dd className="font-semibold">{render.tts.provider} · {render.tts.voice}</dd>{render.tts.fallbackFrom && <dd className="mt-1 text-[11px] text-warn">Fell back to the offline voice: {render.tts.fallbackFrom}</dd>}</div>}
              {render?.audio?.final && <div className="col-span-2 rounded-xl bg-inset p-2" data-testid="audio-check"><dt className="text-fg-subtle">Narration audio (measured in the MP4)</dt><dd className="font-semibold">peak {render.audio.final.peakDb} dB · speech in {Math.round(render.audio.final.speechCoverage * 100)}% of the video</dd></div>}
            </dl>
            {project.llm?.error && <p className="mt-2 text-[11px] text-warn">LLM polish failed, deterministic script used: {project.llm.error}</p>}
          </section>

          <section className="glass rounded-3xl p-4" aria-label="Rendered videos">
            <h3 className="mb-3 font-display font-semibold">Renders</h3>
            {renders.status === 'error' && <ErrorPanel message={renders.error} onRetry={() => loadRenders()} />}
            {renders.status === 'ready' && !renders.items.length && <EmptyState title="No video yet">Render the six-scene script to get a real MP4 with narration and captions.</EmptyState>}
            <ul className="space-y-2" data-testid="render-list">
              {renders.items.map(r => (
                <li key={r.id} className={`rounded-2xl border p-2.5 ${r.id === selectedId ? 'border-accent/50 bg-surface-2' : 'border-line'}`}>
                  <button className="flex w-full items-center gap-3 text-left" onClick={() => setSelectedId(r.id)}>
                    <SafeImg src={renderFileUrl(r.id, 'poster.jpg')} className="h-11 w-20 shrink-0 rounded-lg object-cover" label="no poster" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">{formatDuration(r.durationSec)} · {r.height}p{r.fps}</div>
                      <div className="font-mono text-[11px] text-fg-subtle">{formatBytes(r.sizeBytes)} · {r.tts?.provider} · {timeAgo(r.createdAt)}</div>
                    </div>
                  </button>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <a className="btn btn-ghost btn-sm" href={renderFileUrl(r.id, 'video.mp4', true)}><Download size={12} /> MP4</a>
                    <a className="btn btn-ghost btn-sm" href={renderFileUrl(r.id, 'captions.srt', true)}><FileText size={12} /> SRT</a>
                    <a className="btn btn-ghost btn-sm" href={renderFileUrl(r.id, 'captions.vtt', true)}><FileText size={12} /> VTT</a>
                    <button className="btn btn-ghost btn-sm ml-auto !px-2" aria-label="Delete render" onClick={async () => {
                      if (!window.confirm('Delete this video?')) return;
                      try { await api.deleteRender(r.id); if (r.id === selectedId) setSelectedId(null); await loadRenders(); refreshRenders(); } catch (err) { toast('Delete failed', err.message, 'error'); }
                    }}><Trash2 size={12} /></button>
                  </div>
                </li>
              ))}
            </ul>
            {render && <p className="mt-3 text-[11px] text-fg-subtle">Verified by ffprobe: {render.probe.video.codec} {render.probe.video.width}×{render.probe.video.height} · {render.probe.audio.codec} {render.probe.audio.sampleRate / 1000} kHz · rendered in {render.renderSeconds}s</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
