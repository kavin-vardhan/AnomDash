# host-tools

Decoupled host-side tooling for the AnomalyInjector project — logically independent of the plugin
(`StackOBot/Plugins/AnomalyInjector`), though bundled here alongside the dashboard for convenience. None
of it modifies the engine, the plugin, or the dashboard; it only watches the capture output on disk.

## Client entrypoints & delivery assembly

Two PascalCase launchers are the client-facing surface. Their **repo source-of-truth lives in this
folder**, but they are authored to run from the **delivery-bundle root** and are placed there at assembly
time, next to the `dashboard/` and `host-tools/` folders:

```
<delivery root>/
  README.md            <- the client's guide. CROSS-REPO: its source is the PLUGIN repo's
                          docs/client-readme.md, not this one.
  Setup.bat            <- one-time: finds/downloads ffmpeg, finds Python, asks for the captures
                          folder, writes config.bat + dashboard\config.json, then VERIFIES the
                          dashboard can fetch that config over HTTP
  Run.bat              <- sources config.bat, launches the encoder watcher (encode_watcher.py) and
                          the dashboard server (serve_dashboard.py), opens the browser, then prints
                          a dashboard/watcher/game-server self-check
  dashboard/           <- the BUILT dashboard: index.html + assets/, plus config.json
  config.bat           <- written by Setup.bat (machine-specific: FFMPEG, CAPTURES_ROOT, PY); gitignored
  host-tools/          <- this folder (encode_watcher.py, serve_dashboard.py, selfcheck.py, write_config.py)
```

⚖ **`m27` RETURNED THE CLIENT TO THE BROWSER WORKFLOW.** The Tauri desktop app is **not removed** —
`src-tauri/` and its build scripts stay in this repo, intact and unreferenced — but it **does not ship**.
Nothing in the bundle needs WebView2, and there is no code-signing prompt.

**The client needs Python only — no Node, no `npm install`.** Build on the **build machine** with plain
`npm run build`, which produces `dist/`. The bundler copies `dist/` to `<delivery root>/dashboard/`.

🚨 **`config.json` MUST SIT NEXT TO `index.html`, INSIDE THE SERVED FOLDER.** The app fetches
`./config.json` **relative to the served root** (`src/config.ts`: `CONFIG_URL = './config.json'`), so a
copy at the delivery root is invisible to it — the page loads and silently fails to authenticate.
`Setup.bat` writes it to `dashboard\config.json` and then **asserts it is fetchable over HTTP**
(`serve_dashboard.py --verify-only`), because a served-root relative path fails in ways a file-exists
check cannot see.
📌 *History, so it is not re-broken: `c32f858` and the plugin doc `6d01bc9` both said `dashboard/`; the
Tauri commit `7963be5` moved the script to the delivery root, correct for a desktop app, and left the doc
behind. The doc was stale for the Tauri era only, and is correct again now.*

`Setup.bat` fills in `capturesRoot` (via `write_config.py`) and **never touches `controlToken`** — the
token is the owner's to ship. An empty token still runs; the dashboard just opens on its manual connect
screen.

## make_delivery.bat — assembling the bundle

Double-click it, give it a destination, and it produces a complete client bundle. **It is a dev tool and
never ships** (it is not in the manifest, so it cannot copy itself).

**`bundle_manifest.txt` is the SOURCE OF TRUTH for what ships.** It is an **allowlist, not copy-except**:
a client-facing file that is not listed **will not ship**. That is deliberate — a blocklist silently ships
whatever gets added next. To add a file to the bundle, add a line to the manifest.

Entry kinds: `FILE` and `DIR` (relative to this repo) and **`PLUGINFILE`** (relative to the *plugin* repo,
located by `--plugin-repo`, which has a default and is never hardcoded). A missing `PLUGINFILE` **fails,
names the file and the path it searched, and deletes the partial bundle** — a bundle that reports success
while incomplete is the failure the manifest exists to prevent.

⚠ **The real risk is not a missing file — it is a stale `dist/`.** Every file can copy perfectly while the
dashboard is weeks old, with no error anywhere, and automating the copy makes that *more* likely because
copying stops being the step anyone thinks about. So the bundler refuses to run without a build, warns
loudly and demands a typed confirmation when anything under `src/` is newer than `dist/`, and prints
`dist/`'s build time every run regardless. **It does not run `npm run build`** — a packaging script that
builds is one that can fail halfway and leave a half-built `dist/`.

The `.bat`s use paths relative to their own location (`%~dp0host-tools`, `%~dp0config.bat`,
`%~dp0dashboard`), so they only work once assembled at the delivery root — non-functional from this
repo location by design. Windows built-ins only (`curl.exe` + `tar`). The ffmpeg download tries normally
first, then retries once with `--ssl-no-revoke` if a corporate-network revocation check blocks it. ffmpeg
is **fetched, never committed** (its full build is GPL): the download URL is the `FFMPEG_URL` variable at
the top of `Setup.bat`.

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
unexplained problem. It reports three lines: **dashboard** (`--dashboard-port 5180` → a TCP probe of the
served dashboard; the `--dashboard-exe` process-check route still exists for the unshipped desktop path),
**watcher** (heartbeat file touched within 15 s — `encode_watcher.py --heartbeat`
refreshes it each poll, so a watcher whose window is open but whose process died reads as down), and
**game server** (TCP probe of `:8077`, the line that carries the "start the game" instruction). Always
exits 0 — it is information, never a gate.

## write_config.py
Creates or updates `config.json` (inside `dashboard\`, next to `index.html`): sets `capturesRoot`
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

## measure_label_offset.py (dev/QA only)
Read-only measuring instrument. For each annotated event in a finished session it measures **where the
anomaly actually manifests in pixels** against **where `annotation.json` claims it is**, and prints a
per-anomaly-type offset table plus a per-event CSV. It answers one question: how many frames separate the
annotation from the pixels?

    python host-tools\measure_label_offset.py <session_dir> [<session_dir> ...]
    python host-tools\measure_label_offset.py <root_dir_containing_sessions>
    python host-tools\measure_label_offset.py A B --label editor-sve --label packaged-sve
    python host-tools\measure_label_offset.py <session_dir> --log "<UE .log>" --verbose --series

Python 3 + Pillow, nothing else. It never writes into a session directory; the CSV goes to `--csv`
(default `./measure_label_offset.csv`). Both conventions it depends on are printed in its own output
header, so a screen photo of a result carries them: **the PNG filename index IS the session index and it
is 0-BASED**, and **offset = manifested − annotated, positive = pixels lag the label**.

It reports UNMEASURABLE rather than guessing when ambient change swamps the signal, and raises a
`*** BASELINE CONTAMINATED ***` banner when a reference frame is itself manifesting — the condition under
which an offset larger than the clean gap between bursts would otherwise be silently under-read. With
`--log` it also parses the `m31` `SVE-WANT-TRACE` / `SVE-WANT-SUMMARY` handshake tokens and reports the
arm→publish gap distribution, refusing the join outright if the log's run start time does not match the
session's `run.json`. Full method, constants and limits are in the script's own module docstring.
