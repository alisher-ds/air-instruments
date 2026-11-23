// Audio engine skeleton (Stage 0): ONE AudioContext, a master bus, a soft limiter, and a dummy AudioWorklet.
// Instruments will connect their own buses to `input`. Reverb is added in a later stage (it sits before the limiter).

// The worklet is a TypeScript file, so it must be COMPILED into a JS file for the production build.
// "?worker&url" makes Vite bundle it and give us its URL. (Plain new URL("./x.ts", import.meta.url), the pattern
// named in PLAN.md, was verified NOT to work in `npm run build`: Vite inlines the raw .ts as a data: URI with a
// wrong MIME type. See HANDOFF.md.)
import dummyWorkletUrl from "./worklets/dummy.ts?worker&url";
import ksWorkletUrl from "./worklets/ks-string.ts?worker&url";
import type { PluckParams } from "./ksVoice";
import { DoiraSynth, type DrumHit } from "./drum";
import { PianoSynth } from "./piano";
import { makeImpulse } from "./reverb";

const WET_GAIN_AT_FULL_MIX = 2.5;

export type WorkletStatus = "not-started" | "loading" | "ok" | "failed";

export class AudioEngine {
  readonly ctx: AudioContext;
  /** Instruments connect their buses here. */
  readonly input: GainNode;
  private readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  /** Reverb: everything on `input` is also sent through a convolver (a generated room), and the wet part joins the master. */
  private readonly reverbWet: GainNode;
  private dummyNode: AudioWorkletNode | null = null;
  /** The string synth (ONE node, all voices inside). null until its worklet has loaded. */
  private ksNode: AudioWorkletNode | null = null;
  /** The string synth's bus: everything the harp plays goes through it into `input`. */
  readonly stringBus: GainNode;
  /** The doira's bus and synth (made nodes per hit, see drum.ts). */
  readonly drumBus: GainNode;
  /** The theremin's bus (its oscillators are made by the instrument, see theremin.ts). */
  readonly thereminBus: GainNode;
  /** The air piano's bus and synth. */
  readonly pianoBus: GainNode;
  private readonly piano: PianoSynth;
  /** Piano notes played, and the time from "landmarks received" to "note started" (ms). */
  pianoNoteCount = 0;
  lastNoteDelayMs = 0;
  maxNoteDelayMs = 0;
  private readonly doira: DoiraSynth;
  /** Drum hits played, and the time from "landmarks received" to "hit played" (ms). */
  drumHitCount = 0;
  lastHitDelayMs = 0;
  maxHitDelayMs = 0;

  /** "ks-string" worklet (the harp's sound). */
  ksStatus: WorkletStatus = "not-started";
  ksError = "";
  /** Plucks sent to the synth, and the time from "landmarks received" to "message handed to the audio thread" (ms). */
  pluckCount = 0;
  lastPluckDelayMs = 0;
  maxPluckDelayMs = 0;

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

    this.stringBus = this.ctx.createGain();
    this.stringBus.gain.value = 0.9;
    this.stringBus.connect(this.input);

    this.drumBus = this.ctx.createGain();
    this.drumBus.gain.value = 0.9;
    this.drumBus.connect(this.input);
    this.doira = new DoiraSynth(this.ctx, this.drumBus);

    this.thereminBus = this.ctx.createGain();
    this.thereminBus.gain.value = 0.9;
    this.thereminBus.connect(this.input);

    this.pianoBus = this.ctx.createGain();
    this.pianoBus.gain.value = 0.9;
    this.pianoBus.connect(this.input);
    this.piano = new PianoSynth(this.ctx, this.pianoBus);

    this.input.connect(this.master); // dry

    // Reverb send -> generated impulse response -> wet gain -> master (all before the limiter).
    const convolver = this.ctx.createConvolver();
    const ir = makeImpulse(this.ctx.sampleRate);
    const irBuffer = this.ctx.createBuffer(2, ir.left.length, this.ctx.sampleRate);
    irBuffer.copyToChannel(ir.left, 0);
    irBuffer.copyToChannel(ir.right, 1);
    convolver.buffer = irBuffer;
    this.reverbWet = this.ctx.createGain();
    this.reverbWet.gain.value = 0.3 * WET_GAIN_AT_FULL_MIX;
    this.input.connect(convolver);
    convolver.connect(this.reverbWet);
    this.reverbWet.connect(this.master);

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
    await Promise.all([this.loadDummyWorklet(), this.loadKsWorklet()]);
  }

  private async loadKsWorklet(): Promise<void> {
    this.ksStatus = "loading";
    try {
      await this.ctx.audioWorklet.addModule(ksWorkletUrl);
      const node = new AudioWorkletNode(this.ctx, "ks-string-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "ready") {
          this.ksStatus = "ok";
          this.ksError = "";
        }
      };
      node.connect(this.stringBus);
      this.ksNode = node;
      this.ksStatus = "ok"; // the module loaded and the node exists; "ready" from the audio thread confirms it later
    } catch (e) {
      this.ksStatus = "failed";
      this.ksError = e instanceof Error ? e.message : String(e);
      console.error("String synth worklet failed to load:", e);
    }
  }

  /**
   * Plays a string. `receivedAt` = performance.now() when the landmarks behind this pluck arrived, so the panel can show
   * "landmarks received -> sound scheduled" (PLAN.md: < 5 ms). Returns false if the synth is not available.
   */
  pluck(p: PluckParams, receivedAt?: number): boolean {
    const node = this.ksNode;
    if (!node) return false;
    node.port.postMessage({ type: "pluck", ...p });
    this.pluckCount++;
    if (receivedAt !== undefined) {
      this.lastPluckDelayMs = performance.now() - receivedAt;
      this.maxPluckDelayMs = Math.max(this.maxPluckDelayMs, this.lastPluckDelayMs);
    }
    return true;
  }

  /** Starts a piano note for finger `id` (see PianoSynth). `receivedAt` = performance.now() when the landmarks arrived. */
  pianoOn(id: number, midi: number, velocity: number, receivedAt?: number): void {
    void this.ctx.resume();
    this.piano.noteOn(id, midi, velocity);
    this.pianoNoteCount++;
    if (receivedAt !== undefined) {
      this.lastNoteDelayMs = performance.now() - receivedAt;
      this.maxNoteDelayMs = Math.max(this.maxNoteDelayMs, this.lastNoteDelayMs);
    }
  }

  pianoOff(id: number): void {
    this.piano.noteOff(id);
  }

  pianoStopAll(): void {
    this.piano.stopAll();
  }

  /** Plays a doira hit now. `receivedAt` = performance.now() when the landmarks behind it arrived (for the panel). */
  hitDrum(hit: DrumHit, receivedAt?: number): void {
    void this.ctx.resume();
    this.doira.play(hit);
    this.drumHitCount++;
    if (receivedAt !== undefined) {
      this.lastHitDelayMs = performance.now() - receivedAt;
      this.maxHitDelayMs = Math.max(this.maxHitDelayMs, this.lastHitDelayMs);
    }
  }

  /** Fade out one string's voices (e.g. the string was deleted), or all of them. */
  stopStrings(stringId?: number): void {
    this.ksNode?.port.postMessage({ type: "stop", stringId });
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
          this.workletError = ""; // it may have been slow (busy machine) and already been judged "failed"
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

  /** The final mix (after the limiter) as a MediaStream, for "Record performance". Made on first use. */
  get recordingStream(): MediaStream {
    if (!this.recordDest) {
      this.recordDest = this.ctx.createMediaStreamDestination();
      this.limiter.connect(this.recordDest);
    }
    return this.recordDest.stream;
  }

  /** Reverb amount 0..1 (0 = dry). Smoothly ramped, so moving the slider never clicks. */
  setReverbMix(mix: number): void {
    const m = Math.min(1, Math.max(0, Number.isFinite(mix) ? mix : 0));
    // The convolver is normalised, so its tail is quiet next to the dry sound: mix 1 = wet gain 2.5 (measured: at mix 0.3 the
    // wet peak is about -12 dB under the dry one, a light room).
    this.reverbWet.gain.setTargetAtTime(m * WET_GAIN_AT_FULL_MIX, this.ctx.currentTime, 0.03);
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
