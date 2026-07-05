import type { Route } from "../router";
import { el } from "./components";

export const settingsRoute: Route = {
  name: "settings",
  render(container) {
    container.append(el("div", { class: "empty-note" }, "Settings coming soon."));
  },
};
