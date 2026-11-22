// Audio engine skeleton (Stage 0): ONE AudioContext, a master bus, a soft limiter, and a dummy AudioWorklet.
// Instruments will connect their own buses to `input`. Reverb is added in a later stage (it sits before the limiter).

// The worklet is a TypeScript file, so it must be COMPILED into a JS file for the production build.
// "?worker&url" makes Vite bundle it and give us its URL. (Plain new URL("./x.ts", import.meta.url), the pattern
// named in PLAN.md, was verified NOT to work in `npm run build`: Vite inlines the raw .ts as a data: URI with a
// wrong MIME type. See HANDOFF.md.)
import dummyWorkletUrl from "./worklets/dummy.ts?worker&url";

export type WorkletStatus = "not-started" | "loading" | "ok" | "failed";

export class AudioEngine {
  readonly ctx: AudioContext;
  /** Instruments connect their buses here. */
  readonly input: GainNode;
  private readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private dummyNode: AudioWorkletNode | null = null;

  workletStatus: WorkletStatus = "not-started";
  workletError = "";
  /** Sample rate reported from inside the audio thread by the dummy worklet. */
  workletSampleRate = 0;

  /**
   * Must be called from inside a user click (browser autoplay rule).
   * Chain: instrument buses -> master gain -> soft limiter -> speakers.
   */
  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });

    this.input = this.ctx.createGain();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;

    // Fast, hard-ratio compressor used as a soft limiter so the output never clips.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;

    this.input.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);
  }

  /** Resume the context and load the dummy worklet. Never throws; check `workletStatus`. */
  async start(): Promise<void> {
    try {
      await this.ctx.resume();
    } catch (e) {
      console.warn("AudioContext could not resume:", e);
    }
    await this.loadDummyWorklet();
  }

  private async loadDummyWorklet(): Promise<void> {
    this.workletStatus = "loading";
    try {
      await this.ctx.audioWorklet.addModule(dummyWorkletUrl);
      const node = new AudioWorkletNode(this.ctx, "dummy-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "alive") {
          this.workletStatus = "ok";
          this.workletSampleRate = e.data.sampleRate;
        }
      };
      node.connect(this.input);
      this.dummyNode = node;
      // "ok" is set only when the audio thread really ran the processor. Give it a moment, then judge.
      await new Promise((r) => setTimeout(r, 400));
      if ((this.workletStatus as WorkletStatus) !== "ok") {
        this.workletStatus = "failed";
        this.workletError = "Worklet loaded but never ran (audio context suspended?)";
      }
    } catch (e) {
      this.workletStatus = "failed";
      this.workletError = e instanceof Error ? e.message : String(e);
      console.error("AudioWorklet failed to load:", e);
    }
  }

  /** Short quiet 440 Hz tone from the worklet, to hear that the whole chain works. */
  beep(): void {
    void this.ctx.resume();
    this.dummyNode?.port.postMessage("beep");
  }

  /** baseLatency + outputLatency, in ms (what the browser reports; outputLatency may be 0 on some browsers). */
  get estimatedLatencyMs(): number {
    return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000;
  }

  get state(): AudioContextState {
    return this.ctx.state;
  }

  suspend(): void {
    void this.ctx.suspend();
  }

  resume(): void {
    void this.ctx.resume();
  }
}
