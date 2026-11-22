// HUD: instrument switcher (4 slots, keys 1-4), the one-line hint, the key legend and the REC badge.
// The debug panel lives in debugPanel.ts.

import type { Instrument } from "../instruments/Instrument";
import { el } from "./dom";

const HINT_VISIBLE_MS = 6000;

export class Hud {
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly hint: HTMLElement;
  private readonly rec: HTMLElement;
  private readonly root: HTMLElement;
  private hintTimer = 0;

  constructor(parent: HTMLElement, instruments: Instrument[], onSelect: (index: number) => void) {
    const bar = el("div", { class: "switcher" });
    instruments.forEach((ins, i) => {
      const b = el(
        "button",
        { class: "slot", title: `${ins.name} (key ${i + 1})`, onclick: () => onSelect(i) },
        el("span", { class: "slot-key", textContent: String(i + 1) }),
        el("span", { class: "slot-name", textContent: ins.name }),
      );
      this.buttons.push(b);
      bar.append(b);
    });

    this.hint = el("div", { class: "hint" });
    this.rec = el("div", { class: "rec hidden" });
    const legend = el("div", {
      class: "legend",
      textContent: "1-4 instrument  ·  D debug  ·  R record hands  ·  H show hands",
    });

    this.root = el("div", { class: "hud hidden" }, bar, this.hint, this.rec, legend);
    parent.append(this.root);
  }

  show(): void {
    this.root.classList.remove("hidden");
  }

  setActive(index: number, instrument: Instrument): void {
    this.buttons.forEach((b, i) => b.classList.toggle("active", i === index));
    this.showHint(instrument.hint);
  }

  /** Show the one-line hint, then fade it out. */
  showHint(text: string): void {
    window.clearTimeout(this.hintTimer);
    this.hint.textContent = text;
    this.hint.classList.add("visible");
    this.hintTimer = window.setTimeout(() => this.hint.classList.remove("visible"), HINT_VISIBLE_MS);
  }

  setRecording(active: boolean, seconds: number): void {
    this.rec.classList.toggle("hidden", !active);
    if (active) this.rec.textContent = `● REC ${seconds.toFixed(1)}s  (press R to stop and save)`;
  }
}
