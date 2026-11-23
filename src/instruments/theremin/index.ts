// The theremin instrument: ties the logic (model.ts), the sound (ThereminSynth) and the drawing (visuals.ts) together,
// runs the first-use calibration ("show me your lowest and highest hand position", 2 s, saved in localStorage) and has a
// "Calibrate" button / K key to do it again.

import type { AudioEngine } from "../../audio/engine";
import { ThereminSynth } from "../../audio/theremin";
import { config } from "../../config";
import { extrapolate } from "../../core/predict";
import { Banner } from "../../ui/banner";
import { el } from "../../ui/dom";
import type { Effects } from "../../render/effects";
import type { Hand, HandFrame, Instrument, Vec2 } from "../Instrument";
import { ThereminModel, sanitizeCalibration, type ThereminCalibration } from "./model";
import { ThereminView } from "./visuals";

const STORAGE_KEY = "air-instruments.theremin.v1";
const MAX_LEAD_MS = 150;
const MAX_LEAD_HANDS = 0.5;
const ZERO: Vec2 = { x: 0, y: 0 };

function loadCalibration(): ThereminCalibration | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeCalibration(JSON.parse(raw)) : null;
  } catch {
    return null; // blocked or broken storage: calibrate again
  }
}

function saveCalibration(c: ThereminCalibration): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // not remembered, nothing breaks
  }
}

export function createTheremin(): Instrument {
  const model = new ThereminModel(config);
  const view = new ThereminView();
  // Debug handle for the browser console (e.g. __theremin.state).
  Object.assign(window, { __theremin: model });

  let audio: AudioEngine | null = null;
  let synth: ThereminSynth | null = null;
  let bar: HTMLElement | null = null;
  let banner: Banner | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  let lastFrame: HandFrame | null = null;
  let viewW = 0;
  let viewH = 0;
  let doneTimer = 0;
  let wasCalibrating = false;

  function beginCalibration(): void {
    window.clearTimeout(doneTimer);
    model.startCalibration();
    wasCalibrating = true;
    banner?.show("Show me your lowest and highest hand position", "Move BOTH hands slowly down to the lowest and up to the highest place you want to play. It takes 2 seconds once a hand is seen.");
  }

  function aheadOf(hand: Hand | undefined, now: number, frame: HandFrame | null): Vec2 {
    if (!hand || !frame) return ZERO;
    const age = Math.min(MAX_LEAD_MS, Math.max(0, now - frame.timestamp));
    return extrapolate(ZERO, hand.palmVelocity, age, MAX_LEAD_HANDS * hand.handSize);
  }

  return {
    id: "theremin",
    name: "Theremin",
    hint: "Right hand height = pitch, left hand height = volume (low = silent). Wobble your right hand sideways for vibrato. Pinch with the right hand to separate notes.",

    init(a: AudioEngine): void {
      audio = a;
      viewW = window.innerWidth;
      viewH = window.innerHeight;
      model.setViewport(viewW, viewH);
      model.reset();
      synth = new ThereminSynth(a.ctx, a.thereminBus);
      const ui = document.getElementById("ui");
      banner = ui ? new Banner(ui) : null;
      bar = el(
        "div",
        { class: "harp-bar" },
        el("button", { class: "btn btn-small", textContent: "Calibrate (K)", title: "Show your lowest and highest hand position again", onclick: beginCalibration }),
      );
      ui?.append(bar);
      onKey = (e: KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        if (e.key.toLowerCase() === "k") beginCalibration();
      };
      window.addEventListener("keydown", onKey);

      const saved = loadCalibration();
      if (saved) model.setCalibration(saved);
      else beginCalibration(); // first use
    },

    update(frame: HandFrame, _dt: number, _now: number): void {
      if (window.innerWidth !== viewW || window.innerHeight !== viewH) {
        viewW = window.innerWidth;
        viewH = window.innerHeight;
        model.setViewport(viewW, viewH);
      }
      lastFrame = frame;
      const { calibrated } = model.update(frame, frame.timestamp);

      const cal = model.calibrator;
      if (cal.active) {
        banner?.show(
          "Show me your lowest and highest hand position",
          cal.progress > 0 ? `Keep moving both hands up and down... ${Math.max(0, Math.ceil(2 * (1 - cal.progress)))} s` : "Show your hands to the camera to start.",
        );
      } else if (wasCalibrating) {
        wasCalibrating = false;
        if (calibrated) saveCalibration(calibrated);
        const missing = [!cal.sawPitch ? "right (pitch)" : "", !cal.sawVol ? "left (volume)" : ""].filter(Boolean).join(" and ");
        banner?.show("Done. Now play!", missing ? `I did not see your ${missing} hand, so its range stays at the default.` : "Right hand = pitch, left hand = volume.");
        doneTimer = window.setTimeout(() => banner?.hide(), 3000);
      }

      const s = model.state;
      // Silent while calibrating (the hands are just moving around).
      synth?.set(
        { freq: s.freq, gain: cal.active ? 0 : s.gain, vibratoCents: s.vibratoCents, vibratoHz: s.vibratoHz },
        config.thereminGlideMs,
        s.muted,
      );
    },

    render(ctx: CanvasRenderingContext2D, _fx: Effects): void {
      const now = performance.now();
      const pitchHand = lastFrame?.hands.find((h) => h.side === "right");
      const volHand = lastFrame?.hands.find((h) => h.side === "left");
      view.render(ctx, model, now, viewW || window.innerWidth, viewH || window.innerHeight, aheadOf(pitchHand, now, lastFrame), aheadOf(volHand, now, lastFrame));
    },

    dispose(): void {
      window.clearTimeout(doneTimer);
      synth?.dispose();
      synth = null;
      if (onKey) window.removeEventListener("keydown", onKey);
      onKey = null;
      bar?.remove();
      bar = null;
      banner?.hide();
      banner = null;
      model.calibrator.cancel();
      wasCalibrating = false;
      lastFrame = null;
      void audio;
    },
  };
}
