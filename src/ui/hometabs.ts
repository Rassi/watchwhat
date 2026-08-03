import { el } from "./components";

function tab(label: string, href: string, active: boolean): HTMLElement {
  return el("a", { class: `home-tab ${active ? "active" : ""}`, href }, label);
}

/** WATCH LIST | ALL SHOWS top tabs on the Shows screen. */
export function homeTabs(active: "watchlist" | "library"): HTMLElement {
  return el(
    "div",
    { class: "home-tabs" },
    tab("WATCH LIST", "#/", active === "watchlist"),
    tab("ALL SHOWS", "#/library", active === "library"),
  );
}

/**
 * WATCH LIST | RELEASES | WATCHED top tabs on the Movies screen.
 *
 * Releases sits in the middle so the three read as one timeline: what you mean to watch, what
 * is on its way, what you've seen. It lives under Movies rather than in the bottom bar because
 * it can only ever be about films — a show's return date isn't derivable from the cache, since
 * progress records store aired episodes only.
 */
export function moviesTabs(active: "watchlist" | "releases" | "watched"): HTMLElement {
  return el(
    "div",
    { class: "home-tabs" },
    tab("WATCH LIST", "#/movies", active === "watchlist"),
    tab("RELEASES", "#/releases", active === "releases"),
    tab("WATCHED", "#/movies/watched", active === "watched"),
  );
}
