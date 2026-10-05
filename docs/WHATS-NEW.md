# Anomaly Dashboard: what's new

The dashboard has been rebuilt as a single Windows app. It captures and labels exactly as before, but it is much simpler to set up and use.

## At a glance

| | Before | Now |
|---|---|---|
| **Installing** | Install Python and Pillow, then run `Setup.bat`, which downloads ffmpeg | Nothing to install. It's one file: `AnomalyDashboard.exe` |
| **Starting** | `Run.bat` opened three helper windows and a browser tab | Double-click `AnomalyDashboard.exe` |
| **Connecting to the game** | The access key came from `config.json` | It finds the running game and its access key by itself |
| **Videos, masks and previews** | Made automatically for every capture | Made only when you ask, for the captures you choose |
| **Labelled previews** | Boxes that were often only roughly placed | A red outline that follows the anomaly's exact pixels, with its name |

## 1. One app, nothing to install

Copy `AnomalyDashboard.exe` anywhere and double-click it. You don't need Python, ffmpeg, setup scripts or config files.

The first time, Windows may show **"Windows protected your PC"** because the app isn't code-signed. Click **More info → Run anyway**.

## 2. It connects by itself

1. Start your game, from the editor with **Play** or as a packaged game.
2. Open the game console (**~**) and run `IAI.Server.Start`. To skip this step every time, add `-ExecCmds="IAI.Server.Start"` to the game's launch command.
3. The dashboard finds the game and connects. The bottom-left corner shows **Connected** and your game's name.

If it can't find the game, use **Settings → Game connection → Connect manually** and paste the access key the game prints after `IAI.Server.Start`. To go back to automatic, click **Back to automatic** in the same place.

## 3. Capturing

On the **Capture** page:

- **What to capture**
  - **Random mix** fires a random mix of the anomaly types you switch on.
  - **One object** puts one anomaly on one object; click the object in the live view to pick it.
- **Length:** 4 s, 10 s, 30 s, **Until I stop**, or **Custom** (any number of frames).
- Press **Start capture**, then click into the game window. Recording begins once the game has focus.
- The live view pauses while recording so the capture stays smooth. A timeline shows each anomaly as it happens.
- When it finishes, a **Capture saved** message appears and the capture is listed under **Recent captures**.

Each capture is saved as its own folder in your captures folder. The folder is shown under **Saves to**; change it in **Settings**.

## 4. Make outputs only when you need them

Videos, masks and previews are no longer made automatically. To make them:

1. Open **Library** and tick the captures you want.
2. In the bar at the bottom, choose any of:
   - **Video:** an MP4 at the capture's true frame rate, encoded on your PC.
   - **Target masks:** one greyscale image per frame marking the anomaly's pixels.
   - **Labelled previews:** copies of the labelled frames with the anomaly outlined in red.
3. Press **Generate**. When an output is ready its badge turns green; click a badge to open it.

The labels (`annotation.json` and `labels.jsonl`) are still written automatically for every capture. Target masks are recorded during every capture too, but stay hidden until you generate them.

To remove a capture you don't need, click **⋯ → Move to Recycle Bin** on its row.

## 5. Clearer labelled previews

- **Solid red outline:** follows the object's exact visible pixels, taken from its target mask, and names the anomaly (for example "Corrupted texture").
- **Dashed red box:** used when no mask was recorded for that object. It shows the label's approximate area.

## 6. Recent fixes

- **Custom length** now works whichever length you had selected before. It used to work only after choosing "Until I stop".
- If the Custom box is empty, **Start capture** stays disabled and shows "Enter a frame count". It no longer starts an endless capture.
- Connecting is more reliable when the game is started from the editor or from Visual Studio.

## Please note

- **Don't run the old `Run.bat` alongside the new dashboard.** Its helper windows (Anomaly Watcher, Anomaly Overlay Inspector) still make videos and old-style box previews automatically in the same captures folder. Close them if they're open.
- **Requirements:**
  - Windows 10 or 11.
  - A **Development** or **Test** build of the game. The capture features aren't included in Shipping builds.
  - `IAI.Server.Start` run in the game, by hand or from the launch command.

## What a capture folder contains

| Item | When it appears |
|---|---|
| `Actual_Frames/`: the captured images | Always |
| `annotation.json`: labels, one entry per anomaly | Always |
| `labels.jsonl`: labels, one line per frame | Always |
| `run_summary.json`: technical details of the run | Always |
| `Video_Clip/<capture>.mp4` | After you generate **Video** |
| `target_mask/` and `mask_map.json` | After you generate **Target masks** |
| `annotated/` | After you generate **Labelled previews** |

For a step-by-step guide, see `QUICKSTART.md`.
