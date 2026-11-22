# AIR INSTRUMENTS — Project Plan & Contract

> This file is the single source of truth for the project. Every agent (Claude Code, Codex) reads it before working and never contradicts it. If a change to the plan is needed, propose it to the owner first — do not silently deviate.

## 1. Vision

A browser app where the user plays four musical instruments **in mid-air with bare hands**, using only a webcam. Inspired by a viral "harp strings of light" demo, but the goal is to be clearly **better**: musical, responsive, beautiful, and stable.

Quality bar: it must feel like a real instrument, not a tech demo. A non-technical person should open the link, play something beautiful within 10 seconds, and want to share it.

## 2. Hard constraints

- 100% client-side. No backend, no accounts, no paid APIs, no API keys, no `.env` files.
- Free hosting only (GitHub Pages or Vercel free tier).
- No audio sample files that require licensing — all sound is synthesized in code (Web Audio). Generated impulse responses for reverb are fine.
- Camera frames never leave the device. Say so in the UI.
- Works in latest Chrome and Edge on a mid-range laptop. Firefox/Safari: best-effort, must not crash.

## 3. Tech stack (fixed)

- **Vite + TypeScript (strict mode)**, no UI framework (vanilla TS + small DOM helpers). Keeps latency and bundle small.
- **@mediapipe/tasks-vision** — `HandLandmarker`, `runningMode: "VIDEO"`, `numHands: 2`, GPU delegate with CPU fallback. Model file loaded from the official Google storage URL.
- **Canvas 2D** for rendering (additive blending via `globalCompositeOperation = "lighter"`). Glow done with cheap techniques (layered strokes / pre-rendered sprites), **not** per-frame `shadowBlur` on many objects.
- **Web Audio API** with an **AudioWorklet** for Karplus-Strong string synthesis.
- **Vitest** for unit tests of pure logic.

## 4. Architecture

```
src/
  main.ts                 // boot, permissions, main loop
  core/
    tracking.ts           // camera + frame loop (main thread), sends frames to the worker, ids/smoothing → HandFrame
    trackerWorker.ts      // Web Worker that owns MediaPipe HandLandmarker (inference never blocks rendering)
    smoothing.ts          // One Euro filter per landmark
    gestures.ts           // pinch (with hysteresis), velocities, palm center
    geometry.ts           // segment intersection, distances (pure, tested)
    loop.ts               // requestAnimationFrame loop, timing, FPS
  audio/
    engine.ts             // AudioContext, master bus, limiter, reverb
    scales.ts             // musical scales & note mapping (pure, tested)
    worklets/ks-string.ts // Karplus-Strong AudioWorklet processor
  render/
    renderer.ts           // transparent effects canvas (render scale), mirrored camera <video> layer under it (CSS)
    effects.ts            // glow, particles, trails (pooled, no GC churn)
    handOverlay.ts        // optional hand skeleton
  instruments/
    Instrument.ts         // shared interface (the CONTRACT below)
    harp/                 // stage 1–2
    doira/                // stage 3
    theremin/             // stage 4
    piano/                // stage 5
  ui/
    hud.ts                // instrument switcher, onboarding hints, debug panel
```

### The Instrument contract (all instruments implement this)

```ts
interface Instrument {
  id: "harp" | "doira" | "theremin" | "piano";
  name: string;
  hint: string;                       // one-line "how to play" shown on screen
  init(audio: AudioEngine): void;
  update(frame: HandFrame, dt: number, now: number): void;  // logic only
  render(ctx: CanvasRenderingContext2D, fx: Effects): void;  // drawing only
  dispose(): void;                    // stop all sound, free nodes
}

interface HandFrame {
  hands: Hand[];        // 0–2 hands, already smoothed, in canvas pixel space, mirrored
  timestamp: number;
}
interface Hand {
  id: number;                         // stable tracking id across frames (matched by nearest wrist position)
  side: "left" | "right";             // by SCREEN POSITION (left half / right half, user's view), not MediaPipe's handedness label, which flips unreliably
  landmarks: Vec2[];                  // 21 points
  tips: Vec2[];                       // thumb..pinky tips (4, 8, 12, 16, 20)
  tipVelocity: Vec2[];                // px/s
  tipVelocityRel: Vec2[];             // tip velocity MINUS palm velocity (finger motion only, hand motion removed)
  fingerCurl: number[];               // 0 = straight, 1 = fully bent, per finger (from tip/PIP/MCP angles)
  palmCenter: Vec2;
  palmVelocity: Vec2;
  handSize: number;                   // wrist(0) → middle MCP(9) distance, for scale-invariant thresholds
  pinch: { active: boolean; point: Vec2; strength: number };
}
```

Rule: all gesture thresholds are expressed **relative to `handSize`**, never in raw pixels, so they work at any distance from the camera.

## 5. Shared core requirements

- **Mirroring:** video and landmarks are mirrored so the screen behaves like a mirror.
- **Smoothing:** One Euro filter on every landmark (tunable `minCutoff`, `beta`). Goal: no visible jitter at rest, no visible lag on fast motion.
- **Pinch:** thumb tip (4) ↔ index tip (8) distance / handSize. Hysteresis: ON below ~0.25, OFF above ~0.35 (tunable). Never flickers.
- **Lost hands:** if a hand disappears for < 150 ms, hold its last state; longer → release everything it was holding.
- **Audio:** single `AudioContext`, started on the first user click (browser autoplay rule). Master chain: instrument buses → reverb send → soft limiter → output. Never clips.
- **Latency (realistic targets):** camera capture + inference + audio output make true end-to-end latency ~80–150 ms; we cannot get below that, so we measure what we control:
  - in-app "landmarks received → sound scheduled" < 5 ms;
  - inference < 25 ms per frame (GPU);
  - end-to-end as low as possible via: camera at 640×480 (not HD), `latencyHint: "interactive"`, sounds triggered inside `update`, and **predictive triggering** — extrapolate the fingertip ~1 frame ahead using velocity so fast strikes fire earlier (tunable, can be turned off).
- **Tracking loop:** MediaPipe runs in a **Web Worker** (`trackerWorker.ts`; decided in Stage 0.5 because main-thread inference blocked rendering). The main thread owns the camera: once per NEW camera frame (`requestVideoFrameCallback` when available, not every `requestAnimationFrame`) it grabs an `ImageBitmap`, transfers it to the worker, and gets landmarks back. **At most one frame in flight**; if the worker is busy the camera frame is dropped (no queue). Rendering runs at display rate and never waits for tracking; it interpolates/predicts hand positions between tracking frames.
- **Performance target:** 60 FPS render on a mid-range laptop. Particle systems use object pools. Canvas sized with devicePixelRatio (capped at 2) × render scale (see the rule below). Pause tracking and audio when the tab is hidden.
- **Render must stay cheap (measured, Stage 0.7):** the render and MediaPipe share one GPU. On the owner's Intel Iris Xe laptop (1920×970 canvas, worker GL = the same GPU, not software) inference averaged ~102 ms with the render uncapped at 60 fps (tracking 10 fps, frame age ~128 ms), but ~62 ms (p95 80, tracking 14 fps, frame age ~96 ms) with the render capped at 20 fps, and ~38 ms with the old main-thread tracking while render ran at ~12 fps. So every GPU millisecond the render uses is taken from tracking. Target on that laptop: inference avg ≤ 45 ms and frame age avg ≤ 70 ms with the render at 60 fps (or a stable 30). **Rule: render must stay cheap; heavy effects are drawn at a reduced internal resolution.** Concretely: (1) the camera picture is a normal mirrored `<video>` element under a transparent canvas (CSS mirror, `object-fit` = same mapping as `fitTransform`, dim by CSS opacity), never drawn into the canvas every frame; (2) the effects canvas has a *render scale* (0.5 / 0.75 / 1.0 of the screen's pixel ratio) and is upscaled by CSS, while thin sharp things (the hand skeleton) use a separate full-resolution canvas only while visible; (3) glow = layered strokes and pre-rendered sprites, no `shadowBlur`; (4) any new full-screen effect must be checked with the debug panel's "Compare render settings" before it is kept.
- **Known risk (remaining):** GPU contention between rendering and MediaPipe (see above), not main-thread blocking. Worker loading needs a page without a strict CSP (the `self.import` shim in `trackerWorker.ts`).
- **Debug panel** (toggle with `D`): FPS, tracking ms, estimated audio latency, hand skeletons, pinch values, active thresholds.
- **Tunables:** all magic numbers live in one `config.ts`, adjustable live from the debug panel. "Copy config" button exports current values as JSON so the owner can paste good settings back to the agent.
- **Record & replay (critical for agents):** agents cannot see the owner's camera. In the debug panel, `R` records the smoothed `HandFrame` stream to a JSON file (landmarks only, no video). Gesture logic (pinch, pluck, hit, press) must be testable by replaying these recordings in Vitest. The owner records short clips of real playing and puts them in `test/recordings/`; bugs are reproduced and fixed against them.
- **Version pinning:** exact versions for all dependencies (no `^`), including `@mediapipe/tasks-vision`; WASM files and model loaded from URLs matching that exact version.
- **AudioWorklet loading:** load worklet modules with Vite's `?worker&url` import (`import url from "./worklets/x.ts?worker&url"`, then `audioWorklet.addModule(url)`) and verify it works in the `npm run build` / `npm run preview` output, not only in dev. Approved by the owner. Why not `new URL('./x.ts', import.meta.url)`: it was tested and does not work in the production build (Vite inlines the raw TypeScript as a `data:` URI with the wrong MIME type, so the worklet cannot load). `?worker&url` compiles the file to a real `.js` asset and works in dev, build and preview.
- **Deploy config:** Vite `base` set correctly for GitHub Pages subpath. Camera requires HTTPS (localhost is fine for dev).

## 6. Instruments

### 6.1 Harp — "strings of light" (flagship)
- **Pinch meaning depends on where it starts:** pinch within ~0.5×handSize of an existing string's endpoint or body = **grab** that string (move it, or flick to delete); pinch in empty space = **create**.
- **Create a string:** pinch with both hands → a glowing line follows between the two pinch points → release → string is fixed in space. One-hand variant: pinch, drag, release creates a string from start to end point. Minimum length (e.g. 1.5×handSize) — shorter is cancelled, so accidental pinches don't litter strings.
- **Pluck:** any fingertip whose movement segment (previous → current position) crosses a string triggers it. A hand that is currently pinching/grabbing/creating **cannot pluck** (prevents the creating hand from triggering strings it passes). Cooldown is **per string** (~60 ms), not per finger — otherwise several fingers crossing together cause machine-gun repeats. Pluck strength from fingertip speed perpendicular to the string. Contact position along the string affects tone (near the end = brighter), like a real string.
- **Pitch:** string length (normalized by canvas diagonal) maps to a note in the active scale (longer = lower). Each string shows its note name subtly. Default scale: D major pentatonic over ~3 octaves, so anything played sounds good. Scale selectable (major pentatonic, minor pentatonic, harmonic minor).
- **Sound:** Karplus-Strong in ONE AudioWorklet node that manages all voices internally (not one node per voice). Fractional delay with allpass interpolation so high notes stay in tune. Brightness and decay set by pluck strength; light reverb. Polyphony ≥ 12 voices, voice stealing oldest-first. Re-plucking a ringing string restarts it smoothly (no click).
- **Visual:** string vibrates (standing wave, amplitude decays with the sound), glow brightens on pluck, sparks at the contact point. Color per note (consistent mapping).
- **Manage:** max 12 strings. Remove one: grab it and flick it fast toward a screen edge. Clear all: both open palms, **held still**, for ~1.5 s (visible progress ring; any movement resets it, so normal playing never triggers it). Also a "Clear" button and `C` key. Undo last action: `Z`.

### 6.2 Doira (Uzbek frame drum)
- A glowing frame drum floats on screen (position adjustable).
- **Hit (2D-honest definition):** the webcam cannot reliably see depth, so a hit = palm center enters the drum circle with speed above a threshold, OR a sharp velocity spike followed by a sudden stop (deceleration) inside the circle — whichever fires first. Speed → loudness. After a hit, that hand must leave the circle or slow down before it can hit again. Two hands can play alternating fast rhythms.
- Fingertip-only taps near the rim (small fast finger motion via `tipVelocityRel`) = soft "tak" — allows finger rolls like real doira playing.
- **Zones:** center = deep "bum", rim = sharp "tak", plus jingle (zil) layer on hard hits.
- **Sound:** synthesized (pitched sine with pitch drop for bum; filtered noise burst for tak; short metallic noise for jingles).
- **Visual:** membrane ripple from the hit point, rim flash.
- Debounce so one hit = one sound.

### 6.3 Theremin
- Continuous instrument, no touching.
- **Right hand height** → pitch (gently pulled toward scale notes with adjustable "snap" amount, plus glide so it never sounds jumpy).
- **Left hand height** → volume (hand low = silent). No left hand → silent.
- **Expression:** vibrato from deliberate side-to-side wrist wobble of the pitch hand, measured from **raw (unsmoothed)** landmarks, because the One Euro filter removes small tremble. If no wobble, a gentle automatic vibrato fades in on long notes. Pinch on the pitch hand = mute/articulate (to separate notes).
- Hand height range is calibrated: a 2-second "show me your lowest and highest hand position" step on first use, saved in localStorage.
- **Sound:** oscillator blend (sine + a little triangle), low-pass filter, vibrato LFO, reverb.
- **Visual:** a flowing glowing wave between the hands whose frequency/amplitude match the sound; pitch guide lines for scale notes.

### 6.4 Air piano
- A row of glowing keys in the lower third of the screen (2 octaves default, white + black keys).
- **Press (robust definition):** NOT absolute fingertip y-velocity — moving the whole hand would press every finger at once. A press = a fast increase in that finger's `fingerCurl` (finger bends relative to its own knuckle) and/or downward `tipVelocityRel` (hand motion subtracted), while the tip is over a key. Release = curl returns. All 10 fingers independent → chords possible.
- False-trigger protection: minimum curl change + minimum relative velocity; **sympathetic-finger suppression** (ring and pinky move together anatomically — if a neighbour finger moved much more within the same ~40 ms, ignore the weaker one); ignore the thumb by default (tunable).
- Hand moving left/right over keys without bending = no notes (lets the player reposition).
- **Sound:** soft electric-piano synth (FM or additive), velocity-sensitive.
- **Visual:** key lights up and glows from the fingertip, small note label.

## 7. UI / UX
- Start screen: one button "Start" (unlocks audio + asks camera permission), privacy line ("Video never leaves your device").
- Instrument switcher: 4 icons at the top, also keys `1–4`. Switching fades out sound cleanly.
- Each instrument shows its one-line hint for the first few seconds, then fades.
- Clear errors with a recovery action: camera denied, no camera, WebGL/GPU unavailable (fall back to CPU delegate).
- Dark, minimal aesthetic; the video is slightly dimmed so the light effects pop.
- "Show hands" toggle: skeleton overlay off by default for the clean look, on for learning.
- Lighting check: if tracking confidence stays low, show a hint ("more light on your hands / step back a little").
- Optional "Record performance" button: records canvas + audio with MediaRecorder to a .webm the user can share (makes it viral-ready). Stage 6.

### Out of scope (v1)
- Phones/tablets (front camera + touch UX is a different product). Must show a polite "best on a laptop" message, not break.
- Multiplayer, saving songs, MIDI output (possible v2).

## 8. Build stages (one stage per Claude Code session, `/clear` after each)

| Stage | Scope | Done when |
|---|---|---|
| 0 | Project setup (git, Vite, TS strict, Vitest), camera, tracking loop, smoothing, hand ids, gestures, debug panel, record & replay, Instrument contract, empty instrument switcher, `npm run build` verified with a dummy AudioWorklet | Both hands tracked smoothly, pinch shown reliably in debug panel, a recording replays in a test, inference ms measured, tests + build pass |
| 1 | Harp: strings, pluck detection, Karplus-Strong worklet, scale mapping | Can create strings and play a melody without false or missed plucks |
| 2 | Visual + audio polish for harp: vibration, glow, sparks, reverb, performance | 60 FPS, looks at least as good as the reference video |
| 3 | Doira | Hits feel instant, one hit = one sound, bum/tak distinguishable |
| 4 | Theremin | Smooth, musical, no jumpy pitch |
| 5 | Air piano | Chords work, false triggers rare |
| 6 | Final UX, error states, README with GIF, deploy to free hosting | Public link works on a fresh browser |

Each stage must leave the app runnable and all previous instruments still working.

## 9. Rules for every agent
1. Read `PLAN.md` and `HANDOFF.md` before starting. Work only on the current stage.
2. Keep pure logic (geometry, scales, gestures, filters) in pure functions with Vitest tests.
3. No new dependencies beyond the stack above without asking the owner.
4. After finishing, run `npm run build` and `npm test`; both must pass.
5. Update `HANDOFF.md`: what was done, what is not done, known issues, exact next step, and which tunables the owner should test.
6. Tell the owner, in simple words, exactly how to run and test the stage (which command, which window, what to try with their hands, what they should see).
7. Commit with a clear message at the end of the stage.
