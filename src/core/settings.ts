// Saves the SPEED settings (tracking mode, delegate, ...) in localStorage so the choice survives a reload.
// Only the keys in SAVED_KEYS are saved: they are the ones the owner switches while comparing modes.
// Everything read back is validated against the tunable definitions, so a hand-edited or old value can not break the app.

import { TUNABLES, type Config } from "../config";

export const SETTINGS_STORAGE_KEY = "air-instruments.speed.v1";

export const SAVED_KEYS: ReadonlyArray<keyof Config & string> = [
  "trackMode",
  "delegate",
  "workerInput",
  "pickupOnFree",
  "inferEvery",
  "numHands",
  "cameraRes",
  "maxDpr",
  "videoMode",
  "renderScale",
  "software2d",
  "renderFpsCap",
  "drawLeadEnabled",
  "harpScale",
  "harpTone",
  "doiraBumHz",
  "doiraRadiusFrac",
  "reverbMix",
];

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Keeps only known keys with valid values (right type, allowed option, number clamped to its slider range). */
export function sanitizeSaved(raw: unknown): Partial<Config> {
  const out: Record<string, number | boolean | string> = {};
  if (typeof raw !== "object" || raw === null) return out as Partial<Config>;
  const bag = raw as Record<string, unknown>;
  for (const key of SAVED_KEYS) {
    const tunable = TUNABLES.find((t) => t.key === key);
    const value = bag[key];
    if (!tunable || value === undefined) continue;
    if (tunable.kind === "boolean") {
      if (typeof value === "boolean") out[key] = value;
    } else if (tunable.kind === "choice") {
      if (typeof value === "string" && tunable.options.includes(value)) out[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.min(tunable.max, Math.max(tunable.min, value));
    }
  }
  return out as Partial<Config>;
}

export function pickSaved(cfg: Config): Partial<Config> {
  const out: Record<string, unknown> = {};
  for (const key of SAVED_KEYS) out[key] = cfg[key];
  return out as Partial<Config>;
}

/** localStorage can be missing or throw (private window, blocked site data): then nothing is saved and nothing breaks. */
function browserStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadSavedSettings(storage: StorageLike | null = browserStorage()): Partial<Config> {
  if (!storage) return {};
  try {
    const text = storage.getItem(SETTINGS_STORAGE_KEY);
    return text ? sanitizeSaved(JSON.parse(text)) : {};
  } catch {
    return {};
  }
}

export function saveSettings(cfg: Config, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(pickSaved(cfg)));
  } catch {
    // quota / blocked: the setting simply is not remembered
  }
}
