# 022 — M3: Tauri v2 desktop wrap (2026-07-21)

Desktop-shell milestone. Base `3cc3b67` (end of M2). AnomDash-primary; the plugin, the control-server
protocol, and the WS architecture are untouched. Sequence (a) rust update → (b) scaffold + config branch →
(c) tauri.conf/CSP → (d) build + full-flow gate → (e) delivery + WebView2 → (f) docs.

**Cross-repo (G43).** M3 spans both repos:
- **AnomDash** (this repo): `f10439e` Tauri wrapper + config.ts branch → `7963be5` host-tools (Run/Setup/
  selfcheck) + WebView2 → this commit (journal + README).
- **AnomInject** (plugin repo): `<P1>` `docs(delivery)` — PRE-DELIVERY-CHECKLIST additions (exe + config.json
  beside it, WebView2, SmartScreen), `client-readme.md` (exe delivery), and gotcha **G85** (Tauri lessons).

## What changed and why

The client ran a served build (M2: Python-served `dist/`). M3 makes the default a double-click
**`Dashboard.exe`** — a Tauri v2 app that renders the *same* frontend in the system WebView2 (~8 MB, no
bundled Chromium, no browser, no terminal). Chosen over Electron for the small artifact and no
shipped-Chromium to security-maintain; the Rust toolchain on the build machine is accepted.

**The M2 footgun-fix is preserved — the hard invariant of this milestone.** In a Tauri build the frontend
is compiled into the exe, so a `config.json` in `dist/` would be baked in, silently undoing M2. Two
mechanisms prevent it: `build:tauri` deletes `dist/config.json` before Tauri embeds the frontend, and the
Tauri code path never `fetch`es — a narrow Rust `read_config` command reads `<exe_dir>/config.json` off
disk. `config.ts` branches behind `inTauri()` (`typeof window` + `__TAURI_INTERNALS__`, node-safe so tests
are unaffected); the `@tauri-apps/api/core` import is dynamic (lazy chunk, loaded only under Tauri); the
browser/Python path keeps `fetch('./config.json')` verbatim. All three M2 degradations hold in both branches.

**Least privilege:** the read is a custom app command via `invoke_handler`, not the `fs` plugin — and an
app command needs no capability grant (verified: it worked with the scaffold's default capability). CSP in
`tauri.conf.json` permits the control-server WS; `bundle.active:false` yields a portable exe (no installer).

**Delivery:** `Run.bat` launches `Dashboard.exe` + the watcher and prints the self-check (`selfcheck.py`
gained an exe/process mode); `Setup.bat` checks the WebView2 registry key and silent-installs the Evergreen
bootstrapper if absent, and stamps `capturesRoot` into the delivery-root `config.json` (next to the exe).
The M2 Python-served route (`serve_dashboard.py`) is kept intact as the documented fallback. **Python is
still required for the encoder** (S3 — dropping/embedding Python — remains deferred).

## Decisions (owner-locked at plan review)
D-M3-1 one T1 commit (scaffold+config-branch are one gateable unit); D-M3-2 CSP as proposed, **no loosening
needed** (G-APP proved the WS + decoded-frame path work under it — recorded per the owner's traceability
ask); D-M3-3 app command, no fs plugin, no capability needed; D-M3-4 WebView2 install-path exercised
logically, not against real hardware (residual below); D-M3-5 `.rs` authored comment-free (the stripper
leaves `.rs` untouched; `main.rs`/`build.rs` grep clean), JSON exempt, generated `Cargo.toml` left as-is.

## Findings
- **Rust was present but stale** (1.74.1 < Tauri v2 MSRV 1.77.2) → `rustup update stable` → 1.97.1. Cheaper
  than the fresh-toolchain install budgeted. (The rustup *self*-update tail failed on a locked
  `rustup-init.exe` — harmless; the toolchain updated fine.)
- **Measured exe size: 8.22 MB** (my ~3–6 MB plan estimate was low; ~5–9 MB is the normal Tauri v2 range).
  The real assertion — system WebView2, no bundled Chromium — holds.

## Gates (live, against a running StackOBot, on an assembled delivery folder)
- **G-DEV:** 58/58 unit incl. 4 new Tauri-branch tests (mocked `invoke` + stubbed `__TAURI_INTERNALS__`);
  browser build green; the dynamic import split into a `core-*.js` lazy chunk; `npm run dev` unchanged.
- **G-APP:** `Dashboard.exe` launched, WebView2 rendered the full dashboard, auto-connected over
  `ws://127.0.0.1:8077` (game log `client authenticated`), **the preview stream rendered inside the webview**
  (screenshot: the robot scene, `1280×720 #157`), and an **app-driven 120-frame capture** wrote a complete
  session (`Actual_Frames` + `annotation.json` + `labels.jsonl` + `run.json` + `run_summary.json`,
  `speed_ratio 1.00002`, `paced: true`).
- **G-EXTERNAL (hard gate), four launches of the SAME exe, ZERO rebuilds (exe mtime constant):**
  (A) correct token → `client authenticated`;
  (B) deleted `config.json` → manual connect screen, no auto-connect (nothing baked);
  (C) wrong token → `auth_failed` naming `config.json` + server `bad token — peer rejected`;
  (D) restored token → `client authenticated`.
  This is the definitive proof that `config.json` is external/editable/runtime-read, not embedded.
- **G-SIZE:** 8.22 MB; byte-scan confirmed the dev token is **not** in the exe.
- **G-FALLBACK:** the M2 Python-served build still connects (fetch branch intact).
- **G-WEBVIEW2:** detection true-path found the runtime on this box (`pv=150.0.4078.83`); the forced-absent
  branch (bogus GUID + stub) reached the installer with `/silent /install`; real `Setup.bat` reported
  "WebView2 is present" and `Run.bat`'s self-check showed all three OK.

## Residuals / follow-ups
- **D-M3-4 residual (documented, in the checklist + G85):** the real silent-install has **not** run against
  a machine actually lacking WebView2 — this box has it and was not uninstalled. First WebView2-less client
  machine is the watch-item.
- The `.cmd` stub in the forced-absent test didn't print the post-install tail (a `.cmd` doesn't return
  without `call`); the real bootstrapper is an `.exe`, which returns control, so the re-detect tail runs in
  production. Not a Setup bug.
- Nothing pushed by the build step; M2+M3 pushed together at milestone end per the inverted-push workflow.
