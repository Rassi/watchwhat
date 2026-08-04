/** Movie detail page: artwork, mark watched, watchlist, where to watch, cast, similar films. */

import type { Route } from "../router";
import { dialog, el, posterCard, spinner, toast, withSyncIndicator } from "./components";
import { ensureMovieDetails, ensureMovieExtRatings, loadMovieLists, loadMovies, setMovieWatched } from "../data/sync";
import { describeEstimate, estimateRelease } from "../data/releaseEstimate";
import { isTmdbKeyed, tmdbKey, type MovieListRec, type MovieRec } from "../data/model";
import { backdropUrl, fetchMovieRecommendations, fetchMovieSummary, posterUrl, type TmdbDiscoverHit } from "../api/tmdb";
import { castStripCard, movieListsDropdown, ratingsLine, scoreNote, whereToWatchCard } from "./shared";

/**
 * The last film whose similar list was asked for.
 *
 * Held outside `renderPage` because that function is called again from scratch by the
 * background refresh's repaint — without this, providers arriving a second after you pressed
 * the button would wipe the row and leave you pressing it again. One entry, not a map: you
 * look at one film at a time, and keeping every film's row for the session would be a cache
 * nobody asked for on a screen whose whole point is that it costs nothing until asked.
 */
let lastSimilar: { tmdbId: number; hits: TmdbDiscoverHit[] } | null = null;

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
        // Deep link (e.g. tapping a search result) — build the record from TMDB
        // and cache it lazily. Only TMDB-keyed ids resolve; see show.ts.
        if (!isTmdbKeyed(traktId)) throw new Error("This film isn't in your library, and its id can no longer be looked up.");
        const summary = await fetchMovieSummary(-traktId);
        if (!summary) throw new Error("Could not load this film from TMDB — check your API key in Settings.");
        movie = {
          traktId,
          ids: { trakt: traktId, tmdb: -traktId, imdb: summary.imdb },
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
      const lists = await loadMovieLists();
      // Refresh in the background and redraw in place if anything actually came back
      // different. Scroll position is restored because the redraw replaces the whole page, and
      // having it jump under you while reading is worse than showing the old providers a moment
      // longer. A no-op refresh must not repaint at all, or it steals the selection and any
      // open dropdown for nothing.
      // `topUp.stage` but never `topUp.at`: the stage appearing or clearing changes what the card
      // says and must repaint, while the timestamp moves on every attempt and would make "no
      // change" impossible to detect on exactly the titles that top up most often.
      const snapshot = (m: MovieRec | undefined): string => JSON.stringify([m?.providers, m?.cast, m?.poster, m?.backdrop, m?.digitalRelease, m?.streamingRelease, m?.extRatings, m?.topUp?.stage]);
      let last = snapshot(movies.get(traktId));

      const paint = (): void => {
        const fresh = movies.get(traktId);
        if (!fresh) return;
        last = snapshot(fresh);
        const y = window.scrollY;
        // The callback has to be handed over again: a repaint rebuilds the card from
        // scratch, and without it the refresh button vanishes the first time it works.
        renderPage(body, movies, fresh, lists, refreshProviders);
        window.scrollTo(0, y);
      };
      const redraw = (): void => {
        const fresh = movies.get(traktId);
        if (!fresh || snapshot(fresh) === last) return;
        paint();
      };

      // Re-check the providers on demand, ignoring the TTL. Whether anything moved is
      // decided here rather than in the card, because the snapshot is what knows.
      const refreshProviders = async (): Promise<void> => {
        await ensureMovieDetails(movies, [traktId], undefined, { force: true });
        const changed = snapshot(movies.get(traktId)) !== last;
        // Always repaint, unlike the background refresh: "checked just now" is itself
        // the answer to the button, and leaving it reading "5 hours ago" after a
        // successful check is the one thing the freshness line must never do.
        paint();
        if (!changed) toast("No change — that is still the latest listing");
      };

      // Draw from cache first. Waiting on TMDB before the first paint made every visit as slow
      // as the network, to change nothing at all on the usual visit where the cache was current.
      renderPage(body, movies, movie, lists, refreshProviders);

      void ensureMovieDetails(movies, [traktId], redraw)
        .then(() => ensureMovieExtRatings(movies, movies.get(traktId) ?? movie).catch(() => false))
        .then(redraw)
        .catch(() => undefined);
    } catch (e) {
      body.replaceChildren(el("div", { class: "empty-note" }, e instanceof Error ? e.message : "Could not load this movie."));
    }
  },
};

function renderPage(
  body: HTMLElement,
  movies: Map<number, MovieRec>,
  movie: MovieRec,
  movieLists: MovieListRec[],
  onRefreshProviders?: () => Promise<void>,
): void {
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
    if (movie.plays > 0) {
      const when = movie.lastWatchedAt
        ? ` ${new Date(movie.lastWatchedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
        : "";
      bits.push(`watched${when}${movie.plays > 1 ? ` (${movie.plays}×)` : ""}`);
    }

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

    // Lists ▾ dropdown: toggle the watchlist and each custom list on/off. Shared with the search
    // results, so "add to Family" means the same thing and looks the same in both places.
    const listsWrap = movieListsDropdown({
      movies,
      record: () => movie,
      lists: movieLists,
      onChange: () => renderContent(),
    });

    const actions = el("div", { class: "card" }, el("div", { class: "manage-buttons" }, watchedBtn, listsWrap));

    // About
    const extLinks: [string, string][] = [];
    if (movie.trailer) extLinks.push(["▶ Trailer", movie.trailer]);
    if (movie.ids.imdb) extLinks.push(["IMDb", `https://www.imdb.com/title/${movie.ids.imdb}/`]);
    if (movie.ids.tmdb) extLinks.push(["TMDB", `https://www.themoviedb.org/movie/${movie.ids.tmdb}`]);
    const about = el(
      "div",
      { class: "card" },
      el("h2", {}, "About"),
      ratingsLine({
        title: movie.title,
        rating: movie.rating,
        extRatings: movie.extRatings,
        ids: movie.ids,
        kind: "movie",
      }),
      el("p", { class: "about-overview" }, movie.overview || "No description available."),
      movie.released ? el("p", { class: "about-facts" }, `Released ${movie.released}`) : null,
      // Two dates, kept apart: when you can buy or rent it, and when it starts streaming on a
      // subscription. Collapsing them into one "digital release" reads as the latter and is
      // usually the former, which is the more expensive misunderstanding of the two.
      ...(movie.plays > 0
        ? []
        : ([
            movie.digitalRelease ? { ...movie.digitalRelease, kind: "buy" as const } : null,
            movie.streamingRelease ? { ...movie.streamingRelease, kind: "stream" as const } : null,
          ]
            .filter((r) => r !== null)
            .map((r) => {
              const date = new Date(r.date);
              const upcoming = date.getTime() > Date.now();
              const label =
                r.kind === "stream"
                  ? upcoming
                    ? "Streaming from"
                    : "Streaming since"
                  : upcoming
                    ? "To buy or rent from"
                    : "Digital release";
              const when = date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
              const where = "note" in r ? `${r.country} · ${r.note}` : r.country;
              return el("p", { class: "about-facts digital-release" }, `${label}: ${when} (${where})`);
            }))),
      // Only where nothing is announced: a guess must never sit next to the real date it is
      // guessing at. `estimateRelease` returns null the moment either one lands.
      // Buy before stream, the same order the announced dates above use: cheapest question first,
      // and a reader comparing the two lines should never have to re-orient.
      ...(["buy", "stream"] as const)
        .map((kind) => {
          const est = estimateRelease(movies.values(), movie, kind);
          if (!est) return null;
          const label = kind === "stream" ? "Streaming" : "To buy or rent";
          const line = el("p", { class: "about-facts release-estimate" }, `${label}: ${describeEstimate(est)} (estimated)`);
          line.title = est.basis;
          return line;
        })
        .filter((p) => p !== null),
      (() => {
        const names = [
          ...(movie.onWatchlist ? ["Watchlist"] : []),
          ...(movie.customLists ?? []).map((id) => movieLists.find((l) => l.traktId === id)?.name ?? `List ${id}`),
        ];
        return names.length > 0 ? el("p", { class: "about-facts" }, `On lists: ${names.join(" · ")}`) : null;
      })(),
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

    /**
     * "More like this one", from the same TMDB endpoint Discover's FOR YOU is built on — but
     * behind a button, because this page opens far more often than anyone wants a suggestion
     * from it, and an automatic row would put a request on every single open.
     *
     * Unlike FOR YOU, films you already have are shown rather than dropped. There the row is
     * the whole screen and a top half of your own history would be pointless; here it answers
     * "what else is like this", and *you've seen that one* is part of the answer.
     */
    function similarCard(): HTMLElement | null {
      const tmdbId = movie.ids.tmdb;
      if (!tmdbId) return null;
      const slot = el("div", {});
      const card = el("div", { class: "card" }, el("h2", {}, "Movies like this"), slot);

      // Resolved through the library so a card opens your real record — with its lists, its
      // history and its providers — rather than a blank one keyed on the TMDB id.
      const knownByTmdb = new Map<number, MovieRec>();
      for (const m of movies.values()) if (m.ids.tmdb) knownByTmdb.set(m.ids.tmdb, m);

      function show(hits: TmdbDiscoverHit[]): void {
        if (hits.length === 0) {
          slot.replaceChildren(el("p", { class: "about-facts" }, "TMDB has nothing to suggest for this one."));
          return;
        }
        const strip = el("div", { class: "similar-strip" });
        for (const hit of hits) {
          const rec = knownByTmdb.get(hit.tmdbId);
          const badge = rec == null ? null : rec.plays > 0 ? "SEEN" : rec.onWatchlist || rec.customLists?.length ? "LISTED" : null;
          strip.append(
            posterCard({
              title: hit.title,
              href: `#/movie/${rec ? rec.traktId : tmdbKey(hit.tmdbId)}`,
              posterUrl: posterUrl(hit.poster),
              badge,
              badgeTone: badge === "SEEN" ? "seen" : null,
              subtitle: `${hit.title}${hit.year ? ` (${hit.year})` : ""}`,
              // Already in the response that drew the card — TMDB puts `vote_average` and
              // `vote_count` on every recommendation, so this costs nothing extra.
              note: scoreNote(hit),
            }),
          );
        }
        slot.replaceChildren(strip);
      }

      if (lastSimilar?.tmdbId === tmdbId) {
        show(lastSimilar.hits);
        return card;
      }

      const ask = el("button", { class: "btn" }, "Show similar films");
      ask.addEventListener("click", async () => {
        slot.replaceChildren(spinner("Asking TMDB…"));
        // `fetchMovieRecommendations` answers `[]` rather than throwing, so a failed request
        // and a film TMDB has no suggestions for arrive the same way and read the same way.
        const hits = await fetchMovieRecommendations(tmdbId);
        lastSimilar = { tmdbId, hits };
        show(hits);
      });
      slot.replaceChildren(ask);
      return card;
    }

    const pieces: HTMLElement[] = [header, actions, about];
    const wtw = whereToWatchCard(movie.providers, {
      fetchedAt: movie.tmdbFetchedAt,
      topUp: movie.topUp,
      onRefresh: onRefreshProviders,
      // Same record, redrawn: the providers didn't move, the verdict about them did.
      onServicesChanged: () => renderContent(),
    });
    if (wtw) pieces.push(wtw);
    const cast = castStripCard(movie.cast);
    if (cast) pieces.push(cast);
    const similar = similarCard();
    if (similar) pieces.push(similar);
    body.replaceChildren(...pieces);
  }

  renderContent();
}
