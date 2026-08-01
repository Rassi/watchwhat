/** All shows, grouped like TV Time's "All shows" page — purely from the local cache. */

import type { Route } from "../router";
import { el, posterCard, sectionHeader } from "./components";
import { ensureImages, ensureProgress, loadLibrary } from "../data/sync";
import type { Library, ShowRec } from "../data/model";
import { posterUrl } from "../api/tmdb";
import { homeTabs } from "./hometabs";

type Bucket = "watching" | "upToDate" | "finished" | "stopped" | "notStarted";

const LABELS: Record<Bucket, string> = {
  watching: "Watching",
  upToDate: "Up to date",
  finished: "Finished",
  stopped: "Stopped",
  notStarted: "Haven't started",
};

/** What lands in each group — the rules are cache-derived and not self-evident. */
const INFO: Record<Bucket, string[]> = {
  watching: [
    "Shows you've watched at least one episode of, with episodes still left to watch.",
    "A show stays here no matter how long ago you last watched it — this tab is your whole library, not a to-watch queue.",
  ],
  upToDate: [
    "Shows you've watched every aired episode of, and that are still running.",
    "As soon as a new episode airs, the show moves back to Watching.",
  ],
  finished: [
    "Shows you've watched every aired episode of, and that have ended or been cancelled.",
    "Nothing more is coming, so these stay here.",
  ],
  stopped: [
    'Shows you hid with "Stop tracking" — the equivalent of removing a show in TV Time.',
    "They're kept out of Watch next and the other groups, but nothing is deleted.",
  ],
  notStarted: [
    "Shows on your watchlist that you haven't watched a single episode of yet.",
    "Watching one episode moves the show to Watching.",
  ],
};

function bucketOf(lib: Library, show: ShowRec): Bucket | null {
  if (lib.hidden.has(show.traktId)) return "stopped";
  const watched = lib.watched.get(show.traktId);
  if (!watched || watched.plays === 0) {
    return lib.watchlist.some((e) => e.traktId === show.traktId) ? "notStarted" : null;
  }
  const progress = lib.progress.get(show.traktId);
  if (!progress) return "watching"; // unknown yet — refined once progress loads
  if (progress.completed < progress.aired) return "watching";
  const ended = show.status === "ended" || show.status === "canceled";
  return ended ? "finished" : "upToDate";
}

export const libraryRoute: Route = {
  name: "library",
  tab: "home",
  title: "All shows · WatchWhat",
  async render(container) {
    container.append(homeTabs("library"));

    const lib = await loadLibrary();
    const content = el("div", {});

    // Burger menu to jump between sections
    const burgerMenu = el("div", { class: "burger-menu" });
    const burgerBtn = el("button", { class: "burger-btn", title: "Jump to section" }, "☰");
    const burgerWrap = el("div", { class: "lib-burger" }, burgerBtn, burgerMenu);
    burgerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      burgerWrap.classList.toggle("open");
    });
    container.addEventListener("click", () => burgerWrap.classList.remove("open"));
    container.append(burgerWrap, content);

    const sectionAnchors = new Map<Bucket, HTMLElement>();

    const renderContent = (): void => {
      const buckets = new Map<Bucket, ShowRec[]>();
      for (const show of lib.shows.values()) {
        const bucket = bucketOf(lib, show);
        if (!bucket) continue;
        (buckets.get(bucket) ?? buckets.set(bucket, []).get(bucket)!).push(show);
      }

      content.replaceChildren();
      burgerMenu.replaceChildren();
      sectionAnchors.clear();
      for (const bucket of ["watching", "notStarted", "upToDate", "finished", "stopped"] as Bucket[]) {
        const shows = buckets.get(bucket);
        if (!shows?.length) continue;
        shows.sort((a, b) => a.title.localeCompare(b.title));
        const anchor = sectionHeader(`${LABELS[bucket]} (${shows.length})`, { title: LABELS[bucket], points: INFO[bucket] });
        sectionAnchors.set(bucket, anchor);
        const item = el("button", { class: "burger-item" }, `${LABELS[bucket]} (${shows.length})`);
        item.addEventListener("click", () => {
          burgerWrap.classList.remove("open");
          sectionAnchors.get(bucket)?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        burgerMenu.append(item);
        content.append(
          anchor,
          el(
            "div",
            { class: "poster-grid" },
            ...shows.map((show) => {
              const progress = lib.progress.get(show.traktId);
              return posterCard({
                title: show.title,
                href: `#/show/${show.traktId}`,
                posterUrl: posterUrl(show.poster),
                progress: progress && progress.aired > 0 ? progress.completed / progress.aired : null,
                subtitle: show.title,
              });
            }),
          ),
        );
      }
      if (content.childElementCount === 0) {
        content.append(
          lib.shows.size > 0
            ? el("div", { class: "empty-note" }, "No shows yet — add some via Search.")
            : el("div", { class: "empty-note" }, "No shows here yet — import your data from Settings, or add some via Search."),
        );
      }
    };

    renderContent();

    const started = [...lib.watched.entries()].filter(([, w]) => w.plays > 0).map(([id]) => id);
    void ensureProgress(lib, started, renderContent, { skipFinishedTtl: true });
    void ensureImages(lib, [...lib.shows.keys()], renderContent);
  },
};
