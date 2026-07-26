# 023 — Design round, Stage 1: token foundation (2026-07-26)

Design-round Stage 1 of 2. Base `b0ae695` (end of M3). AnomDash only — no plugin, protocol or host-tools
work. Styling and one canvas-sizing fix; no behavior, controls, or store logic changed.

Source of truth: the approved design spec (`Direction.dc.html`, section `1a` = design system, `2a` = seven
state mockups), read from the handoff bundle. Per its README the visual output was recreated in our
React/CSS — the prototype's DOM and inline-style approach were not copied.

## The token contract (as built)

`src/tokens.css`, imported before `styles.css`. Every value below is spec-exact.

| group | tokens |
|---|---|
| palette | `--void #0A0D14` `--panel #121724` `--raised #1A2130` `--line #273043` `--text #E6EAF3` `--iris #828CF8` |
| palette (adjudicated additions, N1) | `--dim #8E97AC` `--faint #5C6478` `--iris-light #A5ADFF` `--iris-ink #07090F` |
| state | `--live #3ECF8E` `--stalled #E5A83B` `--offline #F25C54` `--capturing #45C4E9` (+ `-glow`, `-tint`, `-edge` variants) |
| type | `--font-sans` IBM Plex Sans, `--font-mono` IBM Plex Mono; display 20/600, panel title 12/600/0.08em caps, body 13/400, micro 11/500/0.06em caps, data mono 12/500, data-large mono 18/600 |
| spacing | `--sp-1..6` = 4 · 8 · 12 · 16 · 24 · 32 |
| radii | `--r-chip 3` `--r-control 4` `--r-panel 8` |
| focus | `--focus-ring` = 2px iris ring on `:focus-visible` |

**Mono is reserved for data** (ids, counts, coords, ratios, timestamps, log, and value inputs — all with
`tabular-nums`); everything conversational is Plex Sans. This is the spec's load-bearing rule and the
reason hierarchy reads without extra weight.

`.is-live/.is-stalled/.is-offline/.is-capturing` each set a single `--state` (plus glow/tint/edge), and the
spine, status dot, status word and connection banner all consume `--state` — so one class drives every
state-colored surface.

## Decisions as adjudicated

- **N1** the four extra greys/accents are named tokens, so Stage 2 never needs a raw hex.
- **N2** static 400/500/600 (no variable font); spec body 450 → 400. *If Stage 2 review finds body text
  reads thin, the variable font is the known upgrade path.*
- **N3** state map, precedence `OFFLINE > STALLED > CAPTURING > LIVE`. Stalled beats capturing because a
  stalled capture is exactly when amber must win (matches the spec's stalled-mid-capture mockup).
  `auth_failed` reads OFFLINE — the spec defines OFFLINE as "error / access denied" — and M1's banner and
  ConnectScreen keep the specific token-rejected copy. **Stage 2 note:** in the spec the connect/auth
  screens are standalone cards *without* console chrome (no spine, no status bar); Stage 1 deliberately
  does not solve how the spine presents pre-connection.
- **N4** our app wins over the spec where they disagree; nothing invented. The preview keeps its current
  box-drawing, only re-tokenized (iris = selected, capturing-cyan = live anomaly); the reticle language,
  ship-check readout, tabs and drawers are Stage 2. **Carry-forward for Stage 2 planning:** the Last-run /
  ship-check readout needs `speed_ratio` + run-summary data client-side — at the Stage 2 checkpoint,
  confirm whether the snapshot / capture-stopped event already carries it or the control server needs a
  small addition.
- **N5** panels moved 6 → 8px radius.
- **N6** fonts self-hosted via `@fontsource` (latin 400/500/600, both families), **bundled, no CDN**.
  **No CSP change was required** — bundled fonts are same-origin, so M3's `default-src 'self'` already
  covers them; verified by the fonts rendering inside the packaged Tauri webview. Therefore **no plugin
  commit and no G86** (that mirror was conditional on a CSP change).
- **A1** the pulse animation is disabled under `prefers-reduced-motion`.

## Hi-DPI preview (finding 4)

The backing store is now `container CSS box × devicePixelRatio` instead of a hardcoded 960×540, measured
**synchronously in a layout effect** and then maintained by a ResizeObserver + window-resize listener.

Two non-obvious points, both requested:
- **A2 — DPR changes need their own listener.** A ResizeObserver does *not* fire when a window moves to a
  monitor with different scaling: the CSS box is unchanged, only the device pixels are. A
  `matchMedia('(resolution: Ndppx)')` listener re-arms itself at the new ratio on each change and removes
  the old listener.
- **A3 — re-blit on resize.** Changing a canvas's `width`/`height` clears it, so the last held frame is
  redrawn (and the overlay rebuilt) immediately rather than blanking until the next ~6 Hz frame.

Overlay geometry scales with the backing store, so annotations keep their apparent size while rendering
crisp. Click-to-select is unaffected by construction — it converts through `getBoundingClientRect`, which
is CSS pixels and never sees the backing store; verified live at 2× DPR.

## Findings during the gates

1. **`ResizeObserver` never fires in a non-compositing window.** The first DPI gate failed with the canvas
   stuck at its fallback size; a control observer proved RO callbacks were not being delivered at all,
   because the Browser pane was not compositing (the same condition that made screenshots time out). This
   is why the initial measure is synchronous — that is genuine robustness for a background or hidden
   window, not a test workaround.
2. **`canvas.width` reflects to an HTML attribute**, so "does the element have a width attribute" is *not*
   a valid check for which code version is running. It briefly looked like a stale bundle.
3. **A stale module in the pane** (G84 trap 3 again): the dev server was serving new code while the tab
   ran old code. Asserting on served content vs. rendered behavior separated them.
4. **Disabled danger buttons still looked enabled** — `button.danger` was declared after `button:disabled`
   at equal specificity, so both "Revert all" buttons rendered bright red while genuinely disabled. Found
   by reading the OFFLINE screenshot rather than the code. Pre-existing ordering, made obvious by the
   brighter token red; fixed in `8fcc278`.
5. **PS 5.1 `Out-File -Encoding utf8` writes a BOM** — it landed in a commit subject (G84 trap 1 in a new
   place). Amended before pushing; commit messages are written via the Write tool from now on.

## Gates

- **G1-BUILD** 69/69 unit (58 existing + 11 new `consoleStatus` tests incl. the precedence cases); `npm run
  build` green.
- **G1-VISUAL** browser: tokens resolve spec-exact (panel `#121724` r8, h3 Sans 600 0.08em caps, iris
  buttons with `#07090F` ink, mono+tabular data), **zero raw hex outside `:root`**, all six font faces
  loaded **from our own origin** (no CDN), no console errors. Tauri: the packaged app renders the same
  foundation, and the font asset names are **present inside the exe** — the offline case is satisfied by
  construction, not by a network being available. No CSP violation (fonts render; same-origin).
- **G1-SPINE** live against a running StackOBot, all five states: LIVE green; CAPTURING cyan + pulse;
  STALLED amber + pulse + tinted banner (forced by suspending the game process, so the socket stays open
  but snapshots stop — a real stall, not a disconnect); **STALLED correctly beat CAPTURING** while a
  capture was genuinely running; OFFLINE red + banner after killing the game.
- **G1-DPI** backing store == container × DPR (658×370 at 1×, not 960×540), tracked a resize to 878×494;
  DPR 1→2 doubled it to 1756×988, **re-armed** at `(resolution: 2dppx)` with **no listener leak**;
  re-blit confirmed after both resize and DPR change (center pixel held live scene content); click at 2×
  DPR selected `SkeletalMeshActor_3` with the click point inside that object's iris box.
- **G1-REGRESSION** mid-capture **and** stalled: **Stop capture enabled, Revert all enabled** — the M1
  escape hatches survive the restyle. A 120-frame capture ran end-to-end **from the packaged exe**
  (`speed_ratio` 1.00003, `paced: true`). `config.json` still **not** embedded in the exe (M2/M3 invariant
  re-checked).

## Stage 2 carry-forward

Reticle overlay language · ship-check / Last-run readout (see N4 data question) · per-panel restyling ·
auth-failed and stalled *screen* layouts · collapse + fullscreen affordances · Live/Captures tab chrome ·
reflow breakpoints · copy rewrites · password-style token field (finding 12) · reserved console/captures
homes. Also noted for Stage 2 review: destructive actions currently use `--offline` red, which is
spec-reserved for state — worth confirming whether danger should get its own treatment; and the long
"captures folder" micro-label wraps to two lines under the uppercase transform.
