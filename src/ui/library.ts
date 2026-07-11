/** All shows, grouped like TV Time's "All shows" page — purely from the local cache. */

import type { Route } from "../router";
import { el, posterCard, sectionHeader, spinner } from "./components";
import { isAuthenticated, isConfigured } from "../data/settings";
import { ensureImages, ensureProgress, loadLibrary } from "../data/sync";
import type { Library, ShowRec } from "../data/model";
import { posterUrl } from "../api/tmdb";

type Bucket = "watching" | "upToDate" | "finished" | "stopped" | "notStarted";

const LABELS: Record<Bucket, string> = {
  watching: "Watching",
  upToDate: "Up to date",
  finished: "Finished",
  stopped: "Stopped",
  notStarted: "Haven't started",
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
  async render(container) {
    if (!isConfigured() || !isAuthenticated()) {
      container.append(el("div", { class: "empty-note" }, "Connect to Trakt in Settings first."));
      return;
    }

    const lib = await loadLibrary();
    const content = el("div", {});
    container.append(content);

    const renderContent = (): void => {
      const buckets = new Map<Bucket, ShowRec[]>();
      for (const show of lib.shows.values()) {
        const bucket = bucketOf(lib, show);
        if (!bucket) continue;
        (buckets.get(bucket) ?? buckets.set(bucket, []).get(bucket)!).push(show);
      }

      content.replaceChildren();
      for (const bucket of ["watching", "upToDate", "finished", "stopped", "notStarted"] as Bucket[]) {
        const shows = buckets.get(bucket);
        if (!shows?.length) continue;
        shows.sort((a, b) => a.title.localeCompare(b.title));
        content.append(
          sectionHeader(`${LABELS[bucket]} (${shows.length})`),
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
          lib.shows.size === 0 ? spinner("Loading your shows…") : el("div", { class: "empty-note" }, "No shows yet — add some via Search."),
        );
      }
    };

    renderContent();

    const started = [...lib.watched.entries()].filter(([, w]) => w.plays > 0).map(([id]) => id);
    void ensureProgress(lib, started, renderContent);
    void ensureImages(lib, [...lib.shows.keys()], renderContent);
  },
};
