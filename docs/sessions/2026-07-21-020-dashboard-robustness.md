# 020 — M1: dashboard robustness + test net (2026-07-21)

Dashboard-repo milestone, paired with one plugin commit (AnomInject `3a46c1f`). Base `e93b43b`.
Commits (this repo): `172960a` test scaffold → `cde28b0` transport → `54f8c49` dead code → this one.
From the 2026-07-21 discovery review: findings 1, 2, 3, 5, 6, 7, 8, 9, 10. Confirmed clean, no action:
store/component structure; the m13 confirmation-bounded optimism (now regression-pinned instead).

## Sequence and what changed

**(a) `172960a` test(store)** — vitest stood up (pinned ^2 for the Node 18 + Vite 5 pairing; node
environment, no jsdom — `loadStored` already try/catches the missing localStorage). The m13 optimism
harness was never committed, so the suite is a reconstruction from journal 019's documented gates:
`keepOptimistic` contract, G1/G2/G2b/G4/G5, both backstop paths, pendingReverts reconciliation,
snapshot-diff events, the 300-cap, frame-bitmap lifecycle. Gate G-a: 25/25 against the UNMODIFIED
store — current behavior locked before any transport change.

**(b) plugin `3a46c1f` + `cde28b0` fix(transport)** — the token footgun's fatal form is gone.
- Server (plugin repo): the bad-token branch now sends `{type:"error", code:"bad_token", message}`
  before rejecting. Verified: `INetworkingWebSocket` (5.1) has no Close/Destroy, so the server cannot
  hang up — previously a wrong token got NOTHING back and the client hung in `authenticating`
  forever. Old clients ignore unknown types; no protocol version bump. The no-hello auth-timeout
  branch is untouched.
- Client: 4s welcome timeout armed at hello; the error envelope honored only while unauthed; both
  paths land in a new distinct `auth_failed` state — socket closed, **no auto-retry** (D1: a static
  token mismatch retried is noise), actionable copy on the connect screen naming
  `DefaultGame.ini [AnomalyControlServer] Token`, a banner variant for connected-then-rejected
  (server restarted with a new token), "token rejected" in the session bar. `auth_failed` clears
  optimistic/pending like a disconnect.
- Reconnect races: the backoff timer is tracked and cancelled on connect/reconnect/disconnect, and
  every socket handler self-guards (`this.ws !== sock → return`). Previously a stale socket's late
  onclose nulled the LIVE socket's reference → wedge (stream flowing, sends failing) + duplicate
  reconnect chains.
- Preview frames: `createImageBitmap` resolutions are commit-guarded (older-than-committed in the
  same epoch, or dead socket → drop + `bitmap.close()`; epoch change resets) so a slow decode can't
  regress the preview.

**(c) `54f8c49` refactor** — dead inject-era code deleted: `pendingInjects`/`addPendingInject`, the
unreachable "injecting…" ActivePanel branch, unused client command methods, the never-populated
`ActiveAnomaly.secondsRemaining`, `.panel.placeholder` and `.arow.pending` (V1 verified: the class
was applied only by the dead branch — pending-REVERT rows are filtered out of rendering, never
styled; `pendingReverts` itself is live and kept).

**(d) this commit fix(ui)** —
- Escape hatches (f3): Stop capture and both Revert-all buttons now gate on `connected` (socket
  OPEN) instead of `live`, so they stay usable while the snapshot stream is stalled — the stall
  historically happens DURING capture (2026-06-21 handoff §7 Bug 1), which made the one command that
  ends the load the one that was greyed out. Per-row revert deliberately stays live-gated (work
  order names only capture_stop/revert_all). Banner copy states the exception.
- Poll-radius slider (f6): now throttled like the coverage slider — both rewritten onto one shared
  `ThrottledSlider` (D4) with 100ms throttle during drag + authoritative send on release. Send fns
  are module-level consts so the memoized throttle survives re-renders.
- Robustness (f7): `transport/validate.ts` structural `isSnapshot`/`isCatalog` guards — malformed
  payloads are dropped with a once-per-client console.warn + one system event (no 5Hz spam); new
  top-level `ErrorBoundary` (reload button) wraps App so a render throw can't blank the page.
- Event log (f9): `capture_stopped` no longer appends its own event — the snapshot-diff deriver is
  the single lifecycle-event source (D3; fires for console-initiated runs too) and its stop wording
  adopts the better copy ("run complete — N frames saved"). `EventEntry` gains a monotonic `seq`
  (assigned in appendEvent, immune to the 300-cap slice) and the log keys rows on it instead of a
  reversed index.

## Decisions (owner-locked at plan review)
D1 no auto-retry after auth_failed; D2 generic error envelope keyed on `code`; D3 snapshot-diff is
the single event source, port the better wording; D4 extract ThrottledSlider; D5 five commits,
`test:` prefix introduced with the suite-establishing commit.

## Gates
- **G-a** 25/25 against unmodified store; build green.
- **G-p** (plugin) clean 49s Dev-Editor compile; live `-game` probe: wrong token → error frame,
  right token → welcome byte-identical.
- **G-b** 37/37 unit (11 transport-race); live: wrong token → distinct auth-failed UI in <1s with
  ZERO retries (server "bad token" log count flat over 20s), correct token → connected, kill game →
  down banner, relaunch → auto-restore with preview flowing.
- **G-d** build + grep zero dangling references; suite green.
- **G-c** 40/40 unit; live with the game process SUSPENDED mid-capture (true stall, WS open):
  stalled banner up, Stop capture + Revert all ENABLED, toggles/sliders disabled; Stop clicked
  DURING the stall queued on the socket and executed on resume (capture cancelled; preview arms
  resumed = m16 suppression released); exactly ONE "run complete" event per run (two runs → two
  events); poll-slider drag → optimistic label, engine-confirmed value held past the 10s backstop
  (no snapback); ActivePanel rendered a live auto-fire row during the run; error boundary verified
  via a temporary HMR throw (not committed).
- Honest residual: the per-row revert BUTTON was not clicked live (capture bursts auto-revert in
  seconds — the row vanished first); its code path is unchanged and the pendingReverts store logic
  is unit-pinned. One-click check during the owner Play-gate: console-inject any anomaly, press the
  row's revert.

## Notes
- The owner's dev `.env` (`TESTVALUE123`) currently matches StackOBot's `DefaultGame.ini` — that is
  why auto-connect works in dev. The M2 runtime-config work replaces this bake entirely.
- Nothing pushed; owner Play-gate smoke pending per standing rule.
