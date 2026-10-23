# StackReel architecture

## Processes

```
Browser (React app) ──/api──▶ Express API (Node, single process)
                                 ├─ JobManager (in-memory queues: analysis ×2, render ×1)
                                 │    ├─ analysis job  ── in-process, async I/O
                                 │    │     └─ headless Chromium (separate OS process)
                                 │    │           └─ all traffic ─▶ per-job egress proxy (127.0.0.1, random port, auth)
                                 │    └─ render job ─── fork() ─▶ render worker (child process)
                                 │                                 ├─ TTS provider (OS voice / meSpeak / cloud)
                                 │                                 ├─ @napi-rs/canvas + shared renderer
                                 │                                 └─ FFmpeg (child process) → MP4
                                 └─ FileStore (server/.data: projects/<id>, renders/<id>)
```

Long work never runs inside a request: `POST /api/analyses` and `POST /api/projects/:id/renders` return `202` with a job; the UI polls `GET /api/jobs/:id`.

## Outbound-request security (SSRF)

Every destination — the submitted URL, each redirect hop, robots.txt, the TLS probe, and **every request the headless browser makes** — goes through one policy (`server/src/security/`):

1. **URL policy** — only `http`/`https`, no credentials in URLs, allow-listed ports (`80,443,8080,8443` by default), no `localhost`, `*.local`, `*.internal`, metadata hostnames or single-label hosts.
2. **IP policy** — `net.BlockList` of loopback, RFC1918, CGNAT, link-local (incl. `169.254.169.254`), multicast, reserved, documentation, benchmarking, IPv6 ULA/link-local/multicast, NAT64, 6to4 and IPv4-mapped forms. If *any* resolved address is non-public, the host is refused.
3. **Connect-time pinning** — sockets use a custom `lookup` that resolves and validates again at connect time and connects to the validated IP, so a DNS answer cannot change between check and use (rebinding).
4. **Redirects** — followed manually (max 5) and every hop is fully re-validated.
5. **Browser isolation** — Chromium runs in its own process with QUIC disabled, WebRTC non-proxied UDP disabled, downloads refused, service workers blocked, popups/dialogs dismissed, non-HTTP schemes aborted, a per-page request cap, and `--proxy-bypass-list=<-loopback>` so even `localhost` goes through the proxy. The proxy (authenticated with a random password) validates and pins every `CONNECT` and plain-HTTP request; plain `ws://` upgrades are refused.
6. **Limits** — HTTP/browser timeouts, 2 MB HTML cap (streamed, not buffered), request cap, hard browser kill timer.
7. **Nothing from the site runs in Node** — the browser returns JSON summaries only. Cookie values, query-string values and bodies are never stored.

The only exception is `NODE_ENV=test`, where `TEST_ALLOWED_TARGETS` (exact `host:port` pairs) and `TEST_HOST_MAP` let automated tests reach local fixture sites. Both are ignored in any other mode.

## Evidence model

`analysis/evidence.js` stores items `{ id, kind, source, label, value }` (`kind` ∈ header, cookie, html, dom, script, request, dns, tls, redirect, meta …). IDs are content hashes, so the same fact is stored once.

- **Technologies** (`signatures.js`, ~90 signatures + ~55 third-party services) are matched by small matcher functions (header / cookie / HTML / DOM fingerprint / request / DNS / generator). Each hit carries a weight; status is `observed` when the strongest hit ≥ 0.8, otherwise `inferred`; confidence combines weights. Framework implications (Next.js ⇒ React) are added as `inferred`.
- **Graph** (`graphBuilder.js`) creates nodes only from detections and traffic. Layers with no evidence get an explicit **UNKNOWN** node ("Backend services — not observable") instead of invented infrastructure. A backend is **INFERRED** only when first-party API calls were answered; a data store is INFERRED with an "engine/schema/location unknown" limitation and never named. Requests that StackReel's own policy blocked are excluded from the architecture (and reported as a security observation).
- Every node and edge has `status`, `confidence`, `evidenceIds`, `limitations`, and edges have an `explanation`. The graph is validated with zod (`narration/schema.js`) before it is stored.

## Narration

`narration/scriptGenerator.js` builds six scenes (overview, frontend, request flow, backend, security, summary) from sentences that each restate a fact from the analysis, with priorities. A word budget derived from the target duration (≈150 wpm minus intro/outro/padding) decides how many lower-priority explanatory sentences are kept. Code panels are real evidence (headers, DOM summary, observed request) or explicitly tagged **ILLUSTRATIVE** when reconstructed (e.g. a `fetch()` built from an observed method + URL).

Optional LLM polish (`narration/llm.js`) may only rewrite wording. Output must pass `llmRewriteSchema`, keep scene order, and pass a vocabulary guard that rejects mentions of known products that were not detected; otherwise the deterministic script is used and the error is recorded.

## Rendering

`render/renderService.js` (parent) forks `render/renderWorker.js`, enforces a timeout, relays progress, supports cancel, deletes partial output on any failure and **re-verifies** the MP4 with ffprobe (codec, size, both streams, duration ±1.5 s) before recording the render.

The worker:
1. synthesizes narration per scene, normalizes to 48 kHz mono PCM, measures real durations;
2. builds the timeline (`shared/scene/timeline.js`): 4.5 s title, per-scene lead-in/tail, 5.5 s outro, caption cues distributed by text length within each scene's speech window; writes VTT/SRT, the full narration WAV and waveform peaks;
3. draws each frame with `shared/scene/renderer.js` (pure function of model + time) on `@napi-rs/canvas` and pipes raw RGBA frames to FFmpeg (libx264 + AAC, `+faststart`);
4. writes scene thumbnails and a poster, verifies with ffprobe.

The browser studio imports the **same** renderer and timeline for its live preview, so the preview matches the MP4 frame for frame (with estimated timing until real audio exists).

## Frontend

- `context/ThemeContext.jsx` — theme from `index.html`'s pre-paint script (saved choice → system preference), persisted in `localStorage`, follows OS changes until the user chooses, animated transition class, CSS tokens in `styles/index.css` mapped into Tailwind via `@theme inline`.
- `context/AppContext.jsx` — backend health/readiness/capabilities with reconnect loop, projects/renders/stats, job tracking + polling, toasts, hash routing (`#/explorer/<projectId>`).
- `lib/api.js` — one client with timeouts and the `{ ok, data | error }` envelope; network/proxy failures become clear errors, never mock data.
- Views are code-split (React Flow and the canvas renderer load on demand).

## Storage

`store/fileStore.js` — `server/.data/projects/<prj_…>/project.json` (+ `screenshot.jpg`) and `server/.data/renders/<rnd_…>/` (`video.mp4`, `captions.vtt/.srt`, `narration.wav`, `poster.jpg`, `thumb-1..6.jpg`, `render.json`). IDs must match `^(prj|rnd)_[a-f0-9]{16}$`; downloadable file names are allow-listed and resolved paths are checked to stay inside the render directory. Writes are atomic. Incomplete renders are removed at startup; projects are pruned to `MAX_PROJECTS`.
