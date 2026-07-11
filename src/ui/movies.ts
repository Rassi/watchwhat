/** Movies tab: watchlist ("want to watch") and watched grids, like TV Time's Movies. */

import type { Route } from "../router";
import { el, posterCard, sectionHeader, spinner, toast } from "./components";
import { isAuthenticated, isConfigured } from "../data/settings";
import { ensureMovieDetails, loadMovies, syncMovies } from "../data/sync";
import type { MovieRec } from "../data/model";
import { posterUrl } from "../api/tmdb";

export const moviesRoute: Route = {
  name: "movies",
  title: "Movies · WatchWhat",
  async render(container) {
    if (!isConfigured() || !isAuthenticated()) {
      container.append(el("div", { class: "empty-note" }, "Connect to Trakt in Settings first."));
      return;
    }

    let movies = await loadMovies();
    const grids = el("div", {});
    container.append(grids);

    const card = (movie: MovieRec): HTMLElement =>
      posterCard({
        title: movie.title,
        href: `#/movie/${movie.traktId}`,
        posterUrl: posterUrl(movie.poster),
        progress: null,
        subtitle: `${movie.title}${movie.year ? ` (${movie.year})` : ""}`,
      });

    const renderContent = (): void => {
      const all = [...movies.values()];
      // Prefer the original TV Time added-date (the Trakt import flattened listed_at).
      const addedAt = (m: MovieRec): string => m.tvtimeAddedAt ?? m.listedAt ?? "";
      const watchlist = all
        .filter((m) => m.onWatchlist && m.plays === 0)
        .sort((a, b) => addedAt(b).localeCompare(addedAt(a)));
      const watched = all
        .filter((m) => m.plays > 0)
        .sort((a, b) => (b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? ""));

      grids.replaceChildren();
      if (watchlist.length > 0) {
        grids.append(sectionHeader(`Want to watch (${watchlist.length})`), el("div", { class: "poster-grid" }, ...watchlist.map(card)));
      }
      if (watched.length > 0) {
        grids.append(sectionHeader(`Watched (${watched.length})`), el("div", { class: "poster-grid" }, ...watched.map(card)));
      }
      if (grids.childElementCount === 0) {
        grids.append(
          movies.size === 0
            ? spinner("Loading your movies from Trakt…")
            : el("div", { class: "empty-note" }, "No movies yet — add some via Search."),
        );
      }
    };

    const kickLazyLoads = (): void => {
      void ensureMovieDetails(movies, [...movies.keys()], renderContent);
    };

    renderContent();
    kickLazyLoads();

    try {
      const changed = await syncMovies();
      if (changed) {
        movies = await loadMovies();
        renderContent();
        kickLazyLoads();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Sync with Trakt failed", "error");
    }
  },
};
