# Volleyball Hitting Analyzer

A local web app that analyzes a hitter's movement from a video. Your videos never leave your computer.

## Start

1. Double-click **Volleyball Analyzer.html**. It opens in Chrome or Edge.
2. Click **Open video**, or drag a clip onto the player. To try it out, use `IMG_0335_compatible.mp4`.
3. Press **Analyze video**. The first time, the app downloads Google's MediaPipe body-tracking model (about 10 MB), so you need internet once. After that your browser caches it.

## Workflow

| Step | What to do |
|---|---|
| 1 · Analyze body | Finds the hitter's joints in every frame and auto-detects take-off, contact and landing. If it tracked the wrong person, use **Pick hitter** and click the right one. |
| 2 · Key moments | Check each one with **Go**. To fix one, step to the right frame (← →) and press **Set here**, or press the key **T**, **C** or **L**. |
| 3 · Ball | For ball speed: turn on **Mark ball** and click the ball in 2–3 frames just after contact. **Track** follows a clear ball automatically and stops at contact. |
| 4 · Player & camera | Enter height (sets the scale) and standing reach (gives contact height). Choose **Tripod, side view** if that's how you filmed. |

Use **Save** to store an analysis as a `.json` file and **Open analysis** to reopen it. Reopening asks for the same video. **CSV** exports the numbers for Excel, and **Snapshot** saves the current frame with overlays.

## What it measures

| Metric | How | Works with handheld video? |
|---|---|---|
| Jump height, time in the air | Flight time: h = g·t²/8 | Yes |
| Contact vs. peak of jump | Contact time vs. half the flight time | Yes |
| Contact height | Standing reach + height gained at contact | Yes (needs reach) |
| Elbow / shoulder angle at contact, knee bend before take-off, knee bend on landing | 3D pose from MediaPipe | Yes (estimate) |
| Hand speed at contact | 3D wrist speed relative to hips | Rough at 30 fps |
| Gap between feet landing | Per-foot touchdown | Yes (estimate) |
| Ball speed and angle | Ball positions after contact, corrected for camera movement, scaled by player height or a reference line | Best from the side at 120/240 fps |
| Approach speed | Hip speed before take-off | Needs tripod + side view |

## Filming tips (biggest accuracy gains)

- **Side view on a tripod**, roughly at right angles to the approach, with the whole body and the ball in frame.
- **Slow-mo (120 or 240 fps).** At 30 fps a spiked ball moves about 0.8 m between frames and smears into a blur.
- **iPhone:** if Chrome won't play a clip, go to *Settings → Camera → Formats → Most Compatible*. Future clips will then be H.264, which plays everywhere.

## Files

- `Volleyball Analyzer.html`: the app (open this)
- `app/analysis.js`: measurement engine (tracking, take-off/landing detection, metrics)
- `app/app.js`: player, overlays, charts, saving
- `app/styles.css`: look and feel
