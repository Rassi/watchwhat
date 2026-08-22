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
import { isInspected, markInspected } from "../data/inspected";
import { getSettings } from "../data/settings";
import { normalizeService, scoreNote, serviceRules } from "./shared";
import { tmdbKey, type MovieRec } from "../data/model";

type View = "home" | "new" | "foryou";
const isView = (s: string | undefined): s is View => s === "home" || s === "new" || s === "foryou";

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
 * Which draw FOR YOU is showing. Zero is the twelve most recently watched films, which is the
 * page you land on; every press of *Shuffle* increments it and means "twelve drawn at random
 * from everything watched", redrawn on each press rather than cycling a fixed set.
 *
 * Deliberately **not** part of `feedKey`. A key per draw would mint a cache slot per press and
 * evict POPULAR and NEW out of the six, so tabbing back would re-ask TMDB three questions it
 * already held answers to. One FOR YOU slot, latest draw wins, and `showFeed` compares this
 * against what the slot holds instead.
 */
let forYouShuffle = 0;

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
 * NEW asks about a week at a time, and this is why it can afford to.
 *
 * The obvious build is one query per day, walking backwards: it is the only way to know the day
 * a film reached home, since neither `sort_by` nor the response carries that date (see
 * `discoverMovies`). It works, and it costs seven requests a week to place films to the day —
 * on a feed where most days hold nothing worth showing.
 *
 * A week asked as one window costs two, because it has to be asked twice: `popularity.desc` for
 * what people are looking at and `vote_count.desc` for what has an audience at all. Measured
 * across three weeks on 2026-08-15, the pair returned **40 of the 40 films** a full day-by-day
 * walk of the same period found, for 6 requests against 21. Nothing was lost but the ordering
 * inside a week, which is why the screen groups by week and ranks by popularity within one.
 */
const NEW_WEEK_SORTS = ["popularity.desc", "vote_count.desc"] as const;

/** Weeks fetched on first load. One week clears the fold; two make the grid look inhabited. */
const NEW_WEEKS_FIRST = 2;

/**
 * How far back *Load more* will go. Beyond a quarter this stops being a new-releases screen, and
 * `CATALOGUE_YEARS` is already the backstop against a service's back catalogue reading as news.
 */
const NEW_WEEKS_BACK = 13;

/**
 * The cut that decides what NEW shows, and the only quality judgement in the app.
 *
 * The measurements behind every number are in `docs/discover.md`; the short of it is that a
 * window of US digital releases is 299 films over three weeks, median vote count **zero**. Most
 * of them never saw a cinema. Two tests admit a film, because the two kinds worth showing fail
 * opposite tests:
 *
 * - **Popularity** catches what has just landed and is being looked at, before anyone has voted.
 * - **Votes** catches the film that had a real theatrical run and arrives home already rated —
 *   *A Poet* is 8.8 from 117 votes at popularity 3.4, and no attention-based cut would keep it.
 *
 * The score is a *veto*, never an entry ticket, and only where enough people voted to mean
 * something. It fires on three films in three weeks — *Winnie-the-Pooh: Blood and Honey 2*,
 * *Bambi: The Reckoning*, *Peter Pan's Neverland Nightmare* — which is exactly the category it
 * exists for. **A low score with few votes is not evidence**, so it is left alone; the same
 * reasoning that keeps a score floor off POPULAR.
 *
 * What this cannot do is judge a film nobody has watched yet. 299 down to 40 is the useful part;
 * a couple of weak titles ride in on popularity alone and that is the honest ceiling here.
 */
const NEW_MIN_POPULARITY = 10;
const NEW_MIN_VOTES = 100;
const NEW_MIN_SCORE = 6;

/** Whether a film has earned a place on NEW — see the constants above. */
function worthShowing(hit: TmdbDiscoverHit): boolean {
  const judged = hit.votes >= NEW_MIN_VOTES;
  if (judged && (hit.rating ?? 0) < NEW_MIN_SCORE) return false;
  return hit.popularity >= NEW_MIN_POPULARITY || judged;
}

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
 * An answer already drawn, so returning to a question repaints the same grid instead of asking
 * TMDB again — and repaints it synchronously, before the router restores the scroll, which a
 * fresh request would arrive far too late for.
 *
 * The three id sets ride along with the hits because they are *part of the answer*, not a
 * decoration on it: which films were upcoming, which were only trending, and which week each
 * one landed in are all facts about the batch that fetched them, and none can be recomputed
 * from a hit. Before NEW they were left out, so coming back from a film's page silently
 * repainted POPULAR with "Coming soon" and "Trending" replaced by scores.
 */
interface Feed {
  hits: TmdbDiscoverHit[];
  nextPage: number;
  totalPages: number;
  upcoming: number[];
  trendingOnly: number[];
  weeks: [number, number][];
  /** Which FOR YOU draw this batch answers — see `forYouShuffle`. */
  shuffle: number;
  /** When the *first* batch under this key was fetched — see `rememberFeed`. */
  fetchedAt: number;
}

/**
 * One slot per question, rather than one slot in total.
 *
 * A single slot covered leaving for a film and coming back, and nothing else: the three views
 * are three keys, so POPULAR → NEW → POPULAR evicted itself twice and paid for the same three
 * requests again. Since `feedKey` can only spell six things — three views, each with its filter
 * either way — six slots hold every question reachable from the bar, and the eviction below is
 * a backstop rather than something that fires.
 */
const FEED_SLOTS = 6;

/**
 * How long a held answer stays good.
 *
 * Not about the films, which barely move in a day. It is about *This week*: `weekLabel` counts
 * back from `Date.now()` while `weekOf` was fixed when the window was asked about, so a session
 * left open across midnight starts labelling the batch it holds with days it never asked for.
 * Half an hour is comfortably shorter than the shortest way to be wrong and comfortably longer
 * than a browsing session.
 */
const FEED_TTL = 30 * 60 * 1000;

const feeds = new Map<string, Feed>();

/**
 * File an answer under its question, evicting the least recently written if that overflows —
 * `Map` iterates in insertion order, and re-filing deletes first so a rewrite counts as recent.
 *
 * `fetchedAt` is deliberately **not** bumped by *Load more*: the TTL is guarding the week
 * headings, and those were decided by the first batch. Refreshing the stamp on every page would
 * let a feed stay eligible forever as long as you kept loading more of it.
 */
function rememberFeed(key: string, feed: Omit<Feed, "fetchedAt">): void {
  const fetchedAt = feeds.get(key)?.fetchedAt ?? Date.now();
  feeds.delete(key);
  feeds.set(key, { ...feed, fetchedAt });
  while (feeds.size > FEED_SLOTS) feeds.delete(feeds.keys().next().value!);
}

/** The held answer to a question, if there is one and it hasn't aged out. */
function heldFeed(key: string): Feed | null {
  const feed = feeds.get(key);
  if (!feed) return null;
  if (Date.now() - feed.fetchedAt > FEED_TTL) {
    feeds.delete(key);
    return null;
  }
  return feed;
}

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
        tab("NEW", "#/discover/new", view === "new"),
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
      const poster = posterCard({
        // Faded once you have opened it, so what is left bright is what you have not
        // considered yet. Read synchronously — see `data/inspected`.
        dimmed: isInspected(hit.tmdbId),
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
      // Marked here rather than on the film's page, so this stays a record of what *Discover*
      // showed you and you chose to look at. Opening the same film later from Search or from
      // your own library says nothing about this screen and leaves it alone.
      //
      // The card is dimmed on the spot instead of waiting for the repaint on the way back: the
      // navigation is instant, and a poster that only fades once you return reads as the app
      // having changed its mind about something you already left.
      poster.addEventListener("click", () => {
        markInspected(hit.tmdbId);
        poster.classList.add("dimmed");
      });
      return poster;
    }

    /** Everything fetched so far for the current view, before the hide-known filter. */
    let hits: TmdbDiscoverHit[] = [];
    /** Pages for POPULAR, weeks back for NEW — which is why it starts at a different number. */
    let nextPage = view === "new" ? 0 : 1;
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
    /**
     * Which week's window each film came back in, and NEW's whole notion of order. The date a
     * film reached home cannot be read off the hit, so the only thing that knows it is the
     * question that found it.
     */
    const weekOf = new Map<number, number>();

    // For NEW, `nextPage` counts weeks back rather than pages: week 0 is the last seven days.
    const hasMore = (): boolean => (view === "new" ? nextPage < NEW_WEEKS_BACK : nextPage <= totalPages);

    function paint(): void {
      const shown = filters.hideKnown && view !== "foryou" ? hits.filter((h) => !isKnown(h)) : hits;
      // NEW is a run of weeks, each its own grid under its own heading; the other two are one
      // grid. `grid` is therefore a plain container there and the poster grid one level down.
      if (view === "new") {
        grid.className = "";
        const weeks = [...new Set(shown.map((h) => weekOf.get(h.tmdbId) ?? 0))].sort((a, b) => a - b);
        grid.replaceChildren(
          ...weeks.flatMap((week) => {
            // Within a week nothing orders the films but attention — see NEW_WEEK_SORTS for why
            // the day they landed on isn't knowable without spending a request per day.
            const inWeek = shown
              .filter((h) => (weekOf.get(h.tmdbId) ?? 0) === week)
              .sort((a, b) => b.popularity - a.popularity);
            return [sectionHeader(weekLabel(week)), el("div", { class: "poster-grid" }, ...inWeek.map(card))];
          }),
        );
      } else {
        grid.className = "poster-grid";
        grid.replaceChildren(...shown.map(card));
      }
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
                : view === "new"
                  ? "Nothing has reached home lately that's worth the space. Load more to look further back."
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

    /**
     * Draws a fresh twelve. A press during a load is not lost: `loadPage` bails while one is in
     * flight, but the counter is part of what that load was asked for, so it re-issues on the
     * way out — see `askedFor`.
     */
    function shuffleButton(): HTMLElement {
      const btn = el("button", { class: "btn small" }, "Shuffle");
      btn.addEventListener("click", () => {
        forYouShuffle++;
        showFeed();
      });
      return btn;
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

    /**
     * One week of arrivals, asked twice and merged — see `NEW_WEEK_SORTS`.
     *
     * Week 0 is the last seven days including today. The windows are contiguous and never
     * overlap, so a film can only be caught by one of them; `absorb` keeps the first, which is
     * the most recent, and that is the right answer for the handful of films that reach home
     * twice (a digital release, then a TV one months later).
     */
    async function newWeek(week: number): Promise<TmdbDiscoverHit[]> {
      const base = await baseQuery();
      const pages = await Promise.all(
        NEW_WEEK_SORTS.map((sortBy) =>
          discoverMovies({ ...base, atHomeFrom: daysAgo(week * 7 + 6), atHomeTo: daysAgo(week * 7), sortBy, page: 1 }),
        ),
      );
      return pages.flatMap((p) => p.hits).filter(worthShowing);
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
      if (view === "foryou") return `foryou\n${forYouFilters.skipHorror}`;
      return `${view}\n${filters.onMyServices}`;
    };

    /**
     * Everything a load is answering to. `feedKey` alone names the *slot*, and a shuffle keeps
     * the same slot on purpose, so it cannot tell a batch from the draw before it. This can, and
     * it is what decides whether an answer arriving late is still the one wanted.
     */
    const askedFor = (): string => `${feedKey()}|${forYouShuffle}`;

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
      // What this batch answers, read before the await rather than after it — a filter can flip
      // or a shuffle land while it is in flight, and the answer must not be filed under the
      // question that happens to be on screen when it arrives.
      const asked = askedFor();
      loading = true;
      paint();
      try {
        if (view === "foryou") {
          // Draw zero is the twelve most recent; every draw after it is random.
          hits = await buildForYou(movies, forYouShuffle > 0);
        } else if (view === "new") {
          // Two weeks to open with, one per Load more. Both weeks go out at once rather than in
          // sequence: they are independent questions, and waiting for the first to decide the
          // second would double the time to a full screen for nothing.
          const weeks = nextPage === 0 ? [...Array(NEW_WEEKS_FIRST).keys()] : [nextPage];
          const batches = await Promise.all(weeks.map(newWeek));
          weeks.forEach((week, i) => {
            // First week wins, which is the most recent one — the same rule `absorb` applies to
            // the hits themselves, and they have to agree or a film would be filed under a week
            // its card is not in.
            for (const hit of batches[i]) if (!weekOf.has(hit.tmdbId)) weekOf.set(hit.tmdbId, week);
          });
          absorb(batches.flat());
          nextPage = weeks[weeks.length - 1] + 1;
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
        // Filed under the slot, not under what it was asked for: one FOR YOU slot holds
        // whichever draw is current, so a shuffle overwrites its predecessor rather than
        // crowding POPULAR and NEW out of the six.
        if (askedFor() === asked) {
          rememberFeed(feedKey(), {
            hits,
            nextPage,
            totalPages,
            upcoming: [...upcoming],
            trendingOnly: [...trendingOnly],
            weeks: [...weekOf],
            shuffle: forYouShuffle,
          });
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : "TMDB request failed", "error");
      } finally {
        loading = false;
        paint();
        // A filter flipped or Shuffle was pressed while this was in flight, and the guard at the
        // top swallowed it. Now that the guard is clear, ask what is actually on screen — which
        // is also why a press during a load doesn't need the button disabling.
        if (askedFor() !== asked) showFeed();
      }
    }

    /**
     * Show the answer to whatever question the bar is now asking — from the last one drawn if it
     * is still held, otherwise by going and asking. Used both on the way in and whenever a filter
     * changes the question, which is what makes ticking a box and unticking it free.
     *
     * Synchronous down the cached path, deliberately: on the way in it runs inside `render`, so
     * the grid has its full height by the time the router restores the scroll position.
     */
    function showFeed(): void {
      const slot = heldFeed(feedKey());
      // A shuffle keeps its slot, so what the slot holds may be a draw already moved on from.
      // Everything else about the question is in the key, so this is the only extra test.
      const held = slot && (view !== "foryou" || slot.shuffle === forYouShuffle) ? slot : null;
      // NEW counts weeks back from zero; the other views count pages from one.
      hits = held?.hits ?? [];
      nextPage = held?.nextPage ?? (view === "new" ? 0 : 1);
      totalPages = held?.totalPages ?? 0;
      upcoming.clear();
      trendingOnly.clear();
      weekOf.clear();
      if (!held) {
        void loadPage();
        return;
      }
      for (const id of held.upcoming) upcoming.add(id);
      for (const id of held.trendingOnly) trendingOnly.add(id);
      for (const [id, week] of held.weeks) weekOf.set(id, week);
      paint();
    }

    if (view === "new") {
      controls.append(
        el(
          "div",
          { class: "discover-blurb" },
          "What reached home in the US lately — digital and TV releases, newest week first. " +
            "Quiet titles nobody has watched or voted on are left out, so this is shorter than the week really was.",
        ),
      );
    }
    if (view === "home" || view === "new") controls.append(filterBar(showFeed, paint));
    if (view === "foryou") {
      controls.append(
        sectionHeader("Because you watched"),
        el(
          "div",
          { class: "discover-blurb" },
          "Films that resemble twelve of yours, ranked by how many of them they came back under. " +
            "Opens on your twelve most recent; Shuffle draws twelve at random from everything you've watched.",
        ),
        el(
          "div",
          { class: "filter-bar" },
          // Changes which films are asked about, so the answer has to be fetched again.
          checkbox("Ignore horror I've watched", forYouFilters.skipHorror, (on) => {
            forYouFilters.skipHorror = on;
            showFeed();
          }),
          shuffleButton(),
        ),
      );
    }

    showFeed();
  },
};

/**
 * What to call a week counted back from this one. "This week" means the last seven days rather
 * than since Monday — the windows are seven-day slices ending today, so a heading that named a
 * calendar week would be describing a different period than the one that was asked about.
 */
function weekLabel(week: number): string {
  if (week === 0) return "This week";
  if (week === 1) return "Last week";
  const start = new Date(Date.now() - (week * 7 + 6) * 86_400_000);
  return `Week of ${start.toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
}

function tab(label: string, href: string, active: boolean): HTMLElement {
  return el("a", { class: `home-tab ${active ? "active" : ""}`, href }, label);
}

/**
 * Ranks what TMDB says resembles films you've watched. A title that turns up under several of
 * your seeds is a better bet than one that only matches a single film, so the count leads and
 * the score only breaks ties.
 *
 * `shuffle` decides *which* films are asked about: the twelve most recent, or twelve drawn at
 * random from everything watched. Nothing else differs between the two — the draw only reorders
 * the pool the seeds are taken off the top of, which is also why `withoutHorror` needs no say
 * in it. It takes the first twelve non-horror films in whatever order it is handed.
 */
async function buildForYou(movies: Map<number, MovieRec>, shuffle: boolean): Promise<TmdbDiscoverHit[]> {
  const watched = [...movies.values()]
    .filter((m) => m.plays > 0 && m.ids.tmdb)
    .sort((a, b) => (b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? ""));
  const pool = shuffle ? shuffled(watched) : watched;
  const seeds = forYouFilters.skipHorror ? await withoutHorror(pool, movies) : pool.slice(0, SEED_COUNT);
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
    .sort((a, b) => b.count - a.count || weightedRating(b.hit) - weightedRating(a.hit))
    .slice(0, 60)
    .map((e) => e.hit);
}

/**
 * A Fisher-Yates copy. `sort(() => Math.random() - 0.5)` is the tempting one-liner and is not a
 * shuffle — it feeds an inconsistent comparator to an algorithm that assumes a consistent one,
 * and leaves the head of the list where it started more often than not, which on a list sorted
 * by recency is exactly the bias this exists to remove.
 */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The score, pulled towards the middle by how few people voted for it.
 *
 * This only ever breaks ties, and until Shuffle it barely mattered: twelve recent films have
 * enough in common that the titles worth showing come back under two or three of them, so the
 * count did the ranking and ties were rare. Twelve films drawn from across a whole history have
 * no such overlap — nearly every candidate arrives with a count of one, and the tiebreak
 * silently becomes the sort.
 *
 * Raw `vote_average` is a bad sort. It puts 8.9 from sixty votes above 8.2 from forty thousand,
 * so a shuffled screen fills with obscurities nobody has an opinion about. Weighting by vote
 * count against a prior fixes the order without excluding anything, which keeps the house rule
 * that a score is a veto and never an entry ticket — see `docs/discover.md`.
 */
const RATING_PRIOR_VOTES = 100;
const RATING_PRIOR_SCORE = 6.5;

function weightedRating(hit: TmdbDiscoverHit): number {
  const votes = hit.votes;
  const score = hit.rating ?? RATING_PRIOR_SCORE;
  return (votes * score + RATING_PRIOR_VOTES * RATING_PRIOR_SCORE) / (votes + RATING_PRIOR_VOTES);
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
