import type { Route } from "../router";
import { dialog, el, toast, withSyncIndicator } from "./components";
import { searchAll, searchShows, searchMovies, type TraktMovie, type TraktShow } from "../api/trakt";
import { fetchMoviePoster, fetchShowImages, posterUrl } from "../api/tmdb";
import { addToWatchlist, loadLibrary, loadMovieLists, loadMovies, removeFromWatchlist } from "../data/sync";
import { isTraktLive } from "../data/settings";
import { movieListsDropdown } from "./shared";
import type { MovieRec, ShowRec } from "../data/model";

/**
 * Cached records in the shape the result rows expect. Everything past title,
 * year and ids is optional on the Trakt types, so this loses nothing the rows
 * actually read.
 */
const asTraktShow = (s: ShowRec): TraktShow => ({
  title: s.title,
  year: s.year,
  ids: s.ids,
  status: s.status,
  overview: s.overview,
  network: s.network,
  aired_episodes: s.airedEpisodes,
  first_aired: s.firstAired,
  genres: s.genres,
  runtime: s.runtime,
  rating: s.rating,
  trailer: s.trailer,
});

const asTraktMovie = (m: MovieRec): TraktMovie => ({
  title: m.title,
  year: m.year,
  ids: m.ids,
  overview: m.overview,
  runtime: m.runtime,
  rating: m.rating,
  genres: m.genres,
  released: m.released,
  trailer: m.trailer,
});

/** Titles starting with the query first, then the rest — both alphabetical. */
function byRelevance<T extends { title: string }>(query: string, items: T[]): T[] {
  const starts = (t: string): boolean => t.toLowerCase().startsWith(query);
  return items.sort(
    (a, b) => Number(starts(b.title)) - Number(starts(a.title)) || a.title.localeCompare(b.title),
  );
}

export const searchRoute: Route = {
  name: "search",
  title: "Search · WatchWhat",
  async render(container) {
    const lib = await loadLibrary();
    const movies = await loadMovies();
    const movieLists = await loadMovieLists();
    type Mode = "all" | "show" | "movie";
    let mode: Mode = "all";

    // Searching the whole catalogue is a Trakt call. Without it, the thing
    // worth searching is the library already on the device — so the box keeps
    // working, over a smaller haystack, and says which one it is searching.
    const local = !isTraktLive();
    const placeholders: Record<Mode, string> = local
      ? { all: "Search your shows & movies…", show: "Search your shows…", movie: "Search your movies…" }
      : { all: "Search movies & TV shows…", show: "Search TV shows…", movie: "Search movies…" };

    const input = el("input", { type: "search", placeholder: placeholders[mode], autofocus: "true" });
    const results = el("div", {});

    const modeTabs = el("div", { class: "home-tabs" });
    const makeModeTab = (label: string, value: Mode): HTMLElement => {
      const tab = el("a", { class: `home-tab ${mode === value ? "active" : ""}`, href: "#/search" }, label);
      tab.addEventListener("click", (e) => {
        e.preventDefault();
        if (mode === value) return;
        mode = value;
        modeTabs.querySelectorAll(".home-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        input.placeholder = placeholders[mode];
        runSearch();
        input.focus();
      });
      return tab;
    };
    modeTabs.append(makeModeTab("ALL", "all"), makeModeTab("SHOWS", "show"), makeModeTab("MOVIES", "movie"));

    container.append(modeTabs, el("div", { class: "search-bar" }, input), results);
    input.focus();

    let requestSeq = 0;
    let debounce: number | undefined;

    // ----- show rows -----
    const inWatchlist = (traktId: number): boolean => lib.watchlist.some((e) => e.traktId === traktId);
    const isStarted = (traktId: number): boolean => (lib.watched.get(traktId)?.plays ?? 0) > 0;

    /** In combined results the two kinds sit side by side, so label them. */
    function typeChip(label: "SHOW" | "MOVIE"): HTMLElement {
      return el("span", { class: "type-chip" }, label);
    }

    function showRow(show: TraktShow, withType = false): HTMLElement {
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
            await withSyncIndicator(removeFromWatchlist(lib, show.ids.trakt));
            toast(`Removed "${show.title}" from your list`);
          } else {
            await withSyncIndicator(addToWatchlist(lib, show));
            toast(`Added "${show.title}" — it'll appear under Haven't Started`);
          }
        } catch (err) {
          toast(err instanceof Error ? err.message : "Update failed", "error");
        }
        refreshAction();
      });

      const title = el("div", { class: "t" }, `${show.title}${show.year ? ` (${show.year})` : ""}`);
      if (withType) title.append(typeChip("SHOW"));
      const rowEl = el(
        "div",
        { class: "search-row" },
        img,
        el("div", { class: "info" }, title, el("div", { class: "o" }, show.overview ?? "")),
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

    function movieRow(movie: TraktMovie, withType = false): HTMLElement {
      const img = el("img", { class: "mini-placeholder", loading: "lazy", alt: "" }) as HTMLImageElement;
      const cached = movies.get(movie.ids.trakt)?.poster;
      if (cached) img.src = posterUrl(cached, "w154")!;
      else if (movie.ids.tmdb) {
        void fetchMoviePoster(movie.ids.tmdb).then((poster) => {
          const url = posterUrl(poster, "w154");
          if (url) img.src = url;
        });
      }

      // The record may not be cached yet; the first toggle is what creates it. Held in a local so
      // every later toggle acts on the same object rather than building a second one that has
      // forgotten the first change.
      let rec = movies.get(movie.ids.trakt);
      const action = movieListsDropdown({
        movies,
        record: () => (rec ??= movies.get(movie.ids.trakt) ?? toMovieRec(movie)),
        lists: movieLists,
        onChange: () => refreshWatched(),
      });

      const title = el("div", { class: "t" }, `${movie.title}${movie.year ? ` (${movie.year})` : ""}`);
      if (withType) title.append(typeChip("MOVIE"));
      // "Watched" used to be the action button's job, which the dropdown takes over. It is still
      // worth knowing at a glance — and a watched film can still go on a list, so it must not
      // disable anything the way the old button did.
      const watchedChip = el("span", { class: "type-chip watched" }, "WATCHED");
      const refreshWatched = (): void => {
        const current = movies.get(movie.ids.trakt);
        watchedChip.hidden = !current || current.plays === 0;
      };
      refreshWatched();
      title.append(watchedChip);
      const rowEl = el(
        "div",
        { class: "search-row" },
        img,
        el("div", { class: "info" }, title, el("div", { class: "o" }, movie.overview ?? "")),
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
      if (local) {
        const q = query.toLowerCase();
        const shows = byRelevance(q, [...lib.shows.values()].filter((s) => s.title.toLowerCase().includes(q))).map(asTraktShow);
        const found = byRelevance(q, [...movies.values()].filter((m) => m.title.toLowerCase().includes(q))).map(asTraktMovie);
        const rows =
          mode === "show"
            ? shows.map((s) => showRow(s))
            : mode === "movie"
              ? found.map((m) => movieRow(m))
              : [...shows.map((s) => showRow(s, true)), ...found.map((m) => movieRow(m, true))];
        results.replaceChildren(...rows);
        if (rows.length === 0) results.append(el("div", { class: "empty-note" }, "Nothing in your library matches."));
        return;
      }

      debounce = window.setTimeout(async () => {
        const seq = ++requestSeq;
        try {
          if (mode === "all") {
            const found = await searchAll(query);
            if (seq !== requestSeq) return; // a newer search superseded this one
            const rows = found
              .map((r) => (r.type === "movie" ? (r.movie ? movieRow(r.movie, true) : null) : r.show ? showRow(r.show, true) : null))
              .filter((row): row is HTMLElement => row !== null);
            results.replaceChildren(...rows);
            if (rows.length === 0) results.append(el("div", { class: "empty-note" }, "Nothing found."));
          } else if (mode === "show") {
            const found = await searchShows(query);
            if (seq !== requestSeq) return;
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
