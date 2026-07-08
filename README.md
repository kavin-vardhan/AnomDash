# Anomaly Dashboard

External control dashboard for the **AnomalyInjector** plugin's in-game control server. A **pure localhost
client** — it connects to the in-game WebSocket server at `ws://127.0.0.1:8077` and never touches the network
at runtime. (Host tooling, like the MCP bridge; its own repo, independent of the plugin.)

## Source convention — no comments
Source in this repo carries **no comments** — none, including any file-header / copyright banner — across
TS/TSX, CSS, Python, and `.bat`. This is deliberate and repo-wide (mirrors the plugin repo). **Do not add
comments, and strip any before committing** (feature/host-tools updates keep re-introducing them; this has
been re-stripped twice now). Enforced with a deterministic, byte-preserving stripper kept alongside the repos
at `../_strip_comments.py` — it preserves every non-comment byte, all string/regex/template literal contents,
CRLF endings and the BOM: run `python ../_strip_comments.py .` from the repo root. Put rationale and design
notes in commit messages, not in the code.

## Dev run
1. `npm install`  *(the only network access — build-time only)*
2. `npm run dev`  →  http://localhost:5173
3. In-game (PIE): console `IAI.Server.Start` → copy the token from the Output Log
4. Open http://localhost:5173, paste `ws://127.0.0.1:8077` + token, **Connect**

`ws://` is not subject to CORS/same-origin, so the `:5173` dev server connecting to `:8077` works directly.

## Transport — the one rule
Every server→client message arrives as a WS **binary** frame (libwebsockets), *including JSON*. The client is
**framing-agnostic**: it reads the leading bytes — `"AIF1"` ⇒ a preview frame (16-byte header + JPEG),
otherwise UTF-8 JSON. It never assumes a text opcode. See `src/transport/`.

## Status (slices)
- **Slice A (built):** transport + live monitoring — connect/auth, preview canvas (frames + overlay rects +
  click-to-select), targets list, session bar (FPS/seed/revert-all/scoping/HUD toggles/poll-radius). Replaces
  `WebClient/spike-client.html` for monitoring.
- B: inject + active panels. C: auto panel. D: capture panel + event log.
- **Post-D:** screen-coverage slider on the session bar — the first *throttled* continuous control
  (`src/lib/throttle.ts`: ~10/sec during a drag + an authoritative send on release; the handle tracks the drag
  optimistically while the numeric % stays snapshot-bound/authoritative). The existing poll-radius slider still sends
  on every change and **could adopt the same throttle util later** (intentionally not retrofitted this pass).

## Architecture
- **State:** a single Zustand store (`src/store.ts`) holding the latest snapshot + latest frame + connection +
  UI selection. Selector subscriptions keep per-panel re-renders cheap under the ~20 Hz snapshot / ~10 Hz frame push.
- **Transport:** `src/transport/AnomalyClient.ts` (one WS, framing-agnostic decode, exponential-backoff reconnect,
  command helpers) + `protocol.ts` (AIF1 frame header).
- **Pure client:** never modifies the plugin/server. Server gaps are flagged, not patched.
