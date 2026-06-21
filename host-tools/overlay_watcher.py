#!/usr/bin/env python3
"""
overlay_watcher.py - host-side auto-overlay watcher for AnomalyInjector capture runs.

Decoupled host tooling (like the MCP bridge): it does NOT modify the engine, the plugin, the dashboard, or
verify_capture.py. It watches the captures directory on disk; when a capture run completes it invokes the
labeling track's verify_capture.py to draw the labeled bounding boxes onto that run's frames.

How it works:
  - Polls CAPTURES_ROOT every few seconds (stdlib only - a run completing is low-frequency, so polling
    latency is irrelevant and there's no pip dependency).
  - A run dir is "complete" when it contains run_summary.json (NOT on bare dir creation - that avoids
    racing a half-written run).
  - For each completed run not yet overlaid, runs:  python verify_capture.py --dir <runDir>
    which writes annotated frames into <runDir>/annotated/.
  - De-dups via a .overlay_done marker written into the run dir (survives restarts). On startup it backfills
    any completed run without that marker (including the one just captured), then keeps watching.
  - Fail-soft: if verify_capture.py errors (e.g. Pillow missing), it LOGS and keeps watching - never crashes.
    Re-running verify_capture.py on a run is safe (it overwrites the annotated images).
  - Works whether the capture was started from the dashboard or the in-game console - it only watches disk.

Run it (start once, leave running):
  python D:\\IntrusiveAnomalies\\host-tools\\overlay_watcher.py

Options:
  --root <dir>      captures root (default below)
  --script <path>   path to verify_capture.py (default below)
  --interval <sec>  poll interval (default 3)
  --once            process existing runs and exit (no watch loop)
"""

import argparse
import json
import os
import subprocess
import sys
import time

# --- defaults (override via CLI) ---
CAPTURES_ROOT = r"D:\IntrusiveAnomalies\StackOBot\Saved\AnomalyCaptures"
VERIFY_SCRIPT = r"D:\IntrusiveAnomalies\StackOBot\Plugins\AnomalyInjector\tools\verify_capture.py"
POLL_SECONDS = 3.0
MARKER = ".overlay_done"
DONE_SIGNAL = "run_summary.json"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def overlay_run(run_dir, script):
    """Invoke verify_capture.py against one run dir. Returns True on success (marker written)."""
    name = os.path.basename(run_dir)
    try:
        proc = subprocess.run(
            [sys.executable, script, "--dir", run_dir],
            capture_output=True, text=True, timeout=900,
        )
    except Exception as e:  # launch failure (missing python/script, timeout, ...)
        log(f"FAILED to launch verify_capture.py for {name}: {e}")
        return False

    if proc.returncode != 0:
        log(f"verify_capture.py errored on {name} (exit {proc.returncode}):")
        for line in (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]:
            log(f"    {line}")
        return False

    ann_dir = os.path.join(run_dir, "annotated")
    n = len([f for f in os.listdir(ann_dir) if f.lower().endswith(".png")]) if os.path.isdir(ann_dir) else 0
    try:
        with open(os.path.join(run_dir, MARKER), "w", encoding="utf-8") as mf:
            json.dump({"overlaid_at": time.strftime("%Y-%m-%d %H:%M:%S"), "annotated_images": n}, mf)
    except OSError as e:
        log(f"WARN: could not write {MARKER} in {name}: {e}")
    log(f"overlaid {name} -> {n} images")
    return True


def scan_once(root, script, failed):
    """One pass over the captures root, overlaying any newly-completed run."""
    if not os.path.isdir(root):
        return
    for name in sorted(os.listdir(root)):
        run_dir = os.path.join(root, name)
        if not os.path.isdir(run_dir):
            continue
        if not os.path.isfile(os.path.join(run_dir, DONE_SIGNAL)):
            continue  # not complete yet (or a single-shot 'manual' dir) - skip
        if os.path.isfile(os.path.join(run_dir, MARKER)):
            continue  # already overlaid (de-dup; survives restarts)
        if run_dir in failed:
            continue  # errored this session - retry on next restart (e.g. after installing Pillow)
        if not os.path.isfile(os.path.join(run_dir, "labels.jsonl")):
            log(f"skip {name}: {DONE_SIGNAL} present but no labels.jsonl")
            failed.add(run_dir)
            continue
        if not overlay_run(run_dir, script):
            failed.add(run_dir)


def main():
    ap = argparse.ArgumentParser(description="Auto-overlay AnomalyInjector capture runs (host-side; engine untouched).")
    ap.add_argument("--root", default=CAPTURES_ROOT, help="captures root containing run_<seed>_<ts>/ dirs")
    ap.add_argument("--script", default=VERIFY_SCRIPT, help="path to verify_capture.py")
    ap.add_argument("--interval", type=float, default=POLL_SECONDS, help="poll interval seconds")
    ap.add_argument("--once", action="store_true", help="process existing runs and exit (no watch loop)")
    args = ap.parse_args()

    log("overlay watcher starting")
    log(f"  root   : {args.root}")
    log(f"  script : {args.script}")
    if not os.path.isfile(args.script):
        log("  WARNING: verify_capture.py not found at that path - overlays will fail until it exists.")
    log(f"  poll   : every {args.interval}s  (backfilling existing runs first, then watching; Ctrl+C to stop)")

    failed = set()
    try:
        while True:
            scan_once(args.root, args.script, failed)
            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("stopped.")


if __name__ == "__main__":
    main()
