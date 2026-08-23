#!/usr/bin/env python3
"""
encode_watcher.py - host-side auto-encode watcher for AnomalyInjector SESSION captures.

Decoupled host tooling (like the MCP bridge + overlay_watcher.py): it does NOT modify the engine, the
plugin, or the dashboard. It watches the captures directory on disk; when a SESSION capture completes it
runs ffmpeg to encode that session's Actual_Frames/frame_%05d.png into Video_Clip/<session>.mp4 (the
path/fps come from the session's annotation.json). This is the mp4 half of the m9 workflow - kept host-side
so the plugin stays ships-as-a-build (no ffmpeg dependency in the engine).

How it works:
  - Polls the captures root (--root) every few seconds (stdlib only; sessions complete at low frequency).
  - A session dir is "complete" when it contains BOTH run_summary.json AND annotation.json (the finalize
    artifacts) plus an Actual_Frames/ dir with frames. (annotation.json is a Stage-2 session; a pre-m9
    flat run without it is skipped - nothing to encode from a session envelope.)
  - For each completed session not yet encoded, runs ffmpeg to write Video_Clip/<session>.mp4 at the
    annotation's video.fps (default 30). Frame numbering is session-local 0-based (frame_%05d) so the
    ffmpeg image2 demuxer globs them directly.
  - Timebase cross-check (m33): when the session carries labels.jsonl, the wall rate is measured from
    the per-row t_wall stamps (keyed by session_index, matched to the frame files actually present;
    never keyed positionally and never by frame_index). The estimator is 1/median(consecutive t_wall
    delta) over the matched rows - NOT (N-1)/span, because the deliberate settle gaps between bursts
    are real wall time that is deliberately uncaptured, so a span-based rate under-reads every healthy
    gapped session by ~25% (measured on a certified-healthy banked session: 22.99 vs 30); the median
    sits inside the bursts and ignores the gap outliers. If the measured wall fps agrees with the
    annotation's video.fps within 2 percent, the annotation wins silently, exactly as before. If they
    disagree, the session encodes at the MEASURED wall rate and one loud line names both numbers and
    which won. No labels.jsonl / unparseable rows / fewer than 2 matched rows -> the annotation fps is
    used as before, with a note line saying the cross-check was unavailable.
  - De-dups via a .mp4_done marker written into the session dir (survives restarts). On startup it backfills
    any completed session without that marker, then keeps watching.
  - Fail-soft: if ffmpeg is missing or errors, it LOGS and keeps watching - never crashes. A session that
    errored this run is retried on the next restart (e.g. after you install ffmpeg).

ffmpeg discovery (do NOT hardcode a path):
  --ffmpeg <path>  an explicit ffmpeg.exe OR the bin dir containing it. If omitted, ffmpeg is looked up on
                   PATH. If neither resolves, every session is FLAGGED and skipped (still valid: frames +
                   annotation.json are intact; just re-run after installing ffmpeg / passing --ffmpeg).

Run it (start once, leave running):
  python encode_watcher.py --root "C:\\path\\to\\GameBuild\\Saved\\AnomalyCaptures" --ffmpeg "C:\\path\\to\\ffmpeg\\bin"

Options:
  --root <dir>      captures root (REQUIRED - no default; error-and-exit if missing)
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

POLL_SECONDS = 3.0
MARKER = ".mp4_done"
DONE_SIGNAL = "run_summary.json"
ANNOTATION = "annotation.json"
FRAMES_SUBDIR = "Actual_Frames"
LABELS = "labels.jsonl"
TIMEBASE_TOLERANCE = 0.02


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


def measured_wall_fps(session_dir, frames_dir, ext):
    """Measure the session's true wall rate from labels.jsonl t_wall stamps.

    Rows are keyed by session_index (the frame filename index) and matched against the frame files
    actually on disk; rows without a matching file are ignored. Returns (fps, matched_count) on
    success, or (None, reason) when the cross-check is unavailable - absent file, unparseable rows,
    fewer than 2 matched rows, or a non-positive t_wall span.
    """
    labels_path = os.path.join(session_dir, LABELS)
    if not os.path.isfile(labels_path):
        return None, f"no {LABELS}"
    rows = {}
    try:
        with open(labels_path, "r", encoding="utf-8") as lf:
            for line in lf:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                idx = rec.get("session_index")
                t_wall = rec.get("t_wall")
                if isinstance(idx, int) and isinstance(t_wall, (int, float)):
                    rows[idx] = float(t_wall)
    except OSError as e:
        return None, f"could not read {LABELS}: {e}"
    if not rows:
        return None, f"{LABELS} carries no usable session_index/t_wall rows"
    matched = sorted(
        idx for idx in rows
        if os.path.isfile(os.path.join(frames_dir, f"frame_{idx:05d}.{ext}"))
    )
    if len(matched) < 2:
        return None, f"only {len(matched)} row(s) match a frame file"
    deltas = sorted(d for d in (rows[b] - rows[a] for a, b in zip(matched, matched[1:])) if d > 0)
    if not deltas:
        return None, "no positive t_wall deltas"
    mid = len(deltas) // 2
    median = deltas[mid] if len(deltas) % 2 else 0.5 * (deltas[mid - 1] + deltas[mid])
    return 1.0 / median, len(matched)


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

    fps_annotation = fps
    fps_measured, detail = measured_wall_fps(session_dir, frames_dir, ext)
    if fps_measured is None:
        log(f"note {name}: timebase cross-check unavailable ({detail}); encoding at annotation fps={fps_annotation}")
    elif abs(fps_measured - fps_annotation) > TIMEBASE_TOLERANCE * fps_annotation:
        fps = round(fps_measured, 3)
        log(f"TIMEBASE MISMATCH {name}: annotation fps={fps_annotation} vs measured wall fps={fps_measured:.3f} "
            f"over {detail} frames -> encoding at {fps} (wall-true)")

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


def touch_heartbeat(path):
    """Refresh the heartbeat file's mtime; never fail the watcher over it.

    Run.bat's self-check reads this mtime to tell "the watcher is running" from "its window is open but
    the process died". Purely advisory - encoding does not depend on it.
    """
    if not path:
        return
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("encode_watcher alive\n")
    except OSError:
        return


def main():
    ap = argparse.ArgumentParser(description="Auto-encode AnomalyInjector session captures to mp4 (host-side; engine untouched).")
    ap.add_argument("--root", required=True, help="captures root containing session_<ts>_s<seed>/ dirs (REQUIRED - no default)")
    ap.add_argument("--ffmpeg", default="", help="ffmpeg.exe or its bin dir (default: PATH lookup)")
    ap.add_argument("--interval", type=float, default=POLL_SECONDS, help="poll interval seconds")
    ap.add_argument("--once", action="store_true", help="process existing sessions and exit (no watch loop)")
    ap.add_argument("--heartbeat", default="", help="file to touch each poll so Run.bat's self-check can see this watcher is alive")
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
            touch_heartbeat(args.heartbeat)
            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("stopped.")


if __name__ == "__main__":
    main()
