// Boot, permissions, main loop.
//
// Flow: Start click -> AudioContext + dummy worklet (needs the click) -> camera + model -> app.
// Tracking runs once per NEW camera frame and calls instrument.update(). Rendering runs at display rate.

import "./style.css";
import { AudioEngine } from "./audio/engine";
import { config } from "./config";
import { runBenchmark } from "./core/benchmark";
import { MainLoop } from "./core/loop";
import { Recorder, recordingFileName } from "./core/recording";
import { CaseCollector, formatCompareTable, runRenderCompare, type CompareRow } from "./core/renderBench";
import { RollingStats } from "./core/rollingStats";
import { loadSavedSettings, saveSettings } from "./core/settings";
import { HandTracker, TrackingError, type TrackingErrorKind } from "./core/tracking";
import { createInstruments } from "./instruments";
import type { HandFrame, Instrument } from "./instruments/Instrument";
import { Effects } from "./render/effects";
import { drawHands, type DrawLead } from "./render/handOverlay";
import { Renderer } from "./render/renderer";
import { TestLoad } from "./render/testLoad";
import { Banner } from "./ui/banner";
import { DebugPanel } from "./ui/debugPanel";
import { Hud } from "./ui/hud";
import { StartScreen } from "./ui/startScreen";

// The speed settings the owner chose last time (tracking mode, delegate, ...) come back before anything starts.
Object.assign(config, loadSavedSettings());

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

const renderer = new Renderer(canvas);
const fx = new Effects();
const testLoad = new TestLoad();
const banner = new Banner(ui);
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
  applyConfig: () => {
    tracker.applySettings();
    saveSettings(config);
  },
  resetNumbers: () => {
    tracker.resetStats();
    renderJs.reset();
    videoDraw.reset();
    renderGap.reset();
    drawFps = 0;
  },
  runBenchmark: async (log) => {
    tracker.pause();
    try {
      return await runBenchmark(tracker.video, (delegate) => tracker.makeRequest(delegate), log);
    } finally {
      tracker.resume();
    }
  },
  runCompare: () => runCompare(),
  stopCompare: () => {
    compareAbort = true;
  },
});

// --- "Compare render settings" ---------------------------------------------

/** While set, tracking results and drawn-frame gaps are copied into it (one collector per case). */
let compareCollector: CaseCollector | null = null;
let compareRunning = false;
let compareAbort = false;
let handsNow = 0;

tracker.onSample = (s) => {
  handsNow = s.hands;
  compareCollector?.pushTrack(s);
};

/**
 * Switches the render settings case by case (live, nothing is saved), collects ~10 s of numbers with hands in view, then
 * puts every setting back. The skeleton is not drawn meanwhile (it is off in normal use), and a synthetic harp-like
 * effects load is on, because with no instrument the canvas would otherwise have nothing to draw.
 */
async function runCompare(): Promise<string[]> {
  if (compareRunning) return ["Already running."];
  const keep = {
    videoMode: config.videoMode,
    renderScale: config.renderScale,
    renderFpsCap: config.renderFpsCap,
    software2d: config.software2d,
    testLoad: config.testLoad,
  };
  compareRunning = true;
  compareAbort = false;
  config.testLoad = true;
  // The panel covers part of the picture: hide it while the owner stands back with his hands up, show it again for the table.
  const panelWasOpen = debug.visible;
  if (panelWasOpen) debug.toggle();
  let rows: CompareRow[] = [];
  try {
    rows = await runRenderCompare({
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      apply: (s) => {
        config.videoMode = s.videoMode;
        config.renderScale = s.renderScale;
        config.renderFpsCap = s.renderFpsCap;
        config.software2d = s.software2d;
        lastDraw = 0; // do not count the gap that the switch itself caused
      },
      setCollector: (c) => {
        compareCollector = c;
      },
      show: (title, detail) => banner.show(title, detail),
      handsNow: () => handsNow,
      aborted: () => compareAbort,
    });
  } finally {
    compareCollector = null;
    compareRunning = false;
    Object.assign(config, keep);
    banner.hide();
    if (panelWasOpen && !debug.visible) debug.toggle();
    debug.syncTunables();
    tracker.resetStats();
  }
  const st = tracker.getStats();
  const header = [
    `Compare render settings${compareAbort ? " (STOPPED EARLY)" : ""}: hands in view, only samples with a hand count.`,
    `window ${renderer.width}x${renderer.height} css px, screen pixel ratio ${renderer.screenDpr.toFixed(2)} | tracking ${st.mode} ${st.delegate} | synthetic effects load ON (harp-like glow), skeleton hidden`,
  ];
  return [...header, ...formatCompareTable(rows)];
}

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
const renderGap = new RollingStats(120);
let debugTick = 0;
let lastDraw = 0;
let drawFps = 0;
let drawLeadMs = 0;

/** How far ahead to draw the skeleton: the measured age of the landmarks (capture -> now), capped. Drawing only. */
function currentDrawLead(now: number): DrawLead | undefined {
  drawLeadMs = 0;
  if (!config.drawLeadEnabled || tracker.lastCaptureTime <= 0) return undefined;
  drawLeadMs = Math.min(config.drawLeadMaxMs, Math.max(0, now - tracker.lastCaptureTime));
  return { ms: drawLeadMs, maxShiftFrac: config.drawLeadMaxShift };
}

const loop = new MainLoop((_dt, now) => {
  // "render fps cap" (a speed test): skip this display frame if the last drawn one is too recent.
  const capped = config.renderFpsCap > 0 && lastDraw > 0 && now - lastDraw < 1000 / config.renderFpsCap - 2;
  if (!capped) {
    const t0 = performance.now();
    renderer.beginFrame(tracker.video);
    videoDraw.push(renderer.lastBeginMs);
    const { ctx } = renderer; // read fresh every frame: the renderer replaces its context when the 2D mode changes
    current?.render(ctx, fx);
    if (config.testLoad) testLoad.draw(ctx, now, renderer.width, renderer.height);
    // At render scale 1 the skeleton goes into the same canvas; below 1 into a small sharp canvas of its own.
    const skeleton = latestFrame !== null && !compareRunning && (config.showHands || debug.visible);
    const skeletonCtx = renderer.overlayContext(skeleton);
    if (skeletonCtx && latestFrame) drawHands(skeletonCtx, latestFrame, currentDrawLead(performance.now()));
    renderJs.push(performance.now() - t0);
    if (lastDraw > 0) {
      const gap = now - lastDraw;
      renderGap.push(gap);
      compareCollector?.pushDraw(gap);
      if (gap > 0) drawFps = drawFps === 0 ? 1000 / gap : drawFps * 0.95 + (1000 / gap) * 0.05;
    }
    lastDraw = now;
  }

  if (now - debugTick > PANEL_INTERVAL_MS) {
    debugTick = now;
    hud.setRecording(recorder.recording, recorder.seconds);
    if (!debug.visible) return; // no stats work at all while the panel is hidden
    const js = renderJs.summary();
    const gaps = renderGap.summary();
    debug.update({
      renderFps: drawFps,
      render: {
        jsAvgMs: js.avg,
        jsP95Ms: js.p95,
        jsMaxMs: js.max,
        videoDrawAvgMs: videoDraw.summary().avg,
        dpr: renderer.dpr,
        mode: renderer.describe(),
        backing: `${renderer.backingWidth}x${renderer.backingHeight}`,
      },
      renderGap: { avgMs: gaps.avg, p95Ms: gaps.p95, maxMs: gaps.max },
      drawLeadMs,
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
            ksStatus: audio.ksStatus,
            ksError: audio.ksError,
            plucks: audio.pluckCount,
            pluckDelayMs: audio.lastPluckDelayMs,
            pluckDelayMaxMs: audio.maxPluckDelayMs,
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
