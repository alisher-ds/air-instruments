import { describe, expect, it } from "vitest";
import { describeGl, interestingLogs, isSoftwareRenderer, type GlProbe } from "./diagnostics";

describe("software renderer detection", () => {
  it("flags the known software paths", () => {
    expect(isSoftwareRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)")).toBe(true);
    expect(isSoftwareRenderer("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)")).toBe(true);
    expect(isSoftwareRenderer("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
  });
  it("does not flag real GPUs", () => {
    expect(isSoftwareRenderer("ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(false);
    expect(isSoftwareRenderer("ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(false);
    expect(isSoftwareRenderer("")).toBe(false);
  });
});

describe("log filtering", () => {
  it("keeps delegate / GL lines and shortens long ones", () => {
    const lines = [
      "log: something unrelated",
      "error: INFO: Created TensorFlow Lite XNNPACK delegate for CPU.",
      "log: gl_context_webgl.cc:150 Successfully created a WebGL context",
      `warn: GPU ${"x".repeat(300)}`,
    ];
    const out = interestingLogs(lines);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("XNNPACK");
    expect(out[2]!.length).toBeLessThanOrEqual(140);
  });
  it("respects the limit", () => {
    expect(interestingLogs(Array.from({ length: 20 }, () => "log: gpu delegate"), 4)).toHaveLength(4);
  });
});

describe("describeGl", () => {
  const base: GlProbe = { ok: true, renderer: "ANGLE (Intel UHD)", vendor: "Google Inc.", version: "WebGL 2.0", software: false, strictOk: true };
  it("describes a normal GPU", () => {
    expect(describeGl(base)).toContain("software: no");
  });
  it("shouts when the strict context is refused", () => {
    expect(describeGl({ ...base, strictOk: false })).toContain("REFUSED");
  });
  it("describes a missing WebGL2", () => {
    expect(describeGl({ ...base, ok: false, error: "null" })).toContain("NO WebGL2");
  });
});
