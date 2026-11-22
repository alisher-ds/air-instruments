// Debug panel (toggle with D): FPS, inference time, pinch values, live tunables, "Copy config".

import { DEFAULT_CONFIG, TUNABLES, config, resetConfig } from "../config";
import { pinchRatio } from "../core/gestures";
import type { TrackerStats } from "../core/tracking";
import type { HandFrame } from "../instruments/Instrument";
import { el } from "./dom";

export interface DebugInfo {
  renderFps: number;
  /** JS time of one render tick (whole rAF callback) and of its video-draw part. Rolling summary. */
  render: { jsAvgMs: number; jsP95Ms: number; jsMaxMs: number; videoDrawAvgMs: number; dpr: number };
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
  /** Called after any control changed config (and after Reset): lets main apply things like the GPU/CPU delegate. */
  applyConfig(): void;
}

type ConfigBag = Record<string, number | boolean | string>;

const f = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : "-");

export class DebugPanel {
  private readonly root: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly hands: HTMLElement;
  private readonly recButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly refreshers: Array<() => void> = [];
  private copyTimer = 0;
  private readonly actions: DebugActions;

  constructor(parent: HTMLElement, actions: DebugActions) {
    this.actions = actions;
    this.stats = el("pre", { class: "dbg-stats" });
    this.hands = el("div", { class: "dbg-hands" });

    this.recButton = el("button", { class: "btn btn-small", textContent: "Record (R)", onclick: () => actions.toggleRecord() });
    this.copyButton = el("button", {
      class: "btn btn-small",
      textContent: "Copy config",
      onclick: () => void this.copyConfig(),
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
      el("div", { class: "dbg-buttons" }, this.recButton, beep, this.copyButton, reset),
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

  update(info: DebugInfo): void {
    if (!this.visible) return;
    const t = info.tracker;
    const lines: string[] = [];
    const r = info.render;
    lines.push(
      `render      ${f(info.renderFps, 0)} fps   canvas ${info.canvas.width}x${info.canvas.height} @${f(r.dpr, 2)}x   JS ${f(r.jsAvgMs, 2)} ms avg | p95 ${f(r.jsP95Ms, 2)} | max ${f(r.jsMaxMs, 1)}  (video draw ${f(r.videoDrawAvgMs, 2)})`,
    );
    if (t) {
      lines.push(
        `tracking    ${f(t.trackingFps, 0)} fps   (camera ${f(t.cameraFps, 0)} fps, ${f(t.droppedPercent, 0)}% not sent: worker busy)`,
      );
      lines.push(`worker      ${t.workerState}   delegate ${t.delegate}   video ${t.videoWidth}x${t.videoHeight}`);
      if (t.fallbackReason) lines.push(`            ! ${t.fallbackReason}`);
      lines.push(
        `inference   ${f(t.inferenceMs)} ms now | avg ${f(t.inferenceAvgMs)} | p95 ${f(t.inferenceP95Ms)} | max ${f(t.inferenceMaxMs)}   (measured in the worker)`,
      );
      lines.push(
        `frame age   ${f(t.frameAgeMs, 0)} ms now | avg ${f(t.frameAgeAvgMs, 0)} | p95 ${f(t.frameAgeP95Ms, 0)}   (camera capture -> landmarks on main thread)`,
      );
      if (!t.frameAgeFromCapture && t.framesWithHands + t.framesNoHands > 0) {
        lines.push("            ! browser gave no capture time: age is too small by the camera delay");
      }
      lines.push(`  parts     grab ${f(t.grabAvgMs)} ms | worker round trip ${f(t.roundTripAvgMs)} ms`);
      lines.push(
        `  session   hands in view: ${f(t.avgWithHandsMs)} ms (${t.framesWithHands} fr) | no hands: ${f(t.avgNoHandsMs)} ms (${t.framesNoHands} fr)${t.watchdogTimeouts ? `  watchdog ${t.watchdogTimeouts}x` : ""}`,
      );
    } else {
      lines.push("tracking    not started");
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
    this.stats.textContent = lines.join("\n");
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

  private async copyConfig(): Promise<void> {
    const text = JSON.stringify(config, null, 2);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = el("textarea", { value: text, style: "position:fixed;left:-9999px;top:0" });
      document.body.append(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    this.copyButton.textContent = ok ? "Copied!" : "Copy failed (see console)";
    window.clearTimeout(this.copyTimer);
    this.copyTimer = window.setTimeout(() => (this.copyButton.textContent = "Copy config"), 1500);
    if (!ok) console.log(text);
  }
}
