/** Movie detail page: artwork, mark watched, watchlist, where to watch, cast, similar films. */

import type { Route } from "../router";
import { dialog, el, posterCard, spinner, toast, withSyncIndicator } from "./components";
import { ensureMovieDetails, ensureMovieExtRatings, loadMovieLists, loadMovies, setMovieStarred, setMovieWatched } from "../data/sync";
import { describeEstimate, estimateRelease } from "../data/releaseEstimate";
import { isTmdbKeyed, tmdbKey, UNDATED, type MovieListRec, type MovieRec } from "../data/model";
import { backdropUrl, fetchMovieRecommendations, fetchMovieSummary, posterUrl, type TmdbDiscoverHit } from "../api/tmdb";
import {
  castStripCard,
  installDropdownCloser,
  movieListsDropdown,
  ratingsLine,
  scoreNote,
  watchedDate,
  whereToWatchCard,
} from "./shared";

/**
 * Films whose similar list has been asked for, and how far along the row you had scrolled.
 *
 * Held outside `renderPage` because that function is called again from scratch by the
 * background refresh's repaint and by every mark-watched — without this, providers arriving a
 * second after you pressed the button would wipe the row and leave you pressing it again.
 *
 * Keyed by film rather than a single entry, which is what the obvious journey demands: tap a
 * recommendation, open *its* similar row, come back. A one-slot cache is evicted by that
 * second row and the film you started on is back to showing a button, having already paid for
 * its answer. Session-only and unbounded, exactly like the router's `scrollPositions` — an
 * entry is 20 hits and you would have to walk hundreds of films to notice.
 */
const similarByMovie = new Map<number, { hits: TmdbDiscoverHit[]; scrollLeft: number }>();

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
      const on = watchedDate(movie.lastWatchedAt);
      bits.push(`watched${on ? ` ${on}` : ""}${movie.plays > 1 ? ` (${movie.plays}×)` : ""}`);
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

    const mark = async (at?: string): Promise<void> => {
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
          await withSyncIndicator(setMovieWatched(movies, movie, true, at ? { at } : undefined));
          toast(`Marked "${movie.title}" as watched`);
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : "Update failed", "error");
      }
      renderContent();
    };

    watchedBtn.addEventListener("click", () => void mark());

    /**
     * The caret beside it, for a film seen years ago: watched, with no date claimed.
     *
     * Not a list of "1 year ago", "2 years ago" — you don't remember which, and the app would
     * then be storing a date you made up. `UNDATED` says only what you actually know, and sorts
     * behind everything dated so a backfill of old films can't take over the For You seeds or
     * bury this week's watches at the top of the Watched grid.
     *
     * Only offered while unwatched: once a film is marked, the button's job is unmarking, and a
     * menu whose one item re-marks what is already marked is noise.
     */
    const watchedWrap = el("div", { class: "menu-dropdown split-btn" }, watchedBtn);
    if (movie.plays === 0) {
      installDropdownCloser();
      const caret = el("button", { class: "btn primary split-caret", "aria-label": "Other watched options" }, "▾");
      const undatedItem = el("button", { class: "burger-item" }, "Seen it — don't remember when");
      undatedItem.addEventListener("click", () => {
        watchedWrap.classList.remove("open");
        void mark(UNDATED);
      });
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        watchedWrap.classList.toggle("open");
      });
      watchedWrap.append(caret, el("div", { class: "burger-menu" }, undatedItem));
    }

    // Lists ▾ dropdown: toggle the watchlist and each custom list on/off. Shared with the search
    // results, so "add to Family" means the same thing and looks the same in both places.
    const listsWrap = movieListsDropdown({
      movies,
      record: () => movie,
      lists: movieLists,
      onChange: () => renderContent(),
    });

    /**
     * The star: of everything on the list, this one first.
     *
     * Offered only on a film that is actually on a list. Starring is nothing but an ordering
     * on those grids, so on a film that appears in none of them it would store a preference
     * with no way to ever see it again — and the star is kept through a removal, so putting
     * the film back brings its star with it.
     */
    const listed = movie.onWatchlist || (movie.customLists?.length ?? 0) > 0;
    const starBtn = listed
      ? el("button", { class: `btn ${movie.starred ? "starred" : ""}` }, movie.starred ? "★ Starred" : "☆ Star")
      : null;
    starBtn?.addEventListener("click", async () => {
      starBtn.disabled = true;
      try {
        await withSyncIndicator(setMovieStarred(movies, movie, movie.starred !== true));
        toast(movie.starred ? `Starred "${movie.title}"` : `Unstarred "${movie.title}"`);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Update failed", "error");
      }
      renderContent();
    });

    const actions = el("div", { class: "card" }, el("div", { class: "manage-buttons" }, watchedWrap, listsWrap, starBtn));

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

      // An arrow, not a declaration: a hoisted `function` is treated as created before the
      // `if (!tmdbId) return null` above, so it wouldn't see `tmdbId` narrowed to a number.
      const show = (hits: TmdbDiscoverHit[]): void => {
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
        // Recorded as you go rather than read back on the way out: by the time a tap has
        // navigated away, this element is already gone and there is nothing left to ask.
        strip.addEventListener(
          "scroll",
          () => {
            const held = similarByMovie.get(tmdbId);
            if (held) held.scrollLeft = strip.scrollLeft;
          },
          { passive: true },
        );
        slot.replaceChildren(strip);
      };

      const held = similarByMovie.get(tmdbId);
      if (held) {
        show(held.hits);
        return card;
      }

      const ask = el("button", { class: "btn" }, "Show similar films");
      ask.addEventListener("click", async () => {
        slot.replaceChildren(spinner("Asking TMDB…"));
        // `fetchMovieRecommendations` answers `[]` rather than throwing, so a failed request
        // and a film TMDB has no suggestions for arrive the same way and read the same way.
        const hits = await fetchMovieRecommendations(tmdbId);
        similarByMovie.set(tmdbId, { hits, scrollLeft: 0 });
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

    // Only now, because `scrollLeft` on a detached element is a no-op — there is no layout to
    // scroll until the card is in the document. Safe to set immediately rather than waiting on
    // the posters: every card is a fixed 105px and its height is reserved by `aspect-ratio`, so
    // the row is already its full width with every image still loading.
    const tmdbId = movie.ids.tmdb;
    const held = tmdbId ? similarByMovie.get(tmdbId) : undefined;
    if (held) {
      const strip = body.querySelector<HTMLElement>(".similar-strip");
      if (strip) strip.scrollLeft = held.scrollLeft;
    }
  }

  renderContent();
}
