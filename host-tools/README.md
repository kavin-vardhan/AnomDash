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
