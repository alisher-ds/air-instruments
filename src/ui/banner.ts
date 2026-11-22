// A big message over the picture (used by "Compare render settings": "keep both hands visible", countdown).

import { el } from "./dom";

export class Banner {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly detail: HTMLElement;

  constructor(parent: HTMLElement) {
    this.title = el("div", { class: "banner-title" });
    this.detail = el("div", { class: "banner-detail" });
    this.root = el("div", { class: "banner hidden" }, this.title, this.detail);
    parent.append(this.root);
  }

  show(title: string, detail: string): void {
    this.root.classList.remove("hidden");
    this.title.textContent = title;
    this.detail.textContent = detail;
  }

  hide(): void {
    this.root.classList.add("hidden");
  }
}
