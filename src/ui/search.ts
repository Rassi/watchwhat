import type { Route } from "../router";
import { dialog, el, toast } from "./components";
import { searchShows, searchMovies, type TraktMovie, type TraktShow } from "../api/trakt";
import { fetchMoviePoster, fetchShowImages, posterUrl } from "../api/tmdb";
import { addToWatchlist, loadLibrary, loadMovies, removeFromWatchlist, setMovieOnWatchlist } from "../data/sync";
import { isAuthenticated, isConfigured } from "../data/settings";
import type { MovieRec } from "../data/model";

export const searchRoute: Route = {
  name: "search",
  title: "Search · WatchWhat",
  async render(container) {
    if (!isConfigured() || !isAuthenticated()) {
      container.append(el("div", { class: "empty-note" }, "Connect to Trakt in Settings to search."));
      return;
    }

    const lib = await loadLibrary();
    const movies = await loadMovies();
    let mode: "show" | "movie" = "show";

    const input = el("input", { type: "search", placeholder: "Search TV shows…", autofocus: "true" });
    const results = el("div", {});

    const modeTabs = el("div", { class: "home-tabs" });
    const makeModeTab = (label: string, value: "show" | "movie"): HTMLElement => {
      const tab = el("a", { class: `home-tab ${mode === value ? "active" : ""}`, href: "#/search" }, label);
      tab.addEventListener("click", (e) => {
        e.preventDefault();
        if (mode === value) return;
        mode = value;
        modeTabs.querySelectorAll(".home-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        input.placeholder = mode === "show" ? "Search TV shows…" : "Search movies…";
        runSearch();
        input.focus();
      });
      return tab;
    };
    modeTabs.append(makeModeTab("SHOWS", "show"), makeModeTab("MOVIES", "movie"));

    container.append(modeTabs, el("div", { class: "search-bar" }, input), results);
    input.focus();

    let requestSeq = 0;
    let debounce: number | undefined;

    // ----- show rows -----
    const inWatchlist = (traktId: number): boolean => lib.watchlist.some((e) => e.traktId === traktId);
    const isStarted = (traktId: number): boolean => (lib.watched.get(traktId)?.plays ?? 0) > 0;

    function showRow(show: TraktShow): HTMLElement {
      const img = el("img", { class: "mini-placeholder", loading: "lazy", alt: "" }) as HTMLImageElement;
      const cached = lib.shows.get(show.ids.trakt)?.poster;
      if (cached) img.src = posterUrl(cached, "w154")!;
      else if (show.ids.tmdb) {
        void fetchShowImages(show.ids.tmdb).then((images) => {
          const url = posterUrl(images?.poster, "w154");
          if (url) img.src = url;
        });
      }

      const action = el("button", { class: "btn" });
      const refreshAction = (): void => {
        if (isStarted(show.ids.trakt)) {
          action.textContent = "Tracking ✓";
          action.disabled = true;
        } else if (inWatchlist(show.ids.trakt)) {
          action.textContent = "Listed ✓";
          action.disabled = false;
        } else {
          action.textContent = "+ Add";
          action.disabled = false;
          action.classList.add("primary");
        }
      };
      refreshAction();
      action.addEventListener("click", async (e) => {
        e.stopPropagation();
        action.disabled = true;
        try {
          if (inWatchlist(show.ids.trakt)) {
            const choice = await dialog(`Remove "${show.title}"?`, "It will be removed from your watchlist.", [
              { label: "Remove", value: "yes", kind: "danger" },
              { label: "Cancel", value: "no" },
            ]);
            if (choice !== "yes") {
              refreshAction();
              return;
            }
            await removeFromWatchlist(lib, show.ids.trakt);
            toast(`Removed "${show.title}" from your list`);
          } else {
            await addToWatchlist(lib, show);
            toast(`Added "${show.title}" — it'll appear under Haven't Started`);
          }
        } catch (err) {
          toast(err instanceof Error ? err.message : "Update failed", "error");
        }
        refreshAction();
      });

      const rowEl = el(
        "div",
        { class: "search-row" },
        img,
        el(
          "div",
          { class: "info" },
          el("div", { class: "t" }, `${show.title}${show.year ? ` (${show.year})` : ""}`),
          el("div", { class: "o" }, show.overview ?? ""),
        ),
        action,
      );
      rowEl.addEventListener("click", () => (location.hash = `#/show/${show.ids.trakt}`));
      return rowEl;
    }

    // ----- movie rows -----
    function toMovieRec(movie: TraktMovie): MovieRec {
      return {
        traktId: movie.ids.trakt,
        ids: movie.ids,
        title: movie.title,
        year: movie.year,
        plays: 0,
        lastWatchedAt: null,
        onWatchlist: false,
        listedAt: null,
        overview: movie.overview,
        runtime: movie.runtime,
        rating: movie.rating,
        genres: movie.genres,
        released: movie.released,
      };
    }

    function movieRow(movie: TraktMovie): HTMLElement {
      const img = el("img", { class: "mini-placeholder", loading: "lazy", alt: "" }) as HTMLImageElement;
      const cached = movies.get(movie.ids.trakt)?.poster;
      if (cached) img.src = posterUrl(cached, "w154")!;
      else if (movie.ids.tmdb) {
        void fetchMoviePoster(movie.ids.tmdb).then((poster) => {
          const url = posterUrl(poster, "w154");
          if (url) img.src = url;
        });
      }

      const action = el("button", { class: "btn" });
      const refreshAction = (): void => {
        const rec = movies.get(movie.ids.trakt);
        if (rec && rec.plays > 0) {
          action.textContent = "Watched ✓";
          action.disabled = true;
        } else if (rec?.onWatchlist) {
          action.textContent = "Listed ✓";
          action.disabled = false;
        } else {
          action.textContent = "+ Add";
          action.disabled = false;
          action.classList.add("primary");
        }
      };
      refreshAction();
      action.addEventListener("click", async (e) => {
        e.stopPropagation();
        action.disabled = true;
        try {
          const existing = movies.get(movie.ids.trakt);
          if (existing?.onWatchlist) {
            const choice = await dialog(`Remove "${movie.title}"?`, "It will be removed from your movie watchlist.", [
              { label: "Remove", value: "yes", kind: "danger" },
              { label: "Cancel", value: "no" },
            ]);
            if (choice !== "yes") {
              refreshAction();
              return;
            }
            await setMovieOnWatchlist(movies, existing, false);
            toast(`Removed "${movie.title}" from your watchlist`);
          } else {
            await setMovieOnWatchlist(movies, existing ?? toMovieRec(movie), true);
            toast(`Added "${movie.title}" to your movie watchlist`);
          }
        } catch (err) {
          toast(err instanceof Error ? err.message : "Update failed", "error");
        }
        refreshAction();
      });

      const rowEl = el(
        "div",
        { class: "search-row" },
        img,
        el(
          "div",
          { class: "info" },
          el("div", { class: "t" }, `${movie.title}${movie.year ? ` (${movie.year})` : ""}`),
          el("div", { class: "o" }, movie.overview ?? ""),
        ),
        action,
      );
      rowEl.addEventListener("click", () => (location.hash = `#/movie/${movie.ids.trakt}`));
      return rowEl;
    }

    // ----- search plumbing -----
    function runSearch(): void {
      window.clearTimeout(debounce);
      const query = input.value.trim();
      if (query.length < 2) {
        results.replaceChildren();
        return;
      }
      debounce = window.setTimeout(async () => {
        const seq = ++requestSeq;
        try {
          if (mode === "show") {
            const found = await searchShows(query);
            if (seq !== requestSeq) return; // a newer search superseded this one
            results.replaceChildren(...found.map((r) => showRow(r.show)));
            if (found.length === 0) results.append(el("div", { class: "empty-note" }, "No shows found."));
          } else {
            const found = await searchMovies(query);
            if (seq !== requestSeq) return;
            results.replaceChildren(...found.map((r) => movieRow(r.movie)));
            if (found.length === 0) results.append(el("div", { class: "empty-note" }, "No movies found."));
          }
        } catch (e) {
          if (seq === requestSeq) toast(e instanceof Error ? e.message : "Search failed", "error");
        }
      }, 350);
    }

    input.addEventListener("input", runSearch);
  },
};
