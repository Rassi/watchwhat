/** Movies tab: WATCH LIST | WATCHED top tabs; the watch-list side can show
 * the watchlist or any custom personal list. */

import type { Route } from "../router";
import { el, posterCard, sectionHeader } from "./components";

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

    // Which list is showing lives in the address — `#/movies/list/36041308` — rather than in
    // session storage, so a reload, a pull-to-refresh or a link back lands on the list you were
    // reading instead of dropping you on the watchlist.
    let activeListId: number | null = params[0] === "list" ? Number(params[1]) : null;
    if (activeListId !== null && !Number.isFinite(activeListId)) activeListId = null;

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
        // Keep the title as subtitle so in-page text search finds movies.
        subtitle: `${movie.title}${movie.year ? ` (${movie.year})` : ""}`,
      });

    // Two different dates, deliberately. The watchlist has one per film; a custom list has one
    // per membership. Sorting both by `listedAt` was why the same film could sit first here and
    // last on another device — a list add stored no date, so a film that arrived through the log
    // had only the watchlist's date to sort by, or none.
    const watchlistedAt = (m: MovieRec): string => m.listedAt ?? "";
    const listedOnAt = (m: MovieRec, listId: number): string => m.listAddedAt?.[listId] ?? "";

    // With nothing to sync from, an empty library is empty — not still loading.
    const nothingYet = (): HTMLElement =>
      el("div", { class: "empty-note" }, "No movies here yet — import your data from Settings, or add some via Search.");

    const renderContent = (): void => {
      const all = [...movies.values()];
      content.replaceChildren();

      if (view === "watched") {
        const watched = all
          .filter((m) => m.plays > 0)
          .sort((a, b) => (b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? ""));
        if (watched.length > 0) {
          content.append(sectionHeader(`Watched (${watched.length})`), el("div", { class: "poster-grid" }, ...watched.map((m) => card(m))));
        } else {
          content.append(movies.size === 0 ? nothingYet() : el("div", { class: "empty-note" }, "No watched movies yet."));
        }
        return;
      }

      // Watch-list view: picker between the watchlist and custom lists.
      const activeList: MovieListRec | undefined = lists.find((l) => l.traktId === activeListId);

      if (lists.length > 0) {
        const select = el("select", { class: "season-select list-select" });
        const optionFor = (value: string, label: string, count: number): HTMLElement => {
          const opt = el("option", { value }, `${label} (${count})`);
          if (value === (activeList ? String(activeList.traktId) : "watchlist")) opt.setAttribute("selected", "");
          return opt;
        };
        select.append(optionFor("watchlist", "Watchlist", all.filter((m) => m.onWatchlist && m.plays === 0).length));
        for (const list of lists) {
          select.append(
            optionFor(String(list.traktId), list.name, all.filter((m) => m.customLists?.includes(list.traktId) && m.plays === 0).length),
          );
        }
        select.addEventListener("change", () => {
          activeListId = select.value === "watchlist" ? null : Number(select.value);
          // `replaceHash`, so flipping through the picker doesn't fill the back stack with
          // every list you glanced at — Back still returns wherever you came from.
          replaceHash(activeListId === null ? "#/movies" : `#/movies/list/${activeListId}`);
          renderContent();
        });
        content.append(el("div", { class: "list-picker" }, select));
      }

      if (!activeList) {
        const watchlist = all
          .filter((m) => m.onWatchlist && m.plays === 0)
          .sort((a, b) => watchlistedAt(b).localeCompare(watchlistedAt(a)));
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
        const items = onList
          .filter((m) => m.plays === 0)
          .sort((a, b) => listedOnAt(b, activeList.traktId).localeCompare(listedOnAt(a, activeList.traktId)));
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
