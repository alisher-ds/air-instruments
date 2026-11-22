# HANDOFF

Current state: **Stage 0 finished** (2026-11-23). Next: owner tests Stage 0 with a real camera, then Stage 1 (harp).

## What is done (Stage 0)

- Project: git, Vite 8 + TypeScript 7 (strict), Vitest 5. **All versions pinned exactly** (no `^`/`~`), including `@mediapipe/tasks-vision@1.2.3`. The WASM URL takes its version from `package.json`, so it can never drift.
- `src/core/tracking.ts`: camera 640x480, HandLandmarker (VIDEO, 2 hands, GPU with CPU fallback, also falls back if the first GPU frame fails). One `detectForVideo` per NEW camera frame (`requestVideoFrameCallback`, rAF fallback). Everything mirrored.
  Stable hand ids by nearest wrist; a lost hand is held 150 ms (pinch state included), then released. Never more than 2 hands.
- `src/core/smoothing.ts`: One Euro filter per landmark coordinate (`minCutoff`, `beta`, `dCutoff` tunable live). Smoothing runs in normalized camera space, then points are mapped to canvas pixels.
- `src/core/gestures.ts`, `geometry.ts`: pinch with hysteresis (relative to `handSize`), palm centre, velocities, `tipVelocityRel`, `fingerCurl`, side by screen position, segment intersection, point-segment distance, video fit transform. All pure and tested.
- `src/config.ts`: every tunable number in one place + the list of what the debug panel shows.
- Debug panel (D): FPS, tracking FPS, inference ms (now / avg / p95 / max, plus split with-hands vs no-hands), delegate, hand skeletons, pinch ratio + ON/OFF badge, curl, audio state + worklet status, live sliders, **Copy config**, Reset, Beep, Record button. Keys: `1-4` instruments, `D` debug, `R` record, `H` show hands.
- Record & replay: `R` records smoothed landmarks (+ stable ids, no video) and downloads `air-recording-YYYYMMDD-HHMMSS.json` to the browser's Downloads folder. `test/replay.test.ts` replays every `test/recordings/*.json` through the gesture code (sanity + no-pinch-flicker checks) and checks a synthetic two-hand recording exactly. The owner's real clips dropped into `test/recordings/` are picked up automatically.
- Instrument contract (`Instrument`, `HandFrame`, `Hand`) exactly as in PLAN.md; four placeholder instruments (harp, doira, theremin, piano) in slots 1-4 that do nothing.
- Start screen (Start button, privacy line, clear errors for camera denied / no camera / camera busy / insecure page / model failed, each with a retry button).
- Audio skeleton: AudioContext created on the Start click (`latencyHint: "interactive"`), master gain, soft limiter, one dummy AudioWorklet (reports "alive" from the audio thread; **Beep** button plays a quiet 440 Hz tone through the whole chain).
- Tests: 67 passing. `npm run build` passes.

## What is NOT done (on purpose, later stages)

- No real instrument, no sound except the Beep test. No reverb yet (it goes before the limiter, Stage 2).
- Render does not interpolate hand positions between tracking frames (PLAN section 5 mentions it; Stage 1/2 should add it when instruments need smooth visuals).
- Predictive triggering (extrapolate fingertip ~1 frame ahead) is not implemented; no instrument uses it yet.
- No "lighting check" hint, no "Record performance" video, no deploy config beyond `base: "./"` (Stage 6).
- `Hand` has no raw (unsmoothed) landmarks. Theremin vibrato (Stage 4) needs them; add them then.

## Deviations from PLAN.md (please confirm or reject)

1. **Worklet loading uses `import url from "./worklets/dummy.ts?worker&url"`, not `new URL("./x.ts", import.meta.url)`.** I tested the PLAN pattern: it works in dev but in `npm run build` Vite inlines the *raw TypeScript* as a `data:video/mp2t` URI, which cannot load as a worklet. `?worker&url` compiles the file to `dist/assets/dummy-*.js` and works in dev, in `npm run build` and in `npm run preview` (verified: worklet status `ok`, audio thread ran at 48000 Hz). Suggest updating PLAN section 5 "AudioWorklet loading" to say `?worker&url`.
2. A few extra small files not in the PLAN tree: `core/recording.ts`, `ui/debugPanel.ts`, `ui/startScreen.ts`, `ui/dom.ts`, `instruments/placeholder.ts`, `instruments/index.ts`, `style.css`, plus `test/helpers/synthHand.ts` and `scripts/make-sample-recording.mjs`. Reason: keeps `hud.ts`/`tracking.ts` readable.
3. `tips`, `tipVelocity`, `tipVelocityRel` have **5** entries (thumb..pinky). The PLAN comment says "4" but lists five indices (4, 8, 12, 16, 20). `fingerCurl` also has 5.
4. Two hands: the one further left on screen is "left", the other "right" (so both are never "left"). One hand: by screen half, with a small dead zone near the centre so it does not flip back and forth.

## Measured numbers (be careful with these)

I (the agent) have **no camera access**: the in-app browser blocks the camera. So I could NOT measure inference with a real hand in view.

What I did measure, in the Claude desktop app's browser (Chrome 152 engine), GPU delegate loaded OK, window not visible on screen (it can slow the GPU), on a synthetic frame with no hand:

| Test | Result |
|---|---|
| Model + WASM load (first `detectForVideo`, includes GPU shader compile) | about 6.5 s once |
| 640x480 canvas input, 190 frames | median 11.6 ms, avg 15.9 ms, p95 35 ms (first run avg 31 ms) |
| Real `<video>` element (fake camera stream), 160 frames | avg 27 ms, p95 39.5 ms, max 154 ms |

These swing a lot (11 to 31 ms average), so **inference time is NOT conclusively known**. The owner must read the real number:

- Start the app, show both hands, open the debug panel (D), look at the line `inference ... avg ... p95 ...` and the line `session hands in view: X ms`.
- **Recommendation / decision rule:** if `avg` with hands in view is **above 25 ms** (or p95 above ~40 ms, or the render fps in the panel drops below ~45), then move tracking into a Web Worker. I have **not** moved it, as instructed; this needs the owner's OK. If avg is under 25 ms, keep it on the main thread. Write the owner's number here: `inference avg with hands: ____ ms, p95: ____ ms, render fps: ____`.
- Why a Worker would help: inference blocks the main thread for its whole duration, so with ~30 ms per frame the 60 fps rendering drops. A Worker costs roughly one extra frame of latency but frees the main thread.

Other numbers: audio output latency is shown in the panel (browser-reported, `baseLatency + outputLatency`). 67 tests, all pass. Bundle: ~31 kB app + 154 kB MediaPipe JS (loaded after Start) + the model (roughly 8 MB, from Google, cached by the browser).

## Known issues / things I could not verify

- Never run against a real camera or real hands by me. Tracking quality, pinch reliability and default smoothing values are **untested on real hands**; defaults are reasoned guesses (see tunables).
- The built-in browser was hidden (0x0 window), so I could not look at the rendered UI (layout of start screen, HUD, debug panel). The DOM and logic were checked; the look was not. Owner: please tell me if anything looks wrong.
- `fingerCurl` uses the bend angle at the middle joint; fully-bent = 2.2 rad is a guess. Recalibrate with a real recording in Stage 5.
- Camera framing: `videoFit: "cover"` fills the screen but crops the top/bottom of the camera image on a wide screen. Switch to `contain` in the panel if the hand leaves the picture too early.
- GPU fallback code path (CPU) is written but I could not force a GPU failure to test it.

## Next step (exact)

1. Owner runs the app with a real camera (instructions given in chat), checks: both hands tracked, skeleton follows smoothly, pinch badge turns ON/OFF reliably, records a clip with `R`.
2. Owner copies inference numbers (above) and, if it feels laggy or jittery, the tuned config via **Copy config**, and gives them to the agent.
3. If inference > 25 ms: decide about the Web Worker (separate small task, owner approves first).
4. Then start **Stage 1: Harp** (strings, pluck detection, Karplus-Strong worklet in `src/audio/worklets/ks-string.ts`, scales). Use `?worker&url` for the new worklet too.

## Tunables the owner should test (debug panel, key D)

| Tunable | Default | What to try |
|---|---|---|
| `minCutoff` | 2.0 | Hand shakes while resting? lower it (1.0-1.5). Hand feels sticky/laggy when moving slowly? raise it. |
| `beta` | 10 | Lag on fast moves? raise it (15-25). Jitter on fast moves? lower it. |
| `pinchOn` / `pinchOff` | 0.25 / 0.35 | Pinch hard to trigger? raise `pinchOn` (0.3). Pinch flickers or sticks? widen the gap. |
| `holdMs` | 150 | How long a lost hand is kept. |
| `matchMaxDist` | 0.3 | Ids swap between hands? lower it. |
| `velocityAlpha` | 0.6 | Lower = smoother velocities but slower reaction. |
| `curlFullBendRad` | 2.2 | Make a fist: all curl numbers should be near 1. Open hand: near 0. |
| `videoDim`, `showHands`, `videoFit` | 0.5 / off / cover | Looks only. |

Press **Copy config** and paste the JSON to the agent when you find good values.
