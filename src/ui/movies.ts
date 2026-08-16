/** Movies tab: WATCH LIST | WATCHED top tabs; the watch-list side can show
 * the watchlist or any custom personal list. */

import type { Route } from "../router";
import { el, posterCard, renderGate, sectionHeader } from "./components";

import { ensureMovieDetails, loadMovieLists, loadMovies } from "../data/sync";
import { isTrackedMovie, type MovieListRec, type MovieRec } from "../data/model";
import { posterUrl } from "../api/tmdb";
import { replaceHash } from "../router";
import { watchBadge } from "./shared";
import { moviesTabs } from "./hometabs";

export const moviesRoute: Route = {
  name: "movies",
  title: "Movies · WatchWhat",
  async render(container, params) {
    const view: "watchlist" | "watched" = params[0] === "watched" ? "watched" : "watchlist";
    container.append(moviesTabs(view));

    // Which list is showing lives in the address — `#/movies/list/family` — rather than in
    // session storage, so the view can be copied and linked. The slug is what goes in it: it
    // came over from Trakt on every list and has been carried unread ever since, which is
    // exactly the readable name this wants. The numeric id still resolves, because a list
    // without a slug has nothing else to be addressed by.
    let listKey: string | null = params[0] === "list" ? (params[1] ?? null) : null;

    let movies = await loadMovies();
    let lists = await loadMovieLists();
    const content = el("div", {});
    container.append(content);

    const card = (movie: MovieRec): HTMLElement =>
      posterCard({
        title: movie.title,
        href: `#/movie/${movie.traktId}`,
        posterUrl: posterUrl(movie.poster),
        progress: null,
        badge: null,
        watch: watchBadge(movie.providers),
        starred: movie.starred === true,
        // Keep the title as subtitle so in-page text search finds movies.
        subtitle: `${movie.title}${movie.year ? ` (${movie.year})` : ""}`,
      });

    // Two different dates, deliberately. The watchlist has one per film; a custom list has one
    // per membership. Sorting both by `listedAt` was why the same film could sit first here and
    // last on another device — a list add stored no date, so a film that arrived through the log
    // had only the watchlist's date to sort by, or none.
    const watchlistedAt = (m: MovieRec): string => m.listedAt ?? "";
    const listedOnAt = (m: MovieRec, listId: number): string => m.listAddedAt?.[listId] ?? "";

    /**
     * Starred films first, everything else in the order it was already in.
     *
     * Wrapping the existing comparator rather than replacing it: a star says which of the
     * listed films to get to first, not how the rest are ordered, so unstarring has to put a
     * film back exactly where it would have been. Within the starred block the same
     * date ordering applies — `starredAt` deliberately doesn't sort here, or starring one film
     * would reshuffle the ones already starred.
     *
     * The watched grid is left alone: that one is a history, newest first, and there is no
     * sense in which a film you have seen comes first.
     */
    const starredFirst =
      (cmp: (a: MovieRec, b: MovieRec) => number) =>
      (a: MovieRec, b: MovieRec): number =>
        Number(b.starred === true) - Number(a.starred === true) || cmp(a, b);

    const listUrlKey = (list: MovieListRec): string => list.slug || String(list.traktId);
    const findList = (key: string | null): MovieListRec | undefined =>
      key === null ? undefined : (lists.find((l) => l.slug === key) ?? lists.find((l) => String(l.traktId) === key));

    // With nothing to sync from, an empty library is empty — not still loading.
    const nothingYet = (): HTMLElement =>
      el("div", { class: "empty-note" }, "No movies here yet — import your data from Settings, or add some via Search.");

    // Everything a card here draws.
    const movieKey = (m: MovieRec): string =>
      `${m.traktId}:${m.poster ?? ""}:${watchBadge(m.providers) ?? ""}:${m.title}:${m.year ?? ""}:${m.starred === true ? "★" : ""}`;
    const changed = renderGate();

    const renderContent = (): void => {
      const all = [...movies.values()];

      // What this screen is about to show, worked out before anything is torn down. The refresh
      // behind it walks every tracked film — some three hundred — while the screen displays a few
      // dozen, so most of its callbacks change nothing here. Repainting on those anyway is what
      // makes a background refresh flicker. See docs/poster-flicker.md.
      const activeList: MovieListRec | undefined = view === "watched" ? undefined : findList(listKey);
      const watched = all
        .filter((m) => m.plays > 0)
        .sort((a, b) => (b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? ""));
      const shown =
        view === "watched"
          ? watched
          : activeList
            ? all
                .filter((m) => m.customLists?.includes(activeList.traktId) && m.plays === 0)
                .sort(starredFirst((a, b) => listedOnAt(b, activeList.traktId).localeCompare(listedOnAt(a, activeList.traktId))))
            : all
                .filter((m) => m.onWatchlist && m.plays === 0)
                .sort(starredFirst((a, b) => watchlistedAt(b).localeCompare(watchlistedAt(a))));
      // The picker's counts are on screen too, and they move independently of the grid.
      const pickerCounts =
        view === "watched"
          ? ""
          : [
              all.filter((m) => m.onWatchlist && m.plays === 0).length,
              ...lists.map((l) => all.filter((m) => m.customLists?.includes(l.traktId) && m.plays === 0).length),
            ].join("/");
      const signature = [view, listKey ?? "", pickerCounts, shown.map(movieKey).join(",")].join("|");
      if (!changed(signature)) return;

      content.replaceChildren();

      if (view === "watched") {
        if (watched.length > 0) {
          content.append(sectionHeader(`Watched (${watched.length})`), el("div", { class: "poster-grid" }, ...watched.map((m) => card(m))));
        } else {
          content.append(movies.size === 0 ? nothingYet() : el("div", { class: "empty-note" }, "No watched movies yet."));
        }
        return;
      }

      // Watch-list view: picker between the watchlist and custom lists.
      if (lists.length > 0) {
        const select = el("select", { class: "season-select list-select" });
        const optionFor = (value: string, label: string, count: number): HTMLElement => {
          const opt = el("option", { value }, `${label} (${count})`);
          if (value === (activeList ? listUrlKey(activeList) : "watchlist")) opt.setAttribute("selected", "");
          return opt;
        };
        select.append(optionFor("watchlist", "Watchlist", all.filter((m) => m.onWatchlist && m.plays === 0).length));
        for (const list of lists) {
          select.append(
            optionFor(listUrlKey(list), list.name, all.filter((m) => m.customLists?.includes(list.traktId) && m.plays === 0).length),
          );
        }
        select.addEventListener("change", () => {
          listKey = select.value === "watchlist" ? null : select.value;
          // `replaceHash`, so flipping through the picker doesn't fill the back stack with
          // every list you glanced at — Back still returns wherever you came from.
          replaceHash(listKey === null ? "#/movies" : `#/movies/list/${listKey}`);
          renderContent();
        });
        content.append(el("div", { class: "list-picker" }, select));
      }

      if (!activeList) {
        const watchlist = shown;
        if (watchlist.length > 0) {
          content.append(sectionHeader(`Want to watch (${watchlist.length})`), el("div", { class: "poster-grid" }, ...watchlist.map((m) => card(m))));
        } else {
          content.append(
            movies.size === 0 ? nothingYet() : el("div", { class: "empty-note" }, "Watchlist is empty — add movies via Search."),
          );
        }
      } else {
        // Custom lists hide watched movies (same rule as the watchlist); the movie
        // stays on the list, so unmarking it brings it back here.
        const onList = all.filter((m) => m.customLists?.includes(activeList.traktId));
        const items = shown;
        if (items.length > 0) {
          content.append(
            sectionHeader(`${activeList.name} (${items.length})`),
            el("div", { class: "poster-grid" }, ...items.map((m) => card(m))),
          );
        } else {
          content.append(
            el(
              "div",
              { class: "empty-note" },
              onList.length > 0
                ? `You've watched everything on "${activeList.name}".`
                : `"${activeList.name}" has no movies yet — add them from a film's page.`,
            ),
          );
        }
      }
    };

    const kickLazyLoads = (): void => {
      // Tracked films only. A film opened once from Search is stored just like a followed one,
      // and refreshing those would grow the bill with every title ever browsed.
      const tracked = [...movies.values()].filter(isTrackedMovie).map((m) => m.traktId);
      void ensureMovieDetails(movies, tracked, renderContent, { skipWatchedRefresh: true });
    };

    renderContent();
    kickLazyLoads();
  },
};
