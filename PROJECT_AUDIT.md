# StackReel — project audit

## v2.1 → Fixed (media playback, narration audio, thumbnails)

Reproduced against the uploaded `StackReel_v2.1.zip` (byte-identical to the previous delivery).

| # | Defect (as seen on Windows) | Severity | Reproduction | Root cause | Fix | Verified by |
|---|---|---|---|---|---|---|
| 1 | Studio shows a black/unavailable player, "The element has no supported sources", "Video unavailable"; broken thumbnails, poster and dashboard screenshot — although the render was verified | **Critical** | Default install (`DATA_DIR=server/.data`) → render → open Studio. `GET /api/renders/<id>/files/video.mp4` → **404** | Express 5 `res.sendFile(absolutePath)` applies its *dot-file rule to the whole path*. The default data folder `server/.data` starts with a dot, so **every** stored file (video, thumbnails, poster, screenshot) was refused with 404. Tests used a temp folder without a dot, so they never saw it. | All stored files go through one `serveFile()` helper that passes the folder as `root` (the dot rule then applies only to the file name), sets explicit `Content-Type` (`video/mp4`, `image/jpeg`, `text/vtt`…), keeps Range support, and returns an accurate JSON error if a file can't be read. Tests and e2e now use a `…/server/.data` folder. | API test "media is served with correct types, lengths and ranges from the default .data folder"; e2e "thumbnails and poster load 7/7", "no Video unavailable" |
| 2 | Narration could play silently in the Studio | High | Browsers that start an `AudioContext` suspended (autoplay policy) | The live audio meter called `createMediaElementSource()` on the `<video>`; that permanently reroutes the element's sound through Web Audio, so a suspended context = no sound. | Connect the meter only after `AudioContext.resume()` confirms it is running; otherwise leave the video's normal audio path untouched. | e2e "narration audio is decoded during speech (unmuted, volume up)" |
| 3 | A render could be recorded as narrated even if the voice engine returned silence | High | Any TTS that returns an empty/silent WAV | Only duration (≥0.3 s) was checked | Each scene's PCM is measured (peak, RMS, share of 50 ms windows with sound) and rejected as `TTS_SILENT` if unusable; clips are peak-normalized to −1 dBFS (gain ≤ 8×, never clipping). After encoding, the AAC track is **decoded back out of the MP4** and must contain speech (`AUDIO_SILENT` otherwise). Levels are stored in the render record and shown in the Studio. | Unit tests (silence/hiss rejected, normalization); API test "narration is real speech…" (independent decode of the MP4) |
| 4 | Windows voice failure aborted the render | Medium | `TTS_PROVIDER=auto` with a broken SAPI voice | No fallback | With `auto`, a failing/silent voice triggers a full re-synthesis with the offline meSpeak voice (all scenes, so voices never mix); recorded as `tts.fallbackFrom` and shown in the UI. | API test "when the default voice fails, narration falls back…" |
| 5 | Generic "could not be loaded" message | Low | Any media error | No diagnosis | On `<video>` error the Studio asks the server for the file and shows the real status/message (e.g. "HTTP 404: …"). Thumbnails/posters/screenshots show an explicit "unavailable" placeholder instead of a broken-image icon. Play is disabled while the video is in error (no repeated toasts). Volume slider added. | Client tests "explains a failed video…", "honest placeholder…" |
| 6 | "No voice" in the live preview | Info | Studio before rendering | By design the canvas preview has no audio; the label was easy to miss | Label now reads "PREVIEW · no sound · render the video to hear the narrator". | Client test |

| 7 | Public sites rejected as "resolves to a non-public address (64:ff9b::…: nat64)" | **High** | Analyze any site on a DNS64/NAT64 network (common on Indian mobile ISPs/hotspots) | The SSRF policy blocked the whole NAT64 prefix `64:ff9b::/96`, but on these networks every IPv4-only site is returned wrapped in it | The embedded IPv4 is extracted and judged: public → allowed; loopback/private/metadata (e.g. `64:ff9b::a9fe:a9fe`) → still blocked. `64:ff9b:1::/48` stays blocked. | Security tests (NAT64 allowed/blocked, host validation) |
| 8 | "could not be resolved (ENOTFOUND)" on a momentary DNS hiccup | Medium | Flaky home/mobile DNS | One lookup attempt, no retry | Up to 3 lookups with short back-off for ENOTFOUND/EAI_AGAIN/timeouts; the final message suggests checking spelling/connection and pressing Retry | Security test "momentary DNS failures are retried" |

Existing renders made with v2.1 were valid files; they play once the fixed server serves them — no re-render needed.

### v2.1 verification (final code)

| Check | Result |
|---|---|
| Clean install from lockfile (`npm ci`) | see final report |
| Lint (ESLint + syntax check) | ✔ |
| Production build | ✔ |
| Backend tests | ✔ 55/55 (incl. 3 real renders: normal, failure cleanup, TTS fallback) |
| Frontend tests | ✔ 22/22 |
| End-to-end (Chromium) | ✔ 25/25 — playback, decoded speech audio, seek/resume, thumbnails, MP4/SRT/VTT downloads |
| Downloaded MP4 | H.264 1280×720 24 fps + AAC 48 kHz mono, 109.3 s; mean −21.2 dB, max −1.0 dB |

Not verifiable in this environment: listening with human ears (no audio device — verified by decoded signal levels and Chromium's decoded-audio counters instead), Windows SAPI voices, cloud TTS (no keys; failure paths tested), real public websites (no internet; local fixtures used).

---

## v1 → v2

Audit of the uploaded `StackReel_reviewed_1.zip`, the problems found, their impact, and what was changed. Severity: **Critical** (product is misleading or unsafe), **High** (core feature broken), **Medium** (reliability/UX), **Low** (polish).

## 1. Reported issues — root causes

| Symptom | Root cause | Fix |
|---|---|---|
| *"Cannot find package 'express'"* | Root `package.json` had no workspaces; `npm install` at the root installed only `concurrently`, so `server/node_modules` never existed unless `npm --prefix server install` was run separately. | npm **workspaces** (`server`, `client`): one `npm install` (or `npm run setup`) installs everything from a single root lockfile. `npm run doctor` checks it. |
| Port 5001 conflict, switch to 5002 → *"Backend unavailable"* | The server read `PORT`, but `client/vite.config.js` hard-coded the proxy target `http://localhost:5001`. Moving the API to 5002 left the proxy pointing at nothing; the client's catch-all then reported "Backend unavailable". | Vite now loads the **same root `.env`** as the server and derives the proxy target from `PORT`/`HOST`. The server never silently changes port: `EADDRINUSE` prints the exact Windows/macOS/Linux commands to find and stop the other process. |
| *"Origin is not allowed"* CORS errors | Allow-list was only `localhost:5173`/`127.0.0.1:5173`. Vite silently moves to 5174+ when 5173 is busy, producing a new origin. The CORS callback also passed an `Error`, which Express turned into an HTML 500. | Vite runs with `strictPort` (fails loudly). CORS is an explicit allow-list from `CLIENT_PORT` + `CORS_ORIGINS`; rejected origins get a JSON `403 CORS_ORIGIN_NOT_ALLOWED` explaining which variable to set. CORS is never disabled. |
| Frontend/API mismatch | Ad-hoc `fetch` calls, no timeouts, non-2xx poll responses silently ignored (`if (!pollRes.ok) return;` → spinner forever), errors shown as "HTTP 500". | One API client (`client/src/lib/api.js`) with timeouts, a `{ ok, data|error }` envelope, distinct messages for "API down", "proxy can't reach API", and server error codes. Every endpoint and schema is documented in `docs/API.md` and covered by tests. |

## 2. Findings

### Critical — fabricated data presented as analysis

1. **Pre-written "analyses" for popular domains.** `server/data/presets.js` and `client/src/utils/presets.js` contained hand-written profiles (e.g. Stripe with an invented `CF-Ray: 8e14f92-IAD`, "Sorbet Ruby", "Citus", "Kafka", security score 98). Submitting `stripe.com` returned this after fake delays and logs such as *"Extracted 9 observed network headers"*. → **Removed.** Every analysis is a live inspection.
2. **App booted with fake data.** The client initialised with the Stripe preset as the active project and showed it when the API was unreachable. → Removed; empty states are honest.
3. **Fake progress and rendering stages.** `setTimeout` delays imitated work; stage 7 logged *"Compiling WebGL canvas frames and audio spectrum"* while nothing rendered. → Stages now report real work, with real logs.
4. **Invented findings in live scans.** The detector always added *"Relational or Document Store"* and a *"Dynamic Application Server"*; the graph builder always emitted the same 8 nodes (API gateway "Validate Token", "Microservices Core", "Cloud Infrastructure") regardless of evidence; `unknownTechCount: 1` was hard-coded; `responseTimeMs || 88` invented a number; evidence strings defaulted to `'HIT'`, `'active'`, `'detected'` when headers were missing.
5. **Fabricated code and security claims in narration.** The script contained an invented SQL handler (`SELECT * FROM data WHERE user_id = $1`), *"TLS 1.3 256-bit GCM"* without measuring TLS, *"Secure Cookie Flags: HttpOnly; SameSite=Lax; Secure"* without reading cookies, and `"grade": "A+"`.
6. **False positives.** `html.includes('react')` marked any page mentioning "react" as React; a loose regex marked any page with a `flex`/`hidden` class as Tailwind.

→ Replaced by the evidence engine (§3).

### Critical — SSRF exposure

7. Private-address checks ran on one DNS lookup, then `fetch` resolved again (**DNS rebinding**). IPv6 coverage was partial (e.g. `::ffff:7f00:1`, NAT64, ULA ranges). No port restriction (`example.com:6379` was fetchable).
8. Redirects were rejected entirely (`redirect: 'error'`), so most real sites (http→https, apex→www) **failed** — the safety measure broke the product.

→ New policy: block-list via `net.BlockList` (IPv4 + IPv6 + mapped forms), port allow-list, connect-time **pinned lookups**, manual redirects with full re-validation per hop, robots.txt, size/time limits, and a validating **egress proxy** for all headless-browser traffic. Tested (`server/test/security.test.js`, `api.test.js`).

### High — core features missing

9. **No video rendering.** `/api/export-video` returned 501; the "studio" animated a canvas with hard-coded durations. → Real pipeline: TTS → measured timeline → shared canvas renderer → FFmpeg H.264/AAC → ffprobe verification, in a child process, with progress, cancel, retry, cleanup, captions, thumbnails and range-enabled downloads.
10. **No browser analysis** (HTML + headers only, so client-rendered sites revealed nothing). → Playwright Chromium with DOM fingerprints, network capture, cookies, websockets, screenshot.
11. **No persistence, no job limits.** Everything in memory, unbounded. → File store with atomic writes and pruning; job manager with concurrency limits, queue cap, dedupe, TTL; per-IP rate limits.
12. **No tests.** → 34 backend tests (unit + integration incl. real render) and 20 frontend tests, plus an end-to-end UI script.

### Medium

13. Monolithic `server/index.js` (routes, pipeline, store, stages). → Modular `config / security / analysis / narration / tts / render / jobs / store / routes / middleware`.
14. No request validation, generic errors, no request IDs, no structured logs, no graceful shutdown, no readiness endpoint. → zod validation, `AppError` codes, JSON envelope, `X-Request-Id`, structured logger, `SIGINT/SIGTERM` handling, `/api/health` + `/api/ready` + `/api/capabilities`.
15. Theme flashed on load (`class="dark"` hard-coded, theme applied after React mounted); many components hard-coded `text-slate-100 light:text-slate-900` pairs. → Pre-paint theme script, semantic CSS tokens mapped into Tailwind, independent light palette, system-preference following.
16. Hard-coded display values: `0:42` video length, `42` s total, `|| 7` scene durations, `|| 84` ms. → Values come from data or are not shown.
17. Google Fonts loaded from a CDN (privacy, offline). → Self-hosted `@fontsource`; the same fonts are embedded into the video renderer.
18. Unused TypeScript config and `@types/*` in a JavaScript project. → Removed; ESLint added.

### Low

19. Several UI controls had no effect (export quality/frame-rate selectors, zoom % unrelated to view). → Every control is wired to real behaviour.

## 3. What replaced it

- **Evidence engine** — ~90 technology signatures + ~55 third-party services matched against headers, cookies, HTML, DOM fingerprints, network requests, DNS and generator tags. Every technology, node, edge, finding and narration fact references evidence IDs. Graph nodes are OBSERVED / INFERRED / UNKNOWN; empty layers become explicit UNKNOWN nodes; databases are never named. Graph and script are zod-validated.
- **Optional LLM** only rewrites wording; output is schema-checked and rejected if it names undetected technologies.
- **Passive security analysis** with observation, evidence, severity, confidence, impact and remediation; disclaimer; no aggregate score.
- **UI rebuilt** around real data: dashboard, React Flow explorer, security, evidence terminal, video studio.

## 4. Verification performed

All run on Linux (Node 22.22, npm 10.9) against local fixture websites (the sandbox had no internet access):

| Check | Result |
|---|---|
| `npm install` (workspaces, from lockfile) | ✔ |
| `npm run lint` (ESLint client + syntax check of 37 server/shared files) | ✔ 0 problems |
| `npm run build` | ✔ |
| `npm run test:server` | ✔ **44/44** — incl. SSRF/DNS-rebinding, CORS, validation, redirects, robots, size limits, retries, real narrated MP4 render verified with ffprobe, range downloads, path traversal, render-failure cleanup |
| `npm run test:server` with Chromium unavailable | ✔ API suite 19/19 (HTTP-only path) |
| `npm run test:client` | ✔ **20/20** |
| `npm run test:e2e` | ✔ **17/17** — analyze → explorer evidence → security → studio → auto-rendered 720p30 MP4 plays → download is a valid MP4 → theme persists → no mobile overflow → no console errors |

Bugs found by these tests and fixed: HTTP-only analyses crashed in scene generation (read a field that is not stored); studio crashed when a video loaded (React event read inside a state updater); `dimmed` flag could be `undefined`; frame encoding was 10× slower than necessary (switched from per-frame JPEG to raw RGBA piping).

Not verified here: real public websites (no internet in the build sandbox), Windows SAPI voices, OpenAI/ElevenLabs/Anthropic integrations (no credentials — their failure paths are tested).

## 5. Remaining limitations

See README → *Known limitations*. In short: one page load per analysis; backends are often unobservable; bot protection may block inspection; no authentication (keep the API on `127.0.0.1`); jobs are in memory; Vitest 3.2 is used because npm 10.9 (bundled with Node 22) cannot install Vitest 4 — Vitest 3 has dev-only advisories (test runner, never shipped or exposed).
