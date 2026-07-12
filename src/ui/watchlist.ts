import type { Route } from "../router";
import { el, posterCard, sectionHeader, spinner, toast } from "./components";
import { getSettings, isAuthenticated, isConfigured } from "../data/settings";
import { ensureImages, ensureProgress, loadLibrary, syncLibrary } from "../data/sync";
import type { Library, ProgressRec, ShowRec, WatchedRec } from "../data/model";
import { posterUrl } from "../api/tmdb";
import { homeTabs } from "./hometabs";

const NEW_WINDOW_DAYS = 30;

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
  // Until progress is fetched, estimate from total plays (may overcount rewatches).
  const aired = progress?.aired ?? show.airedEpisodes ?? watched.plays;
  const completed = progress?.completed ?? Math.min(watched.plays, aired);
  return { show, watched, progress, aired, completed };
}

const NEW_SEASON_GRACE_DAYS = 90;

/**
 * A whole new season awaits after completing everything before it (e.g. a
 * Netflix season drop). Like TV Time, these stay in Watch Next — but only
 * while the premiere is reasonably fresh; months-old untouched seasons are
 * backlog and age out to the stale section like everything else.
 */
function isUntouchedNewSeason(row: RowData): boolean {
  const progress = row.progress;
  const next = progress?.nextEpisode;
  if (!progress || !next || next.number !== 1 || next.season < 2 || !next.firstAired) return false;
  const premiereAge = Date.now() - new Date(next.firstAired).getTime();
  if (premiereAge < 0 || premiereAge > NEW_SEASON_GRACE_DAYS * 24 * 3600 * 1000) return false;
  return progress.seasons
    .filter((s) => s.number > 0 && s.number < next.season)
    .every((s) => s.completed >= s.aired);
}

function isNewBadge(row: RowData): boolean {
  // "NEW" = the newest aired episode is unwatched (there's fresh content) and
  // the next unwatched episode aired recently — covers both "caught up and a
  // new episode dropped" and "a new season just started".
  const progress = row.progress;
  if (!progress?.nextEpisode?.firstAired) return false;

  // Latest aired episode: episodes air in order, so it's episode `aired` of
  // the highest regular season that has aired anything.
  const lastSeason = [...progress.seasons].filter((s) => s.number > 0 && s.aired > 0).sort((a, b) => b.number - a.number)[0];
  if (!lastSeason) return false;
  const latest = lastSeason.episodes.find((e) => e.number === lastSeason.aired);
  if (latest?.completed !== false) return false;

  const nextAired = new Date(progress.nextEpisode.firstAired).getTime();
  return nextAired <= Date.now() && Date.now() - nextAired < NEW_WINDOW_DAYS * 24 * 3600 * 1000;
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
    container.append(homeTabs("watchlist"));
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

      // Shows with fresh episodes surface in Watch Next (badged, first) even
      // if they haven't been watched lately — like TV Time did with Silo.
      // Unstarted new seasons stay in Watch Next indefinitely (un-badged).
      const watchNext = started.filter(
        (r) => new Date(r.watched.lastWatchedAt).getTime() >= cutoff || isNewBadge(r) || isUntouchedNewSeason(r),
      );
      const stale = started.filter((r) => !watchNext.includes(r));
      watchNext.sort((a, b) => Number(isNewBadge(b)) - Number(isNewBadge(a)));

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
      void ensureProgress(lib, startedVisible, renderContent, { skipFinishedTtl: true });
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
