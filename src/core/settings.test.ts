import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../config";
import { SETTINGS_STORAGE_KEY, loadSavedSettings, pickSaved, sanitizeSaved, saveSettings } from "./settings";

function fakeStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SETTINGS_STORAGE_KEY, initial);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("saved speed settings", () => {
  it("round-trips through storage", () => {
    const store = fakeStorage();
    const cfg: Config = { ...DEFAULT_CONFIG, trackMode: "main", delegate: "CPU", inferEvery: 2, cameraRes: "320x240" };
    saveSettings(cfg, store);
    expect(loadSavedSettings(store)).toMatchObject({ trackMode: "main", delegate: "CPU", inferEvery: 2, cameraRes: "320x240" });
  });

  it("saves only the speed keys", () => {
    const saved = pickSaved({ ...DEFAULT_CONFIG, minCutoff: 7 });
    expect(saved).not.toHaveProperty("minCutoff");
    expect(saved).toHaveProperty("trackMode");
  });

  it("drops unknown keys, wrong types and values that are not allowed", () => {
    const out = sanitizeSaved({
      trackMode: "gpu-magic",
      delegate: 5,
      pickupOnFree: "yes",
      inferEvery: "2",
      cameraRes: "800x600",
      minCutoff: 9, // not a saved key
      evil: true,
    });
    expect(out).toEqual({});
  });

  it("clamps numbers to the slider range", () => {
    expect(sanitizeSaved({ inferEvery: 99, maxDpr: -4, renderFpsCap: Number.NaN })).toEqual({ inferEvery: 3, maxDpr: 1 });
  });

  it("keeps the render settings of Stage 0.7 and clamps the scale", () => {
    const store = fakeStorage();
    saveSettings({ ...DEFAULT_CONFIG, videoMode: "canvas", renderScale: 0.5, software2d: true, testLoad: true }, store);
    const back = loadSavedSettings(store);
    expect(back).toMatchObject({ videoMode: "canvas", renderScale: 0.5, software2d: true });
    expect(back).not.toHaveProperty("testLoad"); // a test load is never remembered
    expect(sanitizeSaved({ renderScale: 0.1 })).toEqual({ renderScale: 0.5 });
    expect(sanitizeSaved({ videoMode: "video" })).toEqual({});
  });

  it("survives broken JSON, a missing storage and a throwing storage", () => {
    expect(loadSavedSettings(fakeStorage("{not json"))).toEqual({});
    expect(loadSavedSettings(fakeStorage("null"))).toEqual({});
    expect(loadSavedSettings(null)).toEqual({});
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSavedSettings(throwing)).toEqual({});
    expect(() => saveSettings(DEFAULT_CONFIG, throwing)).not.toThrow();
  });
});
