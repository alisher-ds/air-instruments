// The doira instrument: ties the logic (model.ts), the sound (DoiraSynth via AudioEngine) and the drawing (visuals.ts)
// together. The drum position is remembered in localStorage (try/catch: it may be blocked).

import type { AudioEngine } from "../../audio/engine";
import { config } from "../../config";
import { extrapolate } from "../../core/predict";
import { el } from "../../ui/dom";
import type { Effects } from "../../render/effects";
import type { HandFrame, Instrument, Vec2 } from "../Instrument";
import { DoiraModel, type DoiraEvent } from "./model";
import { DoiraView } from "./visuals";

const STORAGE_KEY = "air-instruments.doira.v1";
const MAX_LEAD_MS = 220; // the real age: camera capture -> now (frame age ~100 ms + the time since the frame arrived)
const MAX_LEAD_HANDS = 0.5;

function loadPosition(model: DoiraModel): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as { fx?: unknown; fy?: unknown };
    if (typeof p.fx === "number" && typeof p.fy === "number") model.setPosition(p.fx, p.fy);
  } catch {
    // blocked or broken storage: the drum simply starts in the default place
  }
}

function savePosition(model: DoiraModel): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ fx: model.fx, fy: model.fy }));
  } catch {
    // not remembered, nothing breaks
  }
}

export function createDoira(): Instrument {
  const model = new DoiraModel(config);
  const view = new DoiraView();
  loadPosition(model);
  // Debug handle for the browser console (e.g. __doira.center).
  Object.assign(window, { __doira: model });

  let audio: AudioEngine | null = null;
  let bar: HTMLElement | null = null;
  let lastFrame: HandFrame | null = null;
  let viewW = 0;
  let viewH = 0;

  function handle(events: readonly DoiraEvent[], receivedAt: number): void {
    for (const e of events) {
      if (e.type === "moved") {
        savePosition(model);
        continue;
      }
      const soft = e.kind === "finger";
      audio?.hitDrum({ velocity: e.velocity, zone: e.zone, soft, bumHz: config.doiraBumHz }, receivedAt);
      view.hit(e.point, e.zone, e.velocity, soft);
    }
  }

  return {
    id: "doira",
    name: "Doira",
    hint: "Hit the drum with your palm: the middle is a deep bum, near the edge a sharp tak. Flick your fingers over it for soft taps. Pinch the drum to move it.",

    init(a: AudioEngine): void {
      audio = a;
      viewW = window.innerWidth;
      viewH = window.innerHeight;
      model.setViewport(viewW, viewH);
      bar = el(
        "div",
        { class: "harp-bar" },
        el("button", {
          class: "btn btn-small",
          textContent: "Reset drum position",
          onclick: () => {
            model.resetPosition();
            savePosition(model);
          },
        }),
      );
      document.getElementById("ui")?.append(bar);
    },

    update(frame: HandFrame, _dt: number, _now: number): void {
      if (window.innerWidth !== viewW || window.innerHeight !== viewH) {
        viewW = window.innerWidth;
        viewH = window.innerHeight;
        model.setViewport(viewW, viewH);
      }
      lastFrame = frame;
      // frame.timestamp is when the landmarks reached the main thread (performance.now clock): the "received" moment.
      handle(model.update(frame, frame.timestamp), frame.timestamp);
    },

    render(ctx: CanvasRenderingContext2D, _fx: Effects): void {
      const now = performance.now();
      // While a hand moves the drum, draw it where the hand is heading (the tracking frame is ~100 ms old). Drawing only.
      let shift: Vec2 | null = null;
      if (lastFrame && model.dragging.size > 0) {
        const hand = lastFrame.hands.find((h) => model.dragging.has(h.id));
        if (hand) {
          const age = Math.min(MAX_LEAD_MS, Math.max(0, now - (lastFrame.captureTime ?? lastFrame.timestamp)));
          const v = { x: (hand.tipVelocity[0]!.x + hand.tipVelocity[1]!.x) / 2, y: (hand.tipVelocity[0]!.y + hand.tipVelocity[1]!.y) / 2 };
          shift = extrapolate({ x: 0, y: 0 }, v, age, MAX_LEAD_HANDS * hand.handSize);
        }
      }
      view.render(ctx, model, now, shift);
    },

    dispose(): void {
      bar?.remove();
      bar = null;
      lastFrame = null;
    },
  };
}
