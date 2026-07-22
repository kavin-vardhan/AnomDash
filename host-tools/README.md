# host-tools

Decoupled host-side tooling for the AnomalyInjector project — logically independent of the plugin
(`StackOBot/Plugins/AnomalyInjector`), though bundled here alongside the dashboard for convenience. None
of it modifies the engine, the plugin, or the dashboard; it only watches the capture output on disk.

## Client entrypoints & delivery assembly

Two PascalCase launchers are the client-facing surface. Their **repo source-of-truth lives in this
folder**, but they are authored to run from the **delivery-bundle root** and are placed there at assembly
time, next to `Dashboard.exe`, `config.json`, and the `host-tools/` folder:

```
<delivery root>/
  Setup.bat            <- one-time: checks/installs WebView2, finds/downloads ffmpeg, finds Python,
                          asks for the captures folder, writes config.bat + stamps capturesRoot into config.json
  Run.bat              <- sources config.bat, launches the encoder watcher (encode_watcher.py) and the
                          desktop app (Dashboard.exe), then prints a dashboard/watcher/game-server self-check;
                          guards on missing config.bat / Dashboard.exe
  Dashboard.exe        <- the Tauri v2 desktop app (frontend embedded; renders in the system WebView2)
  config.json          <- loose, editable, read at RUNTIME by Dashboard.exe; NOT embedded in the exe
  config.bat           <- written by Setup.bat (machine-specific: FFMPEG, CAPTURES_ROOT, PY); gitignored
  host-tools/          <- this folder (encode_watcher.py, selfcheck.py, write_config.py, serve_dashboard.py, ...)
```

**The client needs Python only — no Node, no `npm install`.** (Python is still required for the encoder
watcher; the dashboard itself is a native exe.) Build on the **build machine** and copy the exe:

```
npm run build:tauri && npm run tauri build     # in the dashboard repo (needs Rust >= 1.77.2)
copy src-tauri\target\release\Dashboard.exe  ->  <delivery root>\Dashboard.exe
```

Then author `<delivery root>\config.json` with the client's token:

```json
{ "controlToken": "<same value as the game's DefaultGame.ini [AnomalyControlServer] Token>",
  "capturesRoot": "",
  "serverUrl": "ws://127.0.0.1:8077" }
```

**`config.json` is never embedded in the exe** — `build:tauri` deletes `dist/config.json` before Tauri
compiles the frontend into the binary, and the app reads `config.json` from its own folder at runtime via
a narrow Rust command. So editing `config.json` changes the token (or captures folder) with **no rebuild**.
`Setup.bat` fills in `capturesRoot` (via `write_config.py`) and **never touches `controlToken`** — the
token is the owner's to ship. An empty token still runs; the app just opens on its manual connect screen.

**WebView2:** the app renders in the system WebView2 runtime (present by default on Win10 21H2+/Win11).
`Setup.bat` reads the runtime's registry key and, if absent, silent-installs the Evergreen bootstrapper
(bundled `host-tools\MicrosoftEdgeWebview2Setup.exe`, else downloaded, then `/silent /install`).

**Fallback route (no WebView2 possible on a locked-down box):** the M2 Python-served path still works.
Build with plain `npm run build` (which keeps `config.json` in `dist/`), put `dist/` in a `dashboard/`
folder at the delivery root, and serve it with `python host-tools\serve_dashboard.py --directory dashboard
--port 5180` — `config.json` must sit next to `index.html`. See `serve_dashboard.py` below. This is the
documented escape hatch, not the default.

The `.bat`s use paths relative to their own location (`%~dp0host-tools`, `%~dp0config.bat`,
`%~dp0Dashboard.exe`), so they only work once assembled at the delivery root — non-functional from this
repo location by design. Windows built-ins only (`curl.exe` + `tar`). The ffmpeg download tries normally
first, then retries once with `--ssl-no-revoke` if a corporate-network revocation check blocks it; the
WebView2 bootstrapper download does the same. ffmpeg and the WebView2 installer are **fetched, never
committed** (ffmpeg's full build is GPL; the WebView2 stub is a Microsoft redistributable): the download
URLs are `FFMPEG_URL` / `WV2URL` variables at the top of `Setup.bat`.

## serve_dashboard.py
Serves the built dashboard to the browser (`--directory`, `--port`, default **5180** — the dev server's
5173 is left alone so a packaged bundle and `npm run dev` can run side by side). It is a wrapper rather
than `python -m http.server` for two reasons that both bite on the *client's* machine, not ours:
**MIME types are forced** in `extensions_map` (http.server resolves types via the Windows registry, and a
box whose `HKCR\.js` says `text/plain` serves JavaScript as text/plain → the browser refuses the ES module
→ blank dashboard), and **`Cache-Control: no-store`** (otherwise a `config.json` rewritten by a re-run of
`Setup.bat` can keep serving the old token until a hard refresh). It also binds `127.0.0.1` (http.server
defaults to every interface) and prints a readable message when the port is busy. There is deliberately
**no SPA/index.html fallback** — the app has no client-side router, and a 404 on `config.json` is exactly
the signal that tells it to open the manual connect screen.

## selfcheck.py
Run by `Run.bat` a few seconds after it opens its windows, so the most common client mistake — *"I
forgot to start the game"* — is stated plainly in the launcher window instead of surfacing later as an
unexplained problem. It reports three lines: **dashboard** (`--dashboard-exe Dashboard.exe` → a
`tasklist` process check for the native app; or `--dashboard-port` → a TCP probe, the Python-served
fallback route), **watcher** (heartbeat file touched within 15 s — `encode_watcher.py --heartbeat`
refreshes it each poll, so a watcher whose window is open but whose process died reads as down), and
**game server** (TCP probe of `:8077`, the line that carries the "start the game" instruction). Always
exits 0 — it is information, never a gate.

## write_config.py
Creates or updates `config.json` (at the delivery root, next to `Dashboard.exe`): sets `capturesRoot`
(normalised to forward slashes), **preserves `controlToken` and `serverUrl`**, and fills defaults for
anything absent. Called by `Setup.bat`; JSON editing lives here rather than in the `.bat` to avoid cmd
quoting hazards, and it reads with `utf-8-sig` so a BOM'd config never costs the shipped token.

## encode_watcher.py
Watches the captures directory and auto-runs **ffmpeg** to encode each completed **session** capture (m9)
into `<session>/Video_Clip/<session>.mp4` from `<session>/Actual_Frames/frame_%05d.png`. It triggers on
`run_summary.json` **plus** `annotation.json` (a session envelope — a plain pre-m9 run or a manual shot
without `annotation.json` is skipped), reads `video.fps`/`video.path` from `annotation.json`, de-dups via a
`.mp4_done` marker, backfills existing sessions on startup, and is fail-soft.

The captures root is **required** — pass `--root <dir>` (there is no default; the script errors and exits if
it is missing). ffmpeg is **not hardcoded**: pass `--ffmpeg <ffmpeg.exe | its bin dir>`, else it's looked up
on `PATH`. If neither resolves, sessions are **flagged and skipped** (frames + `annotation.json` stay valid —
just re-run after installing ffmpeg). For clients this is all wired by `Setup.bat` + `Run.bat`; for
dev use, run it directly:

    python host-tools\encode_watcher.py --root "C:\path\to\GameBuild\Saved\AnomalyCaptures" --ffmpeg "C:\path\to\ffmpeg\bin"

Stdlib only (no Pillow). Two Windows/ffmpeg notes baked into the script: the `%05d` input pattern uses
forward slashes (a backslash path matches zero frames), and frames are padded up to even dimensions
(`pad=ceil(iw/2)*2:ceil(ih/2)*2`) because PIE viewports can be odd-height and H.264/yuv420p require even
dims — the pad adds ≤1px at the bottom-right, preserving the top-left origin so `bbox_px` coordinates stay
valid.

## overlay_watcher.py (dev/QA only)
Watches the capture output directory and auto-runs the labeling track's `verify_capture.py` to draw the
labeled bounding boxes onto each completed capture run's frames (into `<run>/annotated/`). It triggers on
`run_summary.json` (run complete), de-dups via a `.overlay_done` marker, backfills existing runs on startup,
and is fail-soft (logs and keeps watching if anything errors). This is a **dev/QA tool** (needs
`labels.jsonl`, which delivery-mode sessions omit) and is **not** part of the client entrypoint set.

Start it once and leave it running. Easiest: **double-click `start_overlay_watcher.bat`** (runs the watcher
with the Pillow-equipped Python; leave the window open, close it when done capturing). Or from a shell:

    python host-tools\overlay_watcher.py

Requires Python 3 (stdlib only for the watcher) and Pillow (for `verify_capture.py`). Works whether the
capture is started from the dashboard or the in-game console — it only watches the disk.
