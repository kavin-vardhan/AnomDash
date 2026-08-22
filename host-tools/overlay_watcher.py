#!/usr/bin/env python3
"""
overlay_watcher.py - watches the captures folder and draws the inspection overlay on each finished run.

WHAT IT IS FOR. Some anomalies are genuinely hard to see by eye - a missing texture on rocks lying on
the ground, for instance. The overlay draws the capture's own bounding boxes onto COPIES of the frames
so you can confirm what the dataset says about a frame instead of squinting at it.

WHAT IT IS NOT. It is not a label producer. The engine-side labels are authoritative; this only reads
what was written and draws it. It never modifies a captured frame and never edits a label file - every
annotated image is a new file under <run>/annotated/.

RED means the event is in annotation.json for that frame: a shipped label.
AMBER means the box is in labels.jsonl but not in annotation.json for that frame - a candidate that did
not become a shipped label, tagged with why (see verify_capture.py's header for the categories).

How it works:
  - Polls the captures root every few seconds (stdlib only; a run completing is a low-frequency event).
  - A run counts as complete when run_summary.json appears - not on bare directory creation, which
    would race a half-written run.
  - Runs verify_capture.py against it and STREAMS that script's progress to this console.
  - De-dups with a .overlay_done marker inside the run dir, so restarting does not redo finished runs.
  - Fail-soft: if a run cannot be overlaid it logs and keeps watching, never crashes.

Run it:  python overlay_watcher.py --root <capturesRoot>
Options: --script <verify_capture.py>  --interval <sec>  --once
"""

import argparse
import json
import os
import subprocess
import sys
import time

CAPTURES_ROOT = r"D:\IntrusiveAnomalies\StackOBot\Saved\AnomalyCaptures"
POLL_SECONDS = 3.0
MARKER = ".overlay_done"
DONE_SIGNAL = "run_summary.json"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def default_verify_script():
    beside = os.path.join(os.path.dirname(os.path.abspath(__file__)), "verify_capture.py")
    if os.path.isfile(beside):
        return beside
    return r"D:\IntrusiveAnomalies\StackOBot\Plugins\AnomalyInjector\tools\verify_capture.py"


def check_pillow():
    try:
        import PIL
        return True
    except ImportError:
        print("", flush=True)
        print("  The overlay tool needs Pillow, and it is not installed for this Python.", flush=True)
        print("", flush=True)
        print("  Install it by running exactly this line:", flush=True)
        print("", flush=True)
        print(f'      "{sys.executable}" -m pip install --upgrade Pillow', flush=True)
        print("", flush=True)
        print("  Then start this watcher again. Nothing else is affected - your captures and the", flush=True)
        print("  video encoder keep working without it; only the overlay images need Pillow.", flush=True)
        print("", flush=True)
        return False


def overlay_run(run_dir, script):
    """Invoke verify_capture.py against one run dir, streaming its progress. True on success."""
    name = os.path.basename(run_dir)
    log(f"overlaying {name} ...")
    summary_lines = []
    try:
        proc = subprocess.Popen(
            [sys.executable, script, "--dir", run_dir, "--quiet"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
    except Exception as e:
        log(f"FAILED to launch verify_capture.py for {name}: {e}")
        return False

    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        if line.startswith("[progress]"):
            print(f"    {name}  frames {line[len('[progress]'):].strip()}", end="\r", flush=True)
        else:
            summary_lines.append(line)
    proc.wait()
    print("", flush=True)

    if proc.returncode != 0:
        log(f"verify_capture.py errored on {name} (exit {proc.returncode}):")
        for line in summary_lines[-6:]:
            log(f"    {line}")
        return False

    for line in summary_lines:
        stripped = line.strip()
        if stripped.startswith(("RED", "AMBER", "NOTE:")) or "box(es) drawn" in stripped \
                or "had no image" in stripped:
            log(f"    {stripped}")

    ann_dir = os.path.join(run_dir, "annotated")
    n = len([f for f in os.listdir(ann_dir) if f.lower().endswith(".png")]) if os.path.isdir(ann_dir) else 0
    try:
        with open(os.path.join(run_dir, MARKER), "w", encoding="utf-8") as mf:
            json.dump({"overlaid_at": time.strftime("%Y-%m-%d %H:%M:%S"), "annotated_images": n}, mf)
    except OSError as e:
        log(f"WARN: could not write {MARKER} in {name}: {e}")
    log(f"done {name} -> {n} annotated image(s) in {os.path.join(run_dir, 'annotated')}")
    return True


def scan_once(root, script, failed):
    if not os.path.isdir(root):
        return
    for name in sorted(os.listdir(root)):
        run_dir = os.path.join(root, name)
        if not os.path.isdir(run_dir):
            continue
        if not os.path.isfile(os.path.join(run_dir, DONE_SIGNAL)):
            continue
        if os.path.isfile(os.path.join(run_dir, MARKER)):
            continue
        if run_dir in failed:
            continue
        if not os.path.isfile(os.path.join(run_dir, "labels.jsonl")):
            log(f"skip {name}: run finished but there is no labels.jsonl. In delivery mode that file is "
                f"written only when IAI.Capture.DeliveryLabels is ON (it is ON by default).")
            failed.add(run_dir)
            continue
        if not overlay_run(run_dir, script):
            failed.add(run_dir)


def main():
    ap = argparse.ArgumentParser(
        description="Draw the inspection overlay on each finished capture run (never alters frames or labels).")
    ap.add_argument("--root", default=CAPTURES_ROOT, help="captures root containing session_<ts>/ dirs")
    ap.add_argument("--script", default=None, help="path to verify_capture.py")
    ap.add_argument("--interval", type=float, default=POLL_SECONDS, help="poll interval seconds")
    ap.add_argument("--once", action="store_true", help="process existing runs and exit (no watch loop)")
    args = ap.parse_args()

    script = args.script or default_verify_script()

    log("overlay watcher starting")
    log(f"  captures : {args.root}")
    log(f"  script   : {script}")

    if not check_pillow():
        return 2

    if not os.path.isfile(script):
        log(f"  ERROR: verify_capture.py not found at {script} - overlays cannot run.")
        return 2
    if not os.path.isdir(args.root):
        log(f"  WARNING: captures root does not exist yet: {args.root}")
        log("           It will be picked up as soon as the first capture is written there.")

    log(f"  polling every {args.interval:.0f}s - existing runs are backfilled first, then it watches. "
        f"Leave this window open; close it when you are done capturing.")

    failed = set()
    try:
        while True:
            scan_once(args.root, script, failed)
            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
