// Friendly hints for the two things that most often go wrong for a new player (PLAN.md section 7, "Lighting check"):
//  - a dim room: the webcam silently drops to ~15 fps and tracking gets slow and jumpy (measured on the owner's laptop);
//  - hands out of the picture: nothing happens and the player does not know why.
// Pure (no DOM, no clock of its own), so it is tested with a fake clock. The app shows the returned text for a few seconds.

export type HintId = "slow-camera" | "no-hands";

export interface Hint {
  id: HintId;
  text: string;
}

export interface AssistInput {
  /** New camera frames per second as the browser sees them (0 = unknown / not running). */
  cameraFps: number;
  /** Hands found in the latest tracking result. */
  hands: number;
  /** False while the tab is hidden or the app has not started: nothing is measured then. */
  active: boolean;
}

export const SLOW_FPS = 22;
export const SLOW_FOR_MS = 6000;
export const NO_HANDS_FOR_MS = 12000;
/** How long a hint stays up, and how long before the SAME hint may come back. */
export const SHOW_MS = 9000;
export const REPEAT_MS = 90000;

const TEXT: Record<HintId, (fps: number) => string> = {
  "slow-camera": (fps) =>
    `Your camera is running slowly (${Math.round(fps)} frames per second), usually because the room is dim. Add light on your hands (a lamp, or face a window): tracking gets faster and steadier.`,
  "no-hands": () =>
    "I can't see your hands. Hold them up in front of the camera, a little further back so both fit in the picture, with light on them.",
};

export class AssistHints {
  private slowSince: number | null = null;
  private noHandsSince: number | null = null;
  private shownAt: Partial<Record<HintId, number>> = {};
  private current: { hint: Hint; until: number } | null = null;
  private lastFps = 0;

  /** Call a few times a second. Returns the hint to show right now, or null. */
  update(now: number, input: AssistInput): Hint | null {
    if (!input.active) {
      this.slowSince = null;
      this.noHandsSince = null;
      this.current = null;
      return null;
    }

    const slow = input.cameraFps > 0 && input.cameraFps < SLOW_FPS;
    if (input.cameraFps > 0) this.lastFps = input.cameraFps;
    this.slowSince = slow ? (this.slowSince ?? now) : null;
    this.noHandsSince = input.hands === 0 ? (this.noHandsSince ?? now) : null;
    // Seeing hands again makes the "no hands" hint pointless: take it down.
    if (input.hands > 0 && this.current?.hint.id === "no-hands") this.current = null;

    if (this.current && now >= this.current.until) this.current = null;
    if (this.current) return this.current.hint;

    const due = (id: HintId): boolean => {
      const last = this.shownAt[id];
      return last === undefined || now - last >= REPEAT_MS;
    };
    // A slow camera explains everything else, so it comes first.
    if (this.slowSince !== null && now - this.slowSince >= SLOW_FOR_MS && due("slow-camera")) return this.show(now, "slow-camera");
    if (this.noHandsSince !== null && now - this.noHandsSince >= NO_HANDS_FOR_MS && due("no-hands")) return this.show(now, "no-hands");
    return null;
  }

  /** The player closed the hint (or acted on it). */
  dismiss(): void {
    this.current = null;
  }

  private show(now: number, id: HintId): Hint {
    const hint: Hint = { id, text: TEXT[id](this.lastFps) };
    this.shownAt[id] = now;
    this.current = { hint, until: now + SHOW_MS };
    return hint;
  }
}
