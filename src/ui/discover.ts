/**
 * Discover: films you don't own yet, from TMDB rather than from your library.
 *
 * Two views. POPULAR is the one with knobs on: three queries — what reached home lately,
 * what is about to, and what is trending anywhere — merged, deduplicated and ranked together.
 * FOR YOU is built here, by asking TMDB what resembles the films you've actually watched and
 * counting the overlaps.
 *
 * Nothing on this screen is cached to the database. These are other people's films until you
 * put one on a list, and a discover feed that wrote 500 records a session would bloat every
 * export and every sync with titles you scrolled past once.
 */

import type { Route } from "../router";
import { el, posterCard, sectionHeader, spinner, toast } from "./components";
import {
  discoverMovies,
  fetchMovieRecommendations,
  fetchTrendingMovies,
  fetchWatchProviders,
  posterUrl,
  RELEASE_TYPES_AT_HOME,
  type DiscoverMoviePage,
  type DiscoverMovieQuery,
  type TmdbDiscoverHit,
} from "../api/tmdb";
import { ensureMovieGenres, loadMovies } from "../data/sync";
import { getSettings } from "../data/settings";
import { normalizeService, scoreNote, serviceRules } from "./shared";
import { tmdbKey, type MovieRec } from "../data/model";

type View = "home" | "foryou";
const isView = (s: string | undefined): s is View => s === "home" || s === "foryou";

/**
 * The filter bar's two toggles, kept in the module rather than the address. Unlike Search's
 * query these aren't worth linking to; they're a standing preference for the session, and
 * leaving to look at a film and coming back must not reset them — which is the whole reason
 * they don't live in `render`.
 */
interface HomeFilters {
  onMyServices: boolean;
  hideKnown: boolean;
}

/**
 * Films that have reached home lately, ranked by attention. No score floor and no vote floor.
 *
 * Both were tried and dropped. A vote floor looked like a quality filter and was mostly an
 * *age* filter — votes accumulate, so a film three weeks old has few of them however big it
 * is, and this is a screen about films three weeks old. A score floor on top of it hid the
 * small ones entirely: `Maddie's Secret` is 67% on Rotten Tomatoes and 5.0 from four votes
 * here, because the two sites' voters are not the same crowd.
 *
 * `popularity` is the signal all that filtering was reaching for. It counts engagement over
 * the last day or so, so it is already high the week a film lands, and it *ranks* the window
 * rather than excluding anything from it. Scores still appear on the cards — to be read, not
 * to be a gate. The one thing popularity cannot survive on its own is a deliberate
 * name-collision, which is what `EXCLUDED_COMPANIES` is for.
 */
const filters: HomeFilters = {
  onMyServices: false,
  hideKnown: false,
};

/**
 * FOR YOU's one knob. Same reasoning as `filters` — session state, not the address bar.
 *
 * It filters the *question*, not the answer: a horror film you watched stops being asked
 * "what's like this?", which is where a run of horror recommendations comes from. Horror can
 * still come back through a seed that merely shares a director or a cast, and that is fine —
 * what it stops is a couple of late-night horrors turning the whole screen into a genre feed.
 * On by default, because that is the failure mode this exists to fix.
 */
const forYouFilters = {
  skipHorror: true,
};

/**
 * The genre, normalised — see `genreKey`. Two spellings of it are in the data: TMDB sends
 * `Horror` and every record cached while Trakt was alive says `horror`.
 */
const HORROR = "horror";

/**
 * Genre names arrive in two vocabularies. TMDB title-cases and spaces them (`Science
 * Fiction`); records that predate the move off Trakt carry its slugs (`science-fiction`).
 * Comparing either against a literal matches half the library, so both are flattened to the
 * same key before anything is asked about them.
 */
const genreKey = (name: string): string => name.toLowerCase().replace(/[^a-z]+/g, "-");

/**
 * How many watched films are asked about. Twelve is what the blurb promises, and with the
 * horror filter on it stays twelve — the scan reaches further back rather than returning a
 * thinner list, so ticking the box changes which films are asked, not how many.
 */
const SEED_COUNT = 12;

/**
 * How far back the scan will go looking for twelve non-horror seeds. A library that really is
 * all horror would otherwise walk every film in it, one TMDB request at a time, to arrive at
 * nothing.
 */
const SEED_SCAN_LIMIT = 48;

/**
 * How far back a film's digital release may be.
 *
 * Was a dropdown until the numbers were looked at. TMDB serves twenty results a page whatever
 * the window, so widening it never returns *more* — it returns better, because more films
 * compete for the same twenty slots. The floor rises from popularity 43.8 at a fortnight to
 * 99.5 at a month to 124.8 at three, and then stops: a six-month window gives a page
 * identical to the three-month one. Ninety days is where the list saturates, so it is the
 * whole of the useful range and the control had nothing left to offer.
 */
const AT_HOME_DAYS = 90;

/**
 * How far ahead to look for films that have a digital date but haven't reached it yet.
 *
 * This needs its own query rather than just a later `release_date.lte`, and not because of
 * volume: a single widened window comes back with no way to tell which of its results are
 * already out. Asking separately means everything the second query returns is, by
 * construction, still ahead — which is what earns the badge.
 */
const FORWARD_DAYS = 90;

/**
 * Popularity a film must reach to be worth showing before it is out.
 *
 * The forward set is shallow — 188 films, of which 60 in every 80 sit below popularity 3 —
 * so taking a full page of twenty filled a third of the grid with titles nobody has heard of:
 * *Beast Race* at 4.0, *Drawn Together* at 3.3, *Uprooted* at 3.1, none with a single vote.
 * A vote floor cannot help, because a film that hasn't come out has no votes by definition,
 * and TMDB's discover has no `popularity.gte` to do it server-side.
 *
 * The exact number matters less than it looks. Nothing at all lives between 12 and 20, so
 * anything from 5 to 20 clears out the same junk; ten keeps four films where fifteen keeps
 * three. What it is *not* is a stable measure — TMDB computes popularity from a single day's
 * views, votes and watchlist adds, and documents no scale for it, so this is a film's share of
 * yesterday's attention rather than a property of the film. Expect the odd title near the line
 * to come and go.
 */
const FORWARD_MIN_POPULARITY = 10;

/**
 * Which country's release dates the window is read against.
 *
 * Not the user's country, deliberately. TMDB's release-date coverage is heavily US-weighted:
 * the same 30-day digital window returns 452 films for `US` and 8 for `DK` — and those eight
 * are local documentaries, not the films anyone is looking for. Leaving it unset is worse
 * still, because then *any* territory's date counts and a film out in June matches a window
 * covering next month. Where a film can actually be watched from here is a question the
 * provider data answers; this one is only about which country has the data.
 */
const RELEASE_DATE_REGION = "US";

/**
 * Studios whose output is excluded outright.
 *
 * Ranking by popularity has one failure mode, and this is it: popularity measures attention,
 * and a deliberate name-collision *is* attention. The Asylum ships mockbusters timed and
 * titled to shadow big releases — their "The Odyssey" is 86 minutes on a budget of nothing,
 * and TMDB gives it a popularity of 239 off eight votes, because people searching for Nolan's
 * land on it instead. No score or vote floor reaches them: the same list carried their
 * "Master of the Universe" at 40 votes and popularity 125. Excluding the label is the only
 * cut that costs nothing real.
 *
 * A list rather than a single id, because this will not be the last such studio.
 */
const EXCLUDED_COMPANIES = [1311]; // The Asylum

/**
 * How old a film may be and still count as newly at home. A service adding *Heat* (1995) to
 * its catalogue registers a digital release that week, and without this such a film reads as
 * a new arrival.
 */
const CATALOGUE_YEARS = 3;

/**
 * The last answer drawn, so returning from a film's page repaints the same grid instead of
 * asking TMDB again — and repaints it synchronously, before the router restores the scroll,
 * which a fresh request would arrive far too late for.
 */
let lastFeed: { key: string; hits: TmdbDiscoverHit[]; nextPage: number; totalPages: number } | null = null;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const daysAgo = (days: number): string => isoDay(new Date(Date.now() - days * 86_400_000));

const daysAhead = (days: number): string => isoDay(new Date(Date.now() + days * 86_400_000));

/** The country `watch_region` is asked about — the first of your watch countries. */
function primaryRegion(): string {
  return getSettings().watchCountries.split(",")[0]?.trim().toUpperCase() || "US";
}

/**
 * The TMDB provider ids behind "My services", for the one region `with_watch_providers` can
 * be asked about. The picker writes TMDB's own spellings into the setting, so matching on the
 * normalised name is exact rather than a guess. Blocked entries ("-Kanopy") are not yours and
 * are dropped; so are entries scoped to other countries, since a subscription in Sweden is no
 * help to a query about Denmark.
 */
async function myProviderIds(region: string): Promise<number[]> {
  const mine = serviceRules().filter((r) => !r.blocked && (r.countries === null || r.countries.includes(region)));
  if (mine.length === 0) return [];
  const names = new Set(mine.map((r) => r.name));
  const catalogue = await fetchWatchProviders(region);
  return catalogue.filter((p) => names.has(normalizeService(p.name))).map((p) => p.id);
}

export const discoverRoute: Route = {
  name: "discover",
  title: "Discover · WatchWhat",
  async render(container, params) {
    const view: View = isView(params[0]) ? params[0] : "home";

    container.append(
      el(
        "div",
        { class: "home-tabs" },
        tab("POPULAR", "#/discover", view === "home"),
        tab("FOR YOU", "#/discover/foryou", view === "foryou"),
      ),
    );

    if (!getSettings().tmdbApiKey) {
      container.append(el("div", { class: "empty-note" }, "Discover needs a TMDB key — add one in Settings."));
      return;
    }

    const movies = await loadMovies();
    // A film already tracked has a record under its own key, which for anything that came from
    // Trakt is not the TMDB id. Resolving through this is what makes a card open the real
    // record — with its lists, its watch history and its providers — rather than a blank one.
    const knownByTmdb = new Map<number, MovieRec>();
    for (const movie of movies.values()) if (movie.ids.tmdb) knownByTmdb.set(movie.ids.tmdb, movie);

    const controls = el("div", {});
    const grid = el("div", { class: "poster-grid" });
    const footer = el("div", { class: "discover-footer" });
    const status = el("div", {});
    container.append(controls, status, grid, footer);

    const known = (hit: TmdbDiscoverHit): MovieRec | undefined => knownByTmdb.get(hit.tmdbId);
    const isKnown = (hit: TmdbDiscoverHit): boolean => {
      const rec = known(hit);
      return rec != null && (rec.plays > 0 || rec.onWatchlist || (rec.customLists?.length ?? 0) > 0);
    };

    function card(hit: TmdbDiscoverHit): HTMLElement {
      const rec = known(hit);
      const badge = rec == null ? null : rec.plays > 0 ? "SEEN" : rec.onWatchlist || rec.customLists?.length ? "LISTED" : null;
      return posterCard({
        title: hit.title,
        href: `#/movie/${rec ? rec.traktId : tmdbKey(hit.tmdbId)}`,
        posterUrl: posterUrl(hit.poster),
        badge,
        badgeTone: badge === "SEEN" ? "seen" : null,
        // Same as the library grids: the title doubles as the subtitle so the browser's
        // own in-page search can find a card by name.
        subtitle: `${hit.title}${hit.year ? ` (${hit.year})` : ""}`,
        // For a film still ahead, that it is coming beats what strangers made of it — and it
        // usually has no score anyway.
        note: upcoming.has(hit.tmdbId) ? "Coming soon" : trendingOnly.has(hit.tmdbId) ? "Trending" : scoreNote(hit),
      });
    }

    /** Everything fetched so far for the current view, before the hide-known filter. */
    let hits: TmdbDiscoverHit[] = [];
    let nextPage = 1;
    let totalPages = 0;
    let loading = false;
    /**
     * Films whose digital date is still ahead — everything the forward query returned.
     *
     * Membership only, no date. TMDB's discover response doesn't carry release dates, so
     * saying *when* each one lands costs a `/release_dates` request per film: twenty extra
     * calls to turn "Coming soon" into "Coming 10 Aug". The window is three months and the
     * film's own page has the exact date, so the badge is left vague on purpose.
     */
    const upcoming = new Set<number>();
    /**
     * Films that only the trending query knew about. Mostly still in cinemas, but not
     * reliably so — *Project Hail Mary* has been at home since May and lands here because it
     * fell outside the window. So the note says "Trending", which is the one thing that is
     * true of all of them, rather than guessing at where they can be watched.
     */
    const trendingOnly = new Set<number>();

    const hasMore = (): boolean => nextPage <= totalPages;

    function paint(): void {
        const shown = filters.hideKnown && view === "home" ? hits.filter((h) => !isKnown(h)) : hits;
      grid.replaceChildren(...shown.map(card));
      footer.replaceChildren();
      status.replaceChildren();

      if (loading) {
        footer.append(spinner(hits.length === 0 ? "Asking TMDB…" : "Loading more…"));
        return;
      }
      if (shown.length === 0) {
        grid.replaceChildren();
        footer.append(
          el(
            "div",
            { class: "empty-note" },
            hits.length > 0
              ? "Everything here is already watched or on a list. Untick “Hide watched & listed” to see it."
              : view === "foryou"
                ? "Nothing to go on yet — mark a few films watched and this fills up."
                : "Nothing matched. Try a longer window.",
          ),
        );
        return;
      }
      if (hasMore()) {
        const more = el("button", { class: "btn" }, "Load more");
        more.addEventListener("click", () => void loadPage());
        footer.append(more);
      }
      // Worth saying out loud, because the hidden tally is the interesting half: a short
      // list is usually a library you've already filled, not a month with nothing in it.
      status.replaceChildren(
        el("div", { class: "discover-count" }, `${shown.length} film${shown.length === 1 ? "" : "s"}${filters.hideKnown && shown.length < hits.length ? ` · ${hits.length - shown.length} hidden` : ""}`),
      );
    }

    /** Everything both queries share: what a film is, never when it landed. */
    async function baseQuery(): Promise<DiscoverMovieQuery> {
      const region = primaryRegion();
      return {
        releaseTypes: RELEASE_TYPES_AT_HOME,
        region: RELEASE_DATE_REGION,
        madeSince: daysAgo(CATALOGUE_YEARS * 365),
        withoutCompanies: EXCLUDED_COMPANIES,
        ...(filters.onMyServices ? { watchRegion: region, providers: await myProviderIds(region) } : {}),
      };
    }

    /** Films that have already reached home, within the window the bar asks for. */
    async function homePage(page: number): Promise<DiscoverMoviePage> {
      return discoverMovies({ ...(await baseQuery()), atHomeFrom: daysAgo(AT_HOME_DAYS), atHomeTo: isoDay(new Date()), page });
    }

    /** Films with a digital date announced but not yet reached. One page is plenty — there
     * are around 190 in a three-month window, and the point is the imminent handful. */
    async function forwardPage(): Promise<DiscoverMoviePage> {
      return discoverMovies({
        ...(await baseQuery()),
        atHomeFrom: daysAhead(1),
        atHomeTo: daysAhead(FORWARD_DAYS),
        page: 1,
      });
    }

    /**
     * Re-sort the merged list. Two queries arrive each already ordered, but interleaved they
     * are not, and a film landing next week should sit among its peers rather than in a lump
     * at the end.
     */
    /**
     * **First batch only.** Three queries arriving at once are each ordered but not ordered
     * against each other, so the join has to be sorted once. Later pages come from the
     * at-home query alone, already in order, and are appended instead.
     *
     * Re-sorting on every Load more was what made the list move under you: a film sitting at
     * position 24 slid to 40 as twenty more popular ones arrived, and the upcoming titles —
     * low popularity almost by definition, since nobody has watched them yet — sank further
     * with every click. Appending costs a visible seam where a page boundary falls, and buys
     * a list where nothing already read ever moves.
     */
    function reorder(): void {
      hits = [...hits].sort((a, b) => b.popularity - a.popularity);
    }

    /**
     * What the cached feed answers, so returning to the screen knows whether it still applies.
     * `hideKnown` is deliberately absent: it only decides which of the fetched hits get drawn,
     * so folding it in here would throw away a perfectly good feed and re-ask TMDB the same
     * question every time the box is ticked.
     */
    const feedKey = (): string => {
      if (view !== "home") return `foryou\n${forYouFilters.skipHorror}`;
      return `home\n${filters.onMyServices}`;
    };

    /**
     * Merge a batch in, dropping anything already held *and* anything repeated inside the
     * batch. The second half matters now that three queries arrive as one batch: thirteen of
     * trending's twenty are also in the at-home page, so checking only against what was
     * already held let every one of them through twice.
     */
    function absorb(batch: TmdbDiscoverHit[]): void {
      const seen = new Set(hits.map((h) => h.tmdbId));
      const fresh: TmdbDiscoverHit[] = [];
      for (const hit of batch) {
        if (seen.has(hit.tmdbId)) continue;
        seen.add(hit.tmdbId);
        fresh.push(hit);
      }
      hits = [...hits, ...fresh];
    }

    async function loadPage(): Promise<void> {
      if (loading) return;
      loading = true;
      paint();
      try {
        if (view === "foryou") {
          hits = await buildForYou(movies);
        } else if (nextPage === 1) {
          // First page only, and the only place three queries are spent: what is at home, what
          // is about to be, and what is big anywhere. Overlap between them is heavy — thirteen
          // of trending's twenty were already in the other two — so `absorb` does the work.
          const [out, ahead, trend] = await Promise.all([homePage(1), forwardPage(), fetchTrendingMovies("week", 1)]);
          const coming = ahead.hits.filter((h) => h.popularity >= FORWARD_MIN_POPULARITY);
          const alreadyPlaced = new Set([...out.hits, ...coming].map((h) => h.tmdbId));
          for (const hit of coming) upcoming.add(hit.tmdbId);
          for (const hit of trend.hits) if (!alreadyPlaced.has(hit.tmdbId)) trendingOnly.add(hit.tmdbId);
          absorb([...out.hits, ...coming, ...trend.hits]);
          reorder();
          nextPage = 2;
          totalPages = out.totalPages;
        } else {
          // Paging only continues the at-home query. The other two are single-page by nature:
          // trending is a chart of twenty, and the forward window is the imminent handful.
          const page = await homePage(nextPage);
          // Appended, deliberately not re-sorted — see `reorder`.
          // Dedupe: paging a feed sorted by a field with ties can repeat a title across pages.
          absorb(page.hits);
          nextPage = page.page + 1;
          totalPages = page.totalPages;
        }
        lastFeed = { key: feedKey(), hits, nextPage, totalPages };
      } catch (e) {
        toast(e instanceof Error ? e.message : "TMDB request failed", "error");
      } finally {
        loading = false;
        paint();
      }
    }

    /** Start over — a filter changed, so the pages already fetched no longer describe anything. */
    function reload(): void {
      hits = [];
      nextPage = 1;
      totalPages = 0;
      upcoming.clear();
      trendingOnly.clear();
      lastFeed = null;
      void loadPage();
    }

    if (view === "home") controls.append(filterBar(reload, paint));
    if (view === "foryou") {
      controls.append(
        sectionHeader("Because you watched"),
        el(
          "div",
          { class: "discover-blurb" },
          "TMDB has no endpoint that reads a whole library, so this asks “what's like this?” about your twelve most recent films and ranks whatever keeps coming back.",
        ),
        el(
          "div",
          { class: "filter-bar" },
          // Changes which films are asked about, so the answer has to be fetched again.
          checkbox("Ignore horror I've watched", forYouFilters.skipHorror, (on) => {
            forYouFilters.skipHorror = on;
            reload();
          }),
        ),
      );
    }

    // Repaint what we left, if it's still the same question. Synchronously, inside render, so
    // the grid has its full height by the time the router restores the scroll position.
    if (lastFeed?.key === feedKey()) {
      hits = lastFeed.hits;
      nextPage = lastFeed.nextPage;
      totalPages = lastFeed.totalPages;
      paint();
    } else {
      void loadPage();
    }
  },
};

function tab(label: string, href: string, active: boolean): HTMLElement {
  return el("a", { class: `home-tab ${active ? "active" : ""}`, href }, label);
}

/**
 * Ranks what TMDB says resembles the films you've watched most recently. A title that turns
 * up under several of your seeds is a better bet than one that only matches a single film,
 * so the count leads and TMDB's score only breaks ties.
 */
async function buildForYou(movies: Map<number, MovieRec>): Promise<TmdbDiscoverHit[]> {
  const watched = [...movies.values()]
    .filter((m) => m.plays > 0 && m.ids.tmdb)
    .sort((a, b) => (b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? ""));
  const seeds = forYouFilters.skipHorror ? await withoutHorror(watched, movies) : watched.slice(0, SEED_COUNT);
  if (seeds.length === 0) return [];

  const results = await Promise.all(seeds.map((m) => fetchMovieRecommendations(m.ids.tmdb!)));
  const scored = new Map<number, { hit: TmdbDiscoverHit; count: number }>();
  const seedIds = new Set(seeds.map((m) => m.ids.tmdb));
  // Anything already in the library is dropped outright rather than badged: a "more like
  // this" row whose top half is films you've seen is just your own history, rearranged.
  const owned = new Set([...movies.values()].map((m) => m.ids.tmdb).filter((id): id is number => id != null));

  for (const list of results) {
    for (const hit of list) {
      if (seedIds.has(hit.tmdbId) || owned.has(hit.tmdbId)) continue;
      const entry = scored.get(hit.tmdbId);
      if (entry) entry.count++;
      else scored.set(hit.tmdbId, { hit, count: 1 });
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.count - a.count || (b.hit.rating ?? 0) - (a.hit.rating ?? 0))
    .slice(0, 60)
    .map((e) => e.hit);
}

/**
 * The most recent `SEED_COUNT` watched films that aren't horror.
 *
 * A batch at a time, because a record without genres costs a TMDB request to fill in, and
 * asking one film at a time down a list of hundreds would take longer than the recommendations
 * themselves. A batch is looked up in parallel, and the next one is only reached for if the
 * last didn't fill the quota. In practice the requests don't happen at all — every path that
 * creates a film sets its genres — so this is the shape of a cost that is currently zero.
 */
async function withoutHorror(watched: MovieRec[], movies: Map<number, MovieRec>): Promise<MovieRec[]> {
  const seeds: MovieRec[] = [];
  for (let i = 0; i < Math.min(watched.length, SEED_SCAN_LIMIT) && seeds.length < SEED_COUNT; i += SEED_COUNT) {
    const batch = watched.slice(i, i + SEED_COUNT);
    // `[]` for a film TMDB won't answer about, which reads as "not horror" — the right way to
    // fail, since a lookup that didn't work should not silently drop a seed.
    const genres = await Promise.all(batch.map((m) => ensureMovieGenres(movies, m)));
    batch.forEach((movie, j) => {
      if (seeds.length < SEED_COUNT && !genres[j].map(genreKey).includes(HORROR)) seeds.push(movie);
    });
  }
  return seeds;
}

function checkbox(label: string, current: boolean, onToggle: (on: boolean) => void): HTMLElement {
  const box = el("input", { type: "checkbox", class: "filter-check" }) as HTMLInputElement;
  box.checked = current;
  box.addEventListener("change", () => onToggle(box.checked));
  return el("label", { class: "filter-toggle" }, box, el("span", {}, label));
}

/** The one control that only changes what's drawn, not what's asked for. */
function hideKnownToggle(repaint: () => void): HTMLElement {
  return checkbox("Hide watched & listed", filters.hideKnown, (on) => {
    filters.hideKnown = on;
    repaint();
  });
}

/**
 * The knobs on POPULAR. `reload` for anything that changes the question TMDB is asked;
 * `repaint` for the one that only changes what's drawn from the answer already in hand.
 */
function filterBar(reload: () => void, repaint: () => void): HTMLElement {
  const bar = el("div", { class: "filter-bar" });

  bar.append(
    checkbox(`On my services (${primaryRegion()})`, filters.onMyServices, (on) => {
      filters.onMyServices = on;
      reload();
    }),
    hideKnownToggle(repaint),
  );

  return bar;
}
