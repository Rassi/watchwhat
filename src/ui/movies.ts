/** Movies tab: WATCH LIST | WATCHED top tabs; the watch-list side can show
 * the Trakt watchlist or any custom personal list. */

import type { Route } from "../router";
import { el, posterCard, sectionHeader, spinner, toast } from "./components";
import { isAuthenticated, isConfigured } from "../data/settings";
import { ensureMovieDetails, loadMovieLists, loadMovies, syncMovies } from "../data/sync";
import type { MovieListRec, MovieRec } from "../data/model";
import { posterUrl } from "../api/tmdb";

const ACTIVE_LIST_KEY = "watchwhat.activeMovieList"; // "watchlist" or a list trakt id

function moviesTabs(active: "watchlist" | "watched"): HTMLElement {
  return el(
    "div",
    { class: "home-tabs" },
    el("a", { class: `home-tab ${active === "watchlist" ? "active" : ""}`, href: "#/movies" }, "WATCH LIST"),
    el("a", { class: `home-tab ${active === "watched" ? "active" : ""}`, href: "#/movies/watched" }, "WATCHED"),
  );
}

export const moviesRoute: Route = {
  name: "movies",
  title: "Movies · WatchWhat",
  async render(container, params) {
    const view: "watchlist" | "watched" = params[0] === "watched" ? "watched" : "watchlist";
    container.append(moviesTabs(view));
    if (!isConfigured() || !isAuthenticated()) {
      container.append(el("div", { class: "empty-note" }, "Connect to Trakt in Settings first."));
      return;
    }

    let movies = await loadMovies();
    let lists = await loadMovieLists();
    const content = el("div", {});
    container.append(content);

    const card = (movie: MovieRec, badge: string | null = null): HTMLElement =>
      posterCard({
        title: movie.title,
        href: `#/movie/${movie.traktId}`,
        posterUrl: posterUrl(movie.poster),
        progress: null,
        badge,
        // Keep the title as subtitle so in-page text search finds movies.
        subtitle: `${movie.title}${movie.year ? ` (${movie.year})` : ""}`,
      });

    const addedAt = (m: MovieRec): string => m.tvtimeAddedAt ?? m.listedAt ?? "";

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
          content.append(el("div", { class: "empty-note" }, movies.size === 0 ? "" : "No watched movies yet."));
          if (movies.size === 0) content.append(spinner("Loading your movies from Trakt…"));
        }
        return;
      }

      // Watch-list view: picker between the Trakt watchlist and custom lists.
      const stored = sessionStorage.getItem(ACTIVE_LIST_KEY) ?? "watchlist";
      const activeList: MovieListRec | undefined = lists.find((l) => String(l.traktId) === stored);

      if (lists.length > 0) {
        const select = el("select", { class: "season-select list-select" });
        const optionFor = (value: string, label: string, count: number): HTMLElement => {
          const opt = el("option", { value }, `${label} (${count})`);
          if (value === (activeList ? String(activeList.traktId) : "watchlist")) opt.setAttribute("selected", "");
          return opt;
        };
        select.append(optionFor("watchlist", "Watchlist", all.filter((m) => m.onWatchlist && m.plays === 0).length));
        for (const list of lists) {
          select.append(optionFor(String(list.traktId), list.name, all.filter((m) => m.customLists?.includes(list.traktId)).length));
        }
        select.addEventListener("change", () => {
          sessionStorage.setItem(ACTIVE_LIST_KEY, select.value);
          renderContent();
        });
        content.append(el("div", { class: "list-picker" }, select));
      }

      if (!activeList) {
        const watchlist = all
          .filter((m) => m.onWatchlist && m.plays === 0)
          .sort((a, b) => addedAt(b).localeCompare(addedAt(a)));
        if (watchlist.length > 0) {
          content.append(sectionHeader(`Want to watch (${watchlist.length})`), el("div", { class: "poster-grid" }, ...watchlist.map((m) => card(m))));
        } else {
          content.append(
            movies.size === 0
              ? spinner("Loading your movies from Trakt…")
              : el("div", { class: "empty-note" }, "Watchlist is empty — add movies via Search."),
          );
        }
      } else {
        // Custom lists show everything on them; watched items get a check badge.
        const items = all
          .filter((m) => m.customLists?.includes(activeList.traktId))
          .sort((a, b) => addedAt(b).localeCompare(addedAt(a)));
        if (items.length > 0) {
          content.append(
            sectionHeader(`${activeList.name} (${items.length})`),
            el("div", { class: "poster-grid" }, ...items.map((m) => card(m, m.plays > 0 ? "✓" : null))),
          );
        } else {
          content.append(el("div", { class: "empty-note" }, `"${activeList.name}" has no movies yet — add them on trakt.tv.`));
        }
      }
    };

    const kickLazyLoads = (): void => {
      void ensureMovieDetails(movies, [...movies.keys()], renderContent, { skipWatchedRefresh: true });
    };

    renderContent();
    kickLazyLoads();

    try {
      const changed = await syncMovies();
      if (changed) {
        movies = await loadMovies();
        lists = await loadMovieLists();
        renderContent();
        kickLazyLoads();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Sync with Trakt failed", "error");
    }
  },
};
