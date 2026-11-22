// Start screen: one Start button, the privacy line, loading state, and clear errors with a recovery action.

import type { TrackingErrorKind } from "../core/tracking";
import { el } from "./dom";

interface ErrorCopy {
  title: string;
  message: string;
  action: string;
}

const ERROR_COPY: Record<TrackingErrorKind, ErrorCopy> = {
  "camera-denied": {
    title: "The camera is blocked",
    message:
      "Air Instruments needs your camera to see your hands. Click the camera icon in the address bar, choose Allow, then try again. Your video never leaves your device.",
    action: "Try again",
  },
  "no-camera": {
    title: "No camera found",
    message: "Plug in a webcam (or enable the built-in one), then try again.",
    action: "Try again",
  },
  "camera-busy": {
    title: "The camera is busy",
    message: "Another app (Zoom, Teams, another tab) is using the camera. Close it, then try again.",
    action: "Try again",
  },
  insecure: {
    title: "The camera needs a secure page",
    message: "Open this page from https:// or from localhost. Browsers block the camera on other addresses.",
    action: "Reload page",
  },
  unsupported: {
    title: "This browser is not supported",
    message: "Please use the latest Chrome or Edge on a laptop.",
    action: "Reload page",
  },
  model: {
    title: "Hand tracking could not load",
    message: "The hand-tracking model did not download. Check your internet connection, then try again.",
    action: "Try again",
  },
  unknown: {
    title: "Something went wrong",
    message: "The camera or hand tracking could not start. Try again, or reload the page.",
    action: "Try again",
  },
};

export class StartScreen {
  private readonly root: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = el("div", { class: "start-screen" });
    parent.append(this.root);
  }

  showStart(onStart: () => void): void {
    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    const button = el("button", { class: "btn btn-primary", textContent: "Start", onclick: onStart });
    this.render(
      el("h1", { textContent: "Air Instruments" }),
      el("p", { class: "lead", textContent: "Play music in mid-air with your bare hands." }),
      button,
      el("p", { class: "privacy", textContent: "Video never leaves your device" }),
      isTouch
        ? el("p", { class: "note", textContent: "Air Instruments is best on a laptop with a webcam." })
        : el("p", { class: "note", textContent: "Works best in Chrome or Edge, with good light on your hands." }),
    );
    button.focus();
  }

  showLoading(message: string): void {
    this.render(
      el("h1", { textContent: "Air Instruments" }),
      el("div", { class: "spinner" }),
      el("p", { class: "lead", textContent: message }),
      el("p", { class: "privacy", textContent: "Video never leaves your device" }),
    );
  }

  showError(kind: TrackingErrorKind, onRetry: () => void): void {
    const copy = ERROR_COPY[kind];
    const button = el("button", {
      class: "btn btn-primary",
      textContent: copy.action,
      onclick: kind === "insecure" || kind === "unsupported" ? () => location.reload() : onRetry,
    });
    this.render(
      el("h1", { textContent: copy.title }),
      el("p", { class: "lead", textContent: copy.message }),
      button,
    );
    button.focus();
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  private render(...children: Node[]): void {
    this.root.classList.remove("hidden");
    this.root.replaceChildren(el("div", { class: "start-card" }, ...children));
  }
}
