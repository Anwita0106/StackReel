# StackReel

**Reverse engineer any website — into an evidence-backed architecture map and a narrated MP4 explainer.**

Paste a public URL. StackReel inspects what the site publicly reveals (headers, TLS, DNS, the rendered DOM and every network request, captured in a sandboxed browser), identifies technologies with deterministic signatures, builds an architecture graph where **every component is labelled OBSERVED, INFERRED or UNKNOWN with links to its evidence**, writes a six-scene technical script from that graph, narrates it, and renders a real, verified H.264/AAC MP4 with captions.

Nothing is simulated: no preset "analyses", no invented metrics, no fake render success.

---

## Quick start (Windows)

Requirements: **Node.js 20.19+ (22 LTS recommended)** from <https://nodejs.org>. Nothing else — FFmpeg ships as an npm dependency.

**Easiest:** double-click `setup-windows.cmd` once, then `start-windows.cmd` whenever you want to run StackReel.

Or open **PowerShell** in the project folder (the one containing this README):

```powershell
# 1. Install everything (root + server + client in one step) and the headless Chromium
npm run setup

# 2. (Optional) create your config file
Copy-Item .env.example .env

# 3. Check that everything is ready
npm run doctor

# 4. Start the API and the web app together
npm run dev
```

Open **http://localhost:5173**. The API runs on **http://127.0.0.1:5001** (`/api/health`).

Stop both with `Ctrl+C`.

> `cmd.exe` works too: use `copy .env.example .env` instead of `Copy-Item`.

### Production-style single server

```powershell
npm run build
npm start          # serves the built UI and the API on http://127.0.0.1:5001
```

---

## What you get

| Area | What it does |
|---|---|
| **Dashboard** | URL input with validation, live job progress with real stages/logs, cancel/retry, recent analyses with real screenshots, rendered-video gallery, stats only when backed by stored data. |
| **Architecture explorer** | React Flow graph with layer lanes (client → edge → origin → frontend → API → backend → data, plus security and integrations bands), status-styled nodes (solid/dashed/dotted), animated observed edges, search, status/layer filters, evidence panel per node, relationships, PNG and JSON export. |
| **Security** | Passive findings (transport, TLS, HSTS, CSP, framing, cookies, mixed content, third-party scripts, header disclosure) each with observation, evidence, severity, confidence, impact and remediation. No aggregate score. |
| **Evidence** | Raw headers, redirect chain, TLS, DNS, cookie flags (never values), DOM fingerprints and the full network-request table (query values stripped). |
| **Video studio** | Live canvas preview (same renderer as the MP4), real MP4 playback with custom controls, soft captions, live audio-level meter, scene timeline with thumbnails and the real narration waveform, subtitle preview, render settings (resolution, fps, voice provider, voice, pace, burned captions), progress, downloads (MP4 / SRT / VTT). |

Both **dark** and **light** themes are designed independently, follow your OS on first visit, persist across reloads, and are applied before first paint (no flash).

---

## How it works

```
URL ─▶ validate (scheme, host, port, DNS → public IPs only)
    ─▶ robots.txt check
    ─▶ HTTP inspection (pinned IP, ≤5 re-validated redirects, size-capped body)
    ─▶ TLS probe · DNS records · http→https probe
    ─▶ headless Chromium through a validating egress proxy (DOM, requests, cookies, screenshot)
    ─▶ deterministic signatures → technologies (+ evidence IDs)
    ─▶ passive security findings
    ─▶ architecture graph (observed / inferred / unknown) — zod-validated
    ─▶ six-scene script (deterministic; optional LLM wording polish, validated)
    ─▶ render job (child process): TTS per scene → timeline from real audio durations
       → frames drawn with the shared canvas renderer → FFmpeg H.264/AAC → ffprobe verification
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/API.md`](docs/API.md).

### Narration voices

| `TTS_PROVIDER` | Notes |
|---|---|
| `auto` (default) | Uses your OS voice if available, else the built-in meSpeak voice. Never picks a paid API automatically. |
| `system` | **Windows:** built-in SAPI voices via PowerShell (e.g. *Microsoft David / Zira*). macOS: `say`. Linux: `espeak-ng`. |
| `mespeak` | Pure-JavaScript eSpeak — offline, works everywhere, robotic. |
| `openai` | Set `OPENAI_API_KEY` (optional `OPENAI_TTS_VOICE`). Paid. |
| `elevenlabs` | Set `ELEVENLABS_API_KEY` (optional `ELEVENLABS_VOICE_ID`). Paid. |

The provider and voice can also be chosen per render in the Video Studio.

### Optional LLM narration polish

`LLM_PROVIDER=anthropic` (with `ANTHROPIC_API_KEY`) or `openai` (with `OPENAI_API_KEY`). The LLM only rewrites the wording of the deterministic, evidence-based script. Its output must match a strict schema and is rejected — falling back to the deterministic script — if it mentions any known technology that was not detected. Without a key, the deterministic script is used and the UI says so.

---

## Configuration

All settings live in `.env` at the project root (see [`.env.example`](.env.example) for every option). The most useful:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5001` | API port. The Vite dev proxy reads the same `.env`, so frontend and backend stay in sync. |
| `CLIENT_PORT` | `5173` | Frontend dev port (strict — fails clearly if taken). |
| `CORS_ORIGINS` | – | Extra allowed browser origins, comma-separated. |
| `DATA_DIR` | `server/.data` | Where projects and videos are stored. |
| `BROWSER_EXECUTABLE_PATH` | – | Use an existing Chrome instead of `npm run setup:browser`. |
| `TTS_PROVIDER` | `auto` | Narration voice provider (above). |
| `LLM_PROVIDER` | `none` | Optional narration polish. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | bundled | Use your own FFmpeg. |

---

## Tests

```powershell
npm test              # backend (node:test) + frontend (Vitest)
npm run test:server   # SSRF policy, robots, detection, graph/script schemas, LLM failure paths,
                      # jobs, CORS, validation, redirects, size limits, real MP4 render + ffprobe,
                      # range downloads and path-traversal checks — all against local fixture sites
npm run test:client   # URL validation, API client errors, form submission, loading/error/empty
                      # states, theme persistence, graph model, UI primitives
npm run lint          # ESLint (client) + syntax check (server/shared)
npm run build
npm run test:e2e      # needs `npm run build`; drives the real UI in Chromium end to end and
                      # saves screenshots to e2e-artifacts/
```

Tests never touch the internet: fixture websites run on localhost and are reachable only through a `NODE_ENV=test`-only allow-list of exact `host:port` pairs.

---

## Troubleshooting

**"Port 5001 is already in use"** — the server refuses to silently switch ports. Find and stop the other process:

```powershell
Get-NetTCPConnection -LocalPort 5001 | Select-Object OwningProcess
Stop-Process -Id <PID>
```

(or `netstat -ano | findstr :5001` then `taskkill /PID <PID> /F`). Or set `PORT=5002` in `.env`; the dev proxy follows automatically.

**"Backend unavailable" / "dev proxy could not reach the API"** — the API isn't running or `PORT` differs from what the proxy uses. Use `npm run dev` (starts both) and keep the port only in `.env`. The status chip in the top bar shows the live API state; click it to re-check.

**"Origin … is not allowed"** — you opened the UI from an origin that is not on the allow-list (for example a different port). Use `http://localhost:5173`, or add the origin to `CORS_ORIGINS`.

**"Cannot find package 'express'"** — dependencies weren't installed. Run `npm install` from the **project root** (it installs server and client via npm workspaces).

**"Browser inspection failed … Target page, context or browser has been closed"** — the headless browser crashed on your PC (common causes: antivirus, GPU drivers, an incomplete browser download). StackReel now retries automatically in a compatibility mode and then falls back to your installed Google Chrome or Microsoft Edge. If it still fails:
1. Run `npm run doctor` — it test-launches the browser and prints Chromium's own error.
2. Re-download the browser: `npm run setup:browser`.
3. Or point StackReel at Chrome in `.env`: `BROWSER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`, then restart.

Analyses still complete with HTTP evidence when the browser is unavailable, and the page says so.

**Rendering is slow** — rendering uses your CPU. Choose **480p** or **24 fps** in the Video Studio (24 fps is the default), pick a shorter length on the dashboard, and keep the laptop plugged in. The job log shows frames per second and whether drawing or encoding is the slow part.

**PowerShell blocks `npm` scripts** (`running scripts is disabled`) — run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use `cmd.exe`.

**Video won't play / thumbnails broken (v2.1 only)** — fixed in this version: files stored under `server/.data` were refused by the web server. Update and restart; existing videos play without re-rendering.

**No narration audio** — check the Studio's *Narration* panel: it shows the audio level measured inside the MP4 ("peak … dB · speech in …% of the video"). If that looks right, check your PC's volume and the player's volume slider. The live preview (before rendering) intentionally has no sound.

**Robotic voice** — that's meSpeak. On Windows set `TTS_PROVIDER=system` to use the built-in Microsoft voices, or configure OpenAI/ElevenLabs.

Run `npm run doctor` at any time for a checklist with fixes.

---

## Known limitations

- **One page, one location, one moment.** Only the submitted page is loaded, once. Logged-in areas, other pages and post-interaction API calls are not observed.
- **Backends are usually invisible.** Unless headers/cookies disclose them, backend frameworks, databases, internal services and cloud topology are shown as INFERRED or UNKNOWN — by design.
- **Sites may block automation.** Bot protection, CAPTCHAs or `robots.txt` can stop the analysis; StackReel reports this rather than working around it.
- **Signatures, not magic.** Frameworks that leave no global, attribute, header or asset-path fingerprint are not identified.
- **Security findings are passive.** A missing header is a hardening observation, not proof of exploitability. No active testing is ever performed.
- **Single-user, local tool.** There are no user accounts; anyone who can reach the API can use it. Keep `HOST=127.0.0.1` unless you add authentication. Jobs are in memory (lost on restart); projects and videos are stored on disk.
- **Bundled FFmpeg is an older static build (4.x)**, adequate for this pipeline; set `FFMPEG_PATH` to use a newer one.
- Render time depends on CPU: expect roughly 1–3 minutes for a 3-minute 720p video on a modern laptop (480p is fastest).

---

## Project layout

```
stackreel/
├── client/                 React 19 + Vite + Tailwind 4 + React Flow + Motion
│   └── src/
│       ├── components/     dashboard · explorer · security · evidence · studio · jobs · layout · common
│       ├── context/        ThemeContext (no-flash theming), AppContext (API state, jobs, routing)
│       ├── lib/            api client, URL validation, router, formatting
│       └── test/           Vitest suites
├── server/                 Node.js + Express 5
│   ├── src/
│   │   ├── security/       IP policy, URL/DNS policy (rebinding-safe lookup), browser egress proxy
│   │   ├── analysis/       HTTP/TLS/DNS inspector, browser inspector, robots, signatures, detector,
│   │   │                   security findings, graph builder, pipeline
│   │   ├── narration/      deterministic script, LLM polish, zod schemas
│   │   ├── tts/            provider interface (system / meSpeak / OpenAI / ElevenLabs)
│   │   ├── render/         render service (supervisor), render worker (child process), media utils
│   │   ├── jobs/           job manager (queues, dedupe, cancel, retry)
│   │   ├── store/          file store (atomic writes, path-safe IDs)
│   │   ├── routes/ middleware/ config.js logger.js app.js index.js
│   ├── scripts/            doctor, syntax check
│   └── test/               node:test suites + local fixture websites
├── shared/                 graph layout + scene renderer + timeline (used by server AND browser)
├── scripts/e2e.mjs         end-to-end UI test
├── docs/                   ARCHITECTURE.md, API.md
└── PROJECT_AUDIT.md        what was wrong and what changed
```

## Ethics

StackReel performs the same requests a visitor's browser would make, once, and honours `robots.txt`. It never bypasses authentication, paywalls, CAPTCHAs or access controls, never stores cookie values or request bodies, and never runs intrusive scans.

MIT License.
