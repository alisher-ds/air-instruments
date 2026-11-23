// The harp instrument: ties the logic (model.ts), the sound (the string worklet via AudioEngine) and the drawing
// (visuals.ts) together, plus its small control bar (Undo, Clear, scale) and the C / Z keys.

import type { AudioEngine } from "../../audio/engine";
import { SCALE_NAMES, type ScaleName } from "../../audio/scales";
import { config } from "../../config";
import { saveSettings } from "../../core/settings";
import { extrapolate } from "../../core/predict";
import { el } from "../../ui/dom";
import type { Effects } from "../../render/effects";
import type { HandFrame, Instrument, Vec2 } from "../Instrument";
import { HarpModel, MAX_STRINGS, type HarpEvent } from "./model";
import { HarpView } from "./visuals";

const SCALE_LABELS: Record<ScaleName, string> = {
  "major-pentatonic": "Major pentatonic",
  "minor-pentatonic": "Minor pentatonic",
  "harmonic-minor": "Harmonic minor",
};

/** Drawing lead for things that follow a hand: at most this far ahead, and at most this many hand sizes. */
const MAX_LEAD_MS = 220; // the real age: camera capture -> now (frame age ~100 ms + the time since the frame arrived)
const MAX_LEAD_HANDS = 0.8; // smoothed velocities understate fast motion, so allow a bit more than the logic's 0.5

export function createHarp(): Instrument {
  const model = new HarpModel(config);
  const view = new HarpView();
  // Debug handle for the browser console (e.g. __harp.strings), like window.__air.
  Object.assign(window, { __harp: model });

  let audio: AudioEngine | null = null;
  let bar: HTMLElement | null = null;
  let scaleSelect: HTMLSelectElement | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  let lastFrame: HandFrame | null = null;
  let seenScale: ScaleName = config.harpScale;
  let viewW = 0;
  let viewH = 0;
  let noSynthWarned = false;
  const timers = new Set<number>();
  const shifts = new Map<number, Vec2>();

  function pan(a: Vec2, b: Vec2): number {
    const w = Math.max(1, viewW);
    return Math.max(-0.8, Math.min(0.8, ((a.x + b.x) / 2 / w - 0.5) * 2));
  }

  function handle(events: readonly HarpEvent[], receivedAt: number): void {
    for (const e of events) {
      switch (e.type) {
        case "pluck": {
          const s = model.stringById(e.stringId);
          if (!s) break;
          const fire = (at: number | undefined): void => {
            const ok = audio?.pluck(
              { stringId: s.id, freq: s.freq, velocity: e.strength, brightness: e.brightness * (0.35 + 0.65 * config.harpTone), pan: pan(s.a, s.b) },
              at,
            );
            if (ok === false && !noSynthWarned) {
              noSynthWarned = true;
              view.showToast("The string sound is not available (audio worklet failed).", performance.now(), 6000);
            }
            view.pluck(s, e.strength, e.contact, e.along);
          };
          if (e.delayMs >= 2) {
            // A fast strum crossed several strings inside one tracking frame: keep them in crossing order.
            const id = window.setTimeout(() => {
              timers.delete(id);
              fire(undefined);
            }, e.delayMs);
            timers.add(id);
          } else {
            fire(receivedAt);
          }
          break;
        }
        case "created":
          view.flash(e.id, 1);
          break;
        case "deleted":
          audio?.stopStrings(e.id);
          view.forget(e.id);
          break;
        case "cleared":
          audio?.stopStrings();
          view.forgetAll();
          break;
        case "limit":
          view.showToast(`Maximum ${MAX_STRINGS} strings. Remove one first (flick it away, or press Z).`, performance.now());
          break;
      }
    }
  }

  function clearAll(): void {
    const events: HarpEvent[] = [];
    model.clearAll(events);
    handle(events, performance.now());
  }

  function undo(): void {
    handle(model.undo(), performance.now());
  }

  function buildBar(): HTMLElement {
    scaleSelect = el("select", { class: "harp-select", title: "Scale: which notes the strings can play" });
    for (const name of SCALE_NAMES) scaleSelect.append(el("option", { value: name, textContent: SCALE_LABELS[name] }));
    scaleSelect.value = config.harpScale;
    scaleSelect.addEventListener("change", () => {
      config.harpScale = scaleSelect!.value as ScaleName;
      saveSettings(config);
    });
    return el(
      "div",
      { class: "harp-bar" },
      el("button", { class: "btn btn-small", textContent: "Undo (Z)", title: "Undo the last action", onclick: undo }),
      el("button", { class: "btn btn-small", textContent: "Clear (C)", title: "Remove all strings (Z brings them back)", onclick: clearAll }),
      scaleSelect,
    );
  }

  return {
    id: "harp",
    name: "Harp",
    hint: "Pinch with both hands and pull apart to make a string, then strum it with your fingers. Pinch a string to move it; flick it away to remove it.",

    init(a: AudioEngine): void {
      audio = a;
      noSynthWarned = false;
      viewW = window.innerWidth;
      viewH = window.innerHeight;
      model.setViewport(viewW, viewH);
      const ui = document.getElementById("ui");
      bar = buildBar();
      ui?.append(bar);
      onKey = (e: KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
        const k = e.key.toLowerCase();
        if (k === "c") clearAll();
        else if (k === "z") undo();
      };
      window.addEventListener("keydown", onKey);
    },

    update(frame: HandFrame, _dt: number, _now: number): void {
      if (window.innerWidth !== viewW || window.innerHeight !== viewH) {
        viewW = window.innerWidth;
        viewH = window.innerHeight;
        model.setViewport(viewW, viewH);
      }
      if (config.harpScale !== seenScale) {
        seenScale = config.harpScale;
        model.retune();
        if (scaleSelect) scaleSelect.value = seenScale;
      }
      lastFrame = frame;
      // frame.timestamp is the time the landmarks reached the main thread (performance.now clock): the "received" moment.
      handle(model.update(frame, frame.timestamp), frame.timestamp);
    },

    render(ctx: CanvasRenderingContext2D, _fx: Effects): void {
      const now = performance.now();
      // Shift things that follow a hand ahead by the age of the last tracking frame (drawing only).
      shifts.clear();
      if (lastFrame) {
        const age = Math.min(MAX_LEAD_MS, Math.max(0, now - (lastFrame.captureTime ?? lastFrame.timestamp)));
        for (const h of lastFrame.hands) {
          const v = { x: (h.tipVelocity[0]!.x + h.tipVelocity[1]!.x) / 2, y: (h.tipVelocity[0]!.y + h.tipVelocity[1]!.y) / 2 };
          shifts.set(h.id, extrapolate({ x: 0, y: 0 }, v, age, MAX_LEAD_HANDS * h.handSize));
        }
      }
      view.render(ctx, model, now, shifts, viewW || window.innerWidth);
    },

    dispose(): void {
      audio?.stopStrings();
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      if (onKey) window.removeEventListener("keydown", onKey);
      onKey = null;
      bar?.remove();
      bar = null;
      scaleSelect = null;
      lastFrame = null;
    },
  };
}
