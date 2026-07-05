import type { Route } from "../router";
import { el } from "./components";

export const showRoute: Route = {
  name: "show",
  render(container) {
    container.append(el("div", { class: "empty-note" }, "Show page coming soon."));
  },
};
