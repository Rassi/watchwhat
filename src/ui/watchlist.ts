import type { Route } from "../router";
import { el, posterCard, sectionHeader } from "./components";
import { getSettings } from "../data/settings";
import { ensureImages, ensureProgress, loadLibrary } from "../data/sync";
import { isEnded, type Library, type ProgressRec, type ShowRec, type WatchedRec } from "../data/model";
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
 * "Haven't watched for a while" is mostly archaeology: measured on a real library, the
 * median stale show was last watched over four years ago, a flat few shows per year going
 * back to 2019. Left whole, the section buries "Haven't started" under a decade of
 * abandoned series.
 *
 * A period rather than a card count, because a count would cut at an arbitrary date. Three
 * years rather than the one this first shipped with: a year folded all but 5 of 35 away,
 * and a section that shows almost nothing is its own kind of useless — the point is to cut
 * the tail off, not to hide the section.
 */
const FOLD_AFTER_DAYS = 3 * 365;

/** Folding two or three cards away isn't worth the extra tap — cf. FOLD_MIN_RUN on the show page. */
const FOLD_MIN = 4;

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
    ended: isEnded(row.show),
    badge: isNewBadge(row) ? "NEW" : null,
    subtitle: next ? `${row.show.title} · S${next.season} E${next.number}` : row.show.title,
  });
}

export const watchlistRoute: Route = {
  name: "home",
  async render(container) {
    container.append(homeTabs("watchlist"));

    let lib = await loadLibrary();

    // An empty library is the only thing worth interrupting for. A library that
    // is merely unsynced still has everything to show, so it gets shown.
    if (lib.watched.size === 0 && lib.watchlist.length === 0) {
      container.append(
        el(
          "div",
          { class: "card" },
          el("h2", {}, "Welcome to WatchWhat"),
          el(
            "p",
            {},
            "Your TV Time-style watch list. If you already use WatchWhat on another device, export your data there " +
              "and import it here from Settings — that carries your shows, movies and watch history across.",
          ),
          (() => {
            const a = el("a", { class: "btn primary", href: "#/settings" }, "Open Settings");
            return a;
          })(),
        ),
      );
      return;
    }

    const grids = el("div", {});
    const syncNote = el("div", { class: "empty-note" });
    container.append(grids, syncNote);

    // Deliberately per-visit, not a stored preference: opening the fold is a one-off
    // rummage through the backlog, and a fold left permanently open is just the old
    // behaviour back again. Survives the re-renders that lazy loads trigger.
    let showOldStale = false;

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
        .sort((a, b) => (b.listedAt ?? "").localeCompare(a.listedAt ?? "")) // newest additions first
        .map((e) => lib.shows.get(e.traktId))
        .filter((s): s is ShowRec => s !== undefined);

      grids.replaceChildren();

      const days = getSettings().staleDays;
      if (watchNext.length > 0) {
        grids.append(
          sectionHeader("Watch next", {
            title: "Watch next",
            points: [
              `Shows you've watched an episode of in the last ${days} days.`,
              `Shows marked NEW: the most recent episode is unwatched and aired within the last 30 days. These sort to the front.`,
              `Shows where a whole new season is waiting and you've finished everything before it — kept here for ${NEW_SEASON_GRACE_DAYS} days after the season premiered, then treated as backlog.`,
              `The "${days} days" cutoff is yours to change, under Settings → Preferences.`,
            ],
          }),
          el("div", { class: "poster-grid" }, ...watchNext.map(card)),
        );
      }
      if (stale.length > 0) {
        // The list is sorted most-recent-first, so the fold is simply its tail.
        const foldFrom = stale.findIndex((r) => new Date(r.watched.lastWatchedAt).getTime() < Date.now() - FOLD_AFTER_DAYS * 24 * 3600 * 1000);
        const folding = !showOldStale && foldFrom !== -1 && stale.length - foldFrom >= FOLD_MIN;
        const shown = folding ? stale.slice(0, foldFrom) : stale;
        const hiddenCount = stale.length - shown.length;

        grids.append(
          sectionHeader("Haven't watched for a while", {
            title: "Haven't watched for a while",
            points: [
              `Shows you've started but haven't watched an episode of in over ${days} days, and that have no fresh episode waiting.`,
              "Most recently watched first, so where you left off is at the top.",
              "Anything you last watched over three years ago folds into one row at the end, so the backlog doesn't push the rest of the page down. Tap it to see them; it folds again next time.",
              "A show returns to Watch next the moment you watch an episode, or when a new episode airs.",
            ],
          }),
          el("div", { class: "poster-grid" }, ...shown.map(card)),
        );

        if (folding) {
          // The date the fold starts at, rather than "over a year ago": a real month is
          // something you can place yourself against, and it says where the tail ends.
          const since = new Date(stale[foldFrom].watched.lastWatchedAt).toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          });
          // A plain button with a verb on it, like Discover's "Load more" — the dashed band
          // this replaced said what was behind it but never that it could be opened.
          const more = el("button", { class: "btn" }, `Show ${hiddenCount} older shows, before ${since}`);
          more.addEventListener("click", () => {
            showOldStale = true;
            renderContent();
          });
          grids.append(el("div", { class: "grid-more" }, more));
        }
      }
      if (notStarted.length > 0) {
        grids.append(
          sectionHeader("Haven't started", {
            title: "Haven't started",
            points: [
              "Shows on your watchlist that you haven't watched a single episode of yet.",
              "Newest addition first.",
              "Watching one episode moves the show up into Watch next.",
            ],
          }),
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
            ? el("div", { class: "empty-note" }, "Nothing here yet — import your data from Settings, or add a show via Search.")
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
  },
};
