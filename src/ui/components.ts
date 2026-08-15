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
export function dialog(title: string, body: string | Node | null, choices: DialogChoice[]): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = el("div", { class: "modal-backdrop" });
    const buttons = el("div", { class: "modal-buttons" });
    const box = el(
      "div",
      { class: "modal" },
      el("h3", {}, title),
      body ? (typeof body === "string" ? el("p", {}, body) : body) : null,
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

/**
 * Section header pill, like TV Time's "WATCH NEXT". `info` explains what lands
 * in the section: the grouping rules are non-obvious, and the question comes up
 * while looking at the section, not while in Settings.
 */
export function sectionHeader(text: string, info?: { title: string; points: string[] }): HTMLElement {
  const header = el("div", { class: "section-header" }, el("span", { class: "pill" }, text.toUpperCase()));
  if (info) header.append(infoButton(info.title, info.points));
  return header;
}

/** Small ⓘ that opens a modal listing `points`. */
export function infoButton(title: string, points: string[]): HTMLElement {
  const button = el("button", { class: "info-dot", title: `What's in "${title}"?`, "aria-label": `What's in "${title}"?` }, "ⓘ");
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const list = el("ul", { class: "info-list" }, ...points.map((p) => el("li", {}, p)));
    void dialog(title, list, [{ label: "Got it", value: "ok", kind: "primary" }]);
  });
  return button;
}

/**
 * A repaint gate for the grids that re-render from a background refresh.
 *
 * Those refreshes call back once per batch, and each call clears the grid and rebuilds every
 * card. Most of the calls change nothing you can see: a Releases refresh walks ~300 tracked
 * films while the screen is showing 26 of them, so the great majority of batches leave the
 * rendered output identical. Measured against a stale library with a cold API, Releases rebuilt
 * itself 19 times in 20 seconds; with this gate, once. The poster flicker, whatever paints it,
 * lasts exactly as long as that churn does. See docs/poster-flicker.md.
 *
 * So each screen describes what it is about to draw, and draws it only if that description
 * changed. The signature has to cover everything a card renders — a poster arriving mid-refresh
 * is precisely the update worth painting — and nothing it doesn't, or the gate opens for free.
 */
export function renderGate(): (signature: string) => boolean {
  let last: string | null = null;
  return (signature: string): boolean => {
    if (signature === last) return false;
    last = signature;
    return true;
  };
}

export interface PosterCardOpts {
  title: string;
  href: string;
  posterUrl?: string | null;
  /** 0..1 progress under the poster; null hides the bar */
  progress?: number | null;
  badge?: string | null;
  /**
   * Recolours the badge green. Yellow is the default because a badge is normally the one
   * thing on a grid worth stopping at; where two badges sit side by side and one of them
   * means "done" — SEEN next to LISTED on Discover — same colour twice reads as one state.
   */
  badgeTone?: "seen" | null;
  subtitle?: string | null;
  /**
   * A second subtitle line, brighter than the first. Split from `subtitle` rather than
   * appended to it because the two carry opposite weight: the title is there so in-page
   * search can find the card, while the note is the thing you came to the screen to read.
   * Sharing one nowrap line, the ellipsis always eats the note — "Mother Mary · HBO M…".
   */
  note?: string | null;
  /**
   * Small chip (top-right), coloured by what it would cost you: "mine" a green ▶ for a
   * service you pay for, "free" a yellow ▶ for free to anyone, "stream" a grey ▶ for a
   * subscription you don't have, "rent" a grey $ for paying per title.
   */
  watch?: "mine" | "free" | "stream" | "rent" | null;
  /**
   * Ended or cancelled. Only changes a *full* bar: done for good reads purple,
   * merely caught up on a running show stays green.
   */
  ended?: boolean;
}

/**
 * Live <img> nodes keyed by URL, reused across re-renders. A fresh <img> makes
 * the browser re-decode even an HTTP-cached image, so the poster sits on its
 * grey background for a frame; grids rebuild dozens of times while a bulk TMDB
 * refresh streams in, and that reads as flickering. Moving the same node into
 * the new card keeps the pixels on screen.
 */
const posterImgs = new Map<string, HTMLImageElement>();
const POSTER_IMG_LIMIT = 500;

/** One node can only be in one place, so the same URL twice in a single render
 * pass has to fall back to a throwaway <img> for the duplicate. */
const claimed = new Set<string>();
let claimResetQueued = false;

function posterImg(src: string, alt: string): HTMLImageElement {
  if (!claimResetQueued) {
    claimResetQueued = true;
    // A render pass is synchronous, so this clears between passes.
    queueMicrotask(() => {
      claimed.clear();
      claimResetQueued = false;
    });
  }

  const cached = posterImgs.get(src);
  if (cached && !claimed.has(src)) {
    claimed.add(src);
    // Re-insert so eviction below is least-recently-used, not insertion order:
    // a long list plus a Search detour shouldn't evict what's still on screen.
    posterImgs.delete(src);
    posterImgs.set(src, cached);
    return cached;
  }

  const img = el("img", { class: "poster", loading: "lazy", alt });
  img.src = src;
  if (cached) return img; // duplicate within this pass — not cached
  if (posterImgs.size >= POSTER_IMG_LIMIT) {
    const lru = posterImgs.keys().next().value; // Map iterates in insertion order
    if (lru !== undefined) posterImgs.delete(lru);
  }
  posterImgs.set(src, img);
  claimed.add(src);
  return img;
}

export function posterCard(opts: PosterCardOpts): HTMLElement {
  const card = el("a", { class: "poster-card", href: opts.href });
  if (opts.posterUrl) {
    card.append(posterImg(opts.posterUrl, opts.title));
  } else {
    card.append(el("div", { class: "poster placeholder" }, el("span", {}, opts.title)));
  }
  if (opts.badge) card.append(el("span", { class: opts.badgeTone ? `badge ${opts.badgeTone}` : "badge" }, opts.badge));
  if (opts.watch) {
    const label =
      opts.watch === "mine"
        ? "On one of your streaming services"
        : opts.watch === "free"
          ? "Free to watch, possibly with ads"
          : opts.watch === "rent"
            ? "Available to rent or buy"
            : "Available for streaming";
    // Rent shows the coin alone: one clean shape per state beats a play mark with something
    // bolted onto it, and the badge's position already implies "you can watch this".
    card.append(el("span", { class: `stream-badge ${opts.watch}`, title: label }, opts.watch === "rent" ? "$" : "▶"));
  }
  if (opts.progress != null) {
    const bar = el("div", { class: "progress-track" });
    const done = Math.min(1, Math.max(0, opts.progress));
    const fill = el("div", { class: `progress-fill${done >= 1 ? (opts.ended ? " finished" : " complete") : ""}` });
    // Floored, so one unwatched episode out of hundreds still leaves a visible
    // gap: a bar that reads full must also be coloured as full.
    fill.style.width = `${Math.floor(done * 100)}%`;
    bar.append(fill);
    card.append(bar);
  }
  if (opts.subtitle) card.append(el("div", { class: "poster-subtitle" }, opts.subtitle));
  if (opts.note) card.append(el("div", { class: "poster-note" }, opts.note));
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
