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
  Setup.bat            <- one-time: finds/downloads ffmpeg, finds Python, asks for the captures folder,
                          runs `npm install`, writes config.bat
  Run.bat              <- sources config.bat, then opens two windows: the encoder watcher
                          (encode_watcher.py --ffmpeg + --root) and the dashboard (`npm run dev -- --open`,
                          which also opens the browser); guards on missing config.bat / node_modules
  config.bat           <- written by Setup.bat (machine-specific: FFMPEG, CAPTURES_ROOT, PY); gitignored
  dashboard/           <- the anomaly-dashboard build
  host-tools/          <- this folder (encode_watcher.py, overlay_watcher.py, ...)
```

The `.bat`s use paths relative to their own location (`%~dp0dashboard`, `%~dp0host-tools`,
`%~dp0config.bat`), so they only work once assembled at the delivery root — they are non-functional from
this repo location by design. `Run.bat` spawns each child in its own titled window via `start "…" cmd /k`
(the watcher command is wrapped in an extra quote pair so paths containing spaces survive cmd's
quote-stripping; the dashboard uses `start /D "…"` to set its working dir). Windows built-ins only
(`curl.exe` + `tar`); `npm.cmd` is always called explicitly (never bare `npm`) to dodge the PowerShell
execution-policy wall. The ffmpeg download tries normally first, then retries once with `--ssl-no-revoke`
if a corporate-network revocation check blocks it. ffmpeg is **fetched, never committed** (the full build
is GPL): the download URL is a `FFMPEG_URL` variable at the top of `Setup.bat`.

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
