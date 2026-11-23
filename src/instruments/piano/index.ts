// The air piano instrument: ties the logic (model.ts), the sound (PianoSynth via AudioEngine) and the drawing (visuals.ts).

import type { AudioEngine } from "../../audio/engine";
import { config } from "../../config";
import { saveSettings } from "../../core/settings";
import { extrapolate } from "../../core/predict";
import { el } from "../../ui/dom";
import type { Effects } from "../../render/effects";
import type { HandFrame, Instrument } from "../Instrument";
import { PianoModel, type PianoEvent } from "./model";
import { PianoView, type TipView } from "./visuals";

const MAX_LEAD_MS = 220; // the real age: camera capture -> now
const MAX_LEAD_HANDS = 0.8;

export function createPiano(): Instrument {
  const model = new PianoModel(config);
  const view = new PianoView();
  // Debug handle for the browser console (e.g. __piano.down).
  Object.assign(window, { __piano: model });

  let audio: AudioEngine | null = null;
  let bar: HTMLElement | null = null;
  let lastFrame: HandFrame | null = null;
  let viewW = 0;
  let viewH = 0;
  const tips: TipView[] = [];

  function handle(events: readonly PianoEvent[], receivedAt: number): void {
    for (const e of events) {
      if (e.type === "on") {
        audio?.pianoOn(e.id, e.midi, e.velocity, receivedAt);
        const key = model.layout.keys.find((k) => k.midi === e.midi);
        if (key) view.press(e.point, key, e.velocity);
      } else {
        audio?.pianoOff(e.id);
      }
    }
  }

  function octave(delta: number): void {
    config.pianoLowOctave = Math.max(2, Math.min(5, config.pianoLowOctave + delta));
    saveSettings(config);
    handle(model.reset(), performance.now()); // keys change under the fingers: let go of everything
  }

  return {
    id: "piano",
    name: "Air piano",
    hint: "Bend a finger over a key as if pressing it: the note plays while you hold it and stops when you straighten it. Use several fingers for chords. Moving the whole hand plays nothing.",

    init(a: AudioEngine): void {
      audio = a;
      viewW = window.innerWidth;
      viewH = window.innerHeight;
      model.setViewport(viewW, viewH);
      bar = el(
        "div",
        { class: "harp-bar", style: "bottom: auto; top: 110px" },
        el("button", { class: "btn btn-small", textContent: "◀ Octave", title: "Keys one octave lower", onclick: () => octave(-1) }),
        el("button", { class: "btn btn-small", textContent: "Octave ▶", title: "Keys one octave higher", onclick: () => octave(1) }),
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
      tips.length = 0;
      if (lastFrame) {
        const age = Math.min(MAX_LEAD_MS, Math.max(0, now - (lastFrame.captureTime ?? lastFrame.timestamp)));
        const first = config.pianoThumb ? 0 : 1;
        for (const h of lastFrame.hands) {
          for (let k = first; k < 5; k++) {
            const pos = extrapolate(h.tips[k]!, h.tipVelocity[k]!, age, MAX_LEAD_HANDS * h.handSize);
            const id = h.id * 8 + k;
            tips.push({ id, pos, down: model.down.size > 0 && [...model.down.values()].includes(id) });
          }
        }
      }
      view.render(ctx, model, now, tips);
    },

    dispose(): void {
      audio?.pianoStopAll();
      model.reset();
      bar?.remove();
      bar = null;
      lastFrame = null;
    },
  };
}
