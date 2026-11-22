// Regenerates test/recordings/synthetic-two-hands.json. Run: node scripts/make-sample-recording.mjs
// (Node 22.18+ / 24 can load the .ts helper directly.)
import { writeFileSync } from "node:fs";
import { syntheticTwoHandsRecording } from "../test/helpers/synthHand.ts";

const out = new URL("../test/recordings/synthetic-two-hands.json", import.meta.url);
writeFileSync(out, JSON.stringify(syntheticTwoHandsRecording()));
console.log("wrote", out.pathname);
