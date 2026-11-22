// Debug panel (toggle with D): FPS, inference time, pinch values, live tunables, "Copy config", "Copy report", benchmark.

import { DEFAULT_CONFIG, TUNABLES, config, resetConfig } from "../config";
import { describeGl, interestingLogs, type EnvDiag } from "../core/diagnostics";
import { pinchRatio } from "../core/gestures";
import type { TrackerStats } from "../core/tracking";
import type { HandFrame } from "../instruments/Instrument";
import { el } from "./dom";

export interface DebugInfo {
  renderFps: number;
  /** JS time of one render tick (whole rAF callback) and of its video-draw part. Rolling summary. */
  render: {
    jsAvgMs: number;
    jsP95Ms: number;
    jsMaxMs: number;
    /** Canvas clear (element mode) or video draw (canvas mode), JS time. */
    videoDrawAvgMs: number;
    /** Backing pixels per CSS pixel of the effects canvas (screen ratio x render scale). */
    dpr: number;
    /** "video element | scale 1 | 2D GPU ..." and the backing store size "1920x970". */
    mode: string;
    backing: string;
  };
  /** Time between two drawn frames (ms). A long max = something blocked the main thread. */
  renderGap: { avgMs: number; p95Ms: number; maxMs: number };
  /** How far ahead the skeleton is drawn right now (ms), 0 = off. */
  drawLeadMs: number;
  tracker: TrackerStats | null;
  frame: HandFrame | null;
  audio: {
    state: string;
    latencyMs: number;
    workletStatus: string;
    workletError: string;
    workletSampleRate: number;
    sampleRate: number;
  } | null;
  recording: { active: boolean; seconds: number; frames: number };
  canvas: { width: number; height: number };
}

export interface DebugActions {
  toggleRecord(): void;
  beep(): void;
  /** Called after any control changed config (and after Reset): lets main apply things like the tracking mode. */
  applyConfig(): void;
  /** Restarts every rolling number (tracking and render), so a new setting can be measured cleanly. */
  resetNumbers(): void;
  /** Pauses tracking, measures the main-thread paths (see core/benchmark.ts), resumes. Resolves with the report lines. */
  runBenchmark(log: (text: string) => void): Promise<string[]>;
  /** "Compare render settings": runs the render cases with hands in view (see core/renderBench.ts). Resolves with the report lines. */
  runCompare(): Promise<string[]>;
  /** Ends a running comparison early. */
  stopCompare(): void;
}

type ConfigBag = Record<string, number | boolean | string>;

const f = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : "-");
const yesNo = (b: boolean): string => (b ? "yes" : "NO");
const baseName = (path: string): string => path.split("?")[0]!.split("/").pop() || path;

function mb(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1048576).toFixed(1)} MB` : "size n/a";
}

/** One line (plus one for a second GPU) about a scope's WebGL: the line the owner sends back as "worker GL". */
function glLines(label: string, env: EnvDiag | null, notRunning: string): string[] {
  if (!env) return [`${label} ${notRunning}`];
  const out = [`${label} OffscreenCanvas ${yesNo(env.offscreenCanvas)} | WebGL2 ${describeGl(env.gl)}`];
  if (env.glHigh.ok && env.glHigh.renderer !== env.gl.renderer) {
    out.push(`            high-performance context gives another GPU: ${env.glHigh.renderer}`);
  }
  return out;
}

export class DebugPanel {
  private readonly root: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly hands: HTMLElement;
  private readonly recButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly reportButton: HTMLButtonElement;
  private readonly benchButton: HTMLButtonElement;
  private readonly bench: HTMLElement;
  private readonly compareButton: HTMLButtonElement;
  private readonly compare: HTMLElement;
  private benchLines: string[] = [];
  private compareLines: string[] = [];
  private comparing = false;
  private lastReport = "";
  private readonly refreshers: Array<() => void> = [];
  private copyTimer = 0;
  private reportTimer = 0;
  private readonly actions: DebugActions;

  constructor(parent: HTMLElement, actions: DebugActions) {
    this.actions = actions;
    this.stats = el("pre", { class: "dbg-stats" });
    this.hands = el("div", { class: "dbg-hands" });
    this.bench = el("pre", { class: "dbg-stats dbg-bench" });

    this.recButton = el("button", { class: "btn btn-small", textContent: "Record (R)", onclick: () => actions.toggleRecord() });
    this.copyButton = el("button", {
      class: "btn btn-small",
      textContent: "Copy config",
      onclick: () => void this.copyConfig(),
    });
    this.reportButton = el("button", {
      class: "btn btn-small",
      textContent: "Copy report",
      title: "Copies the numbers above (and the benchmark, if you ran it) as text",
      onclick: () => void this.copyReport(),
    });
    this.benchButton = el("button", {
      class: "btn btn-small",
      textContent: "Run benchmark",
      title: "Keep your hands in view. Takes 15-25 s, tracking pauses meanwhile.",
      onclick: () => void this.runBenchmark(),
    });
    this.compare = el("pre", { class: "dbg-stats dbg-bench" });
    this.compareButton = el("button", {
      class: "btn btn-small btn-accent",
      textContent: "Compare render settings",
      title: "Keep BOTH hands in front of the camera for about 1.5 minutes. Tries 6 render setups, 10 s each, and prints a table.",
      onclick: () => void this.runCompare(),
    });
    const resetNumbers = el("button", {
      class: "btn btn-small",
      textContent: "Reset numbers",
      title: "Start the averages again (use after changing a setting, then wait ~15 s)",
      onclick: () => actions.resetNumbers(),
    });
    const beep = el("button", { class: "btn btn-small", textContent: "Beep", onclick: () => actions.beep() });
    const reset = el("button", {
      class: "btn btn-small",
      textContent: "Reset",
      onclick: () => {
        resetConfig();
        this.syncTunables();
        actions.applyConfig();
      },
    });

    this.root = el(
      "div",
      { class: "debug hidden" },
      el("div", { class: "dbg-title", textContent: "Debug (D to hide)" }),
      this.stats,
      this.hands,
      el("div", { class: "dbg-buttons" }, this.compareButton, this.reportButton, resetNumbers, this.benchButton, this.recButton, beep, this.copyButton, reset),
      this.compare,
      this.bench,
      this.buildTunables(),
    );
    parent.append(this.root);
  }

  get visible(): boolean {
    return !this.root.classList.contains("hidden");
  }

  toggle(): void {
    this.root.classList.toggle("hidden");
  }

  /** Re-read every slider/checkbox from `config` (after Reset, or after a key such as H changed it). */
  syncTunables(): void {
    this.refreshers.forEach((r) => r());
  }

  /** The text lines of the stats block. The same lines go into "Copy report". */
  private buildLines(info: DebugInfo): string[] {
    const t = info.tracker;
    const lines: string[] = [];
    const r = info.render;
    const g = info.renderGap;
    lines.push(
      `render      ${f(info.renderFps, 0)} fps   window ${info.canvas.width}x${info.canvas.height} css px, effects canvas ${r.backing} px (@${f(r.dpr, 2)}x)   JS ${f(r.jsAvgMs, 2)} ms avg | p95 ${f(r.jsP95Ms, 2)} | max ${f(r.jsMaxMs, 1)}  (${config.videoMode === "canvas" ? "video draw" : "clear"} ${f(r.videoDrawAvgMs, 2)})`,
    );
    lines.push(`  layers    ${r.mode}`);
    lines.push(
      `  gap       between drawn frames: avg ${f(g.avgMs)} ms | p95 ${f(g.p95Ms)} | max ${f(g.maxMs)}${config.renderFpsCap > 0 ? `   (render cap ${config.renderFpsCap} fps)` : ""}`,
    );
    if (!t) {
      lines.push("tracking    not started");
    } else {
      const worker = t.mode === "worker";
      lines.push(
        `MODE        ${t.mode.toUpperCase()}   delegate ${t.delegate}${worker ? `   worker input ${config.workerInput}` : ""}   infer every ${config.inferEvery}   numHands ${config.numHands}   camera ${t.cameraSettings}`,
      );
      lines.push(
        `tracking    ${f(t.trackingFps, 0)} fps   (camera ${f(t.cameraFps, 0)} fps; ${f(t.notSentPercent, 0)}% of camera frames not used = ${f(t.skippedEveryPercent, 0)}% skipped by "infer every" + ${f(t.missedByBrowserPercent, 0)}% missed by the browser + ${f(t.busyPercent, 0)}% worker busy)`,
      );
      if (!worker) lines.push(`  main thread inside MediaPipe: ${f(t.mainBlockedPercent, 0)}% of every second (tracking fps x inference avg)`);
      lines.push(`backend     ${t.workerState}   video ${t.videoWidth}x${t.videoHeight}`);
      if (t.fallbackReason) lines.push(`            ! ${t.fallbackReason}`);

      // Evidence about where MediaPipe really runs (Stage 0.6).
      const scopeEnv = worker ? t.envWorker : t.envMain;
      lines.push(...glLines("worker GL  ", t.envWorker, worker ? "(not reported yet)" : "(no worker in main mode)"));
      lines.push(...glLines("main GL    ", t.envMain, "(not probed yet)"));
      if (t.envWorker && t.envMain) {
        lines.push(
          `  same GPU in worker and page: ${t.envWorker.gl.renderer === t.envMain.gl.renderer ? "yes" : "NO (different renderer)"}`,
        );
      }
      if (scopeEnv) {
        lines.push(
          `env         WASM SIMD ${yesNo(scopeEnv.simd)} | threads ${scopeEnv.threads ? "yes" : "no (the MediaPipe WASM we use is single-threaded anyway)"} | cores ${scopeEnv.cores} | WebGPU ${scopeEnv.webgpu ? "yes" : "no"}`,
        );
      }
      if (t.load) {
        const files = t.load.files.filter((x) => /\.(task|wasm)$/i.test(x.name));
        lines.push(
          `files       model ${baseName(t.load.modelUrl)} (${t.load.modelUrl.split("/").slice(-3, -1).join("/")}) | wasm ${baseName(t.load.wasmBinaryPath)} | loaded in ${f(t.load.loadMs, 0)} ms`,
        );
        if (files.length > 0) lines.push(`            fetched: ${files.map((x) => `${x.name} ${mb(x.bytes)} ${f(x.ms, 0)} ms`).join(", ")}`);
        const logs = interestingLogs(t.load.logs, 4);
        lines.push(logs.length > 0 ? `mediapipe   ${logs.join("\n            ")}` : "mediapipe   (no delegate/GL lines in its console output)");
      }

      lines.push(
        `inference   ${f(t.inferenceMs)} ms now | avg ${f(t.inferenceAvgMs)} | p95 ${f(t.inferenceP95Ms)} | max ${f(t.inferenceMaxMs)}   (${worker ? "measured inside the worker" : "main thread: blocks rendering"})`,
      );
      lines.push(
        `frame age   ${f(t.frameAgeMs, 0)} ms now | avg ${f(t.frameAgeAvgMs, 0)} | p95 ${f(t.frameAgeP95Ms, 0)}   (camera capture -> landmarks ready)`,
      );
      if (info.drawLeadMs > 0) lines.push(`  skeleton drawn ${f(info.drawLeadMs, 0)} ms ahead (draw lag fix on)`);
      if (!t.frameAgeFromCapture && t.framesWithHands + t.framesNoHands > 0) {
        lines.push("            ! browser gave no capture time: age is too small by the camera delay");
      }
      if (worker) lines.push(`  parts     grab ${f(t.grabAvgMs)} ms | worker round trip ${f(t.roundTripAvgMs)} ms`);
      lines.push(
        `  session   hands in view: ${f(t.avgWithHandsMs)} ms (${t.framesWithHands} fr) | no hands: ${f(t.avgNoHandsMs)} ms (${t.framesNoHands} fr)${t.watchdogTimeouts ? `  watchdog ${t.watchdogTimeouts}x` : ""}`,
      );
    }
    if (info.audio) {
      const a = info.audio;
      const sr = a.workletStatus === "ok" ? ` (audio thread ${a.workletSampleRate} Hz)` : "";
      const err = a.workletError ? ` - ${a.workletError}` : "";
      lines.push(`audio       ${a.state}   ~${f(a.latencyMs, 0)} ms output latency   ${a.sampleRate} Hz`);
      lines.push(`worklet     ${a.workletStatus}${sr}${err}`);
    }
    lines.push(
      info.recording.active
        ? `recording   ● ${f(info.recording.seconds)}s, ${info.recording.frames} frames`
        : "recording   off (press R)",
    );
    return lines;
  }

  update(info: DebugInfo): void {
    if (!this.visible) return;
    this.lastReport = this.buildLines(info).join("\n");
    this.stats.textContent = this.lastReport;
    this.recButton.textContent = info.recording.active ? "Stop + save (R)" : "Record (R)";

    this.hands.replaceChildren();
    const frame = info.frame;
    if (!frame || frame.hands.length === 0) {
      this.hands.append(el("div", { class: "dbg-hand dbg-none", textContent: "No hands in view" }));
      return;
    }
    for (const h of frame.hands) {
      const ratio = pinchRatio(h.landmarks, h.handSize);
      const badge = el("span", {
        class: h.pinch.active ? "badge on" : "badge off",
        textContent: h.pinch.active ? "PINCH ON" : "pinch off",
      });
      this.hands.append(
        el(
          "div",
          { class: `dbg-hand ${h.side}` },
          el("div", { class: "dbg-hand-head" }, el("b", { textContent: `#${h.id} ${h.side}` }), badge),
          el("div", {
            class: "dbg-mono",
            textContent:
              `size ${f(h.handSize, 0)}px  pinch ratio ${f(ratio, 2)}  strength ${f(h.pinch.strength, 2)}\n` +
              `palm speed ${f(Math.hypot(h.palmVelocity.x, h.palmVelocity.y), 0)} px/s\n` +
              `curl ${h.fingerCurl.map((c) => f(c, 2)).join(" ")} (thumb..pinky)`,
          }),
        ),
      );
    }
  }

  private async runBenchmark(): Promise<void> {
    this.benchButton.disabled = true;
    this.benchLines = ["Benchmark running. Keep your hands in view and move them a little..."];
    this.bench.textContent = this.benchLines.join("\n");
    try {
      const lines = await this.actions.runBenchmark((text) => {
        this.bench.textContent = `${text}\nKeep your hands in view and move them a little...`;
      });
      this.benchLines = ["Benchmark (main thread, same camera, 30 frames each):", ...lines];
    } catch (e) {
      this.benchLines = [`Benchmark failed: ${e instanceof Error ? e.message : String(e)}`];
    }
    this.bench.textContent = this.benchLines.join("\n");
    this.benchButton.disabled = false;
  }

  private async runCompare(): Promise<void> {
    if (this.comparing) {
      this.actions.stopCompare(); // the same button stops a running comparison
      return;
    }
    this.comparing = true;
    this.compareButton.textContent = "Stop comparing";
    this.benchButton.disabled = true;
    this.compare.textContent = "Comparing render settings. Keep BOTH hands visible and move them a little...";
    try {
      this.compareLines = await this.actions.runCompare();
    } catch (e) {
      this.compareLines = [`Compare failed: ${e instanceof Error ? e.message : String(e)}`];
    }
    this.compare.textContent = this.compareLines.join("\n");
    this.compareButton.textContent = "Compare render settings";
    this.benchButton.disabled = false;
    this.comparing = false;
  }

  private buildTunables(): HTMLElement {
    const wrap = el("div", { class: "dbg-tunables" });
    const cfg = config as unknown as ConfigBag;
    const def = DEFAULT_CONFIG as unknown as ConfigBag;
    let group = "";

    for (const tu of TUNABLES) {
      if (tu.group !== group) {
        group = tu.group;
        wrap.append(el("div", { class: "dbg-group", textContent: group }));
      }
      const key = tu.key;

      if (tu.kind === "number") {
        const value = el("span", { class: "dbg-val" });
        const input = el("input", { type: "range", min: String(tu.min), max: String(tu.max), step: String(tu.step) });
        const sync = () => {
          input.value = String(cfg[key]);
          value.textContent = String(Math.round(Number(cfg[key]) * 100) / 100);
        };
        input.addEventListener("input", () => {
          cfg[key] = Number(input.value);
          sync();
          this.actions.applyConfig();
        });
        this.refreshers.push(sync);
        sync();
        wrap.append(
          el("label", { class: "dbg-row", title: `default ${def[key]}` }, el("span", { textContent: tu.label }), input, value),
        );
      } else if (tu.kind === "boolean") {
        const input = el("input", { type: "checkbox" });
        const sync = () => {
          input.checked = Boolean(cfg[key]);
        };
        input.addEventListener("change", () => {
          cfg[key] = input.checked;
          this.actions.applyConfig();
        });
        this.refreshers.push(sync);
        sync();
        wrap.append(el("label", { class: "dbg-row" }, el("span", { textContent: tu.label }), input));
      } else {
        const select = el("select", {});
        for (const o of tu.options) select.append(el("option", { value: o, textContent: o }));
        const sync = () => {
          select.value = String(cfg[key]);
        };
        select.addEventListener("change", () => {
          cfg[key] = select.value;
          this.actions.applyConfig();
        });
        this.refreshers.push(sync);
        sync();
        wrap.append(el("label", { class: "dbg-row" }, el("span", { textContent: tu.label }), select));
      }
    }
    return wrap;
  }

  /** Clipboard with a fallback for pages where navigator.clipboard is blocked. */
  private async copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = el("textarea", { value: text, style: "position:fixed;left:-9999px;top:0" });
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  private async copyConfig(): Promise<void> {
    const text = JSON.stringify(config, null, 2);
    const ok = await this.copyText(text);
    this.copyButton.textContent = ok ? "Copied!" : "Copy failed (see console)";
    window.clearTimeout(this.copyTimer);
    this.copyTimer = window.setTimeout(() => (this.copyButton.textContent = "Copy config"), 1500);
    if (!ok) console.log(text);
  }

  private async copyReport(): Promise<void> {
    const text = [
      this.lastReport,
      ...(this.compareLines.length > 1 ? ["", ...this.compareLines] : []),
      ...(this.benchLines.length > 1 ? ["", ...this.benchLines] : []),
    ].join("\n");
    const ok = await this.copyText(text);
    this.reportButton.textContent = ok ? "Copied!" : "Copy failed (see console)";
    window.clearTimeout(this.reportTimer);
    this.reportTimer = window.setTimeout(() => (this.reportButton.textContent = "Copy report"), 1500);
    if (!ok) console.log(text);
  }
}
