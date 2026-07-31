import { el } from "./components";

/** WATCH LIST | ALL SHOWS top tabs on the Shows screen. */
export function homeTabs(active: "watchlist" | "library"): HTMLElement {
  const make = (label: string, href: string, isActive: boolean) =>
    el("a", { class: `home-tab ${isActive ? "active" : ""}`, href }, label);
  return el(
    "div",
    { class: "home-tabs" },
    make("WATCH LIST", "#/", active === "watchlist"),
    make("ALL SHOWS", "#/library", active === "library"),
  );
}
