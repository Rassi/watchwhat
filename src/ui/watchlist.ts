import type { Route } from "../router";
import { el } from "./components";

export const watchlistRoute: Route = {
  name: "home",
  render(container) {
    container.append(el("div", { class: "empty-note" }, "Watch list coming soon."));
  },
};
