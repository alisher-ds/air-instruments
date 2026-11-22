# HANDOFF

Current state: **Stage 0.6 finished** (2026-11-23): tracking-speed test bench. Stage 0.5 (tracking in a Web Worker) stays; this stage adds diagnostics, a main-thread mode, test toggles, a one-click benchmark and a draw-only lag fix. **The real cause on the owner's laptop is NOT yet proven** (I cannot reproduce it, see below); the owner's numbers decide. Next: the owner sends numbers (see "Next step"), then Stage 1 (harp).

## Stage 0.6 — what changed

1. **Diagnostics (panel lines "worker GL", "main GL", "env", "files", "mediapipe").** The worker probes its own scope at start (`src/core/diagnostics.ts`): OffscreenCanvas yes/no, WebGL2 yes/no, the GPU name (`WEBGL_debug_renderer_info`), "software renderer?", a strict context (`failIfMajorPerformanceCaveat`; refused = software), a second context with `powerPreference: high-performance`, WASM SIMD, threads, cores. The page does the same ("main GL") and the panel says whether both see the same GPU. MediaPipe's own console lines are captured and shown (it prints `gl_context.cc ... GL version` when the GPU delegate really got a GL context; "XNNPACK" is the CPU path). Also shown: model file + folder (`float16/1`), WASM file, what was fetched and how long it took.
2. **Tracking mode switch (panel group "Tracking" -> "tracking mode"): `worker` or `main`.** `main` = MediaPipe on the main thread with the video element as input (the Stage 0 way). Worker code is kept. Delegate GPU/CPU works in both. Switching reloads the model (1-4 s); the unused backend is closed (worker terminated). The main-thread MediaPipe chunk is loaded only when main mode is used. Both modes feed the same pipeline (ids, smoothing, gestures), so instruments see no difference. **All speed settings are saved in localStorage** (`src/core/settings.ts`, key `air-instruments.speed.v1`: trackMode, delegate, workerInput, pickupOnFree, inferEvery, numHands, cameraRes, maxDpr, renderFpsCap, drawLeadEnabled; validated on load).
3. **Test toggles** (live, saved): `worker input` bitmap|canvas (bitmap drawn to an OffscreenCanvas inside the worker first), `infer every Nth frame` 1-3, `numHands` 1|2, `camera size (test)` 640x480|320x240|1280x720 (reopens the camera), `render fps cap` (0 = off), `max pixel ratio` (existing). New buttons: **Reset numbers** (restart all averages; press it after changing a setting and wait ~15 s), **Run benchmark**, **Copy report** (copies all panel lines + benchmark as text).
4. **Run benchmark** (`src/core/benchmark.ts`): pauses live tracking, loads MediaPipe on the MAIN thread (GPU, then CPU) and feeds the live camera 30 frames each as video element / ImageBitmap / OffscreenCanvas copy, then prints avg/p95 and "hands in x% of frames". It isolates the input path from the thread and the delegate on the owner's own hardware. Hands must be in view.
5. **Draw-only lag fix (panel group "Draw lag fix", default ON).** The skeleton is drawn shifted forward by (now - camera capture time of the landmarks) using velocities, via `predictLandmarksInto` in `src/core/predict.ts` (palm velocity at wrist/knuckles, fingertip velocity at the tips, linear in between). Capped by `drawLeadMaxMs` 150 and `drawLeadMaxShift` 0.5 x handSize per joint (it cannot fly far when a hand stops). Instruments still get the unshifted `HandFrame`. It is only visible while "show hands" or the panel is on (the only place the skeleton is drawn). Unit-tested; the code path ran without errors in the browser, but I have NOT seen it with a real moving hand.
6. Extra stats: render frame gap (avg/p95/max between drawn frames), camera frames "missed by the browser" (from `presentedFrames`; proves the main thread was blocked), "skipped by infer every", "worker busy", "% of each second the main thread spends inside MediaPipe" (main mode), the camera's real size/fps.
7. Tests: 106 passing (new: settings, diagnostics helpers, benchmark helpers, `predictLandmarksInto`). Build passes. Worker, AudioWorklet and the main-thread MediaPipe chunk load in `npm run preview` (production): worker ready delegate GPU, worklet ok, main mode ready delegate GPU.

## Speed investigation: what I measured, and what I could NOT

**I cannot see the owner's camera or his GPU.** I ran in the Claude app's built-in browser (Chrome 152 engine) on a machine with an **Intel Iris Xe GPU, 12 cores**, with a "fake camera": a still photo of two hands (MediaPipe's own sample image `woman_hands.jpg`, slowly shifted sideways, 640x480). MediaPipe found hands in 100% of the frames. That window is throttled and partly hidden: render fps (2-27) and camera fps (4-17) there are **not meaningful**; only the inference ms are usable, and from only ~4-7 frames per second. Treat everything below as "what the code path does on an Intel laptop GPU", not as the owner's numbers.

| Mode (my environment, hands in view) | inference avg / p95 (ms) | frame age avg (ms) | notes |
|---|---|---|---|
| WORKER, GPU, input bitmap (live) | 62-63 / 80-87 | 71-76 | first run had warm-up spikes up to 766 ms in the first frames |
| WORKER, GPU, input canvas | 67 / 114 | 77 | no gain over bitmap |
| MAIN, GPU, video element (live) | 48 / 62 | 49 | blocks the main thread |
| Benchmark: main GPU, video element | 46.4 / 60.0 | - | |
| Benchmark: main GPU, ImageBitmap | 45.1 / 56.7 | - | +0.7 ms to create the bitmap |
| Benchmark: main GPU, OffscreenCanvas copy | 47.7 / 61.2 | - | +0.7 ms |
| Benchmark: main CPU, video element | 64.5 / 77.6 | - | |
| Benchmark: main CPU, ImageBitmap | 63.9 / 82.8 | - | |
| Benchmark: main CPU, OffscreenCanvas copy | 62.9 / 78.2 | - | |

What this shows (and what it does not):
- **Input type is NOT the cause here**: video element, ImageBitmap and canvas copy are within noise on the same GPU. "ImageBitmap forces a slow upload path" is not supported by my data (it could still differ on the owner's driver: the benchmark button tests exactly this on his machine).
- **The worker's WebGL really is the GPU here**: worker GL = main GL = Intel Iris Xe, software: no, strict context OK, and MediaPipe logs `gl_context.cc: GL version 3.0 ... WebGL 2.0` inside the worker. So on this machine the GPU delegate is NOT silently falling back to a software path in the worker. **The owner's hypothesis (silent fallback in the worker) is not reproduced here.** Whether it happens on his laptop is what the "worker GL" line will tell: SwiftShader / Microsoft Basic Render Driver / "strict context REFUSED" / a different GPU than "main GL" would be the cause.
- **The worker costs ~15-20 ms more than main here (62-67 vs 46-48)**, not 65 ms (his 105 vs 40). I could not separate the reasons. The candidate I could not test: GPU contention (the page rendering at 60 fps uses the same GPU as MediaPipe in the worker); my window cannot render at 60 fps. On his laptop the test is: `render fps cap` 30, or `max pixel ratio` 1, **Reset numbers**, wait 15 s; if worker inference avg drops, contention is the cause.
- **CPU vs GPU**: GPU 46 vs CPU 64 ms on the main thread here: with hands in view the gap is smaller than the 2.5-3x I saw in Stage 0.5 without hands. The owner's CPU worker 100 ms vs GPU worker 105 ms (almost equal) is consistent with "the GPU is not helping inside his worker".
- **Why render was 12 fps on the main thread (his old numbers)**: arithmetic: 26-29 tracking fps x 38-40 ms = 100-110% of every second inside `detectForVideo`, which blocks the main thread; rendering only gets the gaps. A ~40 ms blocking call can never leave room for 60 fps (16.7 ms frames). `infer every 2` halves the blocking (~55-60% busy) and should lift render to roughly 25-30 fps, not 60: **main mode cannot give 60 fps render with a 40 ms blocking inference, by construction.** The panel shows "main thread inside MediaPipe: X%", "missed by the browser" and the render gap p95/max in main mode, which prove this on his machine. GPU contention and the synchronous readback inside `detectForVideo` are part of the 38 ms and cannot be moved out of the main thread in this mode.
- **Other causes checked**:
  - Model: only one bundle exists (float16/1), no lite/full option (checked in Stage 0.5).
  - Options: `numHands` 2 (now a toggle), confidence 0.5/0.5/0.5 (constants, unchanged: lower presence/tracking thresholds would only make the expensive palm detector run less often). MediaPipe resizes the input to its own small tensors whatever the camera size, so camera size mostly changes only the upload cost. 640x480 -> 320x240 works (camera reopens), but on my fake camera the numbers were too noisy to claim an effect.
  - `self.import` + indirect `eval` shim: it only changes how the loader script starts; the WASM is compiled and run by the browser as usual. Worker and main inference are within ~15 ms of each other here, so the shim does not force a slow path. (I could not run the worker without it: a module worker cannot load MediaPipe without it.)
  - SIMD yes. Threads: no (no cross-origin isolation), but the `@mediapipe/tasks-vision@1.2.3` WASM in `node_modules` is a single build with no pthread worker file, so threads would not be used even if available. The CPU delegate is single-thread XNNPACK.
  - WebGPU exists in the browser but this MediaPipe version has no WebGPU delegate for hand tracking.
- Load: model fetch ~3 s on first load (7.8 MB), WASM 70 ms (cached), total load 3.4-3.8 s.

## Recommended default (provisional)

Evidence I have: main mode has lower inference and lower frame age (49 vs 71-76 ms here; 38-40 ms vs 105 ms on the owner's laptop) but blocks rendering (his 12 fps). Worker mode keeps render smooth but on his laptop the model is 2.5x slower for a reason I could not reproduce. **I leave the default at worker + GPU (unchanged from Stage 0.5) because I have no number from the owner's laptop that justifies a change.** The switch is saved in localStorage, so once the owner picks the best row from his numbers it stays on his machine; the repository default should then change to that row (one line in `DEFAULT_CONFIG`).

Options if the worker stays slow on his laptop (not built; each needs the owner's OK because it changes visuals or the render path):
1. **Video as a real `<video>` element under a transparent canvas** (the compositor draws/dims/mirrors it, the canvas only draws effects). Removes the full-screen video draw from the canvas GPU work. Touches the Stage 6 "record canvas" plan and the additive-glow look. Worth it only if the render fps cap / pixel ratio tests show contention.
2. **`infer every 2` in main mode + the draw lag fix**: tracking 15 fps, render ~25-30 fps.
3. **Prediction for the instruments** (`predictedTip`, Stage 1) to hide frame age for the harp.

## Known issues added in 0.6

- "Frame age" has no camera delay in it if the browser gives no capture time (the panel warns).
- If GPU fails at load or on a real frame the app drops to CPU and **saves "CPU" to localStorage** (the panel setting switches to CPU). Switch back to GPU in the panel if it was a one-off.
- Camera size toggle is a test: very low resolutions can lose small or far hands.
- The draw lag fix and the render fps cap have not been seen with a real camera in a real 60 fps window.
- The benchmark loads two more MediaPipe instances while the worker's one stays loaded (more GPU memory for ~25 s).
- `.claude/launch.json` (dev/preview servers for the Claude app) is local only (listed in `.git/info/exclude`), not committed.

## Stage 0.5 — what changed (still true)

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

1. **Owner runs the app on his laptop with both hands in view**, presses **D**, and for EACH of these settings (switch in the panel, press **Reset numbers**, wait ~15 s, press **Copy report**, paste to the agent):
   - A: tracking mode **worker**, delegate **GPU** (the default)
   - B: **worker**, **GPU**, **render fps cap 30** (tests GPU contention)
   - C: tracking mode **main**, delegate **GPU**
   - D: **main**, **GPU**, **infer every 2**
   Numbers wanted per setting: render fps, tracking fps, inference avg/p95, frame age avg/p95 and the **"worker GL" line** (the "main GL" and "same GPU" lines once).
2. Then press **Run benchmark** once (hands in view, ~25 s) and paste the benchmark block too.
3. Agent decides from those numbers: change `DEFAULT_CONFIG` (trackMode / delegate / renderFpsCap) and/or build option 1 (video element layer) if B is much faster than A.
4. Then **Stage 1: Harp** (strings, pluck detection, Karplus-Strong worklet in `src/audio/worklets/ks-string.ts` loaded with `?worker&url`, scales; add render-side interpolation; use `predictedTip` for pluck detection).

## Tunables the owner should test (debug panel, key D)

| Tunable | Default | What to try |
|---|---|---|
| `tracking mode` | worker | worker vs main: compare frame age and render fps. |
| `render fps cap` | 0 | 30 or 15: if worker inference drops, the GPU is shared with rendering. |
| `infer every Nth frame` | 1 | 2 in main mode gives rendering room. |
| `worker input` | bitmap | canvas: a different upload path (no gain in my tests). |
| `draw skeleton ahead` | on | With show hands on: does the skeleton stay on the moving hand? Overshoot when stopping: lower max shift. |
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
