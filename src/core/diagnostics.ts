// Diagnostics for the tracking speed problem (Stage 0.6). Runs in BOTH scopes (the tracking worker and the page), so the
// panel can compare "worker GL" with "main GL". Evidence only: nothing here changes how tracking works.
//
// - probeEnv(): is OffscreenCanvas / WebGL2 there, which GPU is behind it (WEBGL_debug_renderer_info), is it a software
//   renderer, are WASM SIMD and threads available.
// - installLogCapture(): MediaPipe's WASM prints things like which delegate it created to console.log/error. We keep
//   the first lines, so the panel can show them (and so the owner can paste them back).
// - loadedFiles(): the model / WASM files that were really fetched (Resource Timing).

export interface GlProbe {
  ok: boolean;
  renderer: string;
  vendor: string;
  version: string;
  /** Looks like a software renderer (SwiftShader, llvmpipe, Microsoft Basic Render Driver...). */
  software: boolean;
  /** Chrome refused to give a context when "no major performance caveat" was demanded: it would be software. null = not tested. */
  strictOk: boolean | null;
  error?: string;
}

export interface EnvDiag {
  scope: "worker" | "main";
  offscreenCanvas: boolean;
  /** WebGL2 context with default attributes (what MediaPipe asks for). */
  gl: GlProbe;
  /** Same with powerPreference "high-performance" (a second GPU on hybrid laptops would show up here). */
  glHigh: GlProbe;
  simd: boolean;
  /** SharedArrayBuffer + cross-origin isolation (needed by threaded WASM; the MediaPipe build we use is single-threaded). */
  threads: boolean;
  cores: number;
  webgpu: boolean;
}

export interface FileInfo {
  name: string;
  /** Bytes over the wire; 0 when the browser hides it (cross-origin without Timing-Allow-Origin). */
  bytes: number;
  ms: number;
}

/** What loading the model told us (sent with "ready"). */
export interface LoadDiag {
  files: FileInfo[];
  logs: string[];
  wasmLoaderPath: string;
  wasmBinaryPath: string;
  modelUrl: string;
  loadMs: number;
}

// --- pure helpers (tested) ---

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|warp\b|mesa offscreen/i;

export function isSoftwareRenderer(renderer: string): boolean {
  return SOFTWARE_RE.test(renderer);
}

/** The log lines that say something about delegates or GL, shortened. At most `max`. */
export function interestingLogs(lines: readonly string[], max = 6): string[] {
  const re = /delegate|xnnpack|gl_context|webgl|opengl|gpu|renderer|egl|\bgl\b/i;
  return lines
    .filter((l) => re.test(l))
    .slice(0, max)
    .map((l) => (l.length > 140 ? `${l.slice(0, 137)}...` : l));
}

/** Short text for one GL probe, e.g. "ANGLE (Intel, UHD 620) [software: no]". */
export function describeGl(p: GlProbe): string {
  if (!p.ok) return `NO WebGL2${p.error ? ` (${p.error})` : ""}`;
  const strict = p.strictOk === false ? " | strict context REFUSED (= software)" : "";
  return `${p.renderer} [${p.vendor}] software: ${p.software ? "YES" : "no"}${strict}`;
}

// --- probes ---

function newCanvas(): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(1, 1);
  if (typeof document !== "undefined") return document.createElement("canvas");
  return null;
}

export function probeGl(attrs: WebGLContextAttributes = {}): GlProbe {
  const empty: GlProbe = { ok: false, renderer: "", vendor: "", version: "", software: false, strictOk: null };
  try {
    const canvas = newCanvas();
    if (!canvas) return { ...empty, error: "no canvas" };
    const gl = canvas.getContext("webgl2", attrs) as WebGL2RenderingContext | null;
    if (!gl) return { ...empty, error: "getContext('webgl2') returned null" };
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    const vendor = String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR));
    const version = String(gl.getParameter(gl.VERSION));
    gl.getExtension("WEBGL_lose_context")?.loseContext();

    let strictOk: boolean | null = null;
    try {
      const strict = newCanvas()?.getContext("webgl2", { ...attrs, failIfMajorPerformanceCaveat: true }) as WebGL2RenderingContext | null;
      strictOk = strict !== null && strict !== undefined;
      strict?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      strictOk = null;
    }
    return { ok: true, renderer, vendor, version, software: isSoftwareRenderer(renderer), strictOk };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}

// The smallest WebAssembly module that uses a SIMD instruction (same bytes as the wasm-feature-detect library).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export function probeEnv(scope: "worker" | "main"): EnvDiag {
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  const g = globalThis as unknown as { crossOriginIsolated?: boolean; navigator?: { hardwareConcurrency?: number; gpu?: unknown } };
  return {
    scope,
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    gl: probeGl(),
    glHigh: probeGl({ powerPreference: "high-performance" }),
    simd,
    threads: typeof SharedArrayBuffer !== "undefined" && g.crossOriginIsolated === true,
    cores: g.navigator?.hardwareConcurrency ?? 0,
    webgpu: g.navigator?.gpu !== undefined,
  };
}

// --- MediaPipe's console output ---

const captured: string[] = [];
let installed = false;

/**
 * Wraps console.log/info/warn/error/debug (they still print as before) and keeps the first `maxLines` lines.
 * Call it BEFORE MediaPipe's WASM glue loads: Emscripten binds console.log / console.error when the glue starts.
 */
export function installLogCapture(maxLines = 80): void {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (captured.length < maxLines) {
        try {
          captured.push(`${level}: ${args.map((a) => String(a)).join(" ").slice(0, 300)}`);
        } catch {
          // a value that can not be turned into text: skip it
        }
      }
      original(...args);
    };
  }
}

export function capturedLogs(): string[] {
  return captured.slice();
}

// --- which files were really fetched ---

export function loadedFiles(): FileInfo[] {
  try {
    return performance
      .getEntriesByType("resource")
      .filter((e) => /\.(task|wasm|js|tflite|binarypb)(\?|$)/i.test(e.name))
      .map((e) => {
        const r = e as PerformanceResourceTiming;
        return {
          name: e.name.split("?")[0]!.split("/").pop() || e.name,
          bytes: r.transferSize || r.encodedBodySize || r.decodedBodySize || 0,
          ms: e.duration,
        };
      });
  } catch {
    return [];
  }
}
