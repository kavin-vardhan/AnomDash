# 021 — M2: runtime config + static dist (2026-07-21)

Setup-simplification milestone. Base `c8d4fe4` (end of M1). Sequence S2 → S1 → S5 → S4.

**Cross-repo (G43).** M2 spans both repos:
- **AnomDash** (this repo): `da7b887` runtime config → `c32f858` Python-served static dist →
  `878089e` Setup/Run papercuts → this commit (journal + README).
- **AnomInject** (plugin repo): `6d01bc9` `docs(delivery)` — the new **`docs/PRE-DELIVERY-CHECKLIST.md`**,
  the `client-delivery.md` / `client-readme.md` migration to `config.json`, the `architecture.md`
  correction, and gotchas **G84** (+ G71 marked partially superseded). The client-facing docs live in the
  plugin repo, so they land there; no dashboard code is described by them that isn't described here.
  Also landed there this session at the kickoff: `9c46ef5` gotcha **G83** (the M1 socket-close finding).

## What changed and why

**S2 — runtime `config.json` (the keystone).** The control token was baked at build time from a
**gitignored** `.env` into the JS bundle. Assemble a delivery from a clean checkout and the dashboard
shipped **silently tokenless** — present, launching, looking correct, unable to connect; and any token
change meant a rebuild. The token (plus `capturesRoot`, optional `serverUrl`) now comes from
`./config.json` served beside `index.html`, read once before first render. Clean cut: every
`import.meta.env` read is gone — no env fallback, because two sources of truth for one secret is the
confusion being removed. All degradations are non-fatal and land on M1's manual connect screen; a
present-but-rejected token still lands on M1's `auth_failed`, whose copy now names `config.json`.
`vite base: './'` makes the build servable from any path (Python now, Tauri in M3).

**S1 — Python-served static dist.** The client ran the *Vite dev server* to display a static ~180 KB SPA,
which forced Node + `npm install` (and its corporate-network failure class) onto every client machine.
Now: build here, ship `dist/`, serve with `host-tools/serve_dashboard.py` on **5180** (dev keeps 5173 so
both can run during M2/M3 testing). Python was already required by `encode_watcher.py`, so the client
prerequisite list *shrank* to one item.

**S5 — two papercuts.** `Setup.bat` refused a captures path whose parent didn't exist even though `mkdir`
creates intermediates; it now creates the full path. `Run.bat` ends with a three-line status check
(dashboard / watcher / game server) so "I forgot to start the game" is stated in the launcher window
instead of surfacing later as an unexplained red dot.

## Decisions (owner-locked at plan review)
D-M2-1 **wrapper, not the one-liner** (owner accepted the pushback — see Trap 2/3 below for why it was the
right call); D-M2-2 **watcher heartbeat** so liveness is a real probe; D-M2-3 **5180** for the packaged
build, dev stays 5173; D-M2-4 five commits, journal separate; D-M2-5 delete the inert `.env` files.

## Four traps this milestone actually hit (all now in G84)

1. **A UTF-8 BOM cost the shipped token.** The first G-S1 run destroyed it: `write_config.py` couldn't
   parse a BOM'd `config.json` and its `except → start from {}` fallback rewrote the file **without**
   `controlToken`. Windows editors write BOMs routinely. Fixed with `utf-8-sig`, an unparseable file is now
   preserved as `.bak` with a loud warning, and the client strips a leading BOM before `JSON.parse`.
   *This is the exact failure class M2 exists to remove, reintroduced by the tool meant to fix it.*
2. **`python -m http.server` resolves MIME from the Windows registry.** A box whose `HKCR\.js` says
   `text/plain` serves JS as text/plain → the browser refuses the ES module → blank dashboard. **Our box is
   clean** (verified: no `.js` Content Type in HKLM or HKCU; Python 3.13 serves `text/javascript`) — which
   is precisely the trap: it passes here and fails there. `extensions_map` now forces the types.
3. **Static-server caching disguised a gate.** A cached `index.html` served an *earlier* bundle and the app
   still connected; the give-away was the asset hash in the DOM (`index-BwbP--zc.js`, the pre-`base` build).
   `Cache-Control: no-store` fixes the real risk (a `config.json` rewritten by Setup serving stale).
   **Lesson: when verifying a static build, assert on the served asset hash, not "the page works".**
4. **Two cmd.exe hazards.** An `echo` containing parentheses inside an `if (...)` block closes the block
   early (`. was unexpected at this time`); `timeout /t` aborts under redirected stdin. Also `.bat` needs
   CRLF — `.gitattributes` enforces it on checkout, but an editor writing LF breaks the working tree.

## Gates
- **G-S2** 54/54 unit (12 loader tests: valid / 404 / SPA-fallback HTML / malformed / non-object / network
  throw / tokenless / BOM / serverUrl default / re-load replaces). Live: dev config present → auto-connects
  (parity with the old `.env`); renamed away → manual connect, no hang, accurate *info*; malformed → manual
  connect + precise warning, **error boundary NOT triggered** (the local catch handles it); built `dist`
  served from a plain Python path → relative assets load, `./config.json` fetched, auto-connected.
- **G-S1** run as a **real assembled delivery bundle** with zero npm/Node in it: `Setup.bat` → `Run.bat` →
  Python-served → browser. Setup preserved a BOM'd token and stamped `capturesRoot`; served JS
  `text/javascript`, HTML `text/html`, config `application/json`, all `no-store`; unknown path **404s** (no
  SPA fallback, as designed); dashboard auto-connected, showed the Setup-configured captures folder, and a
  **20-frame capture** wrote `Actual_Frames/` + `annotation.json` + `labels.jsonl` + `run.json` +
  `run_summary.json` with **`speed_ratio` 1.0002, `paced: true`** — inside the m21 ship rule. This doubles
  as the long-owed packaged dry-run (G76).
- **G-S5** Setup created a three-level captures path whose parent didn't exist (token still preserved);
  `selfcheck` verified in all three states — all up, game stopped, and everything stopped **after letting
  the heartbeat go stale**, which is what proves the heartbeat is liveness and not file-existence.
- **G-S4** checklist committed with every `client-delivery.md` assembly item plus the two new ones;
  `client-readme.md` grep-verified free of Node/npm requirements.

## Notes / follow-ups
- **`capture_stopped` does not fire on auto-finish** (only on explicit Stop): the run-complete badge stayed
  empty while the event log still reported completion. Pre-existing server behaviour, not introduced here —
  and it independently **validates M1's D3 choice** to make the snapshot diff the single lifecycle source.
  Worth a server-side look if the badge is wanted for finite runs.
- `dist/config.json` inherits the **dev** token from `public/config.json` on every build — checklist §2.
- Nothing pushed; owner packaged smoke pending per the standing rule.
