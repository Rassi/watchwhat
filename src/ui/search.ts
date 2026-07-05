import type { Route } from "../router";
import { el } from "./components";

export const searchRoute: Route = {
  name: "search",
  render(container) {
    container.append(el("div", { class: "empty-note" }, "Search coming soon."));
  },
};
