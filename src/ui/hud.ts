// HUD: instrument switcher (4 slots, keys 1-4), the one-line hint, small tools (help, fullscreen, record video), a notice for
// friendly hints ("more light on your hands"), the key legend and the REC badge for hand recordings.
// The debug panel lives in debugPanel.ts.

import type { Instrument } from "../instruments/Instrument";
import { el } from "./dom";

const HINT_VISIBLE_MS = 6000;

export interface HudTools {
  /** "?" : show the how-to-play line of the current instrument again. */
  onHelp(): void;
  onFullscreen(): void;
  /** Starts / stops recording the performance to a video file. */
  onRecordVideo(): void;
  /** Next picture look (Soft / Clear / Bright). */
  onLook(): void;
  /** HD camera on / off. */
  onHd(): void;
}

export class Hud {
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly hint: HTMLElement;
  private readonly rec: HTMLElement;
  private readonly root: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly noticeText: HTMLElement;
  private readonly videoButton: HTMLButtonElement;
  private readonly lookButton: HTMLButtonElement;
  private readonly hdButton: HTMLButtonElement;
  private hintTimer = 0;
  private noticeShown = "";

  constructor(
    parent: HTMLElement,
    instruments: Instrument[],
    onSelect: (index: number) => void,
    tools: HudTools,
    /** Called when the player closes a notice with its x button. */
    onNoticeClosed: () => void = () => {},
  ) {
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
      textContent: "1-4 instrument  ·  ? help  ·  V record video  ·  F fullscreen  ·  H show hands  ·  D debug",
    });

    this.videoButton = el("button", {
      class: "btn btn-small tool tool-record",
      textContent: "● Record",
      title: "Record your performance (picture + sound) to a video file you can share (V)",
      onclick: () => tools.onRecordVideo(),
    });
    this.lookButton = el("button", {
      class: "btn btn-small tool",
      textContent: "Look: Clear",
      title: "How the camera picture looks: Soft (dim), Clear, Bright",
      onclick: () => tools.onLook(),
    });
    this.hdButton = el("button", {
      class: "btn btn-small tool",
      textContent: "HD",
      title: "Sharper camera picture (1280x720). Needs a camera that supports it; tracking speed stays the same.",
      onclick: () => tools.onHd(),
    });
    const tool = (text: string, title: string, onclick: () => void) => el("button", { class: "btn btn-small tool", textContent: text, title, onclick });
    const toolbar = el(
      "div",
      { class: "tools" },
      this.videoButton,
      this.lookButton,
      this.hdButton,
      tool("?", "How to play this instrument (?)", () => tools.onHelp()),
      tool("⛶", "Fullscreen (F)", () => tools.onFullscreen()),
    );

    this.noticeText = el("span", { class: "notice-text" });
    const close = el("button", {
      class: "notice-close",
      textContent: "×",
      title: "Close",
      ariaLabel: "Close",
      onclick: () => {
        this.hideNotice();
        onNoticeClosed();
      },
    });
    this.notice = el("div", { class: "notice hidden", role: "status" }, this.noticeText, close);

    this.root = el("div", { class: "hud hidden" }, bar, this.hint, toolbar, this.notice, this.rec, legend);
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

  /** A friendly message at the bottom of the screen (stays until hideNotice or the player closes it). */
  showNotice(text: string): void {
    if (this.noticeShown === text) return;
    this.noticeShown = text;
    this.noticeText.textContent = text;
    this.notice.classList.remove("hidden");
  }

  hideNotice(): void {
    this.noticeShown = "";
    this.notice.classList.add("hidden");
  }

  setRecording(active: boolean, seconds: number): void {
    this.rec.classList.toggle("hidden", !active);
    if (active) this.rec.textContent = `● REC ${seconds.toFixed(1)}s  (press R to stop and save)`;
  }

  /** The Look button text, e.g. "Clear". */
  setLook(label: string): void {
    this.lookButton.textContent = `Look: ${label}`;
  }

  /** The HD button is lit while the HD camera is on. */
  setHd(on: boolean): void {
    this.hdButton.classList.toggle("btn-accent", on);
    this.hdButton.textContent = on ? "HD ✓" : "HD";
  }

  /** The video recording button: "● Record" or "■ Stop 0:07". */
  setVideoRecording(active: boolean, seconds: number): void {
    this.videoButton.classList.toggle("recording", active);
    const m = Math.floor(seconds / 60);
    const s = String(Math.floor(seconds % 60)).padStart(2, "0");
    this.videoButton.textContent = active ? `■ Stop ${m}:${s}` : "● Record";
  }
}
