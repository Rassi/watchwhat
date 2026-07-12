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

// Per-page scroll memory so going back (e.g. movie -> movies list) returns
// to where you were. Keyed by full hash, session-only.
const scrollPositions = new Map<string, number>();
let currentHash = "";

export function registerRoute(route: Route): void {
  routes.set(route.name, route);
}

function parseHash(): { name: string; params: string[] } {
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter((p) => p !== "");
  return { name: parts[0] ?? "home", params: parts.slice(1) };
}

async function dispatch(): Promise<void> {
  if (currentHash) scrollPositions.set(currentHash, window.scrollY);
  currentHash = location.hash || "#/";

  const { name, params } = parseHash();
  const route = routes.get(name) ?? routes.get("home")!;
  document.querySelectorAll<HTMLAnchorElement>("#tabbar a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === (route.tab ?? route.name));
  });
  document.title = route.title ?? "WatchWhat";
  container.replaceChildren();
  await route.render(container, params);
  window.scrollTo(0, scrollPositions.get(currentHash) ?? 0);
}

export function startRouter(appContainer: HTMLElement): void {
  container = appContainer;
  history.scrollRestoration = "manual"; // we restore positions ourselves
  window.addEventListener("hashchange", () => void dispatch());
  void dispatch();
}

/** Re-render the current route (after data changes). */
export function refreshRoute(): void {
  void dispatch();
}
