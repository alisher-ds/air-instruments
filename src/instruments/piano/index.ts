import type { Instrument } from "../Instrument";
import { createPlaceholder } from "../placeholder";

export const createPiano = (): Instrument => createPlaceholder("piano", "Air piano", "Stage 5");
