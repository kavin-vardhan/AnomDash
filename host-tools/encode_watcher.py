#!/usr/bin/env python3
"""
encode_watcher.py - host-side auto-encode watcher for AnomalyInjector SESSION captures.

Decoupled host tooling (like the MCP bridge + overlay_watcher.py): it does NOT modify the engine, the
plugin, or the dashboard. It watches the captures directory on disk; when a SESSION capture completes it
runs ffmpeg to encode that session's Actual_Frames/frame_%05d.png into Video_Clip/<session>.mp4 (the
path/fps come from the session's annotation.json). This is the mp4 half of the m9 workflow - kept host-side
so the plugin stays ships-as-a-build (no ffmpeg dependency in the engine).

How it works:
  - Polls CAPTURES_ROOT every few seconds (stdlib only; sessions complete at low frequency).
  - A session dir is "complete" when it contains BOTH run_summary.json AND annotation.json (the finalize
    artifacts) plus an Actual_Frames/ dir with frames. (annotation.json is a Stage-2 session; a pre-m9
    flat run without it is skipped - nothing to encode from a session envelope.)
  - For each completed session not yet encoded, runs ffmpeg to write Video_Clip/<session>.mp4 at the
    annotation's video.fps (default 30). Frame numbering is session-local 0-based (frame_%05d) so the
    ffmpeg image2 demuxer globs them directly.
  - De-dups via a .mp4_done marker written into the session dir (survives restarts). On startup it backfills
    any completed session without that marker, then keeps watching.
  - Fail-soft: if ffmpeg is missing or errors, it LOGS and keeps watching - never crashes. A session that
    errored this run is retried on the next restart (e.g. after you install ffmpeg).

ffmpeg discovery (do NOT hardcode a path):
  --ffmpeg <path>  an explicit ffmpeg.exe OR the bin dir containing it. If omitted, ffmpeg is looked up on
                   PATH. If neither resolves, every session is FLAGGED and skipped (still valid: frames +
                   annotation.json are intact; just re-run after installing ffmpeg / passing --ffmpeg).

Run it (start once, leave running):
  python D:\\IntrusiveAnomalies\\host-tools\\encode_watcher.py --ffmpeg "E:\\Downloads\\ffmpeg-8.1.2-full_build\\ffmpeg-8.1.2-full_build\\bin"

Options:
  --root <dir>      captures root (default below)
  --ffmpeg <path>   ffmpeg.exe or its bin dir (default: PATH lookup)
  --interval <sec>  poll interval (default 3)
  --once            process existing sessions and exit (no watch loop)
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

CAPTURES_ROOT = r"E:\AnomalyCaptures"
POLL_SECONDS = 3.0
MARKER = ".mp4_done"
DONE_SIGNAL = "run_summary.json"
ANNOTATION = "annotation.json"
FRAMES_SUBDIR = "Actual_Frames"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def resolve_ffmpeg(arg):
    """Return a usable ffmpeg path, or None. arg may be an exe, a bin dir, or empty (-> PATH)."""
    if arg:
        if os.path.isfile(arg):
            return arg
        for cand in (os.path.join(arg, "ffmpeg.exe"), os.path.join(arg, "ffmpeg")):
            if os.path.isfile(cand):
                return cand
        return None
    return shutil.which("ffmpeg")


def detect_frame_ext(frames_dir):
    """png or jpg, inferred from frame_00000.* in the session's Actual_Frames/."""
    for ext in ("png", "jpg", "jpeg"):
        if os.path.isfile(os.path.join(frames_dir, f"frame_00000.{ext}")):
            return ext
    hits = sorted(glob.glob(os.path.join(frames_dir, "frame_*.*")))
    return os.path.splitext(hits[0])[1].lstrip(".").lower() if hits else None


def encode_session(session_dir, ffmpeg):
    """Encode one session's frames to its Video_Clip mp4. Returns True on success (marker written)."""
    name = os.path.basename(session_dir)
    try:
        with open(os.path.join(session_dir, ANNOTATION), "r", encoding="utf-8") as af:
            ann = json.load(af)
    except (OSError, ValueError) as e:
        log(f"skip {name}: could not read {ANNOTATION}: {e}")
        return False

    video = ann.get("video", {}) if isinstance(ann, dict) else {}
    try:
        fps = float(video.get("fps", 30) or 30)
    except (TypeError, ValueError):
        fps = 30.0
    if fps <= 0:
        fps = 30.0
    fps = round(fps, 3)
    frames_rel = video.get("frames_dir", FRAMES_SUBDIR)
    video_rel = video.get("path", f"Video_Clip/{name}.mp4")

    frames_dir = os.path.join(session_dir, frames_rel)
    if not os.path.isdir(frames_dir):
        log(f"skip {name}: no {frames_rel}/ dir")
        return False
    ext = detect_frame_ext(frames_dir)
    if not ext:
        log(f"skip {name}: no frames in {frames_rel}/")
        return False

    out_path = os.path.join(session_dir, os.path.normpath(video_rel))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    input_pattern = os.path.join(frames_dir, f"frame_%05d.{ext}").replace("\\", "/")

    cmd = [
        ffmpeg, "-y",
        "-framerate", str(fps),
        "-start_number", "0",
        "-i", input_pattern,
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        out_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    except Exception as e:
        log(f"FAILED to launch ffmpeg for {name}: {e}")
        return False

    if proc.returncode != 0:
        log(f"ffmpeg errored on {name} (exit {proc.returncode}):")
        for line in (proc.stderr or proc.stdout or "").strip().splitlines()[-4:]:
            log(f"    {line}")
        return False

    try:
        with open(os.path.join(session_dir, MARKER), "w", encoding="utf-8") as mf:
            json.dump({"encoded_at": time.strftime("%Y-%m-%d %H:%M:%S"), "mp4": video_rel, "fps": fps}, mf)
    except OSError as e:
        log(f"WARN: could not write {MARKER} in {name}: {e}")
    log(f"encoded {name} -> {video_rel}  ({fps} fps, frame_%05d.{ext})")
    return True


def scan_once(root, ffmpeg, failed):
    """One pass over the captures root, encoding any newly-completed session."""
    if not os.path.isdir(root):
        return
    for name in sorted(os.listdir(root)):
        session_dir = os.path.join(root, name)
        if not os.path.isdir(session_dir):
            continue
        if not os.path.isfile(os.path.join(session_dir, DONE_SIGNAL)):
            continue
        if not os.path.isfile(os.path.join(session_dir, ANNOTATION)):
            continue
        if os.path.isfile(os.path.join(session_dir, MARKER)):
            continue
        if session_dir in failed:
            continue
        if ffmpeg is None:
            log(f"FLAG {name}: ffmpeg not found (pass --ffmpeg <path> or add it to PATH); frames + "
                f"annotation.json are intact - re-run after installing to encode.")
            failed.add(session_dir)
            continue
        if not encode_session(session_dir, ffmpeg):
            failed.add(session_dir)


def main():
    ap = argparse.ArgumentParser(description="Auto-encode AnomalyInjector session captures to mp4 (host-side; engine untouched).")
    ap.add_argument("--root", default=CAPTURES_ROOT, help="captures root containing session_<ts>_s<seed>/ dirs")
    ap.add_argument("--ffmpeg", default="", help="ffmpeg.exe or its bin dir (default: PATH lookup)")
    ap.add_argument("--interval", type=float, default=POLL_SECONDS, help="poll interval seconds")
    ap.add_argument("--once", action="store_true", help="process existing sessions and exit (no watch loop)")
    args = ap.parse_args()

    ffmpeg = resolve_ffmpeg(args.ffmpeg)

    log("encode watcher starting")
    log(f"  root   : {args.root}")
    log(f"  ffmpeg : {ffmpeg if ffmpeg else '(NOT FOUND - pass --ffmpeg <path> or add ffmpeg to PATH)'}")
    if ffmpeg is None:
        log("  WARNING: no ffmpeg - sessions will be FLAGGED and skipped until you provide one (frames + "
            "annotation.json stay valid; re-run to encode).")
    log(f"  poll   : every {args.interval}s  (backfilling existing sessions first, then watching; Ctrl+C to stop)")

    failed = set()
    try:
        while True:
            scan_once(args.root, ffmpeg, failed)
            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("stopped.")


if __name__ == "__main__":
    main()
