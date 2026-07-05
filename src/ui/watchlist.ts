import type { Route } from "../router";
import { el, posterCard, sectionHeader, spinner, toast } from "./components";
import { getSettings, isAuthenticated, isConfigured } from "../data/settings";
import { ensureImages, ensureProgress, loadLibrary, syncLibrary } from "../data/sync";
import type { Library, ProgressRec, ShowRec, WatchedRec } from "../data/model";
import { posterUrl } from "../api/tmdb";

const NEW_BADGE_DAYS = 7;

/** Watched episode count excluding specials (fallback when progress isn't fetched yet). */
function watchedCount(w: WatchedRec): number {
  let n = 0;
  for (const [season, eps] of Object.entries(w.seasons)) {
    if (season !== "0") n += Object.keys(eps).length;
  }
  return n;
}

interface RowData {
  show: ShowRec;
  watched: WatchedRec;
  progress: ProgressRec | undefined;
  aired: number;
  completed: number;
}

function rowData(lib: Library, watched: WatchedRec): RowData | null {
  const show = lib.shows.get(watched.traktId);
  if (!show) return null;
  const progress = lib.progress.get(watched.traktId);
  const completed = progress?.completed ?? watchedCount(watched);
  const aired = progress?.aired ?? show.airedEpisodes ?? completed;
  return { show, watched, progress, aired, completed };
}

function isNewBadge(row: RowData): boolean {
  const firstAired = row.progress?.nextEpisode?.firstAired;
  if (!firstAired) return false;
  const aired = new Date(firstAired).getTime();
  return aired <= Date.now() && Date.now() - aired < NEW_BADGE_DAYS * 24 * 3600 * 1000;
}

function card(row: RowData): HTMLElement {
  const next = row.progress?.nextEpisode;
  return posterCard({
    title: row.show.title,
    href: `#/show/${row.show.traktId}`,
    posterUrl: posterUrl(row.show.poster),
    progress: row.aired > 0 ? row.completed / row.aired : 0,
    badge: isNewBadge(row) ? "NEW" : null,
    subtitle: next ? `${row.show.title} · S${next.season} E${next.number}` : row.show.title,
  });
}

export const watchlistRoute: Route = {
  name: "home",
  async render(container) {
    if (!isConfigured() || !isAuthenticated()) {
      container.append(
        el(
          "div",
          { class: "card" },
          el("h2", {}, "Welcome to WatchWhat"),
          el(
            "p",
            {},
            "Your TV Time-style watch list, backed by your Trakt account. Head to Settings to add your (free) Trakt API app and log in — it takes about two minutes, once.",
          ),
          (() => {
            const a = el("a", { class: "btn primary", href: "#/settings" }, "Open Settings");
            return a;
          })(),
        ),
      );
      return;
    }

    let lib = await loadLibrary();
    const grids = el("div", {});
    const syncNote = el("div", { class: "empty-note" });
    container.append(grids, syncNote);

    const renderContent = (): void => {
      const cutoff = Date.now() - getSettings().staleDays * 24 * 3600 * 1000;

      const started = [...lib.watched.values()]
        .filter((w) => !lib.hidden.has(w.traktId))
        .map((w) => rowData(lib, w))
        .filter((r): r is RowData => r !== null)
        .filter((r) => r.aired > r.completed && r.completed > 0)
        .sort((a, b) => b.watched.lastWatchedAt.localeCompare(a.watched.lastWatchedAt));

      const watchNext = started.filter((r) => new Date(r.watched.lastWatchedAt).getTime() >= cutoff);
      const stale = started.filter((r) => new Date(r.watched.lastWatchedAt).getTime() < cutoff);

      const startedIds = new Set([...lib.watched.entries()].filter(([, w]) => w.plays > 0).map(([id]) => id));
      const notStarted = lib.watchlist
        .filter((e) => !startedIds.has(e.traktId) && !lib.hidden.has(e.traktId))
        .map((e) => lib.shows.get(e.traktId))
        .filter((s): s is ShowRec => s !== undefined);

      grids.replaceChildren();

      if (watchNext.length > 0) {
        grids.append(sectionHeader("Watch next"), el("div", { class: "poster-grid" }, ...watchNext.map(card)));
      }
      if (stale.length > 0) {
        grids.append(sectionHeader("Haven't watched for a while"), el("div", { class: "poster-grid" }, ...stale.map(card)));
      }
      if (notStarted.length > 0) {
        grids.append(
          sectionHeader("Haven't started"),
          el(
            "div",
            { class: "poster-grid" },
            ...notStarted.map((show) =>
              posterCard({
                title: show.title,
                href: `#/show/${show.traktId}`,
                posterUrl: posterUrl(show.poster),
                progress: null,
                subtitle: show.title,
              }),
            ),
          ),
        );
      }
      if (grids.childElementCount === 0) {
        grids.append(
          lib.watched.size === 0 && lib.watchlist.length === 0
            ? spinner("Loading your shows from Trakt…")
            : el("div", { class: "empty-note" }, "All caught up — nothing to watch right now 🎉"),
        );
      }
    };

    const kickLazyLoads = (): void => {
      const visible = [
        ...[...lib.watched.values()].filter((w) => !lib.hidden.has(w.traktId)).map((w) => w.traktId),
        ...lib.watchlist.map((e) => e.traktId),
      ];
      const startedVisible = visible.filter((id) => (lib.watched.get(id)?.plays ?? 0) > 0);
      void ensureProgress(lib, startedVisible, renderContent);
      void ensureImages(lib, visible, renderContent);
    };

    renderContent();
    kickLazyLoads();

    try {
      const changed = await syncLibrary();
      if (changed) {
        lib = await loadLibrary();
        renderContent();
        kickLazyLoads();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Sync with Trakt failed", "error");
    }
  },
};
