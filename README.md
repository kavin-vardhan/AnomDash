# Anomaly Dashboard

External control dashboard for the **AnomalyInjector** plugin's in-game control server. A **pure localhost
client** — it connects to the in-game WebSocket server at `ws://127.0.0.1:8077` and never touches the network
at runtime. (Host tooling, like the MCP bridge; its own repo, independent of the plugin.)

## Source convention — no comments
Source in this repo carries **no comments** — none, including any file-header / copyright banner — across
TS/TSX, CSS, Python, and `.bat`. This is deliberate and repo-wide (mirrors the plugin repo). **Do not add
comments, and strip any before committing** (feature/host-tools updates keep re-introducing them; this has
been re-stripped twice now). Enforced with a deterministic, byte-preserving stripper kept alongside the repos
at `../_strip_comments.py` — it preserves every non-comment byte, all string/regex/template literal contents,
CRLF endings and the BOM: run `python ../_strip_comments.py .` from the repo root. Put rationale and design
notes in commit messages, not in the code.

## Dev run (owner)
1. `npm install`  *(the only network access — build-time only)*
2. `npm run dev`  →  http://localhost:5173
3. In-game (PIE): console `IAI.Server.Start` → copy the token from the Output Log
4. Open http://localhost:5173, paste `ws://127.0.0.1:8077` + token, **Connect**

The last token/URL you type is remembered (localStorage), so you don't re-paste every reload.

To skip the paste entirely in dev, create **`public/config.json`** (gitignored; copy
`config.example.json`) with a `controlToken` matching your build's ini — Vite serves `public/` at the
root, so the app finds it at `./config.json` exactly as it does in a delivered bundle.

## Runtime configuration — `config.json`
The dashboard reads **`./config.json`, served beside `index.html`**, once at startup:

```json
{ "controlToken": "<same value as DefaultGame.ini [AnomalyControlServer] Token>",
  "capturesRoot": "D:/AnomalyCaptures",
  "serverUrl": "ws://127.0.0.1:8077" }
```

`serverUrl` is optional (defaults to `ws://127.0.0.1:8077`); `capturesRoot` is written by the client's
`Setup.bat`. A token here means the dashboard **auto-connects** on load.

Nothing is fatal if it is wrong: **absent** (or a dev server answering with `index.html`) → the manual
connect screen; **malformed** → the manual connect screen plus a console warning; **rejected by the
server** → the distinct `auth_failed` screen, which names `config.json` as the file to fix. URL precedence
is *stored (typed) > `config.serverUrl` > built-in default*.

> **This replaced the m16 build-time bake** (`.env` → `VITE_CONTROL_TOKEN` → compiled into the bundle),
> which meant a delivery assembled from a clean checkout was **silently tokenless** and any token change
> needed a rebuild. There is deliberately **no env fallback** — one source of truth. Note a fresh
> `npm run build` copies `public/config.json` into `dist/`, so `dist/config.json` carries your **dev**
> token until you overwrite it at assembly time.

## Client delivery (no Node on the client machine)
The client is served a **prebuilt** `dist/` by Python — `host-tools/serve_dashboard.py` on port **5180**
(the dev server keeps 5173, so both can run at once). Build here, copy `dist/*` plus a token-bearing
`config.json` into the bundle's `dashboard/` folder; the client runs `Setup.bat` then `Run.bat` and needs
**Python only**. See `host-tools/README.md` for assembly and why the server is a wrapper rather than
`python -m http.server` (forced MIME types, `no-store`), and the plugin's `docs/PRE-DELIVERY-CHECKLIST.md`
before shipping.

`ws://` is not subject to CORS/same-origin, so a page served from `:5173`/`:5180` connecting to `:8077`
works directly.

## Transport — the one rule
Every server→client message arrives as a WS **binary** frame (libwebsockets), *including JSON*. The client is
**framing-agnostic**: it reads the leading bytes — `"AIF1"` ⇒ a preview frame (16-byte header + JPEG),
otherwise UTF-8 JSON. It never assumes a text opcode. See `src/transport/`.

## Status (slices)
- **Slice A (built):** transport + live monitoring — connect/auth, preview canvas (frames + overlay rects +
  click-to-select), targets list, session bar (FPS/seed/revert-all/scoping/HUD toggles/poll-radius). Replaces
  `WebClient/spike-client.html` for monitoring.
- B: inject + active panels. C: auto panel. D: capture panel + event log.
- **Post-D:** screen-coverage slider on the session bar — the first *throttled* continuous control
  (`src/lib/throttle.ts`: ~10/sec during a drag + an authoritative send on release; both the handle and the
  numeric % track the drag optimistically as of m13). The existing poll-radius slider still sends
  on every change and **could adopt the same throttle util later** (intentionally not retrofitted this pass).
- **m13 (confirmation-bounded optimism):** control optimism is held until a snapshot CONFIRMS the value
  (or the server settles it, e.g. a clamp), not a fixed wall-clock timer — so sliders/toggles no longer
  snap back to the old value when the snapshot round-trip is slow. See `docs/sessions/2026-07-13-019-*`.
- **M1 (robustness, 2026-07-21):** a wrong/missing token now lands in a distinct **auth-failed** state
  (the server sends `{type:"error",code:"bad_token"}` as of plugin `3a46c1f`; the client also has a 4s
  welcome-timeout fallback; no auto-retry) instead of hanging in "authenticating" forever. Reconnect
  backoff timer tracked + all socket handlers identity-guarded (no stale-socket clobber). Preview-frame
  decodes commit in order. **Stop capture / Revert all stay enabled while the stream is stalled** (only a
  true disconnect disables them). Poll-radius slider throttled (shared `ThrottledSlider`). Structural
  snapshot/catalog guard + top-level error boundary. One capture-stop event per run, stable event keys.
  Dead inject-era code removed. See `docs/sessions/2026-07-21-020-dashboard-robustness.md`.
- **M2 (setup, 2026-07-21):** the token moved from a build-time `.env` bake to the runtime `config.json`
  above, Vite builds with `base: './'`, and the client is served a prebuilt `dist/` by Python on **5180**
  instead of running the Vite dev server — **Node and `npm install` are gone from the client machine**.
  `Setup.bat` stamps `capturesRoot` while preserving the shipped token, and `Run.bat` prints a
  dashboard/watcher/game-server status check. Delivery docs + the new pre-delivery checklist landed in the
  **plugin** repo (`AnomInject`). See `docs/sessions/2026-07-21-021-runtime-config-static-dist.md`.

## Design notes
Milestone design notes / journals live in `docs/sessions/NNN-*.md` (numbered to stay aligned with the
plugin repo's journal sequence). The no-comments source invariant means rationale goes there and in commit
messages, never in code.

## Architecture
- **State:** a single Zustand store (`src/store.ts`) holding the latest snapshot + latest frame + connection +
  UI selection. Selector subscriptions keep per-panel re-renders cheap under the ~5 Hz snapshot / ~6 Hz frame push.
- **Transport:** `src/transport/AnomalyClient.ts` (one WS, framing-agnostic decode, exponential-backoff reconnect,
  command helpers) + `protocol.ts` (AIF1 frame header).
- **Pure client:** never modifies the plugin/server. Server gaps are flagged, not patched.
- **Tests:** `npm test` (vitest, node env, no engine needed) — store suites (optimism, pending reverts,
  events) + transport-race suites (fake sockets, fake timers, controllable bitmap decodes).
