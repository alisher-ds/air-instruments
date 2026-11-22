# HANDOFF

Current state: **Stage 0.5 finished** (2026-11-23): hand tracking now runs in a Web Worker. Stage 0 (project, tracking core, debug panel, record/replay) is unchanged underneath. Next: the owner measures the new numbers on his laptop (see "Next step"), then Stage 1 (harp).

## Stage 0.5 — what changed

1. **Tracking runs in a module Web Worker.** `src/core/trackerWorker.ts` (built by Vite as a separate `dist/assets/trackerWorker-*.js`, ES module worker, `worker.format: "es"` in `vite.config.ts`). It owns MediaPipe `HandLandmarker`.
   - Main thread (`HandTracker` in `src/core/tracking.ts`) keeps the camera and the `requestVideoFrameCallback` loop. For each new camera frame it does `createImageBitmap(video)` and **transfers** the bitmap to the worker (zero-copy). The worker answers with the landmarks (a small `Float32Array`, transferred) and its own measured inference time.
   - **At most ONE frame in flight** (`src/core/frameGate.ts`, tested). If the worker is busy the camera frame is dropped. There is no queue. A watchdog frees the gate after 2 s if an answer is ever lost.
   - **The main thread never waits.** Rendering is the normal `requestAnimationFrame` loop and draws the latest landmarks. Smoothing, hand ids, gestures, `HandFrame`, `Instrument` contract: untouched (`TrackManager`, `HandPipeline`, `HandAnalyzer`, all old tests still pass). The pipeline is still timed with the main-thread arrival time of the landmarks, like before.
   - Messages and landmark packing: `src/core/trackerProtocol.ts` (tested round trip).
2. **PLAN.md section 5 updated** (owner decision): AudioWorklet loading uses `?worker&url`, with the reason. Nothing else in PLAN.md was changed.
3. **Debug panel (D)** now shows: render fps + JS time per frame (+ video-draw part) + pixel ratio; tracking fps, camera fps and how many camera frames were not sent; worker state and the delegate really running; **inference ms (now/avg/p95/max, measured inside the worker)**; **frame age** (camera capture to landmarks on the main thread: now/avg/p95); grab ms and worker round-trip ms; with-hands vs no-hands inference averages. Text refreshes 4 times a second and does no work at all while the panel is hidden.
4. **Live toggles** in the panel (group "Tracking"): **delegate GPU / CPU** (reloads the model in the worker, 1-3 s; the stats window restarts so the numbers belong to the new setting) and **grab newest when free** (see deviations). If GPU fails the worker falls back to CPU itself and the panel switches to CPU and shows why.
5. **Model variant toggle: not added, because there is nothing to switch to.** Google publishes one HandLandmarker bundle (`float16/1`, same as `latest`, about 7.8 MB). I checked `float32/1`, `float32/latest`, `int8/1`: all HTTP 404. The Tasks API has no "lite/full" option. The current default is the only choice. (If more speed is needed later: `numHands: 1` for one-hand instruments, or a lower camera resolution; neither was asked for.)
6. **Predictive triggering groundwork**: `src/core/predict.ts` with `extrapolate(pos, velocity, leadMs, maxShift)` and `predictedTip(hand, finger, cfg)`. Pure, 8 tests. **Off by default** (`predictEnabled: false`). Tunables in `config.ts` and the panel (group "Prediction"): `predictLeadMs` 33, `predictMaxShift` 0.5 (x handSize, so a glitchy velocity cannot throw a point far). **No instrument uses it yet.** The harp should call `predictedTip(...)` and obey the config.
7. **Render cost work** (see findings below): pixel ratio slider `maxDpr` (hard cap 2, as in PLAN), one fewer full-screen pass, no per-frame allocations in the renderer and the hand overlay, panel updates 4x per second.
8. Tests: **86 passing** (was 67). `npm run build` passes. Replay test from Stage 0 passes unchanged.
9. Small fix on the way: the audio worklet row could show a stale "never ran" message after the worklet had in fact started late on a busy machine; the message is now cleared when the worklet reports in.

## What I verified, and what I could NOT (be careful with these)

I (the agent) **cannot see the owner's camera and cannot put a hand in front of it.** All of this was done in the Claude desktop app's built-in browser (Chrome engine, a window that is throttled and partly hidden), with a **fake camera** (an animated canvas stream, no hand in it).

Verified:
- `npm run build` + `npm run preview`: the **tracking Worker loads and runs** (`worker ready, delegate GPU`, frames flow, `createImageBitmap` -> worker -> result works) and the **AudioWorklet loads** (`worklet ok (audio thread 48000 Hz)`). Same in `npm run dev`.
- Live GPU -> CPU -> GPU switching works; stats restart; repeated slider events do not restart the model load.
- The panel text and all tunable groups render.

NOT verified:
- **Landmarks with a real hand through the worker.** The fake camera has no hand, so every result had 0 hands. The packing code is unit-tested and the worker code path with hands is the same call as before (`detectForVideo` on an image), but no hand has gone through it yet. The owner's first run is the real test.
- **Frame age with a real camera.** The fake stream gives the browser no capture time, so the panel showed "no capture time" and the age was too small. Real webcams in Chrome normally provide `captureTime` in `requestVideoFrameCallback`. If the panel on the owner's laptop also says "no capture time", tell the agent: then frame age starts at the moment the browser hands us the frame, and the camera's own delay (typically 30-60 ms) is missing from it.
- **Real render fps.** The built-in browser's `requestAnimationFrame` ran at 1.5 to 19 fps in my tests (throttled window), so my render fps is meaningless. I could not reproduce the owner's "12 fps" or check that the worker brings it back to 60.
- Numbers I did get (fake camera, no hands, GPU, throttled window), only to show the panel works: inference avg 22 to 25 ms, p95 33 ms; CPU delegate 57 to 79 ms avg. On this machine GPU was 2.5-3x faster than CPU. Do not use them for decisions.

## Render cost: what I found

Owner's measurement before the worker: render 12 fps while inference averaged 38-40 ms. Inference on the main thread blocks it for the whole call, so with a ~40 ms call and tracking at ~26 fps, the render loop was starved. **That is by far the most likely main cause, and the worker removes it.** Other things I found by reading the code and fixed:

| Finding | Fix |
|---|---|
| 3 full-screen passes per frame: clear fill, video, dim overlay fill | dim folded into the video draw (`globalAlpha = 1 - dim` over the dark background): 2 passes. The background fill is skipped when the video covers the canvas and dim is 0 |
| Pixel count: the canvas is CSS 1920x970; at pixel ratio 1.25 / 1.5 / 2 that is 2.4 / 2.8 / 7.4 million pixels to fill every frame, shared with the GPU that MediaPipe also uses | `maxDpr` slider (1 to 2, hard cap 2); the renderer re-sizes live |
| `fitTransform` object and the `rgba(...)` dim string rebuilt every frame | cached, no per-frame allocations in `beginFrame` |
| Hand overlay (drawn every frame while the debug panel is open, i.e. while the owner measures): 21 separate `beginPath/arc/fill` per hand + ~25 template strings per hand per frame | joints batched into 2 paths per hand, constant colour strings, one save/restore for all hands |
| Debug panel: stats rebuilt 10x/s, and `getStats()` (sorts samples) ran even with the panel hidden | 4x/s, and no stats work when hidden |
| `getStats` sorting arrays with `shift()` on each sample | ring buffer (`RollingStats`), no allocation per sample |

What I could not measure: the real GPU cost of the full-screen passes. I tried a micro-benchmark in the built-in browser; Chrome skips overdrawn work and the window is throttled, so those numbers were useless and I am not quoting them. The panel now shows the JS time per render tick (0.3 to 0.4 ms in my environment: the JS side is not the problem; the GPU side is what the `maxDpr` slider tests).

A bigger change I did **not** make (it touches the Stage 6 "record canvas" plan): put the video in its own `<video>` element under a transparent canvas, so the compositor draws and dims the video for free and the canvas only draws effects. Worth doing only if the numbers on the owner's laptop say the full-screen passes still hurt.

## Deviations / decisions to confirm

1. **Worker needs a small shim for MediaPipe (`self.import`).** MediaPipe loads its WASM glue with `importScripts()`, which does not work in a module worker, and the fallback (`import()`) fails with `ModuleFactory not set` (I hit this error). `trackerWorker.ts` therefore defines `self.import`, a hook MediaPipe itself looks for: it `fetch`es the glue file (same pinned jsdelivr URL) and runs it with an indirect `eval`. Needs a page without a strict CSP (GitHub Pages / Vercel have none by default). The alternative is a classic worker (`worker.format: "iife"`), but then dev and build would differ in how workers load, which is exactly the trap the AudioWorklet fell into. Tell the agent if you prefer that.
2. **"Grab newest when free" (`pickupOnFree`, on by default).** The brief says: if the worker is busy, drop the new frame. I do that, but with one refinement: when the worker finishes and a newer camera frame arrived meanwhile, that newest frame is sent immediately instead of waiting for the next camera frame. Still max one in flight, still no queue, older frames are dropped. Without it, a ~40 ms inference on a 33 ms camera would idle until the next camera tick and tracking would fall toward 15 fps. It is a live toggle: untick it in the panel to get the literal behaviour and compare.
3. All the Stage 0 deviations still stand (`?worker&url` for worklets, now approved and in PLAN; extra small files; 5 tips instead of 4; side by screen position).
4. **PLAN.md suggestions (not changed, owner decides):** section 4 file tree should list `core/trackerWorker.ts`, and the "Known risk" bullet and the "Tracking loop" bullet in section 5 now describe the old main-thread design.

## What is NOT done (on purpose, later stages)

- No real instrument, no sound except the Beep test. No reverb yet (it goes before the limiter, Stage 2).
- Render does not interpolate hand positions between tracking frames (PLAN section 5). With the worker, tracking fps may be 20-30 while render is 60: Stage 1/2 should add the interpolation when the strings need smooth visuals.
- Predictive triggering exists as a function but no instrument calls it.
- No "lighting check" hint, no "Record performance" video, no deploy config beyond `base: "./"` (Stage 6).
- `Hand` has no raw (unsmoothed) landmarks. Theremin vibrato (Stage 4) needs them.

## Known issues

- Everything about real hands, real camera timing and real render fps is untested by me (see above).
- First start downloads the model (about 7.8 MB, cached later) and the WASM glue; the start screen shows a spinner meanwhile.
- `fingerCurl` full-bend 2.2 rad is a guess; recalibrate with a real recording in Stage 5.
- `videoFit: "cover"` crops the top/bottom of the camera image on a wide screen. Switch to `contain` in the panel if the hand leaves the picture too early.
- The GPU-fails-on-a-real-frame fallback inside the worker is written but I could not force a GPU failure to test it.
- Worker load failures show the existing "Hand tracking could not load" start-screen error with a retry button.

## Next step (exact)

1. **Owner runs the app on his laptop with both hands in view** (instructions were given in chat), opens the debug panel (D) and sends back these numbers:
   - `render` fps
   - `inference` avg and p95 (this is the number measured inside the worker)
   - `frame age` avg and p95, and whether the "no capture time" warning shows
   - `tracking` fps and the "% not sent"
   - the same with the delegate switched to **CPU**, and with **grab newest when free** unticked, if he has time
   - and, if the render fps is still low, the same render fps with **max pixel ratio** set to 1
   - good config via **Copy config**
2. Agent decides from those numbers: inference above 25 ms in the worker is acceptable now (it no longer blocks rendering) but frame age is what the player feels; if frame age avg is above ~100 ms, look at camera resolution and `numHands` next.
3. Then **Stage 1: Harp** (strings, pluck detection, Karplus-Strong worklet in `src/audio/worklets/ks-string.ts` loaded with `?worker&url`, scales). Add render-side interpolation of hand positions and use `predictedTip` for pluck detection (off until the owner turns it on).

## Tunables the owner should test (debug panel, key D)

| Tunable | Default | What to try |
|---|---|---|
| `delegate` | GPU | Switch to CPU and compare inference avg/p95 and frame age. Keep the faster one that still tracks well. |
| `grab newest when free` | on | Untick and compare tracking fps and frame age. |
| `max pixel ratio` | 2 | If render fps is low, set 1 or 1.25 and see if it jumps. |
| `minCutoff` | 2.0 | Hand shakes while resting? lower it (1.0-1.5). Hand feels sticky/laggy when moving slowly? raise it. |
| `beta` | 10 | Lag on fast moves? raise it (15-25). Jitter on fast moves? lower it. |
| `pinchOn` / `pinchOff` | 0.25 / 0.35 | Pinch hard to trigger? raise `pinchOn` (0.3). Pinch flickers or sticks? widen the gap. |
| `holdMs` | 150 | How long a lost hand is kept. |
| `matchMaxDist` | 0.3 | Ids swap between hands? lower it. |
| `velocityAlpha` | 0.6 | Lower = smoother velocities but slower reaction. |
| `curlFullBendRad` | 2.2 | Make a fist: all curl numbers should be near 1. Open hand: near 0. |
| `predict`, `lead (ms)`, `max shift` | off / 33 / 0.5 | No effect yet (no instrument uses it). Leave alone until Stage 1. |
| `videoDim`, `showHands`, `videoFit` | 0.5 / off / cover | Looks only. |

Press **Copy config** and paste the JSON to the agent when you find good values.

## Stage 0 summary (still true)

- Vite 8 + TypeScript 7 (strict) + Vitest 5, **all versions pinned exactly**, including `@mediapipe/tasks-vision@1.2.3`; the WASM URL takes its version from `package.json`.
- `src/core`: `tracking.ts` (ids by nearest wrist, 150 ms hold, smoothing -> canvas pixels), `smoothing.ts` (One Euro per coordinate), `gestures.ts` (pinch with hysteresis, velocities, `tipVelocityRel`, `fingerCurl`, side by screen position), `geometry.ts`, `recording.ts` (R records smoothed landmarks, no video), `loop.ts`.
- Debug panel keys: `1-4` instruments, `D` debug, `R` record, `H` show hands. Start screen with clear camera errors and retry. Audio skeleton: one `AudioContext` on the Start click, master gain, soft limiter, one dummy AudioWorklet (**Beep** button).
- `test/replay.test.ts` replays every `test/recordings/*.json` through the gesture code. Real clips dropped into `test/recordings/` are picked up automatically.
- Instrument contract and four placeholder instruments exactly as in PLAN.md.
