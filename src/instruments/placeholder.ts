// Stage 0 placeholder: implements the Instrument contract and does nothing yet.
import type { AudioEngine } from "../audio/engine";
import type { Effects } from "../render/effects";
import type { HandFrame, Instrument, InstrumentId } from "./Instrument";

export function createPlaceholder(id: InstrumentId, name: string, comingIn: string): Instrument {
  return {
    id,
    name,
    hint: `${name} is not built yet (${comingIn}).`,
    init(_audio: AudioEngine): void {},
    update(_frame: HandFrame, _dt: number, _now: number): void {},
    render(_ctx: CanvasRenderingContext2D, _fx: Effects): void {},
    dispose(): void {},
  };
}
