export {};

// The string synth AudioWorklet (Stage 1): ONE node, all voices inside (see ../ksVoice.ts for the DSP).
// Messages in:  { type: "pluck", stringId, freq, velocity, brightness, pan }  |  { type: "stop", stringId? }
// Messages out: { type: "ready", sampleRate } once, from the audio thread.
//
// Loaded with Vite's "?worker&url" import (see engine.ts), which compiles this file AND the ../ksVoice import into one
// real .js asset, so it works in dev, build and preview.

import { KsSynth, type PluckParams } from "../ksVoice";

// The worklet global scope has these, but TypeScript's DOM lib does not describe them.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  },
): void;
declare const sampleRate: number;

type InMessage = ({ type: "pluck" } & PluckParams) | { type: "stop"; stringId?: number };

class KsStringProcessor extends AudioWorkletProcessor {
  private readonly synth = new KsSynth(sampleRate);
  private announced = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<InMessage>) => {
      const m = e.data;
      if (m.type === "pluck") this.synth.pluck(m);
      else if (m.type === "stop") this.synth.stop(m.stringId);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.announced) {
      this.announced = true;
      this.port.postMessage({ type: "ready", sampleRate });
    }
    const out = outputs[0];
    const left = out?.[0];
    if (!left) return true;
    this.synth.process(left, out[1]);
    return true;
  }
}

registerProcessor("ks-string-processor", KsStringProcessor);
