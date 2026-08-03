import { replaceHash, type Route } from "../router";
import { dialog, el, toast, withSyncIndicator } from "./components";
import {
  fetchMoviePoster,
  fetchShowImages,
  posterUrl,
  searchTmdbAll,
  searchTmdbMovies,
  searchTmdbShows,
  type TmdbSearchHit,
} from "../api/tmdb";
import { addToWatchlist, loadLibrary, loadMovieLists, loadMovies, removeFromWatchlist } from "../data/sync";
import { getSettings } from "../data/settings";
import { movieListsDropdown } from "./shared";
import { tmdbKey, type MovieRec, type ShowRec } from "../data/model";

/** Titles starting with the query first, then the rest — both alphabetical. */
function byRelevance<T extends { title: string }>(query: string, items: T[]): T[] {
  const starts = (t: string): boolean => t.toLowerCase().startsWith(query);
  return items.sort(
    (a, b) => Number(starts(b.title)) - Number(starts(a.title)) || a.title.localeCompare(b.title),
  );
}

type Mode = "all" | "show" | "movie";
const isMode = (s: string | undefined): s is Mode => s === "all" || s === "show" || s === "movie";

/**
 * The last TMDB answer, so that coming back from a title's page re-draws the list
 * you left instead of asking TMDB the same question again — and re-draws it before
 * the router restores the scroll, which a fresh request would arrive far too late for.
 * One entry: going back is the only way in, and that only ever wants the last one.
 */
let lastResults: { key: string; hits: TmdbSearchHit[] } | null = null;

export const searchRoute: Route = {
  name: "search",
  title: "Search · WatchWhat",
  async render(container, params) {
    const lib = await loadLibrary();
    const movies = await loadMovies();
    const movieLists = await loadMovieLists();
    // The query lives in the address (#/search/all/dune), so tapping a result and
    // pressing back returns to the same search rather than an empty box.
    let mode: Mode = isMode(params[0]) ? params[0] : "all";
    const initialQuery = params[1] ? decodeURIComponent(params[1]) : "";

    // TMDB when there's a key, and failing that the library on the device.
    // Only the second cannot turn up something new, so it says so in the
    // placeholder rather than looking like a search that found nothing.
    const source: "tmdb" | "library" = getSettings().tmdbApiKey ? "tmdb" : "library";
    const placeholders: Record<Mode, string> =
      source === "library"
        ? { all: "Search your shows & movies…", show: "Search your shows…", movie: "Search your movies…" }
        : { all: "Search movies & TV shows…", show: "Search TV shows…", movie: "Search movies…" };

    const input = el("input", { type: "search", placeholder: placeholders[mode], autofocus: "true" }) as HTMLInputElement;
    input.value = initialQuery;
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
        rememberSearch();
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

    function showRow(show: ShowRec, withType = false, poster?: string | null): HTMLElement {
      const img = el("img", { class: "mini-placeholder", loading: "lazy", alt: "" }) as HTMLImageElement;
      const cached = lib.shows.get(show.ids.trakt)?.poster ?? poster;
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
    function movieRow(movie: MovieRec, withType = false, poster?: string | null): HTMLElement {
      const img = el("img", { class: "mini-placeholder", loading: "lazy", alt: "" }) as HTMLImageElement;
      const cached = movies.get(movie.ids.trakt)?.poster ?? poster;
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
        record: () => (rec ??= movies.get(movie.ids.trakt) ?? movie),
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

    // ----- TMDB results -----
    // A hit for something already tracked has to resolve to that record, or the
    // row would offer to add a second copy under a different key and show none
    // of its state. TMDB ids are the only thing the two eras share.
    const showsByTmdb = new Map<number, ShowRec>();
    for (const show of lib.shows.values()) if (show.ids.tmdb) showsByTmdb.set(show.ids.tmdb, show);
    const moviesByTmdb = new Map<number, MovieRec>();
    for (const movie of movies.values()) if (movie.ids.tmdb) moviesByTmdb.set(movie.ids.tmdb, movie);

    function hitToShow(hit: TmdbSearchHit): ShowRec {
      return (
        showsByTmdb.get(hit.tmdbId) ?? {
          traktId: tmdbKey(hit.tmdbId),
          ids: { trakt: tmdbKey(hit.tmdbId), tmdb: hit.tmdbId },
          title: hit.title,
          year: hit.year,
          overview: hit.overview ?? undefined,
        }
      );
    }

    function hitToMovie(hit: TmdbSearchHit): MovieRec {
      return (
        moviesByTmdb.get(hit.tmdbId) ?? {
          traktId: tmdbKey(hit.tmdbId),
          ids: { trakt: tmdbKey(hit.tmdbId), tmdb: hit.tmdbId },
          title: hit.title,
          year: hit.year,
          plays: 0,
          lastWatchedAt: null,
          onWatchlist: false,
          listedAt: null,
          overview: hit.overview ?? undefined,
        }
      );
    }

    const hitRow = (hit: TmdbSearchHit, withType: boolean): HTMLElement =>
      hit.kind === "show" ? showRow(hitToShow(hit), withType, hit.poster) : movieRow(hitToMovie(hit), withType, hit.poster);

    // ----- search plumbing -----
    const cacheKey = (query: string): string => `${mode}\n${query}`;

    /** Keep the address in step with the box, without a history entry per keystroke. */
    function rememberSearch(): void {
      const query = input.value.trim();
      replaceHash(query ? `#/search/${mode}/${encodeURIComponent(query)}` : "#/search");
    }

    function showHits(hits: TmdbSearchHit[]): void {
      const rows = hits.map((h) => hitRow(h, mode === "all"));
      results.replaceChildren(...rows);
      if (rows.length === 0) results.append(el("div", { class: "empty-note" }, "Nothing found."));
    }

    function runSearch(): void {
      window.clearTimeout(debounce);
      const query = input.value.trim();
      if (query.length < 2) {
        results.replaceChildren();
        return;
      }
      if (source === "library") {
        const q = query.toLowerCase();
        const shows = byRelevance(q, [...lib.shows.values()].filter((s) => s.title.toLowerCase().includes(q)));
        const found = byRelevance(q, [...movies.values()].filter((m) => m.title.toLowerCase().includes(q)));
        const rows =
          mode === "show"
            ? shows.map((s) => showRow(s))
            : mode === "movie"
              ? found.map((m) => movieRow(m))
              : [...shows.map((s) => showRow(s, true)), ...found.map((m) => movieRow(m, true))];
        results.replaceChildren(...rows);
        if (rows.length === 0) {
          results.append(el("div", { class: "empty-note" }, "Nothing in your library matches. Add a TMDB key in Settings to search for new titles."));
        }
        return;
      }

      const key = cacheKey(query);
      debounce = window.setTimeout(async () => {
        const seq = ++requestSeq;
        try {
          const hits =
            mode === "all" ? await searchTmdbAll(query) : mode === "show" ? await searchTmdbShows(query) : await searchTmdbMovies(query);
          if (seq !== requestSeq) return; // a newer search superseded this one
          lastResults = { key, hits };
          showHits(hits);
        } catch (e) {
          if (seq === requestSeq) toast(e instanceof Error ? e.message : "Search failed", "error");
        }
      }, 350);
    }

    input.addEventListener("input", () => {
      rememberSearch();
      runSearch();
    });

    // Arriving with a query — from the back button, or a link. Cached hits are painted
    // here and now, still inside `render`, so the router finds a full-height list to
    // restore the scroll onto; anything else has to go and ask.
    if (initialQuery.length >= 2) {
      if (source === "tmdb" && lastResults?.key === cacheKey(initialQuery)) showHits(lastResults.hits);
      else runSearch();
    }
  },
};
