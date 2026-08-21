#!/usr/bin/env python3
"""
measure_label_offset.py - measure WHERE ANOMALIES ACTUALLY MANIFEST IN PIXELS against WHERE THE
ANNOTATIONS CLAIM THEY ARE, per event, and print a compact per-type offset table.

Read-only diagnostic. It never writes into a session directory and never modifies the plugin, the
engine or the dashboard. It reads a finished capture session off disk (PNG frames + annotation.json
[+ labels.jsonl] [+ a UE log]) and answers one question: for each annotated event, how many frames
separate the annotation from the pixels?

STDLIB + PILLOW ONLY. No numpy, no OpenCV.

--------------------------------------------------------------------------------------------------
INDEX CONVENTION - stated because viewers that count from 1 have caused phantom off-by-ones here
--------------------------------------------------------------------------------------------------
The PNG filename index IS the session index and it is 0-BASED.

    Actual_Frames/frame_00000.png  ==  session index 0  ==  annotation frame_indices value 0
    labels.jsonl "session_index"   ==  that same 0-based number
    labels.jsonl "frame_index"     ==  the ENGINE frame counter (GFrameCounter). NOT a session index.

A media player or image viewer that numbers the first frame "1" will appear to disagree with this
tool by exactly +1. It is the viewer that is offset, not the data. This tool prints the convention in
its own output header so a screen photo of a result carries it.

Per session the tool verifies that every annotated frame index has a corresponding PNG on disk and
reports any miss LOUDLY, before any offset is computed. That check exists so a numbering artifact
cannot masquerade as an offset.

--------------------------------------------------------------------------------------------------
SIGN CONVENTION - one convention everywhere
--------------------------------------------------------------------------------------------------
    offset  =  MANIFESTED  -  ANNOTATED      (in frames)

    POSITIVE  =  the pixels LAG the label   (the label is stamped EARLY / upstream of rendering)
    NEGATIVE  =  the pixels LEAD the label  (the label is stamped LATE)

This applies to startDelta, endDelta and to the hide-type best shift alike.

--------------------------------------------------------------------------------------------------
HOW A FRAME IS JUDGED MANIFESTED
--------------------------------------------------------------------------------------------------
REGION.  Per event, the region is that event's own bbox, taken from labels.jsonl:
    bbox_px   = [x, y, width, height]   in written-frame pixels, already clamped to the frame
    bbox_norm = [x0, y0, x1, y1]        normalized CORNERS, NOT x/y/w/h, and NOT clamped
bbox_px is preferred; bbox_norm x image size is the fallback. Frames outside the annotated window
carry no label row at all, so those frames use the event's MODAL bbox (the most frequent bbox across
the event's labelled frames). Per-frame bbox variation is reported as bbox_jitter_px and lowers
confidence. If neither field is reachable - notably a DELIVERY-MODE session, where labels.jsonl is
not written at all - the region degrades to the FULL FRAME and the event is reported with
region_source=fullframe and reduced confidence. It is never silently dropped.

BASELINE.  Frames outside EVERY annotated window in the session (the union of all events' windows,
each padded by BASELINE_GUARD frames) are eligible. If a dense burst schedule leaves fewer than
BASELINE_MIN eligible frames, the guard is RELAXED (2 -> 1 -> 0) and the guard actually used is
printed - a five-burst 60-frame leg leaves exactly one eligible frame at guard 2.

The event then takes up to BASELINE_N eligible frames, ranked by (distance to the window, then
BEFORE-the-window first, then index) and admitted only while the whole set stays within
BASELINE_SPREAD frames end to end. The spread cap is the part that matters, and it was added after
measurement: on a session whose camera is still settling, a "nearest N before the window" set can
reach back into the settle, and its own internal variance then inflates the threshold until real
manifestations read as nothing. Measured on a MainWorld leg: the same annotated frame reads 0.31
against a settle-era reference and 0.048 against a near one. If no capped set reaches BASELINE_MIN
the cap is relaxed (x2, x4, unbounded) and the tag in baseline_side records which applied.

Ranking by distance with BEFORE winning the tie is the brief's "prefer before, fall back to after";
the resulting set MAY straddle the window when the nearest clean frames lie on both sides, and
baseline_side says "before", "after" or "straddle" so the reader always knows.

SIGNAL.  Every baseline frame is used as a REFERENCE, not just one. For frame f and reference b:

         raw(f,b)     = mean |gray(f) - gray(b)| over the region, in 0..1 units
         ambient(f,b) = the same quantity over a RING around the region (the region dilated by
                        RING_DILATE_PX, minus the region itself)
         net(f,b)     = raw(f,b) - ambient(f,b)

    References whose ambient exceeds max(AMBIENT_REF_FACTOR x min_ambient, min_ambient +
    AMBIENT_REF_FLOOR) are DISCARDED for that frame - a reference the camera has drifted far from is
    not a usable comparison, and its raw and ambient both inflate and falsely cancel. At least
    NET_QUANTILE_INDEX+1 references always survive.

         net(f) = the (NET_QUANTILE_INDEX+1)-th SMALLEST net(f,b) over the surviving references

    Near-minimum rather than mean, because a clean frame need only match ONE clean reference to be
    clean, while an anomalous frame must differ from ALL of them. That is what cancels camera drift:
    measured on a MainWorld leg, an annotated frame reads 0.31 against a settle-era reference and
    0.020 against a near one, and taking the near-minimum recovers a clean 9x separation where a
    single fixed reference gave none. Not the outright minimum, because one reference may itself be
    contaminated (see BASELINE CONTAMINATION below); the second-smallest tolerates exactly one.

    Subtracting ambient is what stops camera motion, a passing mover or a lighting change from
    faking a manifestation: a whole-frame change lifts the ring as much as the region and cancels.
    The ring is unavailable when the region IS the frame (camera_clipping labels the whole frame; a
    delivery-mode fallback does too) or when the ring is thinner than RING_MIN_PX pixels. Then
    ambient_mode is "none", net == raw, and confidence is capped at MED. Reported, not hidden.

THRESHOLD.  Self-calibrated from that event's OWN baseline noise, ROBUSTLY:

    base_vals = net(b) for every baseline frame b, each measured against the OTHER baseline frames
    T         = median(base_vals) + K * 1.4826 * MAD(base_vals) + SIGNAL_FLOOR

A frame is MANIFESTED when net(f) > T. Median and MAD rather than mean and standard deviation
because a contaminated baseline frame is a single large outlier that would otherwise inflate T until
the real anomaly disappears beneath it - measured: one settle-era frame in a five-frame baseline
raised T by roughly 4x. SIGNAL_FLOOR exists because a settled camera with a deterministic renderer
can produce byte-identical baseline frames, which would otherwise yield T = 0 and call rounding
noise a manifestation.

BASELINE CONTAMINATION - the failure this instrument is most likely to hit, made LOUD.
    The baseline is chosen from frames the ANNOTATION says are clean. If the annotation is offset by
    more than the clean gap between bursts, some of those frames are anomalous in the pixels, and a
    naive instrument then reports a confident, WRONG, UNDER-READ offset. So: any baseline frame
    whose own net exceeds T is counted in baseline_contaminated, the row drops to LOW confidence,
    and the type line prints a *** BASELINE CONTAMINATED *** banner naming the risk.
    THE HARD LIMIT THIS IMPLIES, stated rather than discovered later: THE MEASURABLE OFFSET IS
    BOUNDED BY THE CLEAN GAP BETWEEN ANNOTATED WINDOWS. On the standard 2/4/8/4/0 capture config
    that gap is about four frames. Beyond it the tool reports contamination, low confidence or
    UNMEASURABLE - it does not report a confident wrong number. Verified by construction: a +-3
    shift applied to a real bench session raises the banner on most events, while the same +-3 on a
    sparse synthetic session (18 clean frames between windows) reads back as exactly +-3.

Every constant is printed in the output header, so a photograph of the console carries the
configuration that produced the numbers.

UNMEASURABLE.  A frame is UNMEASURABLE when ambient(f) > AMBIENT_FACTOR * T - ambient change is too
large to separate signal from it. An event is UNMEASURABLE when it has fewer than 3 baseline frames,
when fewer than MIN_MEASURABLE_FRAC of its evaluated frames are measurable, when its region is
degenerate, or when nothing manifests anywhere near its window. Unmeasurable is REPORTED as such and
never replaced by a guess.

--------------------------------------------------------------------------------------------------
PER-TYPE LAYERS
--------------------------------------------------------------------------------------------------
HIDE TYPES (blink / blinking / missing_object) - and any event whose annotated frame set has GAPS.
    A blink event's annotated set is deliberately NON-CONTIGUOUS: {40,41,45,46} means
    disappear / reappear / disappear / reappear. Reducing it to a start and an end would destroy the
    structure that makes the alignment measurable, so this path does not.
    The annotated indicator A(f) and the measured indicator M(f) are built over the event's
    neighbourhood, and the best integer shift s in [-SHIFT_RANGE, +SHIFT_RANGE] is the one maximizing
    agreement between A(f) and M(f+s). Reported: best shift, agreement at that shift, and agreement
    at shift 0. BEST SHIFT IS THE EVENT'S OFFSET for hide types.
    AGREEMENT IS BALANCED ACCURACY - the mean of the true-positive rate over annotated frames and the
    true-negative rate over the rest. Plain accuracy is dominated by the many correct negatives in the
    padding and barely moves when a 4-frame set is misaligned; balanced accuracy does move. Plain
    accuracy is carried in the CSV as agreement_best_raw / agreement_0_raw for anyone who wants it.

MISSING_TEXTURE / CORRUPTED_TEXTURE - contiguous window; startDelta and endDelta.
    Manifested frames are additionally classified MAGENTA / CHECKER / OTHER.
      MAGENTA - proximity to the corruption material's colour, tested RELATIVELY so that a LIT
                magenta surface still passes: min(R,B) > MAGENTA_MIN_RB, G < MAGENTA_G_RATIO*min(R,B),
                |R-B| < MAGENTA_RB_RATIO*max(R,B), over at least MAGENTA_FRAC_MIN of the region.
                An absolute-brightness form of this test was tried first and MISSED real magenta
                frames whose lit pixels sat below the absolute floor; the relative form reads the
                same frames at 0.20-0.37 of the region while reading 0.000 on checkered ones.
      CHECKER - a grey/white grid, by EITHER of two routes, both requiring low mean saturation:
                (a) ABSOLUTE - high per-pixel edge energy plus a strongly bimodal luminance
                    histogram (Otsu split) with both modes well populated. Catches a high-contrast
                    checker outright.
                (b) DIFFERENTIAL - edge energy at least CHECKER_EDGE_GAIN times the SAME REGION's
                    edge energy in the nearest baseline frame. Route (b) exists because route (a)
                    alone was measured FAILING on a real case and for an instructive reason: a bbox
                    holding a dark object against a bright background is strongly bimodal whether or
                    not a checker is present, so the absolute statistics of the anomalous frame and
                    the clean frame were nearly identical (sep 0.739 vs 0.720, conc 0.914 vs 0.943).
                    The only quantity that moved was edge energy, 0.0081 -> 0.0108. A differential
                    test reads that; an absolute one cannot.
                NOTE the region is the whole bbox, background included, so a target that fills
                little of its own rect dilutes the concentration statistic. CHECKER_CONC_MIN is set
                low enough for the measured real cases (0.446-0.696) and is a stated soft spot.
    THIS CLASSIFICATION IS INFORMATIONAL ONLY. Manifested-or-not always comes from the generic
    net-vs-threshold signal above, never from the classifier. The classifier runs on both texture
    ids because the two share one detector pair and the split is what identifies which material
    actually reached the frame.

LOD_POPPING / LOD_CORRUPTION - contiguous; expect small step changes.
    peak_net and its ratio to the threshold are reported so a low signal is visible rather than
    rounded away, and a confidence rating is mandatory.

EVERYTHING ELSE - generic signal plus confidence, contiguous unless the annotated frame set itself
    has gaps, in which case the set-alignment path is used and the row says so.

SESSION-SPANNING EVENTS - an event annotated over SESSION_SPAN_FRAC or more of the session (the
    shape camera_clipping takes: a Global-scoped anomaly held for the whole run) is reported
    UNMEASURABLE:session-spanning-no-negative-reference and no offset is emitted for it. This is
    structural, not a tuning choice: every frame in the session is inside its window, so there is no
    clean frame anywhere to compare against, and any number produced would be measured against a
    reference that carries the anomaly too. Such an event is also excluded from BLOCKING other
    events' baselines - otherwise one session-wide global anomaly makes every object-scoped event in
    the same session unmeasurable as well. To measure a session-spanning anomaly's offset you need a
    session in which it toggles.

--------------------------------------------------------------------------------------------------
LOG JOIN (optional, auto-detected, never fatal)
--------------------------------------------------------------------------------------------------
If a UE log sits inside or beside a session directory, or is named with --log, the m31 handshake
trace is parsed. THE EXACT TOKENS PARSED, so their presence can be confirmed off a screen:

    Capture(sve): SVE-WANT-TRACE arm <i>/<limit> requestId=<n> gameFrame=<n> pendingAfter=<n>
    Capture(sve): SVE-WANT-TRACE publish <i>/<limit> familyFrame=<n> wanted=<0|1> requestId=<n> pendingBefore=<n>
    Capture(sve): SVE-WANT-SUMMARY marksIssued=<n> publishesSeen=<n> wantedMatches=<n> submitsIssued=<n> framesWritten=<n> pendingWantedAtEnd=<n> maxPendingDepth=<n>
    Capture(async): CAP-PAIR-DROP completed frame id=<n> has no pending snapshot

The trace is bounded to the first 64 arms and the first 64 publishes per run, so joins exist only for
the first <=64 captured frames. That bound is reported with the result.

SERIAL to SESSION-INDEX MAPPING - stated because it is load-bearing and because one of the two
routes is NOT always safe:
  ROUTE A (preferred, exact).  The arm line's gameFrame is GFrameCounter at the arm site. That is the
      same value labels.jsonl records as "frame_index". So gameFrame -> labels.jsonl frame_index ->
      session_index. Requires labels.jsonl, i.e. a delivery-OFF session.
  ROUTE B (fallback, ordinal).  requestId is a plugin-owned monotonic serial minted once per armed
      frame. Within one run it increases by one per captured frame, so
      session_index = requestId - min(requestId over that run's arm lines).
      Subtracting the run minimum is REQUIRED: the serial is a subsystem member that is NOT reset at
      StartRun, so in a process that captured twice the second run's serials do not start at 1. A
      raw "session_index = requestId - 1" would be wrong for every run but the first.
When both routes resolve for the same arm they are cross-checked and the agreement count is printed.

A log may contain SEVERAL capture runs, and a log handed to several sessions belongs to at most one
of them. Runs are segmented on "arm 1/" (the trace index resets per run) and each segment records the
timestamp of its first arm line. A segment is attributed to a session only when that timestamp falls
within LOG_TIME_TOLERANCE_S of the session's run.json start_time_utc - both are UTC and, measured on
a real pair, agree to the millisecond. If no traced run matches, the line reads *** LOG DOES NOT
BELONG TO THIS SESSION *** and the per-event join is SKIPPED; the gap distribution is still printed
because it is still a fact about that log. Without a run.json to check against, a single-segment log
is accepted with "run start time not checkable" and a multi-segment log falls back to matching
framesWritten against total_frames, joining only on a unique match.

This guard exists because the natural office invocation - one --log for a whole batch - would
otherwise attribute one run's pairing gaps to every session in the batch, silently and plausibly.

PURPOSE OF THE JOIN, CONTEXT ONLY: it separates "the arm-to-publish pairing gap owns the offset" from
"render-side latency owns it". No fix reasoning lives in this tool.

If no log is found the tool prints "no log found" and continues.

--------------------------------------------------------------------------------------------------
OUTPUT
--------------------------------------------------------------------------------------------------
Console: a header carrying the script version, every constant, the index convention and the sign
convention; then per session a schema line, an index-check line, a log line, and one table row per
anomaly type (two lines for contiguous types - startD and endD).
CSV: one row per EVENT, written to --csv (default ./measure_label_offset.csv), never into a session
directory. --series additionally dumps the per-frame signal series beside it.
--verbose adds one console line per event.

DETERMINISTIC: the same input produces byte-identical output. Nothing in the output is derived from
wall-clock time, randomness or filesystem enumeration order.

--------------------------------------------------------------------------------------------------
USAGE
--------------------------------------------------------------------------------------------------
    python measure_label_offset.py <session_dir> [<session_dir> ...]
    python measure_label_offset.py <root_dir_containing_sessions>
    python measure_label_offset.py A B --label editor-sve --label packaged-sve
    python measure_label_offset.py <dir> --log "<path to UE log>" --verbose --series
    python measure_label_offset.py --selftest

--selftest runs the MAGENTA/CHECKER classifier against synthetic patches with known answers and exits.
Worth running once on a machine you have not used this script on before: the detectors are built from
Pillow primitives, so a different Pillow build is the one thing that could silently change them.

Exit codes: 0 normal, 1 no session found, 2 Pillow missing, 3 selftest failed.
"""

import argparse
import csv
import datetime
import json
import os
import re
import statistics
import sys
from collections import OrderedDict

try:
    from PIL import Image, ImageChops, ImageStat
except Exception:
    sys.stderr.write(
        "measure_label_offset: Pillow (PIL) is required and could not be imported.\n"
        "Install it with this exact line, then re-run:\n"
        "\n"
        "    python -m pip install --upgrade Pillow\n"
        "\n"
    )
    sys.exit(2)


VERSION = "measure_label_offset 1.0.0"

K_SIGMA = 6.0
SIGNAL_FLOOR = 0.0040
RING_DILATE_PX = 48
RING_MIN_PX = 2000
RING_MAX_REGION_FRAC = 0.60
AMBIENT_FACTOR = 3.0
AMBIENT_REF_FACTOR = 2.0
AMBIENT_REF_FLOOR = 0.0020
BASELINE_N = 5
BASELINE_MIN = 3
BASELINE_GUARD = 2
NEIGHBOURHOOD_PAD = 12
SHIFT_RANGE = 10
MIN_AGREE_FRAMES = 8
MIN_MEASURABLE_FRAC = 0.50
GAP_BRIDGE = 1
MIN_REGION_PX = 64
MIN_MANIFEST_FRAMES = 2
SESSION_SPAN_FRAC = 0.80
NET_QUANTILE_INDEX = 1

MAGENTA_FRAC_MIN = 0.10
MAGENTA_MIN_RB = 60
MAGENTA_G_RATIO = 0.60
MAGENTA_RB_RATIO = 0.40
CHECKER_SAT_MAX = 0.150
CHECKER_EDGE_MIN = 0.015
CHECKER_MODE_SEP = 0.250
CHECKER_MODE_MIN_FRAC = 0.150
CHECKER_CONC_MIN = 0.400
CHECKER_MODE_TOL = 30
CHECKER_EDGE_GAIN = 1.25
CHECKER_EDGE_FLOOR = 0.005

CONTRAST_HIGH = 3.0
CONTRAST_MED = 2.0
AGREE_HIGH = 0.95
AGREE_MED = 0.85
COVERAGE_HIGH = 0.90
COVERAGE_MED = 0.60

HIDE_TYPES = ("blink", "blinking", "missing_object", "flicker", "flickering")
TEXTURE_TYPES = ("missing_texture", "corrupted_texture")

LOG_TIME_TOLERANCE_S = 180

FRAME_RE = re.compile(r"^frame_(\d+)\.(png|jpg|jpeg)$", re.IGNORECASE)
LOG_TS_RE = re.compile(r"^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]")
ARM_RE = re.compile(
    r"SVE-WANT-TRACE\s+arm\s+(\d+)/(\d+)\s+requestId=(\d+)\s+gameFrame=(\d+)\s+pendingAfter=(-?\d+)"
)
PUB_RE = re.compile(
    r"SVE-WANT-TRACE\s+publish\s+(\d+)/(\d+)\s+familyFrame=(\d+)\s+wanted=([01])\s+"
    r"requestId=(\d+)\s+pendingBefore=(-?\d+)"
)
SUM_RE = re.compile(
    r"SVE-WANT-SUMMARY\s+marksIssued=(\d+)\s+publishesSeen=(\d+)\s+wantedMatches=(\d+)\s+"
    r"submitsIssued=(\d+)\s+framesWritten=(\d+)\s+pendingWantedAtEnd=(-?\d+)\s+maxPendingDepth=(-?\d+)"
)


def mean_of(vals):
    return sum(vals) / float(len(vals))


def median_or_none(vals):
    v = [x for x in vals if x is not None]
    if not v:
        return None
    return statistics.median(v)


def compress_indices(idxs):
    if not idxs:
        return ""
    xs = sorted(set(int(i) for i in idxs))
    parts = []
    run_start = xs[0]
    prev = xs[0]
    for v in xs[1:]:
        if v == prev + 1:
            prev = v
            continue
        parts.append(str(run_start) if run_start == prev else "%d-%d" % (run_start, prev))
        run_start = v
        prev = v
    parts.append(str(run_start) if run_start == prev else "%d-%d" % (run_start, prev))
    return ",".join(parts)


def signed(v):
    if v is None:
        return "-"
    return "%+d" % int(v)


def f2(v):
    if v is None:
        return "-"
    return "%.2f" % v


def f4(v):
    if v is None:
        return "-"
    return "%.4f" % v


def clamp_box(box, w, h):
    x0 = max(0, min(int(round(box[0])), w))
    y0 = max(0, min(int(round(box[1])), h))
    x1 = max(0, min(int(round(box[2])), w))
    y1 = max(0, min(int(round(box[3])), h))
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return (x0, y0, x1, y1)


def box_area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


class FrameCache(object):
    def __init__(self, paths, downscale, limit=192):
        self.paths = paths
        self.downscale = downscale
        self.limit = max(8, limit)
        self.gray = OrderedDict()
        self.size = None

    def _open(self, idx):
        im = Image.open(self.paths[idx])
        im.load()
        if self.downscale and self.downscale > 0:
            w, h = im.size
            longest = max(w, h)
            if longest > self.downscale:
                scale = float(self.downscale) / float(longest)
                im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.BILINEAR)
        return im

    def rgb(self, idx):
        return self._open(idx).convert("RGB")

    def gray_of(self, idx):
        hit = self.gray.get(idx)
        if hit is not None:
            self.gray.move_to_end(idx)
            return hit
        im = self._open(idx).convert("L")
        if self.size is None:
            self.size = im.size
        self.gray[idx] = im
        self.gray.move_to_end(idx)
        while len(self.gray) > self.limit:
            self.gray.popitem(last=False)
        return im

    def frame_size(self):
        if self.size is None and self.paths:
            self.gray_of(sorted(self.paths.keys())[0])
        return self.size


def region_mean(diff_img, box):
    if box_area(box) <= 0:
        return None
    return ImageStat.Stat(diff_img.crop(box)).mean[0] / 255.0


def ring_mean(diff_img, box, w, h, dilate):
    outer = clamp_box((box[0] - dilate, box[1] - dilate, box[2] + dilate, box[3] + dilate), w, h)
    inner = clamp_box(box, w, h)
    ring_area = box_area(outer) - box_area(inner)
    if ring_area < RING_MIN_PX:
        return None
    s_out = ImageStat.Stat(diff_img.crop(outer)).sum[0]
    s_in = ImageStat.Stat(diff_img.crop(inner)).sum[0] if box_area(inner) > 0 else 0.0
    return ((s_out - s_in) / float(ring_area)) / 255.0


def otsu_split(hist):
    total = float(sum(hist))
    if total <= 0:
        return None
    sum_all = 0.0
    for i, c in enumerate(hist):
        sum_all += i * c
    sum_b = 0.0
    w_b = 0.0
    best_var = -1.0
    best_t = 0
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        m_b = sum_b / w_b
        m_f = (sum_all - sum_b) / w_f
        var = w_b * w_f * (m_b - m_f) * (m_b - m_f)
        if var > best_var:
            best_var = var
            best_t = t
    w_lo = float(sum(hist[: best_t + 1]))
    w_hi = total - w_lo
    if w_lo == 0 or w_hi == 0:
        return None
    mu_lo = sum(i * hist[i] for i in range(best_t + 1)) / w_lo
    mu_hi = sum(i * hist[i] for i in range(best_t + 1, 256)) / w_hi
    conc = 0.0
    for i, c in enumerate(hist):
        if abs(i - mu_lo) <= CHECKER_MODE_TOL or abs(i - mu_hi) <= CHECKER_MODE_TOL:
            conc += c
    return {
        "mu_lo": mu_lo,
        "mu_hi": mu_hi,
        "w_lo": w_lo / total,
        "w_hi": w_hi / total,
        "sep": (mu_hi - mu_lo) / 255.0,
        "conc": conc / total,
    }


def classify_from(detail, ref_edge=None):
    if not detail:
        return "OTHER"
    if detail.get("magenta_frac", 0.0) >= MAGENTA_FRAC_MIN:
        return "MAGENTA"
    achromatic = detail.get("sat_mean") is not None and detail["sat_mean"] <= CHECKER_SAT_MAX
    bimodal = (
        detail.get("sep") is not None
        and detail["sep"] >= CHECKER_MODE_SEP
        and detail.get("w_min") is not None
        and detail["w_min"] >= CHECKER_MODE_MIN_FRAC
        and detail.get("conc") is not None
        and detail["conc"] >= CHECKER_CONC_MIN
    )
    edge = detail.get("edge", 0.0)
    if achromatic and edge >= CHECKER_EDGE_MIN and bimodal:
        return "CHECKER"
    if (
        achromatic
        and ref_edge
        and ref_edge > 0.0
        and edge >= CHECKER_EDGE_FLOOR
        and (edge / ref_edge) >= CHECKER_EDGE_GAIN
    ):
        return "CHECKER"
    return "OTHER"


def patch_stats(rgb_patch):
    w, h = rgb_patch.size
    if w < 2 or h < 2:
        return {}
    r, g, b = rgb_patch.split()
    min_rb = ImageChops.darker(r, b)
    max_rb = ImageChops.lighter(r, b)
    hi = min_rb.point(lambda v: 255 if v > MAGENTA_MIN_RB else 0)
    g_gate = min_rb.point(lambda v: int(v * MAGENTA_G_RATIO))
    g_low = ImageChops.subtract(g_gate, g).point(lambda v: 255 if v > 0 else 0)
    rb_gate = max_rb.point(lambda v: int(v * MAGENTA_RB_RATIO))
    rb_close = ImageChops.subtract(rb_gate, ImageChops.difference(r, b)).point(
        lambda v: 255 if v > 0 else 0
    )
    mask = ImageChops.multiply(ImageChops.multiply(hi, g_low), rb_close)
    magenta_frac = ImageStat.Stat(mask).mean[0] / 255.0

    mx = ImageChops.lighter(max_rb, g)
    mn = ImageChops.darker(min_rb, g)
    sat_mean = ImageStat.Stat(ImageChops.subtract(mx, mn)).mean[0] / 255.0

    gr = rgb_patch.convert("L")
    eh = ImageStat.Stat(
        ImageChops.difference(gr.crop((0, 0, w - 1, h)), gr.crop((1, 0, w, h)))
    ).mean[0] / 255.0
    ev = ImageStat.Stat(
        ImageChops.difference(gr.crop((0, 0, w, h - 1)), gr.crop((0, 1, w, h)))
    ).mean[0] / 255.0
    edge = eh + ev

    modes = otsu_split(gr.histogram())
    return {
        "magenta_frac": magenta_frac,
        "sat_mean": sat_mean,
        "edge": edge,
        "sep": modes["sep"] if modes else None,
        "w_min": min(modes["w_lo"], modes["w_hi"]) if modes else None,
        "conc": modes["conc"] if modes else None,
    }


def classify_patch(rgb_patch, ref_edge=None):
    detail = patch_stats(rgb_patch)
    return classify_from(detail, ref_edge), detail


def selftest():
    from PIL import ImageDraw

    def solid(rgb, size=(200, 160)):
        return Image.new("RGB", size, rgb)

    def checker(cell, size=(200, 160)):
        im = Image.new("RGB", size, (105, 105, 105))
        d = ImageDraw.Draw(im)
        for y in range(0, size[1], cell):
            for x in range(0, size[0], cell):
                if ((x // cell) + (y // cell)) % 2 == 0:
                    d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(235, 235, 235))
        return im

    def gradient(size=(200, 160)):
        im = Image.new("RGB", size)
        d = ImageDraw.Draw(im)
        for y in range(size[1]):
            v = int(40 + 120 * y / float(size[1]))
            d.line([(0, y), (size[0], y)], fill=(v, int(v * 0.9), int(v * 0.8)))
        return im

    half = Image.new("RGB", (200, 160), (128, 128, 128))
    ImageDraw.Draw(half).rectangle([0, 0, 99, 159], fill=(242, 0, 200))

    cases = [
        ("MAGENTA solid (242,0,200)", solid((242, 0, 200)), "MAGENTA"),
        ("MAGENTA lit/darkened (120,8,100)", solid((120, 8, 100)), "MAGENTA"),
        ("MAGENTA half-fill on grey", half, "MAGENTA"),
        ("CHECKER cell=8 grey/white", checker(8), "CHECKER"),
        ("CHECKER cell=16 grey/white", checker(16), "CHECKER"),
        ("CHECKER cell=32 grey/white", checker(32), "CHECKER"),
        ("negative flat grey", solid((128, 128, 128)), "OTHER"),
        ("negative warm gradient", gradient(), "OTHER"),
        ("negative solid blue", solid((40, 60, 200)), "OTHER"),
        ("negative solid red", solid((200, 40, 40)), "OTHER"),
    ]
    print("SELFTEST  classifier sanity on synthetic patches (informational classifier only)")
    print("-" * 100)
    ok = True
    for name, patch, expect in cases:
        kind, d = classify_patch(patch)
        good = kind == expect
        ok = ok and good
        print(
            "  %-36s -> %-8s expect %-8s %s   mag=%.3f sat=%.3f edge=%.4f"
            % (name, kind, expect, "PASS" if good else "**FAIL**",
               d.get("magenta_frac", -1.0), d.get("sat_mean", -1.0), d.get("edge", -1.0))
        )
    print("-" * 100)
    print("SELFTEST: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 3


def find_sessions(root, max_depth=6):
    root = os.path.abspath(root)
    if os.path.isfile(os.path.join(root, "annotation.json")):
        return [root]
    if not os.path.isdir(root):
        return []
    base = root.rstrip(os.sep).count(os.sep)
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        if dirpath.rstrip(os.sep).count(os.sep) - base > max_depth:
            dirnames[:] = []
            continue
        if "annotation.json" in filenames:
            found.append(dirpath)
            dirnames[:] = []
    return sorted(found)


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            return json.load(fh)
    except Exception:
        return None


def read_labels(path):
    rows = {}
    if not os.path.isfile(path):
        return rows, "absent"
    bad = 0
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    bad += 1
                    continue
                si = obj.get("session_index")
                if si is None:
                    bad += 1
                    continue
                rows[int(si)] = obj
    except Exception:
        return rows, "unreadable"
    return rows, ("present" if bad == 0 else "present(%d unparsable line(s))" % bad)


def detect_schema(ann, labels_state, labels_rows, run_summary):
    events = (ann or {}).get("anomalies") or []
    has_manifested = any("manifested" in (e or {}) for e in events)
    has_indices = any(((e or {}).get("affected_frames") or {}).get("frame_indices") for e in events)
    has_mask = any("mask" in (e or {}) for e in events)
    span_count = False
    for e in events:
        af = (e or {}).get("affected_frames") or {}
        idx = af.get("frame_indices")
        cnt = af.get("frame_count")
        if isinstance(idx, list) and idx and isinstance(cnt, (int, float)):
            if int(cnt) != len(idx):
                span_count = True
    bbox_px = False
    bbox_norm = False
    for si in sorted(labels_rows.keys()):
        for a in labels_rows[si].get("anomalies") or []:
            if isinstance(a, dict) and isinstance(a.get("bbox_px"), list):
                bbox_px = True
            if isinstance(a, dict) and isinstance(a.get("bbox_norm"), list):
                bbox_norm = True
    rs = run_summary or {}
    if has_manifested and has_mask:
        era = "m26+"
    elif has_manifested:
        era = "m23+"
    elif has_indices:
        era = "m22-era (pre-m23: no 'manifested')"
    else:
        era = "unknown/older"
    return {
        "era": era,
        "manifested": has_manifested,
        "frame_indices": has_indices,
        "mask": has_mask,
        "frame_count_is_span": span_count,
        "labels": labels_state,
        "bbox_px": bbox_px,
        "bbox_norm": bbox_norm,
        "capture_path": rs.get("capture_path"),
        "delivery_mode": rs.get("delivery_mode"),
        "wanted_matches": rs.get("wanted_matches"),
        "total_frames": rs.get("total_frames"),
        "speed_ratio": rs.get("speed_ratio"),
    }


def log_line_time(line):
    m = LOG_TS_RE.match(line)
    if not m:
        return None
    try:
        return datetime.datetime(
            int(m.group(1)), int(m.group(2)), int(m.group(3)),
            int(m.group(4)), int(m.group(5)), int(m.group(6)),
            int(m.group(7)) * 1000,
        )
    except ValueError:
        return None


def run_start_time(sess):
    s = (sess.run or {}).get("start_time_utc")
    if not isinstance(s, str):
        return None
    txt = s.strip().rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.datetime.strptime(txt, fmt)
        except ValueError:
            continue
    return None


def parse_log(path):
    segments = []
    cur = None
    n_pair_drop = 0
    pubs = 0
    arms = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if "CAP-PAIR-DROP" in line:
                    n_pair_drop += 1
                    continue
                if "SVE-WANT-SUMMARY" in line:
                    m = SUM_RE.search(line)
                    if m and cur is not None:
                        cur["summary"] = {
                            "marksIssued": int(m.group(1)),
                            "publishesSeen": int(m.group(2)),
                            "wantedMatches": int(m.group(3)),
                            "submitsIssued": int(m.group(4)),
                            "framesWritten": int(m.group(5)),
                            "pendingWantedAtEnd": int(m.group(6)),
                            "maxPendingDepth": int(m.group(7)),
                        }
                    continue
                if "SVE-WANT-TRACE" not in line:
                    continue
                m = ARM_RE.search(line)
                if m:
                    ti = int(m.group(1))
                    if ti == 1 or cur is None:
                        cur = {"arms": [], "pubs": [], "summary": None, "t0": log_line_time(line)}
                        segments.append(cur)
                        pubs = 0
                        arms = 0
                    arms += 1
                    cur["arms"].append(
                        {
                            "request_id": int(m.group(3)),
                            "game_frame": int(m.group(4)),
                            "pending_after": int(m.group(5)),
                            "arm_ord": arms,
                            "pubs_before": pubs,
                        }
                    )
                    continue
                m = PUB_RE.search(line)
                if m:
                    if cur is None:
                        cur = {"arms": [], "pubs": [], "summary": None}
                        segments.append(cur)
                        pubs = 0
                        arms = 0
                    pubs += 1
                    cur["pubs"].append(
                        {
                            "family_frame": int(m.group(3)),
                            "wanted": int(m.group(4)),
                            "request_id": int(m.group(5)),
                            "pending_before": int(m.group(6)),
                            "pub_ord": pubs,
                            "arms_before": arms,
                        }
                    )
    except Exception as exc:
        return {"error": str(exc), "segments": [], "pair_drops": 0, "path": path}

    for seg in segments:
        arm_by_id = {}
        for a in seg["arms"]:
            arm_by_id.setdefault(a["request_id"], a)
        gaps = []
        for p in seg["pubs"]:
            if p["wanted"] != 1:
                continue
            a = arm_by_id.get(p["request_id"])
            if a is None:
                continue
            gaps.append(
                {
                    "request_id": p["request_id"],
                    "game_frame": a["game_frame"],
                    "gap_publishes": p["pub_ord"] - a["pubs_before"],
                    "gap_arms": p["arms_before"] - a["arm_ord"],
                    "pending_before": p["pending_before"],
                }
            )
        seg["gaps"] = sorted(gaps, key=lambda g: g["request_id"])
        seg["min_request_id"] = min([a["request_id"] for a in seg["arms"]] or [0]) if seg["arms"] else None
    return {"error": None, "segments": segments, "pair_drops": n_pair_drop, "path": path}


def autodetect_log(session_dir):
    cands = []
    parent = os.path.dirname(session_dir.rstrip(os.sep))
    for d in (session_dir, parent, os.path.join(parent, "Logs"), os.path.join(session_dir, "Logs")):
        if not os.path.isdir(d):
            continue
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        for n in names:
            if n.lower().endswith(".log"):
                cands.append(os.path.join(d, n))
    out = []
    for c in cands:
        if c not in out:
            out.append(c)
    return out


def pick_segment(loginfo, total_frames, run_start):
    segs = loginfo.get("segments") or []
    if not segs:
        return None, "log parsed, no SVE-WANT-TRACE lines present"
    if run_start is not None:
        timed = [
            s
            for s in segs
            if s.get("t0") is not None
            and abs((s["t0"] - run_start).total_seconds()) <= LOG_TIME_TOLERANCE_S
        ]
        if len(timed) == 1:
            return timed[0], "attributed by run start time (log t0 within %ds of run.json start_time_utc)" % (
                LOG_TIME_TOLERANCE_S,
            )
        if not timed and any(s.get("t0") is not None for s in segs):
            return None, (
                "*** LOG DOES NOT BELONG TO THIS SESSION: no traced run within %ds of run.json "
                "start_time_utc - join SKIPPED ***" % LOG_TIME_TOLERANCE_S
            )
    if len(segs) == 1:
        return segs[0], "single capture run in log (run start time not checkable)"
    matches = [
        s
        for s in segs
        if s.get("summary")
        and total_frames is not None
        and s["summary"]["framesWritten"] == total_frames
    ]
    if len(matches) == 1:
        return matches[0], "%d runs in log; attributed by framesWritten==%s" % (len(segs), total_frames)
    return None, "%d runs in log; cannot attribute to this session - per-event join SKIPPED" % len(segs)


class Session(object):
    def __init__(self, path, label):
        self.path = os.path.abspath(path)
        self.label = label or os.path.basename(self.path)
        self.ann = read_json(os.path.join(self.path, "annotation.json")) or {}
        self.run = read_json(os.path.join(self.path, "run.json")) or {}
        self.summary = read_json(os.path.join(self.path, "run_summary.json")) or {}
        self.labels, labels_state = read_labels(os.path.join(self.path, "labels.jsonl"))
        self.schema = detect_schema(self.ann, labels_state, self.labels, self.summary)
        video = self.ann.get("video") or {}
        self.session_id = self.ann.get("session_id") or os.path.basename(self.path)
        self.frames_dir = os.path.join(self.path, video.get("frames_dir") or "Actual_Frames")
        self.frame_paths = {}
        if os.path.isdir(self.frames_dir):
            for name in sorted(os.listdir(self.frames_dir)):
                m = FRAME_RE.match(name)
                if m:
                    self.frame_paths[int(m.group(1))] = os.path.join(self.frames_dir, name)
        self.total_frames = video.get("total_frames")
        self.events = self.ann.get("anomalies") or []

    def png_indices(self):
        return sorted(self.frame_paths.keys())


def event_indices(ev):
    af = (ev or {}).get("affected_frames") or {}
    idx = af.get("frame_indices")
    if isinstance(idx, list) and idx:
        return sorted(set(int(v) for v in idx if isinstance(v, (int, float)))), False
    s = af.get("start_frame")
    e = af.get("end_frame")
    if s is None or e is None:
        return [], True
    return list(range(int(s), int(e) + 1)), True


def event_node_name(ev):
    ao = (ev or {}).get("affected_objects") or {}
    nodes = ao.get("nodes") or []
    if isinstance(nodes, list) and nodes:
        pi = ao.get("primary_index") or 0
        try:
            n = nodes[int(pi)]
        except Exception:
            n = nodes[0]
        if isinstance(n, dict):
            return n.get("name") or ""
    return ""


def bbox_from_label_entry(entry, w, h):
    px = entry.get("bbox_px")
    if isinstance(px, list) and len(px) == 4:
        try:
            x, y, bw, bh = [float(v) for v in px]
            if bw > 0 and bh > 0:
                return (x, y, x + bw, y + bh), "labels_bbox_px"
        except Exception:
            pass
    nm = entry.get("bbox_norm")
    if isinstance(nm, list) and len(nm) == 4:
        try:
            x0, y0, x1, y1 = [float(v) for v in nm]
            return (x0 * w, y0 * h, x1 * w, y1 * h), "labels_bbox_norm"
        except Exception:
            pass
    return None, None


def match_label_entry(row, node_name, start_frame):
    entries = [a for a in (row.get("anomalies") or []) if isinstance(a, dict)]
    best = None
    best_score = 0
    for a in entries:
        score = 0
        tn = a.get("target_name") or ""
        if node_name and tn and tn == node_name:
            score += 2
        sf = a.get("start_frame")
        if sf is not None and start_frame is not None:
            try:
                if abs(int(sf) - int(start_frame)) <= 2:
                    score += 1
            except Exception:
                pass
        if score == 0 and len(entries) == 1:
            score = 1
        if score > best_score:
            best_score = score
            best = a
    return best if best_score > 0 else None


def collect_region(sess, ev, indices, frame_w, frame_h):
    node = event_node_name(ev)
    start_frame = ((ev or {}).get("affected_frames") or {}).get("start_frame")
    per_frame = {}
    source = None
    for f in indices:
        row = sess.labels.get(f)
        if not row:
            continue
        w = row.get("width") or frame_w
        h = row.get("height") or frame_h
        entry = match_label_entry(row, node, start_frame)
        if entry is None or entry.get("bbox_valid") is False:
            continue
        box, src = bbox_from_label_entry(entry, float(w), float(h))
        if box is None:
            continue
        if w and h and frame_w and frame_h and (int(w) != int(frame_w) or int(h) != int(frame_h)):
            sx = float(frame_w) / float(w)
            sy = float(frame_h) / float(h)
            box = (box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy)
            src = src + "+rescaled"
        per_frame[f] = clamp_box(box, frame_w, frame_h)
        if source is None:
            source = src
    if not per_frame:
        return {}, None, None, 0.0
    counts = {}
    for f in sorted(per_frame.keys()):
        counts[per_frame[f]] = counts.get(per_frame[f], 0) + 1
    modal = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    jitter = 0.0
    for f in sorted(per_frame.keys()):
        b = per_frame[f]
        jitter = max(jitter, max(abs(b[i] - modal[i]) for i in range(4)))
    if box_area(modal) >= RING_MAX_REGION_FRAC * frame_w * frame_h:
        source = (source or "labels") + "(fullframe-sized)"
    return per_frame, modal, source or "labels", jitter


def eligible_baseline_frames(sess, png_idx):
    n_png = max(1, len(png_idx))
    spanning = 0
    for guard in range(BASELINE_GUARD, -1, -1):
        blocked = set()
        spanning = 0
        for ev in sess.events:
            idxs, _ = event_indices(ev)
            if not idxs:
                continue
            if (max(idxs) - min(idxs) + 1) >= SESSION_SPAN_FRAC * n_png:
                spanning += 1
                continue
            for f in range(min(idxs) - guard, max(idxs) + guard + 1):
                blocked.add(f)
        out = [f for f in png_idx if f not in blocked]
        if len(out) >= BASELINE_MIN or guard == 0:
            return out, guard, spanning
    return [], 0, spanning


def choose_baseline(eligible, a_lo, a_hi):
    def dist(f):
        return (a_lo - f) if f < a_lo else (f - a_hi)

    ranked = sorted(eligible, key=lambda f: (dist(f), 0 if f < a_lo else 1, f))
    picked = ranked[:BASELINE_N]
    if not picked:
        return [], "none"
    if all(f < a_lo for f in picked):
        tag = "before"
    elif all(f > a_hi for f in picked):
        tag = "after"
    else:
        tag = "straddle"
    return sorted(picked), "%s,nearest%d,maxdist%d" % (tag, len(picked), max(dist(f) for f in picked))


def attribution_span(sess, ev_i, indices, png_idx):
    spans = []
    for j, other in enumerate(sess.events):
        o_idx, _ = event_indices(other)
        if o_idx:
            spans.append((j, min(o_idx), max(o_idx)))
    lo = max(0, min(indices) - NEIGHBOURHOOD_PAD)
    hi = max(indices) + NEIGHBOURHOOD_PAD
    for j, o_lo, o_hi in spans:
        if j == ev_i:
            continue
        if o_hi < min(indices):
            lo = max(lo, int((o_hi + min(indices)) // 2) + 1)
        elif o_lo > max(indices):
            hi = min(hi, int((max(indices) + o_lo) // 2))
    if png_idx:
        hi = min(hi, max(png_idx))
        lo = max(lo, min(png_idx))
    return lo, hi


def new_row(sess, ev_i, ev, indices, derived):
    return {
        "session_label": sess.label,
        "session_id": sess.session_id,
        "session_dir": sess.path,
        "event_id": "E%02d" % (ev_i + 1),
        "anomaly_type": (ev or {}).get("anomaly_type") or "unknown",
        "anomaly_subtype": (ev or {}).get("anomaly_subtype") or "",
        "target": event_node_name(ev),
        "path": "",
        "annotated_set": compress_indices(indices),
        "annotated_start": min(indices) if indices else None,
        "annotated_end": max(indices) if indices else None,
        "n_annotated": len(indices),
        "annotated_gapped": bool(indices) and (len(indices) != (max(indices) - min(indices) + 1)),
        "indices_derived_from_range": derived,
        "manifested_flag": (ev or {}).get("manifested"),
        "measured_set": "",
        "measured_start": None,
        "measured_end": None,
        "start_delta": None,
        "end_delta": None,
        "best_shift": None,
        "shift_ties": "",
        "agreement_best": None,
        "agreement_0": None,
        "agreement_best_raw": None,
        "agreement_0_raw": None,
        "coverage": None,
        "peak_net": None,
        "peak_net_annotated": None,
        "median_net_annotated": None,
        "ambient_median": None,
        "threshold": None,
        "contrast": None,
        "baseline_n": 0,
        "baseline_frames": "",
        "baseline_side": "",
        "baseline_contaminated": 0,
        "baseline_mu": None,
        "baseline_sd": None,
        "ambient_mode": "",
        "region_source": "",
        "region_box": "",
        "bbox_jitter_px": None,
        "n_evaluated_frames": 0,
        "n_unmeasurable_frames": 0,
        "missing_pngs": "",
        "status": "OK",
        "confidence": "LOW",
        "classification": "",
        "magenta_frames": 0,
        "checker_frames": 0,
        "other_frames": 0,
        "publish_gap": None,
        "arm_gap": None,
        "request_id": None,
    }


def measure_event(sess, cache, ev_i, ev, eligible, png_idx, frame_w, frame_h, region_mode, series):
    indices, derived = event_indices(ev)
    row = new_row(sess, ev_i, ev, indices, derived)
    ev_type = row["anomaly_type"].lower()

    if not indices:
        row["status"] = "UNMEASURABLE:no-annotated-frames"
        return row

    row["missing_pngs"] = compress_indices([f for f in indices if f not in sess.frame_paths])

    if png_idx and (max(indices) - min(indices) + 1) >= SESSION_SPAN_FRAC * len(png_idx):
        row["path"] = "set" if ev_type in HIDE_TYPES or row["annotated_gapped"] else "contiguous"
        row["status"] = "UNMEASURABLE:session-spanning-no-negative-reference(%d of %d frames)" % (
            max(indices) - min(indices) + 1,
            len(png_idx),
        )
        return row

    present = [f for f in indices if f in sess.frame_paths]
    per_frame_box, modal_box, region_source, jitter = collect_region(
        sess, ev, present, frame_w, frame_h
    )
    if modal_box is None:
        modal_box = (0, 0, frame_w, frame_h)
        region_source = (
            "fullframe_no_labels" if sess.schema["labels"] == "absent" else "fullframe_no_valid_bbox"
        )
    row["region_source"] = region_source
    row["region_box"] = "%d,%d,%d,%d" % modal_box
    row["bbox_jitter_px"] = jitter

    if box_area(modal_box) < MIN_REGION_PX:
        row["status"] = "UNMEASURABLE:region-degenerate"
        return row

    lo, hi = attribution_span(sess, ev_i, indices, png_idx)
    core = [f for f in range(lo, hi + 1) if f in sess.frame_paths]
    ext_lo = max(0, lo - SHIFT_RANGE)
    ext_hi = hi + SHIFT_RANGE
    if png_idx:
        ext_hi = min(ext_hi, max(png_idx))
    ext = [f for f in range(ext_lo, ext_hi + 1) if f in sess.frame_paths]

    a_lo = min(indices)
    a_hi = max(indices)
    base, base_side = choose_baseline(eligible, a_lo, a_hi)
    base = [f for f in base if f in sess.frame_paths]
    row["baseline_n"] = len(base)
    row["baseline_frames"] = compress_indices(base)
    row["baseline_side"] = base_side
    if len(base) < BASELINE_MIN:
        row["status"] = "UNMEASURABLE:baseline-too-small(%d<%d)" % (len(base), BASELINE_MIN)
        return row

    use_ring = (
        not region_source.startswith("fullframe")
        and "(fullframe-sized)" not in region_source
        and box_area(modal_box) < RING_MAX_REGION_FRAC * frame_w * frame_h
    )

    def measure_frame(f):
        box = modal_box
        if region_mode != "modal" and f in per_frame_box:
            box = per_frame_box[f]
        gf = cache.gray_of(f)
        cands = []
        for b in base:
            if b == f:
                continue
            d = ImageChops.difference(gf, cache.gray_of(b))
            raw = region_mean(d, box)
            if raw is None:
                continue
            amb = ring_mean(d, box, frame_w, frame_h, RING_DILATE_PX) if use_ring else None
            cands.append({"raw": raw, "ambient": amb, "net": (raw - amb) if amb is not None else raw, "ref": b})
        if not cands:
            return None
        ambients = [c["ambient"] for c in cands if c["ambient"] is not None]
        amb_min = min(ambients) if ambients else None
        keep = cands
        if amb_min is not None:
            cap = max(amb_min * AMBIENT_REF_FACTOR, amb_min + AMBIENT_REF_FLOOR)
            keep = [c for c in cands if c["ambient"] is not None and c["ambient"] <= cap]
            if len(keep) < NET_QUANTILE_INDEX + 1:
                keep = sorted(cands, key=lambda c: (c["ambient"] if c["ambient"] is not None else 0.0, c["ref"]))
                keep = keep[: NET_QUANTILE_INDEX + 1]
        ordered = sorted(keep, key=lambda c: (c["net"], c["ref"]))
        best = dict(ordered[min(NET_QUANTILE_INDEX, len(ordered) - 1)])
        best["ambient_min"] = amb_min
        best["n_refs"] = len(keep)
        return best

    base_vals = []
    for b in base:
        mv = measure_frame(b)
        if mv is not None:
            base_vals.append(mv["net"])
    if len(base_vals) < 2:
        row["status"] = "UNMEASURABLE:baseline-noise-samples(%d<2)" % len(base_vals)
        return row
    center = statistics.median(base_vals)
    scale = 1.4826 * statistics.median([abs(v - center) for v in base_vals])
    thr = center + K_SIGMA * scale + SIGNAL_FLOOR
    row["baseline_mu"] = center
    row["baseline_sd"] = scale
    row["threshold"] = thr
    n_contaminated = sum(1 for v in base_vals if v > thr)
    row["baseline_contaminated"] = n_contaminated
    row["ambient_mode"] = ("ring(%dpx)" % RING_DILATE_PX) if use_ring else "none"

    ann_set = set(indices)
    meas = {}
    for f in ext:
        mv = measure_frame(f)
        if mv is None:
            continue
        amb_ref = mv.get("ambient_min")
        unmeas = amb_ref is not None and amb_ref > AMBIENT_FACTOR * thr
        mv["unmeasurable"] = unmeas
        mv["manifested"] = (not unmeas) and (mv["net"] > thr)
        meas[f] = mv
        if series is not None:
            series.append(
                {
                    "session_label": sess.label,
                    "session_id": sess.session_id,
                    "event_id": row["event_id"],
                    "anomaly_type": row["anomaly_type"],
                    "frame": f,
                    "raw": "%.6f" % mv["raw"],
                    "ambient": ("%.6f" % mv["ambient"]) if mv["ambient"] is not None else "",
                    "net": "%.6f" % mv["net"],
                    "threshold": "%.6f" % thr,
                    "annotated": 1 if f in ann_set else 0,
                    "measured": 1 if mv["manifested"] else 0,
                    "unmeasurable": 1 if unmeas else 0,
                }
            )

    evaluated = [f for f in core if f in meas]
    row["n_evaluated_frames"] = len(evaluated)
    n_unmeas = sum(1 for f in evaluated if meas[f]["unmeasurable"])
    row["n_unmeasurable_frames"] = n_unmeas
    if not evaluated:
        row["status"] = "UNMEASURABLE:no-frames-readable"
        return row
    if (len(evaluated) - n_unmeas) < MIN_MEASURABLE_FRAC * len(evaluated):
        row["status"] = "UNMEASURABLE:ambient-too-high(%d/%d frames)" % (n_unmeas, len(evaluated))
        return row
    n_ann_unmeas = sum(1 for f in indices if f in meas and meas[f]["unmeasurable"])
    if n_ann_unmeas == len([f for f in indices if f in meas]):
        row["status"] = "UNMEASURABLE:every-annotated-frame-ambient-too-high(%d)" % n_ann_unmeas
        return row

    ann_ok = [f for f in indices if f in meas and not meas[f]["unmeasurable"]]
    if ann_ok:
        row["coverage"] = sum(1 for f in ann_ok if meas[f]["manifested"]) / float(len(ann_ok))
        row["peak_net_annotated"] = max(meas[f]["net"] for f in ann_ok)
        row["median_net_annotated"] = statistics.median([meas[f]["net"] for f in ann_ok])
    evaluated_ok = [f for f in evaluated if not meas[f]["unmeasurable"]]
    row["peak_net"] = max((meas[f]["net"] for f in evaluated_ok), default=None)
    row["ambient_median"] = median_or_none(
        [meas[f].get("ambient_min") for f in evaluated if meas[f].get("ambient_min") is not None]
    )
    row["contrast"] = (row["peak_net"] / thr) if (row["peak_net"] is not None and thr > 0) else None

    best = None
    ties = []
    agree0 = None
    agree0_raw = None
    for s in range(-SHIFT_RANGE, SHIFT_RANGE + 1):
        usable = [f for f in core if (f + s) in meas and not meas[f + s]["unmeasurable"]]
        if len(usable) < MIN_AGREE_FRAMES:
            continue
        tp = fn = fp = tn = 0
        for f in usable:
            a = f in ann_set
            m = meas[f + s]["manifested"]
            if a and m:
                tp += 1
            elif a and not m:
                fn += 1
            elif (not a) and m:
                fp += 1
            else:
                tn += 1
        raw_acc = (tp + tn) / float(len(usable))
        if (tp + fn) and (tn + fp):
            bal = 0.5 * (tp / float(tp + fn) + tn / float(tn + fp))
        else:
            bal = raw_acc
        if s == 0:
            agree0 = bal
            agree0_raw = raw_acc
        if best is None or bal > best[0] + 1e-12:
            best = (bal, raw_acc, s)
            ties = [s]
        elif abs(bal - best[0]) <= 1e-12:
            ties.append(s)
            if abs(s) < abs(best[2]):
                best = (bal, raw_acc, s)

    if best is not None:
        row["best_shift"] = best[2]
        row["agreement_best"] = best[0]
        row["agreement_best_raw"] = best[1]
        row["agreement_0"] = agree0
        row["agreement_0_raw"] = agree0_raw
        if len(ties) > 1:
            row["shift_ties"] = ",".join(str(t) for t in sorted(ties))

    manifested = sorted(
        f
        for f in core
        if f in meas and meas[f]["manifested"] and not meas[f]["unmeasurable"]
    )
    row["measured_set"] = compress_indices(manifested)

    a0 = min(indices)
    a1 = max(indices)
    is_hide = ev_type in HIDE_TYPES
    row["path"] = "set" if (is_hide or row["annotated_gapped"]) else "contiguous"

    need = min(MIN_MANIFEST_FRAMES, len(indices))
    if len(manifested) < need:
        row["status"] = "UNMEASURABLE:no-manifestation-above-noise(peak/T=%s,n=%d)" % (
            f2(row["contrast"]),
            len(manifested),
        )

    if row["path"] == "set":
        if manifested:
            row["measured_start"] = min(manifested)
            row["measured_end"] = max(manifested)
            row["start_delta"] = min(manifested) - a0
            row["end_delta"] = max(manifested) - a1
        if best is None and row["status"] == "OK":
            row["status"] = "UNMEASURABLE:too-few-comparable-frames"
    else:
        runs = []
        for f in manifested:
            if runs and f - runs[-1][1] <= (GAP_BRIDGE + 1):
                runs[-1][1] = f
            else:
                runs.append([f, f])

        def overlap(r):
            return max(0, min(r[1], a1) - max(r[0], a0) + 1)

        chosen = None
        if runs:
            top = sorted(
                runs, key=lambda r: (-overlap(r), abs((r[0] + r[1]) / 2.0 - (a0 + a1) / 2.0), r[0])
            )[0]
            if overlap(top) > 0:
                chosen = top
            else:
                near = sorted(
                    runs, key=lambda r: (abs((r[0] + r[1]) / 2.0 - (a0 + a1) / 2.0), r[0])
                )[0]
                if abs((near[0] + near[1]) / 2.0 - (a0 + a1) / 2.0) <= SHIFT_RANGE:
                    chosen = near
        if chosen is None:
            if row["status"] == "OK":
                row["status"] = "UNMEASURABLE:no-manifestation-near-window"
        else:
            row["measured_start"] = chosen[0]
            row["measured_end"] = chosen[1]
            row["start_delta"] = chosen[0] - a0
            row["end_delta"] = chosen[1] - a1

    if ev_type in TEXTURE_TYPES and row["status"] == "OK":
        targets = [f for f in ann_ok if meas[f]["manifested"]]
        if not targets and row["measured_start"] is not None:
            targets = [
                f
                for f in range(row["measured_start"], row["measured_end"] + 1)
                if f in sess.frame_paths
            ]
        ref_frame = sorted(base, key=lambda b: (min(abs(b - a0), abs(b - a1)), b))[0] if base else None
        ref_edge = None
        if ref_frame is not None:
            ref_edge = patch_stats(
                cache.rgb(ref_frame).crop(clamp_box(modal_box, frame_w, frame_h))
            ).get("edge")
        counts = {"MAGENTA": 0, "CHECKER": 0, "OTHER": 0}
        for f in targets:
            box = modal_box
            if region_mode != "modal" and f in per_frame_box:
                box = per_frame_box[f]
            detail = patch_stats(cache.rgb(f).crop(clamp_box(box, frame_w, frame_h)))
            counts[classify_from(detail, ref_edge)] += 1
        row["magenta_frames"] = counts["MAGENTA"]
        row["checker_frames"] = counts["CHECKER"]
        row["other_frames"] = counts["OTHER"]
        top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0]
        row["classification"] = top[0] if top[1] > 0 else ""

    conf = "LOW"
    contrast = row["contrast"]
    if row["status"] == "OK" and contrast is not None:
        if row["path"] == "set":
            ab = row["agreement_best"]
            if ab is not None:
                if ab >= AGREE_HIGH and contrast >= CONTRAST_HIGH and n_unmeas == 0:
                    conf = "HIGH"
                elif ab >= AGREE_MED and contrast >= CONTRAST_MED:
                    conf = "MED"
        else:
            cov = row["coverage"]
            if cov is not None:
                if cov >= COVERAGE_HIGH and contrast >= CONTRAST_HIGH and n_unmeas == 0:
                    conf = "HIGH"
                elif cov >= COVERAGE_MED and contrast >= CONTRAST_MED:
                    conf = "MED"
    if conf == "HIGH" and (not use_ring or (jitter and jitter > RING_DILATE_PX)):
        conf = "MED"
    if row["baseline_contaminated"]:
        conf = "LOW"
    row["confidence"] = conf
    return row


def join_log_gaps(sess, rows, segment, note):
    gaps = (segment or {}).get("gaps") or []
    if not gaps:
        return note + " | no arm/publish pairs recovered"
    frame_to_session = {}
    for si in sorted(sess.labels.keys()):
        fi = sess.labels[si].get("frame_index")
        if fi is not None:
            frame_to_session[int(fi)] = int(si)
    min_rid = segment.get("min_request_id")
    by_session = {}
    n_a = n_b = n_both = n_agree = 0
    for g in gaps:
        si_a = frame_to_session.get(g["game_frame"])
        si_b = (g["request_id"] - min_rid) if min_rid is not None else None
        if si_a is not None:
            n_a += 1
        if si_b is not None:
            n_b += 1
        if si_a is not None and si_b is not None:
            n_both += 1
            if si_a == si_b:
                n_agree += 1
        si = si_a if si_a is not None else si_b
        if si is not None:
            by_session[si] = g
    hits = 0
    for r in rows:
        s = r.get("annotated_start")
        if s is None:
            continue
        g = by_session.get(int(s))
        if g is None:
            continue
        hits += 1
        r["publish_gap"] = g["gap_publishes"]
        r["arm_gap"] = g["gap_arms"]
        r["request_id"] = g["request_id"]
    route = "A gameFrame->labels.frame_index (exact)" if n_a else "B requestId-min(requestId) (ordinal)"
    extra = " | route cross-check %d/%d agree" % (n_agree, n_both) if n_both else ""
    return note + " | join route %s | %d event(s) joined%s" % (route, hits, extra)


def summarise_gaps(segment):
    gaps = (segment or {}).get("gaps") or []
    if not gaps:
        return None
    gp = sorted(g["gap_publishes"] for g in gaps)
    ga = sorted(g["gap_arms"] for g in gaps)
    hist = {}
    for v in gp:
        hist[v] = hist.get(v, 0) + 1
    return {
        "n": len(gaps),
        "pub_min": gp[0],
        "pub_med": statistics.median(gp),
        "pub_max": gp[-1],
        "arm_min": ga[0],
        "arm_med": statistics.median(ga),
        "arm_max": ga[-1],
        "hist": " ".join("%d:%d" % (k, hist[k]) for k in sorted(hist)),
    }


def print_header(args, csv_path):
    print("=" * 108)
    print(VERSION + "   read-only  ::  deterministic (no wall-clock, no randomness in output)")
    print("-" * 108)
    print("INDEX CONVENTION: the PNG filename index IS the session index and it is 0-BASED.")
    print("    frame_00000.png == session index 0 == annotation frame_indices value 0.")
    print("    labels.jsonl session_index is that same number; labels.jsonl frame_index is GFrameCounter.")
    print("    A viewer numbering the first frame 1 will look +1 off. The viewer is wrong, not the data.")
    print("SIGN CONVENTION: offset = MANIFESTED - ANNOTATED, in frames.")
    print("    POSITIVE = pixels LAG the label (label stamped early). NEGATIVE = pixels lead the label.")
    print("    Hide/gapped events report BEST SHIFT; contiguous events report startD and endD.")
    print("AGREEMENT is BALANCED accuracy (mean of TPR over annotated frames and TNR over the rest).")
    print("    Plain accuracy is in the CSV as agreement_best_raw / agreement_0_raw.")
    print("-" * 108)
    print(
        "CONSTANTS  k=%.1f floor=%.4f ring=%dpx ring_min=%dpx ring_max_region_frac=%.2f ambient_factor=%.1f"
        % (K_SIGMA, SIGNAL_FLOOR, RING_DILATE_PX, RING_MIN_PX, RING_MAX_REGION_FRAC, AMBIENT_FACTOR)
    )
    print(
        "           baseline_n=%d baseline_min=%d baseline_guard=%d pad=%d "
        "shift=[%+d,%+d] min_agree=%d"
        % (
            BASELINE_N,
            BASELINE_MIN,
            BASELINE_GUARD,
            NEIGHBOURHOOD_PAD,
            -SHIFT_RANGE,
            SHIFT_RANGE,
            MIN_AGREE_FRAMES,
        )
    )
    print(
        "           min_measurable=%.2f gap_bridge=%d min_manifest=%d min_region=%dpx net_quantile_idx=%d "
        "span_frac=%.2f amb_ref_factor=%.1f region_mode=%s downscale=%s"
        % (
            MIN_MEASURABLE_FRAC,
            GAP_BRIDGE,
            MIN_MANIFEST_FRAMES,
            MIN_REGION_PX,
            NET_QUANTILE_INDEX,
            SESSION_SPAN_FRAC,
            AMBIENT_REF_FACTOR,
            args.region,
            args.downscale or "off",
        )
    )
    print(
        "           magenta: frac>=%.2f minRB>%d G<%.2f*minRB |R-B|<%.2f*maxRB   checker: sat<=%.3f "
        "edge>=%.3f sep>=%.3f wmin>=%.2f conc>=%.2f tol=%d"
        % (
            MAGENTA_FRAC_MIN,
            MAGENTA_MIN_RB,
            MAGENTA_G_RATIO,
            MAGENTA_RB_RATIO,
            CHECKER_SAT_MAX,
            CHECKER_EDGE_MIN,
            CHECKER_MODE_SEP,
            CHECKER_MODE_MIN_FRAC,
            CHECKER_CONC_MIN,
            CHECKER_MODE_TOL,
        )
    )
    print(
        "           confidence HIGH needs agree>=%.2f (or cov>=%.2f) AND peak/T>=%.1f AND 0 unmeasurable"
        % (AGREE_HIGH, COVERAGE_HIGH, CONTRAST_HIGH)
    )
    print("CSV -> %s" % csv_path)
    print("=" * 108)


def print_session_block(sess, rows, index_check, log_line, verbose):
    sc = sess.schema
    print("")
    print("SESSION  label=%s" % sess.label)
    print("   dir     %s" % sess.path)
    print(
        "   schema  %s | labels=%s bbox_px=%s bbox_norm=%s | manifested=%s frame_indices=%s mask=%s"
        % (
            sc["era"],
            sc["labels"],
            "yes" if sc["bbox_px"] else "no",
            "yes" if sc["bbox_norm"] else "no",
            "yes" if sc["manifested"] else "NO",
            "yes" if sc["frame_indices"] else "NO",
            "yes" if sc["mask"] else "no",
        )
    )
    print(
        "   run     capture_path=%s delivery_mode=%s speed_ratio=%s total_frames=%s wanted_matches=%s"
        % (
            sc["capture_path"] if sc["capture_path"] is not None else "-",
            sc["delivery_mode"] if sc["delivery_mode"] is not None else "-",
            ("%.5f" % sc["speed_ratio"]) if isinstance(sc["speed_ratio"], (int, float)) else "-",
            sc["total_frames"] if sc["total_frames"] is not None else "-",
            sc["wanted_matches"] if sc["wanted_matches"] is not None else "-",
        )
    )
    if sc["frame_count_is_span"]:
        print(
            "   NOTE    affected_frames.frame_count disagrees with len(frame_indices) - PRE-m22 SPAN"
        )
        print(
            "           semantics. frame_count is IGNORED here; frame_indices is authoritative."
        )
    for line in index_check:
        print("   " + line)
    print("   log     %s" % log_line)
    if verbose:
        for r in rows:
            print(
                "   ~ %s %-18s ann[%s] meas[%s] shift=%s startD=%s endD=%s cov=%s peak/T=%s amb=%s %s %s"
                % (
                    r["event_id"],
                    r["anomaly_type"],
                    r["annotated_set"],
                    r["measured_set"],
                    signed(r["best_shift"]),
                    signed(r["start_delta"]),
                    signed(r["end_delta"]),
                    f2(r["coverage"]),
                    f2(r["contrast"]),
                    f4(r["ambient_median"]),
                    r["confidence"],
                    r["status"],
                )
            )


TABLE_FMT = "   %-20s %3s %4s %4s  %-7s %5s %5s %5s  %5s  %-11s %-5s %s"


def print_type_table(rows):
    groups = {}
    for r in rows:
        groups.setdefault(r["anomaly_type"], []).append(r)
    header = TABLE_FMT % (
        "TYPE",
        "nEv",
        "meas",
        "unm",
        "METRIC",
        "min",
        "med",
        "max",
        "cov",
        "agree(b/0)",
        "conf",
        "notes",
    )
    print(header)
    print("   " + "-" * (len(header) - 3))
    for t in sorted(groups.keys()):
        rs = groups[t]
        ok = [r for r in rs if r["status"] == "OK"]
        unm = [r for r in rs if r["status"] != "OK"]
        cov = median_or_none([r["coverage"] for r in ok])
        ab = median_or_none([r["agreement_best"] for r in ok])
        a0 = median_or_none([r["agreement_0"] for r in ok])
        confs = [r["confidence"] for r in ok]
        if not ok:
            conf = "-"
        elif confs.count("LOW") == 0 and confs.count("MED") == 0:
            conf = "HIGH"
        elif confs.count("LOW") == 0:
            conf = "MED"
        else:
            conf = "LOW"
        if ok:
            conf = "%s %dH/%dM/%dL" % (conf, confs.count("HIGH"), confs.count("MED"), confs.count("LOW"))

        notes = []
        mag = sum(r["magenta_frames"] for r in rs)
        chk = sum(r["checker_frames"] for r in rs)
        oth = sum(r["other_frames"] for r in rs)
        if (mag + chk + oth) > 0:
            notes.append("MAG %d / CHK %d / OTH %d" % (mag, chk, oth))
        peaks = [r["contrast"] for r in ok if r["contrast"] is not None]
        if peaks:
            notes.append("peak/T med %.1f" % statistics.median(peaks))
        gaps = [r["publish_gap"] for r in rs if r["publish_gap"] is not None]
        if gaps:
            notes.append("pubgap med %.1f" % statistics.median(gaps))
        if any(r["region_source"].startswith("fullframe") for r in rs):
            notes.append("FULLFRAME region")
        if any(r["ambient_mode"] == "none" for r in ok):
            notes.append("no ambient ring")
        contam = sum(1 for r in rs if r["baseline_contaminated"])
        if contam:
            notes.append(
                "*** BASELINE CONTAMINATED on %d event(s) - a reference frame is itself manifesting; "
                "the true offset may exceed the clean gap between windows and be UNDER-READ ***" % contam
            )
        if unm:
            notes.append("unmeasurable: " + "; ".join(sorted(set(r["status"] for r in unm))))
        note = " | ".join(notes) if notes else "-"

        set_rows = [r for r in ok if r["path"] == "set"]
        con_rows = [r for r in ok if r["path"] == "contiguous"]
        lead_done = False

        def emit(metric, vals, lead):
            print(
                TABLE_FMT
                % (
                    t if lead else "",
                    str(len(rs)) if lead else "",
                    str(len(ok)) if lead else "",
                    str(len(unm)) if lead else "",
                    metric,
                    signed(min(vals)) if vals else "-",
                    signed(int(statistics.median(vals))) if vals else "-",
                    signed(max(vals)) if vals else "-",
                    f2(cov) if lead else "",
                    ("%s/%s" % (f2(ab), f2(a0))) if lead else "",
                    conf if lead else "",
                    note if lead else "",
                )
            )

        if set_rows:
            emit("shift", [r["best_shift"] for r in set_rows if r["best_shift"] is not None], True)
            lead_done = True
        if con_rows:
            emit("startD", [r["start_delta"] for r in con_rows if r["start_delta"] is not None], not lead_done)
            lead_done = True
            emit("endD", [r["end_delta"] for r in con_rows if r["end_delta"] is not None], False)
        if not lead_done:
            emit("-", [], True)


CSV_FIELDS = [
    "session_label",
    "session_id",
    "session_dir",
    "event_id",
    "anomaly_type",
    "anomaly_subtype",
    "target",
    "path",
    "annotated_set",
    "annotated_start",
    "annotated_end",
    "n_annotated",
    "annotated_gapped",
    "indices_derived_from_range",
    "manifested_flag",
    "measured_set",
    "measured_start",
    "measured_end",
    "start_delta",
    "end_delta",
    "best_shift",
    "shift_ties",
    "agreement_best",
    "agreement_0",
    "agreement_best_raw",
    "agreement_0_raw",
    "coverage",
    "peak_net",
    "peak_net_annotated",
    "median_net_annotated",
    "ambient_median",
    "threshold",
    "contrast",
    "baseline_n",
    "baseline_frames",
    "baseline_side",
    "baseline_contaminated",
    "baseline_mu",
    "baseline_sd",
    "ambient_mode",
    "region_source",
    "region_box",
    "bbox_jitter_px",
    "n_evaluated_frames",
    "n_unmeasurable_frames",
    "missing_pngs",
    "status",
    "confidence",
    "classification",
    "magenta_frames",
    "checker_frames",
    "other_frames",
    "publish_gap",
    "arm_gap",
    "request_id",
]

SERIES_FIELDS = [
    "session_label",
    "session_id",
    "event_id",
    "anomaly_type",
    "frame",
    "raw",
    "ambient",
    "net",
    "threshold",
    "annotated",
    "measured",
    "unmeasurable",
]


def fmt_csv_value(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, float):
        return "%.6f" % v
    return v


def build_index_check(sess, png_idx, annotated_all, frame_w, frame_h):
    lines = []
    if not png_idx:
        lines.append("frames   NONE FOUND under %s" % sess.frames_dir)
        lines.append("index    *** no frames on disk - nothing can be measured ***")
        return lines
    span = compress_indices(png_idx) if len(png_idx) <= 4 else "%d-%d" % (png_idx[0], png_idx[-1])
    lines.append(
        "frames   %d png on disk (indices %s) | %d label row(s) | annotation total_frames=%s | %dx%d"
        % (
            len(png_idx),
            span,
            len(sess.labels),
            sess.total_frames if sess.total_frames is not None else "-",
            frame_w,
            frame_h,
        )
    )
    missing = sorted(f for f in annotated_all if f not in sess.frame_paths)
    if missing:
        lines.append(
            "index    *** FAILED: %d annotated frame index(es) have NO PNG: %s ***"
            % (len(missing), compress_indices(missing))
        )
        lines.append(
            "index    *** measured on the frames that DO exist; treat those offsets as SUSPECT "
            "until the numbering is explained ***"
        )
    else:
        lines.append(
            "index    OK: %d event(s), %d annotated index(es), all present as PNGs (0-based)"
            % (len(sess.events), len(annotated_all))
        )
    return lines


def build_log_line(sess, logpath, no_log):
    if no_log:
        return "log lookup disabled (--no-log)", None
    cands = [logpath] if logpath else autodetect_log(sess.path)
    cands = [c for c in cands if c and os.path.isfile(c)]
    if not cands:
        return "no log found", None
    info = parse_log(cands[0])
    name = os.path.basename(cands[0])
    if info.get("error"):
        return "%s -> unreadable (%s)" % (name, info["error"]), None
    segment, note = pick_segment(info, sess.total_frames, run_start_time(sess))
    parts = [name, note]
    if info["pair_drops"]:
        parts.append("CAP-PAIR-DROP x%d" % info["pair_drops"])
    if segment and segment.get("summary"):
        s = segment["summary"]
        parts.append(
            "SVE-WANT-SUMMARY marks=%d pubs=%d matches=%d submits=%d frames=%d pendingAtEnd=%d maxDepth=%d"
            % (
                s["marksIssued"],
                s["publishesSeen"],
                s["wantedMatches"],
                s["submitsIssued"],
                s["framesWritten"],
                s["pendingWantedAtEnd"],
                s["maxPendingDepth"],
            )
        )
    for seg in info["segments"] if segment is None else [segment]:
        gs = summarise_gaps(seg)
        if gs:
            parts.append(
                "arm->publish gap n=%d publishes min/med/max %d/%.1f/%d hist[%s] arms-between %d/%.1f/%d"
                % (
                    gs["n"],
                    gs["pub_min"],
                    gs["pub_med"],
                    gs["pub_max"],
                    gs["hist"],
                    gs["arm_min"],
                    gs["arm_med"],
                    gs["arm_max"],
                )
            )
    return " | ".join(parts), segment


def main():
    global K_SIGMA, NEIGHBOURHOOD_PAD, BASELINE_N, RING_DILATE_PX, AMBIENT_FACTOR

    ap = argparse.ArgumentParser(
        description="Measure per-event pixel-vs-annotation frame offsets in AnomalyInjector capture sessions."
    )
    ap.add_argument("paths", nargs="*", help="session dir(s), or a root dir containing sessions")
    ap.add_argument("--selftest", action="store_true", help="run the classifier sanity check and exit")
    ap.add_argument("--label", action="append", default=[], help="provenance label, matched to paths in order")
    ap.add_argument("--log", action="append", default=[], help="UE log path, matched to paths in order")
    ap.add_argument("--no-log", action="store_true", help="disable log auto-detection")
    ap.add_argument("--csv", default="measure_label_offset.csv", help="per-event CSV output path")
    ap.add_argument("--series", action="store_true", help="also dump the per-frame signal series CSV")
    ap.add_argument("--verbose", action="store_true", help="one console line per event")
    ap.add_argument("--region", choices=("auto", "modal"), default="auto", help="per-frame bbox or modal bbox")
    ap.add_argument("--k", type=float, default=K_SIGMA, help="threshold sigma multiplier")
    ap.add_argument("--pad", type=int, default=NEIGHBOURHOOD_PAD, help="neighbourhood padding in frames")
    ap.add_argument("--baseline-n", type=int, default=BASELINE_N, help="baseline frames per event")
    ap.add_argument("--ring", type=int, default=RING_DILATE_PX, help="ambient ring dilation in pixels")
    ap.add_argument("--ambient-factor", type=float, default=AMBIENT_FACTOR, help="unmeasurable ambient multiple")
    ap.add_argument("--downscale", type=int, default=0, help="downscale long edge to N px (0 = native)")
    ap.add_argument("--cache-frames", type=int, default=192, help="decoded frames kept in memory")
    args = ap.parse_args()

    if args.selftest:
        print(VERSION)
        return selftest()
    if not args.paths:
        ap.error("give at least one session dir or root dir (or --selftest)")

    K_SIGMA = args.k
    NEIGHBOURHOOD_PAD = args.pad
    BASELINE_N = args.baseline_n
    RING_DILATE_PX = args.ring
    AMBIENT_FACTOR = args.ambient_factor

    csv_path = os.path.abspath(args.csv)
    print_header(args, csv_path)

    inputs = []
    for i, p in enumerate(args.paths):
        label = args.label[i] if i < len(args.label) else None
        if i < len(args.log):
            logpath = args.log[i]
        elif len(args.log) == 1:
            logpath = args.log[0]
        else:
            logpath = None
        for sd in find_sessions(p):
            inputs.append((sd, label, logpath))
    if not inputs:
        print("")
        print("NO SESSION FOUND. A session directory is one containing annotation.json.")
        return 1

    all_rows = []
    series = [] if args.series else None
    for sess_dir, label, logpath in inputs:
        sess = Session(sess_dir, label)
        png_idx = sess.png_indices()
        cache = FrameCache(sess.frame_paths, args.downscale, limit=args.cache_frames)
        size = cache.frame_size()
        frame_w, frame_h = size if size else (0, 0)

        annotated_all = set()
        for ev in sess.events:
            idxs, _ = event_indices(ev)
            annotated_all.update(idxs)

        index_check = build_index_check(sess, png_idx, annotated_all, frame_w, frame_h)
        log_line, segment = build_log_line(sess, logpath, args.no_log)

        eligible, guard_used, spanning = eligible_baseline_frames(sess, png_idx)
        index_check.append(
            "baseline %d eligible frame(s) outside every annotated window (guard=%d%s%s): %s"
            % (
                len(eligible),
                guard_used,
                "" if guard_used == BASELINE_GUARD else ", RELAXED from %d - dense burst schedule" % BASELINE_GUARD,
                "" if not spanning else ", %d session-spanning event(s) excluded from blocking" % spanning,
                compress_indices(eligible) if len(eligible) <= 16 else compress_indices(eligible)[:90] + "...",
            )
        )
        rows = []
        if png_idx:
            for i, ev in enumerate(sess.events):
                rows.append(
                    measure_event(
                        sess, cache, i, ev, eligible, png_idx, frame_w, frame_h, args.region, series
                    )
                )
        if segment is not None and rows:
            log_line = join_log_gaps(sess, rows, segment, log_line)

        print_session_block(sess, rows, index_check, log_line, args.verbose)
        if rows:
            print_type_table(rows)
        all_rows.extend(rows)

    try:
        with open(csv_path, "w", encoding="utf-8", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=CSV_FIELDS, extrasaction="ignore")
            w.writeheader()
            for r in all_rows:
                w.writerow({k: fmt_csv_value(r.get(k)) for k in CSV_FIELDS})
    except Exception as exc:
        print("")
        print("CSV WRITE FAILED: %s" % exc)

    if series is not None:
        spath = os.path.splitext(csv_path)[0] + "_series.csv"
        try:
            with open(spath, "w", encoding="utf-8", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=SERIES_FIELDS, extrasaction="ignore")
                w.writeheader()
                for r in series:
                    w.writerow(r)
            print("")
            print("SERIES -> %s" % spath)
        except Exception as exc:
            print("")
            print("SERIES WRITE FAILED: %s" % exc)

    print("")
    print("=" * 108)
    print(
        "TOTAL  %d event(s) over %d session(s)   measurable=%d   unmeasurable=%d"
        % (
            len(all_rows),
            len(inputs),
            sum(1 for r in all_rows if r["status"] == "OK"),
            sum(1 for r in all_rows if r["status"] != "OK"),
        )
    )
    print("=" * 108)
    return 0


if __name__ == "__main__":
    sys.exit(main())
