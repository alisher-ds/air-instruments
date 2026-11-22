// The four instrument slots, in key order: 1 = harp, 2 = doira, 3 = theremin, 4 = piano.
import type { Instrument } from "./Instrument";
import { createDoira } from "./doira";
import { createHarp } from "./harp";
import { createPiano } from "./piano";
import { createTheremin } from "./theremin";

export function createInstruments(): Instrument[] {
  return [createHarp(), createDoira(), createTheremin(), createPiano()];
}
