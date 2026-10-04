# Anomaly Dashboard — quick start

The dashboard is one file, `AnomalyDashboard.exe`. You don't need to install anything, run any setup or type a token.

## 1. Start the game, then the dashboard
1. Start the game, either from the editor with **Play** (a new window works best) or as the packaged game.
2. Open the game console (**~**) and run `IAI.Server.Start`.
   To skip this step every time, add `-ExecCmds="IAI.Server.Start"` to the game's launch command.
3. Double-click `AnomalyDashboard.exe`. It finds the running game and connects by itself. The bottom-left corner shows **Connected**.

The first time you run it, Windows may show "Windows protected your PC", because the app isn't code-signed. Click **More info → Run anyway**.

## 2. Capture
- **What to capture:**
  - **Random mix** fires a random mix of the anomaly types you switch on.
  - **One object** puts one anomaly on one object. Click the object in the live view to pick it.
- **Length:** 4 s, 10 s, 30 s, a custom number of frames, or until you press Stop.
- Press **Start capture**, then click into the game window. Capture starts as soon as the game window has focus. The live view pauses while recording; that's normal and keeps the capture smooth.

Each capture is saved as one folder in the captures folder (shown under **Saves to**; change it in **Settings**). It contains:
- `Actual_Frames/`: the captured images;
- `annotation.json`: the labels for the session (always written);
- `labels.jsonl`: the per-frame labels (always written);
- `run_summary.json`: technical details of the run.

## 3. Generate what you need
Open **Library**, tick the captures you want, choose the outputs in the bar at the bottom, then press **Generate**:

| Output | What you get |
|---|---|
| **Video** | `Video_Clip/<session>.mp4`, encoded on this PC at the capture's true frame rate |
| **Target masks** | `target_mask/` plus `mask_map.json`: one greyscale PNG per frame, marking the anomaly's pixels |
| **Labelled previews** | `annotated/`: copies of the labelled frames, with each anomaly outlined in red and named (for example "Corrupted texture") |

In the labelled previews:
- **A solid red outline** follows the object's exact visible pixels, taken from its target mask.
- **A dashed red box** means no mask was recorded for that object (for example Nanite meshes). The box shows the label's approximate area.

Masks are recorded during every capture, but they stay in a hidden working folder inside the capture until you generate them.

Green badges on a capture mean that output is ready; click a badge to open it. **⋯ → Open folder** opens the capture folder, and **Move to Recycle Bin** removes a capture you don't need.

## Troubleshooting
- **It says "Start your game to begin":** the game isn't running, or `IAI.Server.Start` hasn't been run in it yet.
- **It found the game but won't connect:** wait a few seconds. If it still fails, use **Settings → Game connection → Connect manually** and paste the key the game printed after `IAI.Server.Start`.
- **Recording waits:** click into the game window. Capture starts only when the game has focus.
