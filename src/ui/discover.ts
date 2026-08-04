/**
 * Discover: films you don't own yet, from TMDB rather than from your library.
 *
 * Three views, because "what should I watch" is really three questions. NEW AT HOME is the
 * one with knobs on — it rebuilds the Rotten Tomatoes *movies at home / newest* browse out
 * of TMDB's own filters. TRENDING is the global chart. FOR YOU is built here, by asking
 * TMDB what resembles the films you've actually watched and counting the overlaps.
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
  type DiscoverMovieQuery,
  type TmdbDiscoverHit,
} from "../api/tmdb";
import { loadMovies } from "../data/sync";
import { getSettings } from "../data/settings";
import { normalizeService, serviceRules } from "./shared";
import { tmdbKey, type MovieRec } from "../data/model";

type View = "home" | "trending" | "foryou";
const isView = (s: string | undefined): s is View => s === "home" || s === "trending" || s === "foryou";

/**
 * The filter bar's state, kept in the module rather than the address. Unlike Search's query
 * these aren't worth linking to, and unlike a list picker they're a standing preference for
 * the session — you set your score floor once and then browse. Leaving to look at a film and
 * coming back must not reset them, which is the whole reason they don't live in `render`.
 */
interface HomeFilters {
  /** How far back to look for the *digital* release. */
  days: number;
  minRating: number;
  minVotes: number;
  onMyServices: boolean;
  /** Let in films that are merely *newly available* rather than newly made. Off by default. */
  includeCatalogue: boolean;
  hideKnown: boolean;
  /**
   * "newest" is the primary release date — how new the *film* is. TMDB has no sort on the
   * digital date, so it parts company with "just arrived" on a long gap: Demon Slayer opened
   * in cinemas a full year before it streamed and sorts as old despite landing last week. The
   * date window is what makes the set right; this only orders it.
   */
  sortBy: "newest" | "popular" | "rated";
}

/**
 * No score floor, no vote floor, ranked by popularity.
 *
 * A vote floor looked like a quality filter and was mostly an *age* filter: votes accumulate,
 * so a film three weeks old has few of them however good or big it is, and a feed of new
 * releases is the one place that hurts most. It cut `Borderline` at 10 votes and `The Debt
 * Collector` at 55 while TMDB's own popularity had them at 163 and 171 — well inside the top
 * twenty of the month.
 *
 * `popularity` is the signal that floor was reaching for. It is engagement over the last day
 * or so — page views, watchlist adds, searches — so it is already high the week a film lands,
 * and it sorts the window without excluding anything from it. Where a score matters it is on
 * the card to be read rather than in the query as a gate.
 */
const filters: HomeFilters = {
  days: 30,
  minRating: 0,
  minVotes: 0,
  onMyServices: false,
  includeCatalogue: false,
  hideKnown: true,
  sortBy: "popular",
};

/**
 * How old a film may be and still count as new *at home*. Ordering by the true digital date
 * exposed a category the old primary-date sort had been accidentally suppressing: catalogue.
 * A service adding *Heat* (1995) or *Brazil* (1985) registers a digital release that week, so
 * a feed of genuine arrivals filled up with films from the eighties. Rotten Tomatoes' shelf
 * has none of it — every title on it is from the last year or two — so the default matches.
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

/** "1.4k" past a thousand — the exact vote count is never the point, its order of magnitude is. */
function shortCount(votes: number): string {
  return votes >= 1000 ? `${(votes / 1000).toFixed(votes >= 10_000 ? 0 : 1)}k` : String(votes);
}

function scoreNote(hit: TmdbDiscoverHit): string | null {
  if (hit.rating == null || hit.rating === 0) return null;
  return `★ ${hit.rating.toFixed(1)} · ${shortCount(hit.votes)}`;
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
        tab("NEW AT HOME", "#/discover", view === "home"),
        tab("TRENDING", "#/discover/trending", view === "trending"),
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
        // Same as the library grids: the title doubles as the subtitle so the browser's
        // own in-page search can find a card by name.
        subtitle: `${hit.title}${hit.year ? ` (${hit.year})` : ""}`,
        note: scoreNote(hit),
      });
    }

    /** Everything fetched so far for the current view, before the hide-known filter. */
    let hits: TmdbDiscoverHit[] = [];
    let nextPage = 1;
    let totalPages = 0;
    let loading = false;

    const hasMore = (): boolean => nextPage <= totalPages;

    function paint(): void {
      const shown = filters.hideKnown && view !== "foryou" ? hits.filter((h) => !isKnown(h)) : hits;
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
                : "Nothing matched. Try a longer window, or lower the score and vote floors.",
          ),
        );
        return;
      }
      if (hasMore()) {
        const more = el("button", { class: "btn" }, "Load more");
        more.addEventListener("click", () => void loadPage());
        footer.append(more);
      }
      // The count is worth saying out loud once you start filtering: it's the difference
      // between "the score floor is too high" and "there just wasn't much this month".
      status.replaceChildren(
        el("div", { class: "discover-count" }, `${shown.length} film${shown.length === 1 ? "" : "s"}${filters.hideKnown && shown.length < hits.length ? ` · ${hits.length - shown.length} hidden` : ""}`),
      );
    }

    /** The filters that don't concern dates or ordering — shared by both fetch paths. */
    async function baseQuery(): Promise<DiscoverMovieQuery> {
      const region = primaryRegion();
      return {
        minRating: filters.minRating > 0 ? filters.minRating : undefined,
        minVotes: filters.minVotes > 0 ? filters.minVotes : undefined,
        releaseTypes: RELEASE_TYPES_AT_HOME,
        ...(filters.includeCatalogue ? {} : { madeSince: daysAgo(CATALOGUE_YEARS * 365) }),
        ...(filters.onMyServices ? { watchRegion: region, providers: await myProviderIds(region) } : {}),
      };
    }

    /**
     * What the cached feed answers, so returning to the screen knows whether it still applies.
     * `hideKnown` is deliberately absent: it only decides which of the fetched hits get drawn,
     * so folding it in here would throw away a perfectly good feed and re-ask TMDB the same
     * question every time the box is ticked.
     */
    const feedKey = (): string => {
      if (view !== "home") return view;
      const { days, minRating, minVotes, onMyServices, includeCatalogue, sortBy } = filters;
      return `home\n${days}\n${minRating}\n${minVotes}\n${onMyServices}\n${includeCatalogue}\n${sortBy}`;
    };

    /** Merge a batch in, dropping anything already held. */
    function absorb(batch: TmdbDiscoverHit[]): void {
      const seen = new Set(hits.map((h) => h.tmdbId));
      hits = [...hits, ...batch.filter((h) => !seen.has(h.tmdbId))];
    }

    async function loadPage(): Promise<void> {
      if (loading) return;
      loading = true;
      paint();
      try {
        if (view === "foryou") {
          hits = await buildForYou(movies);
        } else {
          const page =
            view === "trending"
              ? await fetchTrendingMovies("week", nextPage)
              : await discoverMovies({
                  ...(await baseQuery()),
                  sortBy:
                    filters.sortBy === "newest"
                      ? "primary_release_date.desc"
                      : filters.sortBy === "popular"
                        ? "popularity.desc"
                        : "vote_average.desc",
                  releasedFrom: daysAgo(filters.days),
                  // Capped at today: TMDB carries announced future digital dates, and without
                  // this the newest-first sort opens on films nobody can watch yet.
                  releasedTo: isoDay(new Date()),
                  page: nextPage,
                });
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
      lastFeed = null;
      void loadPage();
    }

    if (view === "home") controls.append(filterBar(reload, paint));
    // Trending gets the hide toggle on its own, without the rest of the bar. It has no query
    // to tune, but it is the view most likely to be *mostly* films you already know — and a
    // count saying "11 hidden" with no way to see them is a dead end.
    if (view === "trending") {
      controls.append(el("div", { class: "filter-bar" }, hideKnownToggle(paint)));
    }
    if (view === "foryou") {
      controls.append(
        sectionHeader("Because you watched"),
        el(
          "div",
          { class: "discover-blurb" },
          "TMDB has no endpoint that reads a whole library, so this asks “what's like this?” about your twelve most recent films and ranks whatever keeps coming back.",
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
  const seeds = [...movies.values()]
    .filter((m) => m.plays > 0 && m.ids.tmdb)
    .sort((a, b) => (b.lastWatchedAt ?? "").localeCompare(a.lastWatchedAt ?? ""))
    .slice(0, 12);
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

function checkbox(label: string, current: boolean, onToggle: (on: boolean) => void): HTMLElement {
  const box = el("input", { type: "checkbox", class: "filter-check" }) as HTMLInputElement;
  box.checked = current;
  box.addEventListener("change", () => onToggle(box.checked));
  return el("label", { class: "filter-toggle" }, box, el("span", {}, label));
}

/** Shared by NEW AT HOME and TRENDING: the one control that only changes what's drawn. */
function hideKnownToggle(repaint: () => void): HTMLElement {
  return checkbox("Hide watched & listed", filters.hideKnown, (on) => {
    filters.hideKnown = on;
    repaint();
  });
}

/**
 * The knobs on NEW AT HOME. `reload` for anything that changes the question TMDB is asked;
 * `repaint` for the one that only changes what's drawn from the answer already in hand.
 */
function filterBar(reload: () => void, repaint: () => void): HTMLElement {
  const bar = el("div", { class: "filter-bar" });

  const select = <T extends string | number>(
    label: string,
    options: { value: T; label: string }[],
    current: T,
    onPick: (value: T) => void,
  ): HTMLElement => {
    const sel = el("select", { class: "season-select" }) as HTMLSelectElement;
    for (const opt of options) {
      const node = el("option", { value: String(opt.value) }, opt.label);
      if (opt.value === current) node.setAttribute("selected", "");
      sel.append(node);
    }
    sel.addEventListener("change", () => {
      const picked = options.find((o) => String(o.value) === sel.value);
      if (picked) onPick(picked.value);
    });
    return el("label", { class: "filter-field" }, el("span", {}, label), sel);
  };

  bar.append(
    select(
      "At home since",
      [
        { value: 7, label: "7 days" },
        { value: 14, label: "14 days" },
        { value: 30, label: "30 days" },
        { value: 60, label: "60 days" },
        { value: 90, label: "3 months" },
        { value: 180, label: "6 months" },
      ],
      filters.days,
      (v) => {
        filters.days = v;
        reload();
      },
    ),
    select(
      "Score at least",
      [
        { value: 0, label: "Any" },
        { value: 5.5, label: "5.5" },
        { value: 6, label: "6.0" },
        { value: 6.5, label: "6.5" },
        { value: 7, label: "7.0" },
        { value: 7.5, label: "7.5" },
      ],
      filters.minRating,
      (v) => {
        filters.minRating = v;
        reload();
      },
    ),
    select(
      "Votes at least",
      [
        { value: 0, label: "Any" },
        { value: 5, label: "5" },
        { value: 25, label: "25" },
        { value: 50, label: "50" },
        { value: 100, label: "100" },
        { value: 300, label: "300" },
      ],
      filters.minVotes,
      (v) => {
        filters.minVotes = v;
        reload();
      },
    ),
    select(
      "Order by",
      [
        { value: "popular" as const, label: "Most popular" },
        { value: "newest" as const, label: "Newest" },
        { value: "rated" as const, label: "Highest score" },
      ],
      filters.sortBy,
      (v) => {
        filters.sortBy = v;
        reload();
      },
    ),
  );

  bar.append(
    checkbox(`On my services (${primaryRegion()})`, filters.onMyServices, (on) => {
      filters.onMyServices = on;
      reload();
    }),
    checkbox("Include older films", filters.includeCatalogue, (on) => {
      filters.includeCatalogue = on;
      reload();
    }),
    hideKnownToggle(repaint),
  );

  return bar;
}
