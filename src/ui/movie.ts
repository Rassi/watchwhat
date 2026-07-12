/** Movie detail page: artwork, mark watched, watchlist, where to watch, cast. */

import type { Route } from "../router";
import { dialog, el, spinner, toast, withSyncIndicator } from "./components";
import { ensureMovieDetails, loadMovies, refreshMovieSummary, setMovieOnWatchlist, setMovieWatched, syncMovies } from "../data/sync";
import type { MovieRec } from "../data/model";
import { getMovieSummary } from "../api/trakt";
import { backdropUrl } from "../api/tmdb";
import { castStripCard, whereToWatchCard } from "./shared";

export const movieRoute: Route = {
  name: "movie",
  tab: "movies",
  async render(container, params) {
    const traktId = Number(params[0]);
    if (!Number.isFinite(traktId)) {
      location.hash = "#/movies";
      return;
    }

    const body = el("div", {});
    container.append(body);
    body.append(spinner());

    try {
      const movies = await loadMovies();
      let movie = movies.get(traktId);
      if (!movie) {
        // Deep link (e.g. from search) — build a record from Trakt and cache it lazily.
        const summary = await getMovieSummary(traktId);
        movie = {
          traktId,
          ids: summary.ids,
          title: summary.title,
          year: summary.year,
          plays: 0,
          lastWatchedAt: null,
          onWatchlist: false,
          listedAt: null,
          overview: summary.overview,
          runtime: summary.runtime,
          rating: summary.rating,
          genres: summary.genres,
          released: summary.released,
        };
        movies.set(traktId, movie);
      }
      document.title = `${movie.title} · WatchWhat`;
      // Cached before the trailer field existed — refresh Trakt metadata once.
      if (movie.trailer === undefined) movie = (await refreshMovieSummary(movies, traktId)) ?? movie;
      await ensureMovieDetails(movies, [traktId]);
      renderPage(body, movies, movie);
    } catch (e) {
      body.replaceChildren(el("div", { class: "empty-note" }, e instanceof Error ? e.message : "Could not load this movie."));
    }
  },
};

function renderPage(body: HTMLElement, movies: Map<number, MovieRec>, movie: MovieRec): void {
  function renderContent(): void {
    const back = el("a", { class: "back-link", href: "#/movies" }, "‹");
    back.addEventListener("click", (e) => {
      e.preventDefault();
      history.length > 1 ? history.back() : (location.hash = "#/movies");
    });

    const backdrop = backdropUrl(movie.backdrop);
    const bits: string[] = [];
    if (movie.year) bits.push(String(movie.year));
    if (movie.runtime) bits.push(`${movie.runtime} min`);
    if (movie.genres?.length) bits.push(movie.genres.slice(0, 3).join(", "));
    if (movie.plays > 0) bits.push(`watched${movie.plays > 1 ? ` ${movie.plays}×` : ""}`);

    const header = el(
      "div",
      { class: "show-header" },
      (() => {
        const bd = el("div", { class: "backdrop" });
        if (backdrop) bd.style.backgroundImage = `url(${backdrop})`;
        return bd;
      })(),
      back,
      el(
        "div",
        { class: "head-content" },
        el("h1", {}, movie.title),
        el("div", { class: "meta" }, bits.join(" · ")),
      ),
    );

    // Watched toggle + watchlist
    const watchedBtn = el(
      "button",
      { class: `btn ${movie.plays > 0 ? "" : "primary"}` },
      movie.plays > 0 ? "✓ Watched — unmark" : "Mark watched",
    );
    watchedBtn.addEventListener("click", async () => {
      watchedBtn.disabled = true;
      try {
        if (movie.plays > 0) {
          const choice = await dialog(`Unmark "${movie.title}"?`, "All plays of this movie will be removed from your history.", [
            { label: "Unmark", value: "yes", kind: "danger" },
            { label: "Cancel", value: "no" },
          ]);
          if (choice === "yes") {
            await withSyncIndicator(setMovieWatched(movies, movie, false));
            toast(`Unmarked "${movie.title}"`);
          }
        } else {
          await withSyncIndicator(setMovieWatched(movies, movie, true));
          toast(`Marked "${movie.title}" as watched`);
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : "Update failed", "error");
      }
      renderContent();
    });

    const listBtn = el(
      "button",
      { class: `btn ${movie.onWatchlist ? "danger" : ""}` },
      movie.onWatchlist ? "Remove from watchlist" : "+ Watchlist",
    );
    listBtn.addEventListener("click", async () => {
      listBtn.disabled = true;
      try {
        if (movie.onWatchlist) {
          const choice = await dialog(`Remove "${movie.title}"?`, "It will be removed from your movie watchlist.", [
            { label: "Remove", value: "yes", kind: "danger" },
            { label: "Cancel", value: "no" },
          ]);
          if (choice === "yes") {
            await withSyncIndicator(setMovieOnWatchlist(movies, movie, false));
            toast(`Removed "${movie.title}" from your watchlist`);
          }
        } else {
          await withSyncIndicator(setMovieOnWatchlist(movies, movie, true));
          toast(`Added "${movie.title}" to your watchlist`);
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : "Update failed", "error");
      }
      renderContent();
    });

    const actions = el("div", { class: "card" }, el("div", { class: "manage-buttons" }, watchedBtn, listBtn));

    // About
    const extLinks: [string, string][] = [];
    if (movie.trailer) extLinks.push(["▶ Trailer", movie.trailer]);
    extLinks.push(["Trakt", `https://trakt.tv/movies/${movie.ids.slug ?? movie.traktId}`]);
    if (movie.ids.imdb) extLinks.push(["IMDb", `https://www.imdb.com/title/${movie.ids.imdb}/`]);
    if (movie.ids.tmdb) extLinks.push(["TMDB", `https://www.themoviedb.org/movie/${movie.ids.tmdb}`]);
    const about = el(
      "div",
      { class: "card" },
      el("h2", {}, "About"),
      movie.rating ? el("p", { class: "about-rating" }, `★ ${movie.rating.toFixed(1)}/10`) : null,
      el("p", { class: "about-overview" }, movie.overview || "No description available."),
      movie.released ? el("p", { class: "about-facts" }, `Released ${movie.released}`) : null,
      el(
        "div",
        { class: "ext-links" },
        ...extLinks.map(([label, href]) =>
          el(
            "a",
            { class: `ext-link ${label.startsWith("▶") ? "trailer" : ""}`, href, target: "_blank", rel: "noopener" },
            label.startsWith("▶") ? label : `${label} ↗`,
          ),
        ),
      ),
    );

    const pieces: HTMLElement[] = [header, actions, about];
    const wtw = whereToWatchCard(movie.providers);
    if (wtw) pieces.push(wtw);
    const cast = castStripCard(movie.cast);
    if (cast) pieces.push(cast);
    body.replaceChildren(...pieces);
  }

  renderContent();
  // Refresh state in the background in case another device changed it.
  void syncMovies().then(async (changed) => {
    if (changed) {
      const fresh = (await loadMovies()).get(movie.traktId);
      if (fresh) {
        movie = fresh;
        movies.set(movie.traktId, movie);
        renderContent();
      }
    }
  });
}
