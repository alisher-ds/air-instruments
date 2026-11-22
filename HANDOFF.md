# HANDOFF

Current state: **Stage 0.7 finished** (2026-11-23): cut the render GPU cost. Stage 0.5 (tracking in a Web Worker) and 0.6 (test bench) stay. The owner proved with his own numbers that the render steals GPU time from MediaPipe (render 60 fps uncapped: inference ~102 ms; render capped at 20 fps: ~62 ms). This stage makes the render much cheaper and adds a one-click "Compare render settings" table. **Owner's table is in (see "Owner's result" below): the video element and the render scale did NOT help; only a lower render FRAME RATE helped. Goal (inference <= 45 ms) is NOT reached.** Defaults changed to render cap 30, scale 1. Next: one more measurement (see "Next step"), then Stage 1 (harp).

## Stage 0.7 — owner's result (Intel Iris Xe, window 1920x970, dpr 1.0, worker + GPU, both hands, synthetic harp-like load ON)

```
case                                      render fps | inference avg / p95 | tracking fps | frame age avg / p95
1. old: video in canvas, 1.0, no cap         59.3    | 132.6 / 134.6       | 7.5          | 158 / 218
2. new: video element, 1.0                   58.8    | 137.3 / 164.7       | 7.2          | 187 / 218
3. video element, 0.75                       59.3    | 134.4 / 148.9       | 7.4          | 183 / 218
4. video element, 0.5                        59.5    | 133.8 / 147.8       | 7.4          | 178 / 220
5. video element, 0.5, cap 30                29.9    |  91.7 / 122.8       | 10.7         | 145 / 187
6. EXPERIMENT: element, 1.0, 2D software     59.3    | 134.0 / 148.3       | 7.4          | 185 / 214
```
Live panel line at the same time (cap 20, scale 0.75, NO synthetic load): inference avg 61 (p95 102), tracking 16 fps, frame age avg 95; **"hands in view: 87.1 ms (52 fr) | no hands: 38.1 ms (59 fr)"**.

What this means (my reading, not proven beyond the rows):
- **Rows 1-4 and 6 are the same within noise.** Moving the video out of the canvas, rendering at 0.75 or 0.5 (4x fewer pixels) and CPU 2D drawing all changed nothing. So the cost is **not pixel fill and not the video draw**. The only thing that moved inference is the **number of rendered frames per second** (row 5: 60 -> 30 fps: 134 -> 92 ms, tracking 7.4 -> 10.7 fps). Working hypothesis (NOT tested): every rendered frame sends GPU work through the same GPU process / GPU queue as MediaPipe's long WebGL batches, so the cost is per frame (scheduling/flush), not per pixel.
- **The earlier "38-40 ms" and "62 ms" numbers were probably MIXED with no-hands frames.** The panel shows no-hands 38 ms vs hands 87 ms even at a 20 fps render with no heavy load: with hands MediaPipe runs the hand-landmark model for each hand (x2) on top, no-hands only runs the palm detector. So with two hands the realistic floor on this GPU may be ~80-90 ms whatever the render does. **If so, "inference <= 45 ms with two hands" cannot be reached by render changes at all** and needs a different lever (numHands 1, infer every 2 + prediction, lower camera size, or accepting ~90 ms and hiding it with prediction/draw-ahead). This is the next thing to find out.
- The synthetic load is heavy (it pushed inference from ~87 to ~134 ms at 60 fps vs the live no-load panel), so rows are pessimistic compared with the real harp; the relative differences are what counts.
- Row 6: software 2D gives no gain. **Drop it** (left as a hidden test toggle, off).
- **Defaults changed in this follow-up:** `renderFpsCap` 0 -> **30** (the only thing that helped; PLAN allows "a stable 30 if 60 is impossible") and `renderScale` 0.75 -> **1** (no measured gain, so no reason to soften the picture). The owner's browser still has his own saved settings (cap 20, scale 0.75) in localStorage; press Reset in the panel or change the sliders to take the new defaults.
- **Floor measurement (owner, render cap 5, scale 1, no synthetic load, worker + GPU, numHands 2):** hands in view **70.2 ms** (405 frames), no hands 42.1 ms; inference avg 65 / p95 88; tracking 16 fps; **camera only 15 fps** (panel says "@30 fps" is what the camera was asked for; Windows webcams drop to 15 fps in dim light); frame age avg 103 / p95 148. So with almost NO render the two-hand inference is still ~70 ms, and render cap 30 (row 5, with the heavy synthetic load) was ~92 ms. **Render is therefore not the main cost: at most ~20 ms of the gap is render, ~70 ms is MediaPipe itself on this GPU. The goal inference <= 45 ms with two hands cannot be reached by render changes.** Also: tracking fps is capped by the camera's real fps (15); in dim light the webcam may deliver only 15 fps, which adds up to ~66 ms of waiting to the frame age. Untested ideas: more light on the hands (camera back to 30 fps), numHands 1, camera 320x240.
- **Lamp test (owner, more light, same settings as the floor test):** camera now **31 fps** (was 15), but hands-in-view inference is unchanged (**69.8 ms**, 306 frames; no hands 33.7 ms) and frame age avg **98** / p95 136 (was 103 / 148). The panel's "tracking 30 fps" at that moment is an average that includes cheap no-hands frames; with hands MediaPipe cannot go faster than ~1000/70 = ~14 fps. So more light fixes the camera fps but NOT the frame age: it is ~70 ms inference + ~30 ms transfer/waiting. Stage 1 must plan for ~100 ms frame age with hands (use `predictedTip`, draw-ahead for visuals).
- **PLAN.md proposal (NOT applied, owner decides):** the new section 5 bullet says (1) video element and (2) reduced-resolution effects are how to keep render cheap. The measurement does not support that on this laptop; what is supported is "render frames per second cost tracking time, cap the render at 30". Suggest rewording the rule to: "render must stay cheap: cap render fps (30) and keep the per-frame GPU command count low; reduced resolution did not help on Intel Iris Xe".



## Stage 0.7 — what changed

1. **The camera is no longer drawn into the canvas.** The tracker's own `<video>` element (class `cam`, `src/style.css`) becomes the visible camera layer (class `layer`): CSS `object-fit: cover|contain`, `transform: scaleX(-1)`, dim = the video's own CSS opacity (`1 - videoDim`) over the dark page background (the same picture as before: video at `1-dim` over `#05060a`). The canvas above it is transparent and draws only effects. Layer order: video 0, effects canvas 1, sharp skeleton canvas 2, UI 3. **Alignment:** `cssVideoPoint()` in `src/render/renderScale.ts` does the CSS maths independently of `fitTransform`; a test proves both give the same point for cover and contain on 4 window shapes. In the browser the skeleton also sat on the hands with a fake camera (cover). I did not check it with a real moving hand.
2. **Render scale** (`renderScale` 0.5 / 0.75 / 1, panel group View, saved). Effects canvas backing store = window x screen ratio (devicePixelRatio, capped by `maxDpr` and the hard cap 2) x scale; its CSS size stays the full window, so the browser upscales it. Instruments still draw in CSS pixels (they do not see the scale). **Skeleton stays sharp:** at scale < 1 the skeleton is drawn into a separate full-resolution canvas (`#overlay`, created lazily, `display:none` when the skeleton is off); at scale 1 it goes into the normal canvas. Checked by screenshot at 0.5: strings and sparks soft, skeleton lines crisp.
   **Default is 0.75 and PROVISIONAL.** I have no usable measurement (see below). Right now the canvas draws almost nothing, so the scale matters only once there are effects; 0.75 is the cheap-but-safe pick. Change `renderScale` in `DEFAULT_CONFIG` after the owner's table.
3. **Software 2D experiment** (`software2d`, off by default, saved): creates the 2D context with `willReadFrequently: true` (Chrome then draws on the CPU and uploads the result). A canvas can only get its context once, so switching replaces the `<canvas>` element (same id); the renderer reads `renderer.ctx` fresh every frame. **Result: unknown.** It runs without errors (it was case 6 of a full comparison in my browser) but I have no valid numbers. It is row 6 of the comparison so the owner's table answers it. Keep it only if row 6 clearly beats row 2 and still looks smooth.
4. **Render fps cap** kept (slider 0..60 step 5; use 30 or 20; 0 = off). **"Auto" idea (NOT built, as asked):** measure inference avg for a few seconds; if it is above the target (e.g. 45 ms) lower the render cap 60 -> 30 -> 20 and/or `renderScale` 1 -> 0.75 -> 0.5, and raise them again when inference has been well under target for ~10 s. Needs a hysteresis so it does not oscillate, and must never touch tracking.
5. **"Compare render settings" button** (debug panel, first button; `src/core/renderBench.ts`, wired in `main.ts`). Flow: 5 s countdown with the on-screen message "Keep BOTH hands visible to the camera", then 6 cases, ~10 s each (1.2 s settle first): 1 old (video in canvas, 1.0, no cap), 2 new (video element, 1.0), 3 element 0.75, 4 element 0.5, 5 element 0.5 + cap 30, 6 EXPERIMENT element 1.0 + software 2D. Each prints: render fps, inference avg/p95, tracking fps, frame age avg/p95, hand samples ("N of M", share with two hands). **Samples with no hand are discarded.** A case runs on (up to 20 s) until it has 40 hand samples; a row with fewer than 25 says "TOO FEW, do not trust". Tracking fps is computed only from consecutive results that both had a hand (a gap with no hands does not look like slow tracking). The debug panel is hidden during the run (it covers the picture) and comes back with the table; the same button turns into "Stop comparing". All settings are put back afterwards and nothing is saved by the run. **Copy report** includes the table. Choices to know about:
   - During the run a **synthetic harp-like effects load** is ON (`src/render/testLoad.ts`: 12 glowing strings with 3 additive stroke layers, 120 glow sprites, 4 big soft blobs; no shadowBlur) and the skeleton is hidden. Reason: the canvas has nothing to draw yet, so without it scales 1.0 / 0.75 / 0.5 could not differ. It is a stand-in for the harp, not a measurement of the harp. The same load is a panel toggle (`synthetic effects load`, not saved).
   - Row 6 (software 2D) is an addition to the five rows asked for, so the experiment gets an answer in the same run (run time ~1.5 min).
   - The tracking mode and delegate stay as the owner has them set (report header says which).
6. **Panel:** the render line now shows the window size AND the effects canvas size in real pixels, and a "layers" line (video element/canvas, scale, 2D GPU/software, test load). `HandTracker.onSample` (new, tiny) hands raw per-result numbers to the comparison. Worker architecture, gestures, instruments, draw-ahead logic: untouched.
7. **PLAN.md updated (owner approved):** section 4 tree now lists `trackerWorker.ts` (and the new renderer description), the "Tracking loop" and "Known risk" bullets in section 5 are rewritten for the Worker design, and a new bullet records the measured finding and the rule "render must stay cheap; heavy effects are drawn at a reduced internal resolution".
8. Tests: **123 passing** (new: render scale maths + CSS-vs-canvas mapping, comparison collector/table/runner with a fake clock, settings). `npm run build` passes. **Production preview checked** (`npm run build` + `vite preview`): the Worker loads (`worker ready, delegate GPU`, hands found), the AudioWorklet loads (`worklet ok`), canvas 960x720 at default scale 0.75 in a 1024x768 window at dpr 1.25.

### What I measured, and what I could NOT (Stage 0.7)

- I ran the full comparison (all 6 cases, fake camera with the MediaPipe sample photo of two hands, production build). The window I have renders at ~1 fps and the camera stream at ~1 fps, so every row said render 1.0 fps, tracking 1.0 fps, inference 104-120 ms, "TOO FEW" samples. That proves the button, the countdown, the discard rule, the restore of settings and the table work. **It says nothing about GPU cost.** I am not quoting those numbers as findings.
- Not seen with a real camera or real moving hands: alignment of the skeleton in "contain" mode (only the unit test), the draw-ahead skeleton on the new layers, 60 fps.
- Possible cost of the new layers that I could not measure: the compositor now draws the video (opacity < 1) and the canvas as two layers. The old way drew one canvas.
- Not built, on purpose: Stage 6 "record canvas" now needs to draw the `<video>` and the canvas together into a hidden canvas **only while recording** (the video is no longer inside the canvas). Proposal for Stage 6, PLAN.md section 7 is unchanged.

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
1. ~~**Video as a real `<video>` element under a transparent canvas**~~ **Built in Stage 0.7** (after the owner's numbers showed render contention).
2. **`infer every 2` in main mode + the draw lag fix**: tracking 15 fps, render ~25-30 fps.
3. **Prediction for the instruments** (`predictedTip`, Stage 1) to hide frame age for the harp.

## Known issues added in 0.6

- "Frame age" has no camera delay in it if the browser gives no capture time (the panel warns).
- If GPU fails at load or on a real frame the app drops to CPU and **saves "CPU" to localStorage** (the panel setting switches to CPU). Switch back to GPU in the panel if it was a one-off.
- Camera size toggle is a test: very low resolutions can lose small or far hands.
- The draw lag fix and the render fps cap have not been seen with a real camera in a real 60 fps window.
- The benchmark loads two more MediaPipe instances while the worker's one stays loaded (more GPU memory for ~25 s).
- `.claude/launch.json` (dev/preview servers for the Claude app) is local only (listed in `.git/info/exclude`), not committed.
- (0.7) `videoFit` "contain" and the draw-ahead skeleton on the new layers were not seen with a real hand; with the video as a separate element, the video is no longer in the canvas (matters for Stage 6 "Record performance", see Stage 0.7).

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
4. ~~PLAN.md suggestions (tree, "Known risk", "Tracking loop")~~ **Done in Stage 0.7** with the owner's approval.

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

1. ~~Find the floor~~ **Done: ~70 ms with two hands (see above).** Old text: Owner, panel open (D), both hands in view, render fps cap **5** (slider), synthetic load OFF, **Reset numbers**, wait 15 s, **Copy report**: the line "session hands in view: X ms" is MediaPipe with two hands and almost no render. Repeat with **numHands 1** (one hand in view) and with cap 30. If the floor with two hands is ~85 ms, render is NOT the main cost any more and the goal needs another lever.
2. (Superseded: the floor is ~70 ms, so the first branch applies.) Agent then decides: if floor ~ cap-30 row (~90 ms): keep cap 30, stop tuning render, and work on hiding latency (draw-ahead exists; `predictedTip` for the harp; `numHands` 1 where an instrument allows it; `infer every 2` is likely worse for frame age). If floor is much lower (< 60 ms): the per-frame GPU command count matters; look at what a rendered frame sends to the GPU (compositor layers, canvas flush) and try cap 20 / fewer layers.
   - Possibly extend "Compare render settings" with cap 20 and cap 10 rows and a no-load variant.
3. Then **Stage 1: Harp** (strings, pluck detection, Karplus-Strong worklet in `src/audio/worklets/ks-string.ts` loaded with `?worker&url`, scales; add render-side interpolation; use `predictedTip` for pluck detection).

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
| `render scale` | 0.75 | 0.5 / 0.75 / 1: internal resolution of the effects canvas (CSS upscales it). Lower = less GPU. Best value comes from "Compare render settings". |
| `video layer` | element | `canvas` = the old way (video drawn into the canvas), only to compare. |
| `2D canvas in software (test)` | off | On = CPU-drawn canvas. Does inference drop? Does it stay smooth? |
| `synthetic effects load (test)` | off | On = harp-like glow so render settings can be judged before the harp exists. |
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
