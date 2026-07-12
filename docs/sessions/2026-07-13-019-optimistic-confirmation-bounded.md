# 019 — m13: confirmation-bounded optimistic UI (2026-07-13, gates GREEN; COMMIT PENDING owner eyeball)

Dashboard-repo (AnomDash) milestone. Base 0cb79d9. Plugin untouched.

## Doc convention (NEW — proposed this milestone)
AnomDash had no `docs/` dir; prior dashboard work (m10/m12 UI) was recorded only in commit messages, with
the milestone journals living in the plugin repo. This milestone starts a dashboard-side
`docs/sessions/NNN-*.md` journal, numbered to STAY ALIGNED with the plugin's journal sequence (plugin's
last was 018; this is 019) so the two repos read as one project history. Flag for the owner: veto or
renumber to a dashboard-local sequence if preferred. Rationale/design notes go here (and a pointer in
README), never in code — the no-comments source invariant applies to this repo too.

## Problem (Issue 3, diagnosis accepted)
Dashboard control changes reached the game instantly, but the dashboard's OWN slider/toggle snapped back
to the old value and lagged badly (poll-radius 15→25: engine got 25, thumb snapped to 15, stayed, then
finally showed 25). Root cause = the optimistic-UI entry had a fixed 2500ms wall-clock TTL (old
`OPT_TTL`): if the confirming snapshot's round-trip exceeded 2.5s (real cause: the steady-state preview
ReadPixels pump starving the game-thread snapshot cadence — server-side, out of m13 scope), the
optimistic value expired before confirmation and the still-old snapshot showed through. The reconciler was
otherwise correct (stale-value snapshots didn't clobber), and the server snapshot fields are read live
(`AnomalyViewport::GetPollRadius()` etc.), so the only client defect was the fixed timer.

## Fix (m13, client-only — correct regardless of stream cadence)
Confirmation-bounded optimism, mirroring the existing `pendingInjects`/`pendingReverts`
confirm-plus-backstop model. In `src/store.ts`:
- `Optimistic` gains `baseline` (the field's value at command time) beside `value`/`until`.
- `setOptimistic(path, value)` captures `baseline = resolvePath(snapshot, path)` and sets
  `until = now + PENDING_BACKSTOP_MS` (10s — an absolute backstop, NOT a confirm timer). Dropped the
  unused `ttlMs` param.
- New exported pure `keepOptimistic(e, cur, prev, now)` is the single drop decision:
  - `now > e.until` → drop (absolute backstop: a genuinely rejected/never-applied command, or a dead
    stream, resolves in bounded time — never hangs forever).
  - `cur === e.value` → drop (CONFIRM: the snapshot reached the requested value).
  - `cur !== e.baseline && cur === prev` → drop (SETTLE: the server moved the field off baseline and it
    is stable across two snapshots = the server's authoritative answer, e.g. a clamp — resolves to the
    clamped value without needing an exact match and without hanging).
  - else keep. Crucially, a snapshot still carrying the OLD value has `cur === baseline`, so it is KEPT —
    an unconfirmed control is NEVER overwritten by an old-value snapshot at ANY realistic round-trip
    latency (F1/F2). While `cur` is progressing (moved but not yet stable, `cur !== prev`) the entry is
    also kept, so no intermediate value flashes during a drag.
- `setSnapshot` reconciler calls `keepOptimistic` per entry (passing the previous snapshot for settle
  detection).
- `setConn` clears `optimistic`/`pendingInjects`/`pendingReverts` on `'disconnected'` so no pending
  local truth survives an (unintentional) reconnect (F1 edge; the intentional-disconnect path already
  `hardReset`s).
- `tick()` unchanged — it already prunes on `until`, now doubling as the dead-stream/backstop timer
  between snapshots.
`src/components/SessionBar.tsx`: CoverageSlider's numeric label now renders `shown` (optimistic) not
`value` (snapshot) so the % text tracks the thumb (F3). Audited — it was the only label/thumb split;
poll-radius already used `shown`.

No protocol/server/transport/Hz change (F4). The deeper server-side preview-ReadPixels starvation (the
reason round-trips exceed 2.5s) is the separately-tracked async-preview upgrade, deliberately NOT touched
here — the client fix makes controls correct regardless of cadence.

## Approach choice (F1 a vs b)
Chose the confirmation-bounded model (closest to plan's (b)) over per-snapshot deadline-refresh (a),
because it directly mirrors the in-repo `pendingInjects` precedent and, with the added SETTLE rule, also
resolves server clamps/rejects promptly and deterministically — no reliance on a live-stream heartbeat to
keep refreshing a timer. The single 10s absolute backstop only ever fires for a command the server never
reflects at all (pure reject with no field movement, or a dead stream); every legitimate command (even on
a badly starved multi-second stream) resolves earlier via CONFIRM or SETTLE.

## Edge cases
- Rapid re-drag / supersede: each `setOptimistic` replaces the entry with the latest value (and a fresh
  baseline). A late snapshot confirming a SUPERSEDED intermediate value has `cur !== value` and, while
  the field is progressing, `cur !== prev`, so it is kept (shows the latest) — no resurrection. Verified
  (G2b).
- Server clamp/reject-with-move: SETTLE rule drops the entry to the clamped value once it is stable
  across two snapshots — bounded, no exact-match required, no hang. Verified (G4).
- Pure reject with no field movement (e.g. `capture_start` rejected → `capture.running` stays false):
  resolves at the 10s backstop. Verified (pure-fn + integration).
- Disconnect mid-pending: optimism cleared on `'disconnected'`. Verified (G5).

## Gates (method: headless harness driving the REAL compiled store — `tsc`-emitted store.js run under
node, exercising `setOptimistic`/`setSnapshot`/`setConn` + the exported `keepOptimistic`; 23/23 assertions
pass. The engine was down; this store-level harness is deterministic and covers the timed backstop via the
pure function with explicit `now`. The build `tsc && vite build` passes clean.)
- G1 normal cadence: thumb 2500 immediately, held through a stale snapshot, drops cleanly on confirm. ✓
- G2 slow cadence (the bug): held at 2500 across 40 consecutive stale (old-value) snapshots, no snapback;
  confirms when the value finally arrives. ✓  (+ G2b supersede: no intermediate resurrection. ✓)
- G3 all control families (toggle / auto pool / capture.running, same path as the sliders): held through
  stale, confirmed+dropped. ✓
- G4 server clamp (requested 90 → clamped 50): resolves to 50 without hang. ✓
- G5 disconnect while pending: optimism cleared. ✓

## Owner live-eyeball (2026-07-13)
Owner confirmed the headline gate on a live PIE + dashboard: controls are immediately responsive and the
snapback is gone. The 23/23 store harness covers the reconciliation mechanics; the remaining live
spot-checks were LIGHT — the per-control-family sweep (coverage % label / scoping / HUD toggles /
auto-pool / capture Start) and the mid-drag disconnect case were not each exercised end-to-end on screen.
Recorded honestly: those families share the identical setOptimistic/useControlValue path proven by the
harness, so the risk is low, but they were not individually eyeballed live.

## State / Hand-off
- Working tree dirty by design: `src/store.ts`, `src/components/SessionBar.tsx` + this journal + README
  note (uncommitted). Single m13 commit next turn after the owner's eyeball. Base 0cb79d9. Plugin
  untouched.
- Constants: `PENDING_BACKSTOP_MS = 10000` (was `OPT_TTL = 2500`). `ACTIVE_TTL`/`STALL_MS` unchanged.
