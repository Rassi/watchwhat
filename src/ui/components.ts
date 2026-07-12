/** Small DOM helpers + shared widgets (toast, modal dialog, poster card). */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) throw new Error("use addEventListener");
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child != null) node.append(child);
  }
  return node;
}

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const box = document.getElementById("toasts")!;
  const t = el("div", { class: `toast ${kind}` }, message);
  box.append(t);
  setTimeout(() => {
    t.classList.add("fade");
    setTimeout(() => t.remove(), 400);
  }, 3500);
}

export interface DialogChoice {
  label: string;
  value: string;
  kind?: "primary" | "danger" | "plain";
}

/** Modal dialog; resolves with the chosen value, or null when dismissed via backdrop. */
export function dialog(title: string, body: string, choices: DialogChoice[]): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = el("div", { class: "modal-backdrop" });
    const buttons = el("div", { class: "modal-buttons" });
    const box = el(
      "div",
      { class: "modal" },
      el("h3", {}, title),
      body ? el("p", {}, body) : null,
      buttons,
    );
    const close = (value: string | null) => {
      backdrop.remove();
      resolve(value);
    };
    for (const choice of choices) {
      const b = el("button", { class: `btn ${choice.kind ?? "plain"}` }, choice.label);
      b.addEventListener("click", () => close(choice.value));
      buttons.append(b);
    }
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
    backdrop.append(box);
    document.body.append(backdrop);
  });
}

/** Section header pill, like TV Time's "WATCH NEXT". */
export function sectionHeader(text: string): HTMLElement {
  return el("div", { class: "section-header" }, el("span", { class: "pill" }, text.toUpperCase()));
}

export interface PosterCardOpts {
  title: string;
  href: string;
  posterUrl?: string | null;
  /** 0..1 progress under the poster; null hides the bar */
  progress?: number | null;
  badge?: string | null;
  subtitle?: string | null;
  /** Show a small ▶ chip (top-right): available for streaming. */
  streamable?: boolean;
}

export function posterCard(opts: PosterCardOpts): HTMLElement {
  const card = el("a", { class: "poster-card", href: opts.href });
  if (opts.posterUrl) {
    const img = el("img", { class: "poster", loading: "lazy", alt: opts.title });
    img.src = opts.posterUrl;
    card.append(img);
  } else {
    card.append(el("div", { class: "poster placeholder" }, el("span", {}, opts.title)));
  }
  if (opts.badge) card.append(el("span", { class: "badge" }, opts.badge));
  if (opts.streamable) card.append(el("span", { class: "stream-badge", title: "Available for streaming" }, "▶"));
  if (opts.progress != null) {
    const bar = el("div", { class: "progress-track" });
    const fill = el("div", { class: "progress-fill" });
    fill.style.width = `${Math.round(Math.min(1, Math.max(0, opts.progress)) * 100)}%`;
    bar.append(fill);
    card.append(bar);
  }
  if (opts.subtitle) card.append(el("div", { class: "poster-subtitle" }, opts.subtitle));
  return card;
}

let busyCount = 0;
let busyEl: HTMLElement | null = null;

/** Show a small "Syncing…" pill while `promise` is in flight (stacks safely). */
export async function withSyncIndicator<T>(promise: Promise<T>): Promise<T> {
  if (!busyEl) {
    busyEl = el("div", { class: "sync-indicator" }, el("div", { class: "spinner small" }), el("span", {}, "Syncing…"));
    document.body.append(busyEl);
  }
  busyCount++;
  busyEl.classList.add("visible");
  try {
    return await promise;
  } finally {
    if (--busyCount === 0) busyEl.classList.remove("visible");
  }
}

export function spinner(label = "Loading…"): HTMLElement {
  return el("div", { class: "spinner-wrap" }, el("div", { class: "spinner" }), el("div", { class: "spinner-label" }, label));
}
