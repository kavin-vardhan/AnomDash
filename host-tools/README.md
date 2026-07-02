# host-tools

Decoupled host-side tooling for the AnomalyInjector project — logically independent of the plugin
(`StackOBot/Plugins/AnomalyInjector`), though bundled here alongside the dashboard for convenience. None
of it modifies the engine, the plugin, or the dashboard; it only watches the capture output on disk.

## overlay_watcher.py
Watches the capture output directory and auto-runs the labeling track's `verify_capture.py` to draw the
labeled bounding boxes onto each completed capture run's frames (into `<run>/annotated/`). It triggers on
`run_summary.json` (run complete), de-dups via a `.overlay_done` marker, backfills existing runs on startup,
and is fail-soft (logs and keeps watching if anything errors).

Start it once and leave it running. Easiest: **double-click `start_overlay_watcher.bat`** (runs the watcher
with the Pillow-equipped Python; leave the window open, close it when done capturing). Or from a shell:

    python D:\IntrusiveAnomalies\host-tools\overlay_watcher.py

Requires Python 3 (stdlib only for the watcher) and Pillow (for `verify_capture.py`). Works whether the
capture is started from the dashboard or the in-game console — it only watches the disk.

## encode_watcher.py
Watches the same capture output directory and auto-runs **ffmpeg** to encode each completed **session**
capture (m9) into `<session>/Video_Clip/<session>.mp4` from `<session>/Actual_Frames/frame_%05d.png`. It
triggers on `run_summary.json` **plus** `annotation.json` (a session envelope — a plain pre-m9 run or a
manual shot without `annotation.json` is skipped), reads `video.fps`/`video.path` from `annotation.json`,
de-dups via a `.mp4_done` marker, backfills existing sessions on startup, and is fail-soft.

ffmpeg is **not hardcoded**: pass `--ffmpeg <ffmpeg.exe | its bin dir>`, else it's looked up on `PATH`. If
neither resolves, sessions are **flagged and skipped** (frames + `annotation.json` stay valid — just re-run
after installing ffmpeg). Start it: **double-click `start_encode_watcher.bat`** (its `FFMPEG=` line points at
a prebuilt ffmpeg bin dir; edit it to match your machine). Or from a shell:

    python host-tools\encode_watcher.py --ffmpeg "C:\path\to\ffmpeg\bin"

Stdlib only (no Pillow). The overlay and encode watchers are independent — run either or both.

Two Windows/ffmpeg notes baked into the script: the `%05d` input pattern uses forward slashes (a backslash
path matches zero frames), and frames are padded up to even dimensions (`pad=ceil(iw/2)*2:ceil(ih/2)*2`)
because PIE viewports can be odd-height and H.264/yuv420p require even dims — the pad adds ≤1px at the
bottom-right, preserving the top-left origin so `bbox_px` coordinates stay valid.
