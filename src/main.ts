// Boot, permissions, main loop.
//
// Flow: Start click -> AudioContext + dummy worklet (needs the click) -> camera + model -> app.
// Tracking runs once per NEW camera frame and calls instrument.update(). Rendering runs at display rate.

import "./style.css";
import { AudioEngine } from "./audio/engine";
import { config } from "./config";
import { MainLoop } from "./core/loop";
import { Recorder, recordingFileName } from "./core/recording";
import { RollingStats } from "./core/rollingStats";
import { HandTracker, TrackingError, type TrackingErrorKind } from "./core/tracking";
import { createInstruments } from "./instruments";
import type { HandFrame, Instrument } from "./instruments/Instrument";
import { Effects } from "./render/effects";
import { drawHands } from "./render/handOverlay";
import { Renderer } from "./render/renderer";
import { DebugPanel } from "./ui/debugPanel";
import { Hud } from "./ui/hud";
import { StartScreen } from "./ui/startScreen";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

const renderer = new Renderer(canvas);
const fx = new Effects();
const tracker = new HandTracker();
const recorder = new Recorder();
const instruments = createInstruments();
const startScreen = new StartScreen(ui);

let audio: AudioEngine | null = null;
let current: Instrument | null = null;
let currentIndex = -1;
let latestFrame: HandFrame | null = null;
let lastUpdateMs = 0;
let started = false;

tracker.pipeline.setViewport(renderer.width, renderer.height);
renderer.onResize = (w, h) => tracker.pipeline.setViewport(w, h);

const hud = new Hud(ui, instruments, (i) => selectInstrument(i));
const debug = new DebugPanel(ui, {
  toggleRecord,
  beep: () => audio?.beep(),
  applyConfig: () => tracker.setDelegate(config.delegate),
});

// --- instruments ---------------------------------------------------------

function selectInstrument(index: number): void {
  if (!audio || index < 0 || index >= instruments.length || index === currentIndex) return;
  current?.dispose();
  const next = instruments[index]!;
  next.init(audio);
  current = next;
  currentIndex = index;
  hud.setActive(index, next);
}

// --- tracking frames -----------------------------------------------------

tracker.onFrame = (frame) => {
  latestFrame = frame;
  recorder.push(frame);
  if (recorder.recording && recorder.seconds >= config.recordMaxSeconds) toggleRecord();
  const dt = lastUpdateMs > 0 ? (frame.timestamp - lastUpdateMs) / 1000 : 0;
  lastUpdateMs = frame.timestamp;
  current?.update(frame, dt, frame.timestamp);
};

tracker.onError = (err) => showFailure(err.kind);

// GPU was asked for but CPU is running (GPU failed): make the panel say what is really happening.
tracker.onDelegateChange = (delegate) => {
  config.delegate = delegate;
  debug.syncTunables();
};

// --- recording -----------------------------------------------------------

function toggleRecord(): void {
  if (!started) return;
  if (!recorder.recording) {
    recorder.start(renderer.width, renderer.height);
    return;
  }
  const rec = recorder.stop();
  hud.setRecording(false, 0);
  if (rec.frames.length === 0) return;
  const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = recordingFileName();
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// --- render loop ---------------------------------------------------------

// The panel text and REC badge update ~4 times a second, not every frame.
const PANEL_INTERVAL_MS = 250;
const renderJs = new RollingStats(120);
const videoDraw = new RollingStats(120);
let debugTick = 0;

const loop = new MainLoop((_dt, now) => {
  const t0 = performance.now();
  renderer.beginFrame(tracker.video);
  videoDraw.push(renderer.lastBeginMs);
  const { ctx } = renderer;
  current?.render(ctx, fx);
  if (latestFrame && (config.showHands || debug.visible)) drawHands(ctx, latestFrame);
  renderJs.push(performance.now() - t0);

  if (now - debugTick > PANEL_INTERVAL_MS) {
    debugTick = now;
    hud.setRecording(recorder.recording, recorder.seconds);
    if (!debug.visible) return; // no stats work at all while the panel is hidden
    const js = renderJs.summary();
    debug.update({
      renderFps: loop.fps,
      render: {
        jsAvgMs: js.avg,
        jsP95Ms: js.p95,
        jsMaxMs: js.max,
        videoDrawAvgMs: videoDraw.summary().avg,
        dpr: renderer.dpr,
      },
      tracker: tracker.getStats(),
      frame: latestFrame,
      audio: audio
        ? {
            state: audio.state,
            latencyMs: audio.estimatedLatencyMs,
            workletStatus: audio.workletStatus,
            workletError: audio.workletError,
            workletSampleRate: audio.workletSampleRate,
            sampleRate: audio.ctx.sampleRate,
          }
        : null,
      recording: { active: recorder.recording, seconds: recorder.seconds, frames: recorder.frameCount },
      canvas: { width: renderer.width, height: renderer.height },
    });
  }
});

// --- start / errors ------------------------------------------------------

async function onStart(): Promise<void> {
  startScreen.showLoading("Starting audio...");
  // The AudioContext must be created inside this click handler.
  if (!audio) {
    try {
      audio = new AudioEngine();
    } catch (e) {
      console.error(e);
      startScreen.showError("unsupported", onStart);
      return;
    }
  }
  await audio.start();
  startScreen.showLoading("Starting camera and loading hand tracking...");
  try {
    await tracker.start();
  } catch (e) {
    showFailure(e instanceof TrackingError ? e.kind : "unknown");
    return;
  }
  startScreen.hide();
  started = true;
  hud.show();
  if (currentIndex < 0) selectInstrument(0);
  loop.start();
}

function showFailure(kind: TrackingErrorKind): void {
  tracker.pause();
  startScreen.showError(kind, () => void onStart());
}

// --- keyboard ------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (!started) return;
  switch (e.key.toLowerCase()) {
    case "1":
    case "2":
    case "3":
    case "4":
      selectInstrument(Number(e.key) - 1);
      break;
    case "d":
      debug.toggle();
      break;
    case "r":
      toggleRecord();
      break;
    case "h":
      config.showHands = !config.showHands;
      debug.syncTunables();
      break;
  }
});

// Pause tracking and audio when the tab is hidden.
document.addEventListener("visibilitychange", () => {
  if (!started) return;
  if (document.hidden) {
    tracker.pause();
    audio?.suspend();
  } else {
    tracker.resume();
    audio?.resume();
  }
});

// Debug handle for the browser console (e.g. window.__air.audio()?.workletStatus).
Object.assign(window, { __air: { audio: () => audio, tracker, config } });

startScreen.showStart(() => void onStart());
