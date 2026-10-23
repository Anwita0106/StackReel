# StackReel API

Base path: `/api`. All responses are JSON envelopes:

```json
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "code": "TARGET_NOT_ALLOWED", "message": "…", "details": … }, "requestId": "…" }
```

Every response carries `X-Request-Id`. Browser calls must come from an allowed origin (`CORS_ORIGINS` + the dev frontend); others receive `403 CORS_ORIGIN_NOT_ALLOWED`.

## Health

| Method | Path | Result |
|---|---|---|
| GET | `/health` | Liveness: `{ status: "ok", version, uptimeSec }` |
| GET | `/ready` | `200` when storage, FFmpeg/ffprobe and a TTS provider are ready, else `503`; `data.checks` lists each (browser is optional). |
| GET | `/capabilities[?refresh=1]` | Browser availability, FFmpeg info, TTS providers & voices, LLM status, limits (cached 60 s). |

## Analyses & jobs

`POST /analyses` — start an analysis (rate-limited per IP).

```json
{ "url": "stripe.com", "browser": true, "targetDurationSec": 180, "autoRender": false,
  "render": { "resolution": "720p", "fps": 30, "ttsProvider": "auto", "voice": "…", "rate": 0, "burnCaptions": true } }
```

- `202 { job, deduplicated: false }` — new job. `200 { job, deduplicated: true }` — the same URL is already running.
- `400 VALIDATION_ERROR | INVALID_JSON`, `422 TARGET_NOT_ALLOWED` (scheme/host/port/IP rejected up front), `429 RATE_LIMITED`, `503 QUEUE_FULL`.
- Later failures appear on the job: `TARGET_NOT_ALLOWED` (DNS/redirect), `ROBOTS_DISALLOWED`, `TOO_MANY_REDIRECTS`, `TARGET_TIMEOUT`, `TARGET_UNREACHABLE` (retried once automatically).

`GET /jobs/:id` → job:

```json
{ "id": "job_…", "type": "analysis|render", "status": "queued|running|completed|failed|cancelled",
  "stage": "Fetching document & headers", "stageIndex": 2, "stages": ["…"], "progress": 25,
  "attempts": 1, "logs": [{ "t": "ISO", "msg": "…" }], "error": { "code", "message" } | null,
  "result": { "projectId", "host", "renderJobId?" } | { "renderId", "projectId", "durationSec" },
  "meta": { "host", "url|projectId" }, "createdAt", "startedAt", "finishedAt" }
```

`GET /jobs[?active=1&type=analysis]` · `POST /jobs/:id/cancel` · `POST /jobs/:id/retry` (failed/cancelled only, `409 NOT_RETRYABLE` otherwise). Jobs live in memory for 2 hours.

## Projects

| Method | Path | Result |
|---|---|---|
| GET | `/projects` | Summaries: `id, createdAt, url, finalUrl, site, title, hasScreenshot, browserRendered, counts{technologies,observed,inferred,unknown,concerns}, topTechnologies` |
| GET | `/projects/:id` | Full analysis: `http, tls, dns, upgrade, robots, browser, technologies, integrations, traffic, security, graph, evidence, script, llm, unavailable, limits` |
| DELETE | `/projects/:id` | Deletes the project and its renders |
| GET | `/projects/:id/screenshot` | JPEG captured by the sandboxed browser |

Key shapes:

- **Technology** `{ id, name, category, layer, version, status: observed|inferred, confidence 0–1, evidenceIds[], rationale, signals[] }`
- **Graph node** `{ id, label, layer, type, status: observed|inferred|unknown, confidence, description, evidenceIds[], technologies[], limitations[], details{} }`
- **Graph edge** `{ id, source, target, label, explanation, status, evidenceIds[] }`
- **Evidence** `{ id, kind, source, label, value }`
- **Security finding** `{ id, category, title, status: concern|pass|observation, severity: high|medium|low|info, confidence, observation, evidenceIds[], impact, remediation }`
- **Script** `{ provider, targetDurationSec, scenes[6]: { id, key, title, subtitle, narration, focusNodeIds[], bullets[], panel{title,lines[]}, snippet{title,language,code,illustrative} } }`

## Renders

`POST /projects/:id/renders` with `{ resolution: "480p|720p|1080p", fps: 24|30, ttsProvider, voice?, rate: -5..5, burnCaptions }` → `202 { job }`. `503 FFMPEG_UNAVAILABLE | TTS_UNAVAILABLE` when the pipeline cannot run.

| Method | Path | Result |
|---|---|---|
| GET | `/renders[?projectId=]` | Summaries `{ id, projectId, host, createdAt, durationSec, width, height, fps, sizeBytes, tts }` |
| GET | `/renders/:id` | Full record incl. `probe` (ffprobe), `timeline` (scenes, captions), `waveform`, `files` |
| DELETE | `/renders/:id` | Deletes the render |
| GET | `/renders/:id/files/:file[?download=1]` | `video.mp4`, `poster.jpg`, `captions.vtt`, `captions.srt`, `narration.wav`, `thumb-1..6.jpg`. Supports `Range` (206). Any other name → 404. |

## Stats

`GET /stats` → `{ analyses, videos, videoSeconds, componentsMapped, topTechnologies[], activeJobs }` computed from stored data only.
