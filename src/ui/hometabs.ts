import { el } from "./components";

/** WATCH LIST | UPCOMING top tabs, like TV Time's Shows screen. */
export function homeTabs(active: "watchlist" | "upcoming"): HTMLElement {
  const make = (label: string, href: string, isActive: boolean) =>
    el("a", { class: `home-tab ${isActive ? "active" : ""}`, href }, label);
  return el(
    "div",
    { class: "home-tabs" },
    make("WATCH LIST", "#/", active === "watchlist"),
    make("UPCOMING", "#/upcoming", active === "upcoming"),
  );
}
