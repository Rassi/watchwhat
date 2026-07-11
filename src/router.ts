export interface Route {
  /** e.g. "show" for #/show/123 — first hash segment */
  name: string;
  /** Which bottom tab to highlight (defaults to `name`). */
  tab?: string;
  /** Static page title; routes with dynamic titles (show) set document.title themselves. */
  title?: string;
  render: (container: HTMLElement, params: string[]) => void | Promise<void>;
}

const routes = new Map<string, Route>();
let container: HTMLElement;

export function registerRoute(route: Route): void {
  routes.set(route.name, route);
}

function parseHash(): { name: string; params: string[] } {
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter((p) => p !== "");
  return { name: parts[0] ?? "home", params: parts.slice(1) };
}

async function dispatch(): Promise<void> {
  const { name, params } = parseHash();
  const route = routes.get(name) ?? routes.get("home")!;
  document.querySelectorAll<HTMLAnchorElement>("#tabbar a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === (route.tab ?? route.name));
  });
  document.title = route.title ?? "WatchWhat";
  container.replaceChildren();
  container.scrollTop = 0;
  await route.render(container, params);
}

export function startRouter(appContainer: HTMLElement): void {
  container = appContainer;
  window.addEventListener("hashchange", () => void dispatch());
  void dispatch();
}

/** Re-render the current route (after data changes). */
export function refreshRoute(): void {
  void dispatch();
}
