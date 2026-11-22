export {};

// Stage 0 dummy AudioWorklet. It only proves that worklet loading works in dev AND in the production build.
//  - it posts "alive" the first time the audio thread runs it
//  - on a "beep" message it plays a short quiet 440 Hz tone (so the owner can hear that the whole chain works)
// The real Karplus-Strong processor (ks-string.ts) comes in Stage 1.

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

class DummyProcessor extends AudioWorkletProcessor {
  private announced = false;
  private beepSamplesLeft = 0;
  private beepTotal = 0;
  private phase = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === "beep") {
        this.beepTotal = Math.floor(sampleRate * 0.35);
        this.beepSamplesLeft = this.beepTotal;
        this.phase = 0;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.announced) {
      this.announced = true;
      this.port.postMessage({ type: "alive", sampleRate });
    }
    const out = outputs[0]?.[0];
    if (!out || this.beepSamplesLeft <= 0) return true;

    const step = (2 * Math.PI * 440) / sampleRate;
    for (let i = 0; i < out.length && this.beepSamplesLeft > 0; i++) {
      const progress = 1 - this.beepSamplesLeft / this.beepTotal;
      const env = Math.sin(Math.PI * progress); // soft fade in and out, no click
      out[i] = Math.sin(this.phase) * 0.15 * env;
      this.phase += step;
      this.beepSamplesLeft--;
    }
    // Copy to the other channels, if any.
    for (let c = 1; c < (outputs[0]?.length ?? 0); c++) outputs[0]![c]!.set(out);
    return true;
  }
}

registerProcessor("dummy-processor", DummyProcessor);
