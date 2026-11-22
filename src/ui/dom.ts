// Tiny DOM helper (no framework).

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], "style">> & { class?: string; style?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, style, ...rest } = props as Record<string, unknown>;
  if (typeof className === "string") node.className = className;
  if (typeof style === "string") node.style.cssText = style;
  Object.assign(node, rest);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
  return node;
}
