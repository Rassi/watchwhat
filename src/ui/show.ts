import type { Route } from "../router";
import { dialog, el, spinner, toast, withSyncIndicator } from "./components";
import { addNeverMarkPrevious, getNeverMarkPrevious } from "../data/settings";
import { castStripCard, whereToWatchCard } from "./shared";
import {
  addToWatchlist,
  setShowHidden,
  ensureEpisodes,
  ensureImages,
  ensureProgress,
  ensureShowExtRatings,
  episodeWatchedAt,
  isEpisodeWatched,
  loadLibrary,
  refreshShowSummary,
  removeFromWatchlist,
  setEpisodesWatched,
  type EpisodeRef,
} from "../data/sync";
import { isTmdbKeyed, type EpisodeInfo, type EpisodesRec, type Library, type ShowRec } from "../data/model";
import { backdropUrl, fetchShowSummary, stillUrl } from "../api/tmdb";

function epCode(season: number, number: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `S${pad(season)} | E${pad(number)}`;
}

/** TV Time-style countdown: big number over a small "days" label. Null if the date passed. */
function daysUntilBadge(airDate: string): HTMLElement | null {
  const days = Math.ceil((new Date(`${airDate}T00:00:00`).getTime() - Date.now()) / (24 * 3600 * 1000));
  if (days < 0) return null;
  const badge = el("span", { class: "days-until", title: `Airs ${airDate}` });
  if (days === 0) {
    badge.append(el("span", { class: "du-label" }, "Today"));
  } else {
    badge.append(el("span", { class: "du-num" }, String(days)), el("span", { class: "du-label" }, days === 1 ? "day" : "days"));
  }
  return badge;
}

export const showRoute: Route = {
  name: "show",
  async render(container, params) {
    const traktId = Number(params[0]);
    if (!Number.isFinite(traktId)) {
      location.hash = "#/";
      return;
    }

    const lib = await loadLibrary();
    let show = lib.shows.get(traktId);
    const body = el("div", {});
    container.append(body);
    body.append(spinner());

    try {
      if (!show) {
        // Deep link to a show we haven't cached (e.g. tapping a search result).
        // Only TMDB-keyed ids can be resolved: a bare Trakt id would need a
        // Trakt lookup to map it onto TMDB, and that door is closed.
        if (!isTmdbKeyed(traktId)) throw new Error("This show isn't in your library, and its id can no longer be looked up.");
        const summary = await fetchShowSummary(-traktId);
        if (!summary) throw new Error("Could not load this show from TMDB — check your API key in Settings.");
        show = {
          traktId,
          ids: { trakt: traktId, tmdb: -traktId, imdb: summary.imdb },
          title: summary.title,
          year: summary.year,
          status: summary.status,
          network: summary.network,
          overview: summary.overview,
          genres: summary.genres,
          runtime: summary.runtime,
          rating: summary.rating,
          firstAired: summary.firstAired,
        };
        lib.shows.set(traktId, show);
      }
      await ensureImages(lib, [traktId]);
      document.title = `${show.title} · WatchWhat`;
      const [episodesRec] = await Promise.all([ensureEpisodes(show), ensureProgress(lib, [traktId])]);
      renderPage(body, lib, show, episodesRec);
    } catch (e) {
      body.replaceChildren(
        el("div", { class: "empty-note" }, e instanceof Error ? e.message : "Could not load this show."),
      );
    }
  },
};

type SeasonEntry = EpisodesRec["seasons"][number];
type BandKind = "watched" | "fresh";
type Band = { band: BandKind; seasons: SeasonEntry[] };

function renderPage(body: HTMLElement, lib: Library, show: ShowRec, episodesRec: EpisodesRec): void {
  const expanded = new Set<number>();
  const expandedEpisodes = new Set<string>(); // "season:number" rows showing their description
  const unfolded = new Set<number>(); // seasons pulled out of a collapsed band
  let activeTab: "about" | "episodes" = "episodes";
  let ratingsSeason =
    episodesRec.seasons.find((s) => s.number > 0 && s.episodes.some((e) => (e.rating ?? 0) > 0))?.number ?? 1;

  // Older cached shows may predate the metadata fields — backfill once.
  if (show.genres === undefined || show.trailer === undefined || !show.overview) {
    void refreshShowSummary(lib, show.traktId).then((rec) => {
      if (rec) {
        show = rec;
        renderContent();
      }
    });
  }

  void ensureShowExtRatings(lib, show).then((updated) => {
    if (updated) renderContent();
  });
  const progress0 = lib.progress.get(show.traktId);
  // Skip specials when guessing where you're up to — on a show you haven't started they
  // sort first, and opening the page onto 80-odd specials helps nobody.
  const firstOpen =
    progress0?.nextEpisode?.season ?? progress0?.seasons.find((s) => s.number > 0 && s.completed < s.aired)?.number;
  if (firstOpen != null) expanded.add(firstOpen);
  // The season you'd watch next never folds away, so a show you haven't started can't
  // collapse into nothing but bands. Without progress that's simply the first season.
  const numbered = episodesRec.seasons.filter((s) => s.number > 0 && s.episodes.length > 0).map((s) => s.number);
  const startHere = firstOpen || (numbered.length > 0 ? Math.min(...numbered) : null);
  if (startHere != null) unfolded.add(startHere);

  const rerender = (): void => renderContent();

  // ---------- helpers over current lib state ----------

  const isWatched = (season: number, number: number): boolean => isEpisodeWatched(lib, show.traktId, season, number);

  const isAired = (season: number, number: number): boolean => {
    // Progress episode lists (incl. specials) contain only aired episodes.
    const progress = lib.progress.get(show.traktId);
    if (!progress) return true; // no progress info — don't block marking
    const s = progress.seasons.find((x) => x.number === season);
    return s ? s.episodes.some((e) => e.number === number) : false;
  };

  /** All aired, unwatched, non-special episodes strictly before (season, number). */
  const previousUnwatched = (season: number, number: number): EpisodeRef[] => {
    const out: EpisodeRef[] = [];
    for (const s of episodesRec.seasons) {
      if (s.number === 0 || s.number > season) continue;
      for (const e of s.episodes) {
        if (s.number === season && e.number >= number) continue;
        if (isAired(s.number, e.number) && !isWatched(s.number, e.number)) {
          out.push({ traktId: e.traktId, season: s.number, number: e.number });
        }
      }
    }
    return out;
  };

  const mutate = async (episodes: EpisodeRef[], watched: boolean): Promise<void> => {
    // The cache is updated synchronously inside setEpisodesWatched, so the
    // checkmarks flip immediately; only the IndexedDB write is still in flight.
    const op = setEpisodesWatched(lib, show.traktId, episodes, watched);
    rerender();
    try {
      await withSyncIndicator(op);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "error");
      // Storage refused the write — reload so the UI rolls back to what's saved.
      const fresh = await loadLibrary();
      lib.shows = fresh.shows;
      lib.watched = fresh.watched;
      lib.progress = fresh.progress;
      lib.watchlist = fresh.watchlist;
      lib.hidden = fresh.hidden;
    }
    rerender();
  };

  // ---------- actions ----------

  const onToggleEpisode = async (ep: EpisodeRef): Promise<void> => {
    if (isWatched(ep.season, ep.number)) {
      await mutate([ep], false);
      return;
    }
    const previous = ep.season === 0 ? [] : previousUnwatched(ep.season, ep.number);
    if (previous.length === 0 || getNeverMarkPrevious().has(show.traktId)) {
      await mutate([ep], true);
      return;
    }

    const inSeason = previous.filter((p) => p.season === ep.season);
    const hasEarlierSeasons = previous.length > inSeason.length;
    const choices = [
      { label: `All previous (${previous.length})`, value: "all", kind: "primary" as const },
      ...(hasEarlierSeasons && inSeason.length > 0
        ? [{ label: `Only this season (${inSeason.length})`, value: "season" }]
        : []),
      { label: "Just this one", value: "one" },
      { label: "Never for this show", value: "never" },
    ];
    const choice = await dialog(
      "Mark previous episodes?",
      "Do you want to mark previous unwatched episodes as watched too?",
      choices,
    );
    if (choice === null) return; // dismissed — do nothing
    if (choice === "never") addNeverMarkPrevious(show.traktId);
    const extra = choice === "all" ? previous : choice === "season" ? inSeason : [];
    await mutate([...extra, ep], true);
  };

  const onToggleSeason = async (seasonNumber: number): Promise<void> => {
    const season = episodesRec.seasons.find((s) => s.number === seasonNumber);
    if (!season) return;
    const airedEps = season.episodes.filter((e) => isAired(seasonNumber, e.number));
    const unwatched = airedEps.filter((e) => !isWatched(seasonNumber, e.number));

    if (unwatched.length > 0) {
      // Aired, unwatched episodes in earlier (non-special) seasons.
      const previous = previousUnwatched(seasonNumber, 1);
      const choice = await dialog(
        `Mark Season ${seasonNumber} as watched?`,
        previous.length > 0
          ? `${unwatched.length} episode${unwatched.length === 1 ? "" : "s"} in this season — and ${previous.length} unwatched in earlier seasons.`
          : `${unwatched.length} episode${unwatched.length === 1 ? "" : "s"} will be marked as watched.`,
        [
          { label: `This season (${unwatched.length})`, value: "season", kind: "primary" },
          ...(previous.length > 0 ? [{ label: `Incl. previous seasons (${unwatched.length + previous.length})`, value: "all" }] : []),
          { label: "Cancel", value: "no" },
        ],
      );
      if (choice !== "season" && choice !== "all") return;
      const episodes = unwatched.map((e) => ({ traktId: e.traktId, season: seasonNumber, number: e.number }));
      if (choice === "all") episodes.push(...previous);
      await mutate(episodes, true);
    } else {
      const choice = await dialog(
        `Unmark Season ${seasonNumber}?`,
        "All episodes in this season will be marked as unwatched.",
        [
          { label: "Unmark all", value: "yes", kind: "danger" },
          { label: "Cancel", value: "no" },
        ],
      );
      if (choice !== "yes") return;
      await mutate(
        airedEps.map((e) => ({ traktId: e.traktId, season: seasonNumber, number: e.number })),
        false,
      );
    }
  };

  // ---------- folding long season lists ----------

  /**
   * Shows like Location, Location, Location run to 45 seasons, most of which hold no
   * decision: they're either finished or never started. Contiguous runs of those fold
   * into one band row so the seasons you're actually part-way through stay in reach.
   */
  const FOLD_MIN_SEASONS = 8; // short shows always list every season
  const FOLD_MIN_RUN = 3; // folding one or two rows away isn't worth the extra tap

  const seasonTally = (season: SeasonEntry): { aired: number; seen: number } => {
    const aired = season.episodes.filter((e) => isAired(season.number, e.number));
    return { aired: aired.length, seen: aired.filter((e) => isWatched(season.number, e.number)).length };
  };

  /** null for anything still in play — part-watched, unaired, specials, or manually unfolded. */
  const settledKind = (season: SeasonEntry): BandKind | null => {
    if (season.number === 0 || unfolded.has(season.number)) return null;
    const { aired, seen } = seasonTally(season);
    if (aired === 0) return null;
    return seen === aired ? "watched" : seen === 0 ? "fresh" : null;
  };

  const seasonGroups = (ordered: SeasonEntry[]): (SeasonEntry | Band)[] => {
    const seasons = ordered.filter((s) => s.episodes.length > 0);
    const canFold = seasons.filter((s) => s.number !== 0).length >= FOLD_MIN_SEASONS;

    const groups: (SeasonEntry | Band)[] = [];
    for (const season of seasons) {
      const kind = canFold ? settledKind(season) : null;
      const last = groups[groups.length - 1];
      // Keep watched and untouched runs apart — a mixed band couldn't say anything useful.
      if (kind && last && "band" in last && last.band === kind) last.seasons.push(season);
      else if (kind) groups.push({ band: kind, seasons: [season] });
      else groups.push(season);
    }
    return groups.flatMap((g) => ("band" in g && g.seasons.length < FOLD_MIN_RUN ? g.seasons : [g]));
  };

  function renderBand({ band, seasons }: Band): HTMLElement {
    const totals = seasons.reduce(
      (acc, s) => {
        const { aired, seen } = seasonTally(s);
        return { aired: acc.aired + aired, seen: acc.seen + seen };
      },
      { aired: 0, seen: 0 },
    );
    const first = seasons[0].number;
    const last = seasons[seasons.length - 1].number;

    const bar = el("div", { class: "season-bar" });
    const barFill = el("div", { class: `progress-fill ${band === "watched" ? "complete" : ""}` });
    barFill.style.height = "100%";
    barFill.style.width = band === "watched" ? "100%" : "0%";
    bar.append(barFill);

    const box = el(
      "div",
      { class: `season season-band ${band}` },
      el(
        "div",
        { class: "season-head" },
        el("h2", {}, `Seasons ${first}–${last} ⌄`),
        el("span", { class: "band-note" }, band === "watched" ? "all watched" : "not started"),
        el("span", { class: "count" }, `${totals.seen}/${totals.aired}`),
      ),
      bar,
    );
    box.title = `Show seasons ${first}–${last}`;
    box.addEventListener("click", () => {
      // Unfold by season number rather than by range, so marking something watched
      // inside the band can't silently re-fold the rows out from under you.
      for (const s of seasons) unfolded.add(s.number);
      renderContent();
    });
    return box;
  }

  // ---------- rendering ----------

  /**
   * Next unwatched aired episodes, in watch order (for the Continue tracking strip).
   *
   * Anchored to `firstOpen` — where you're up to — rather than the earliest
   * unwatched episode anywhere, so a show you dip into out of order (45 seasons of
   * Location, Location, Location) offers the current season instead of S01E01. Marking
   * an episode watched nulls `nextEpisode` until the next refetch, so the anchor is the
   * one captured at page load; the strip then just advances as episodes get ticked off.
   */
  const nextUnwatched = (limit: number): EpisodeInfo[] => {
    const out: EpisodeInfo[] = [];
    const seasons = [...episodesRec.seasons]
      .filter((s) => s.number > 0 && (firstOpen == null || s.number >= firstOpen))
      .sort((a, b) => a.number - b.number);
    for (const s of seasons) {
      for (const e of [...s.episodes].sort((a, b) => a.number - b.number)) {
        if (isAired(s.number, e.number) && !isWatched(s.number, e.number)) {
          out.push(e);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  };

  // ---------- about view ----------

  function ratingsChart(): HTMLElement | null {
    const ratedSeasons = episodesRec.seasons.filter((s) => s.number > 0 && s.episodes.some((e) => (e.rating ?? 0) > 0));
    if (ratedSeasons.length === 0) return null;
    if (!ratedSeasons.some((s) => s.number === ratingsSeason)) ratingsSeason = ratedSeasons[0].number;

    // Build each season's SVG at the real pixel width so text stays readable
    // on phones (a scaled viewBox shrinks the axis legends into illegibility).
    const app = document.getElementById("app")!;
    const W = Math.max(300, Math.min(852, app.clientWidth - 56)); // card inner width
    const H = 220;
    const padLeft = 26;
    const padBottom = 26;
    const padTop = 10;
    const plotW = W - padLeft - 12;
    const plotH = H - padTop - padBottom;

    const buildSeasonSvg = (season: (typeof ratedSeasons)[number]): SVGSVGElement => {
      const points = season.episodes.filter((e) => (e.rating ?? 0) > 0);
      const x = (i: number) => padLeft + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
      const y = (rating: number) => padTop + (1 - rating / 10) * plotH;

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", String(W));
      svg.setAttribute("height", String(H));
      svg.setAttribute("class", "ratings-svg");
      const add = (tag: string, attrs: Record<string, string>, text?: string) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        if (text) node.textContent = text;
        svg.append(node);
        return node;
      };
      for (const grid of [2, 4, 6, 8, 10]) {
        add("line", { x1: String(padLeft), y1: String(y(grid)), x2: String(W - 12), y2: String(y(grid)), class: "grid" });
        add("text", { x: String(padLeft - 6), y: String(y(grid) + 4), "text-anchor": "end", class: "axis" }, String(grid));
      }
      if (points.length > 1) {
        add("polyline", { points: points.map((e, i) => `${x(i)},${y(e.rating!)}`).join(" "), class: "rating-line" });
      }
      // Thin the episode-number labels when they'd collide.
      const labelEvery = Math.ceil(points.length / Math.floor(plotW / 26));
      points.forEach((e, i) => {
        add("circle", { cx: String(x(i)), cy: String(y(e.rating!)), r: "3.5", class: "rating-dot" });
        if (i % labelEvery === 0 || i === points.length - 1) {
          add("text", { x: String(x(i)), y: String(H - 8), "text-anchor": "middle", class: "axis" }, String(e.number));
        }
      });
      return svg;
    };

    // Swipe horizontally through seasons (snap pages), TV Time style.
    const scroller = el("div", { class: "ratings-scroller" });
    for (const season of ratedSeasons) {
      const page = el("div", { class: "ratings-page" });
      page.append(buildSeasonSvg(season));
      scroller.append(page);
    }

    const select = el("select", { class: "season-select" });
    for (const s of ratedSeasons) {
      const opt = el("option", { value: String(s.number) }, `Season ${s.number}`);
      if (s.number === ratingsSeason) opt.setAttribute("selected", "");
      select.append(opt);
    }
    const indexOfSeason = (n: number): number => Math.max(0, ratedSeasons.findIndex((s) => s.number === n));
    select.addEventListener("change", () => {
      ratingsSeason = Number(select.value);
      scroller.scrollTo({ left: indexOfSeason(ratingsSeason) * scroller.clientWidth, behavior: "smooth" });
    });
    scroller.addEventListener("scroll", () => {
      const index = Math.round(scroller.scrollLeft / Math.max(1, scroller.clientWidth));
      const season = ratedSeasons[Math.min(index, ratedSeasons.length - 1)];
      if (season && season.number !== ratingsSeason) {
        ratingsSeason = season.number;
        select.value = String(season.number);
      }
    });
    // Jump to the remembered season once the card is laid out.
    requestAnimationFrame(() => {
      scroller.scrollTo({ left: indexOfSeason(ratingsSeason) * scroller.clientWidth });
    });

    return el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("h2", {}, "Episode ratings"), select),
      scroller,
    );
  }

  function aboutView(): HTMLElement {
    const wrap = el("div", {});

    // Show info
    const meta: string[] = [];
    const years = show.firstAired ? String(new Date(show.firstAired).getFullYear()) : show.year ? String(show.year) : "";
    if (years) meta.push(years);
    if (show.genres?.length) meta.push(show.genres.slice(0, 4).join(", "));
    const facts: string[] = [];
    if (show.airs?.day && show.status !== "ended" && show.status !== "canceled") {
      facts.push(`${show.airs.day}${show.airs.time ? ` | ${show.airs.time}` : ""}`);
    }
    if (show.runtime) facts.push(`${show.runtime} min`);
    if (show.network) facts.push(show.network);
    if (show.status) facts.push(show.status);

    const extLinks: [string, string][] = [];
    if (show.trailer) extLinks.push(["▶ Trailer", show.trailer]);
    extLinks.push(["Trakt", `https://trakt.tv/shows/${show.ids.slug ?? show.traktId}`]);
    if (show.ids.imdb) extLinks.push(["IMDb", `https://www.imdb.com/title/${show.ids.imdb}/`]);
    if (show.ids.tmdb) extLinks.push(["TMDB", `https://www.themoviedb.org/tv/${show.ids.tmdb}`]);
    if (show.ids.tvdb) extLinks.push(["TheTVDB", `https://thetvdb.com/dereferrer/series/${show.ids.tvdb}`]);
    const linkRow = el(
      "div",
      { class: "ext-links" },
      ...extLinks.map(([label, href]) =>
        el(
          "a",
          { class: `ext-link ${label.startsWith("▶") ? "trailer" : ""}`, href, target: "_blank", rel: "noopener" },
          label.startsWith("▶") ? label : `${label} ↗`,
        ),
      ),
    );

    wrap.append(
      el(
        "div",
        { class: "card" },
        el("h2", {}, "Show info"),
        el("p", { class: "about-meta" }, meta.join(" • ")),
        (() => {
          const bits = [
            show.rating ? `★ ${show.rating.toFixed(1)} TMDB` : null,
            show.extRatings?.imdb ? `IMDb ${show.extRatings.imdb}` : null,
            show.extRatings?.rottenTomatoes ? `🍅 ${show.extRatings.rottenTomatoes}` : null,
          ].filter(Boolean);
          return bits.length > 0 ? el("p", { class: "about-rating" }, bits.join("  ·  ")) : null;
        })(),
        el("p", { class: "about-overview" }, show.overview || "No description available."),
        el("p", { class: "about-facts" }, facts.join("  ·  ")),
        linkRow,
      ),
    );

    const wtw = whereToWatchCard(episodesRec.providers);
    if (wtw) wrap.append(wtw);

    const castCard = castStripCard(episodesRec.cast);
    if (castCard) wrap.append(castCard);

    const chart = ratingsChart();
    if (chart) wrap.append(chart);

    // Manage: watchlist membership + stop/resume tracking, with confirmations
    const onList = lib.watchlist.some((e) => e.traktId === show.traktId);
    const started = (lib.watched.get(show.traktId)?.plays ?? 0) > 0;
    const isHidden = lib.hidden.has(show.traktId);
    const manageButtons: HTMLElement[] = [];

    const makeButton = (label: string, tooltip: string, kind: string, action: () => Promise<void>): HTMLElement => {
      const btn = el("button", { class: `btn ${kind}`, title: tooltip }, label);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await action();
        } catch (e) {
          toast(e instanceof Error ? e.message : "Update failed", "error");
        }
        renderContent();
      });
      return btn;
    };

    if (onList) {
      manageButtons.push(
        makeButton("Remove from watchlist", "Removes this show from your watchlist", "danger", async () => {
          const choice = await dialog(
            `Remove "${show.title}"?`,
            "It will be removed from your watchlist. Nothing else is affected.",
            [
              { label: "Remove", value: "yes", kind: "danger" },
              { label: "Cancel", value: "no" },
            ],
          );
          if (choice !== "yes") return;
          await removeFromWatchlist(lib, show.traktId);
          toast(`Removed "${show.title}" from your watchlist`);
        }),
      );
    } else if (!started && !isHidden) {
      manageButtons.push(
        makeButton("Add to watchlist", "Adds this show to your watchlist (Haven't started)", "primary", async () => {
          await addToWatchlist(lib, show);
          toast(`Added "${show.title}" to your watchlist`);
        }),
      );
    }

    if (isHidden) {
      manageButtons.push(
        makeButton("Resume tracking", "Bring this show back to your watch list", "primary", async () => {
          await setShowHidden(lib, show.traktId, false);
          toast(`Resumed tracking "${show.title}"`);
        }),
      );
    } else if (started) {
      manageButtons.push(
        makeButton("Stop tracking", "Hides this show from your watch list — your history is kept", "danger", async () => {
          const choice = await dialog(
            `Stop tracking "${show.title}"?`,
            "It disappears from your watch list and moves to Stopped in the Library. Your watch history is kept, and you can resume any time.",
            [
              { label: "Stop tracking", value: "yes", kind: "danger" },
              { label: "Cancel", value: "no" },
            ],
          );
          if (choice !== "yes") return;
          await setShowHidden(lib, show.traktId, true);
          toast(`Stopped tracking "${show.title}"`);
        }),
      );
    }

    if (manageButtons.length > 0) {
      wrap.append(el("div", { class: "card" }, el("h2", {}, "Manage"), el("div", { class: "manage-buttons" }, ...manageButtons)));
    }

    return wrap;
  }

  function continueStrip(): HTMLElement | null {
    const next = nextUnwatched(6);
    if (next.length === 0) return null;
    const strip = el("div", { class: "continue-strip" });
    for (const e of next) {
      const check = el("button", { class: "check" }, "✓");
      check.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void onToggleEpisode({ traktId: e.traktId, season: e.season, number: e.number });
      });
      const still = stillUrl(e.still, "w300");
      const card = el(
        "div",
        { class: "next-card" },
        still
          ? (() => {
              const img = el("img", { class: "next-still", loading: "lazy", alt: "" });
              img.src = still;
              return img;
            })()
          : el("div", { class: "next-still placeholder-still" }),
        el(
          "div",
          { class: "next-info" },
          el("div", { class: "ep-num" }, epCode(e.season, e.number)),
          el("div", { class: "next-title" }, e.title ?? ""),
        ),
        check,
      );
      strip.append(card);
    }
    return el("div", {}, el("div", { class: "strip-label" }, "Continue tracking"), strip);
  }

  function renderContent(): void {
    const progress = lib.progress.get(show.traktId);
    const backdrop = backdropUrl(show.backdrop);

    const back = el("a", { class: "back-link", href: "#/" }, "‹");
    back.addEventListener("click", (e) => {
      e.preventDefault();
      history.length > 1 ? history.back() : (location.hash = "#/");
    });

    const headerBits: string[] = [];
    const seasonCount = episodesRec.seasons.filter((s) => s.number > 0 && s.episodes.length > 0).length;
    if (seasonCount > 0) headerBits.push(`${seasonCount} season${seasonCount === 1 ? "" : "s"}`);
    if (show.year) headerBits.push(String(show.year));
    if (show.network) headerBits.push(show.network);
    if (show.status) headerBits.push(show.status);

    const fill = el("div", { class: "progress-fill" });
    if (progress && progress.aired > 0) {
      fill.style.width = `${Math.round((progress.completed / progress.aired) * 100)}%`;
      if (progress.completed === progress.aired) fill.classList.add("complete"); // all caught up
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
        el("h1", {}, show.title),
        el("div", { class: "meta" }, headerBits.join(" · ") + (progress ? ` · ${progress.completed}/${progress.aired} watched` : "")),
        el("div", { class: "show-progress" }, fill),
      ),
    );

    const seasonsWrap = el("div", {});
    const ordered = [...episodesRec.seasons].sort((a, b) => {
      // specials at the bottom
      if (a.number === 0) return 1;
      if (b.number === 0) return -1;
      return a.number - b.number;
    });

    const renderSeason = (season: SeasonEntry): HTMLElement => {
      const label = season.number === 0 ? "Specials" : `Season ${season.number}`;
      const airedEps = season.episodes.filter((e) => isAired(season.number, e.number));
      const watchedInSeason = airedEps.filter((e) => isWatched(season.number, e.number)).length;
      const complete = airedEps.length > 0 && watchedInSeason === airedEps.length;
      const partial = !complete && watchedInSeason > 0;

      const checkAll = el("button", { class: `check ${complete ? "on" : partial ? "partial" : ""}` }, "✓");
      checkAll.addEventListener("click", (e) => {
        e.stopPropagation();
        void onToggleSeason(season.number);
      });

      const head = el(
        "div",
        { class: "season-head" },
        el("h2", {}, `${label} ${expanded.has(season.number) ? "⌃" : "⌄"}`),
        el("span", { class: "count" }, `${watchedInSeason}/${airedEps.length}`),
        checkAll,
      );
      head.addEventListener("click", () => {
        expanded.has(season.number) ? expanded.delete(season.number) : expanded.add(season.number);
        renderContent();
      });

      const bar = el("div", { class: "season-bar" });
      const barFill = el("div", { class: `progress-fill ${complete ? "complete" : ""}` });
      barFill.style.height = "100%";
      if (airedEps.length > 0) barFill.style.width = `${Math.round((watchedInSeason / airedEps.length) * 100)}%`;
      bar.append(barFill);

      const seasonBox = el("div", { class: "season" }, head, bar);

      if (expanded.has(season.number)) {
        for (const e of season.episodes) {
          const aired = isAired(season.number, e.number);
          const watched = isWatched(season.number, e.number);
          const epKey = `${season.number}:${e.number}`;
          const check = el("button", { class: `check ${watched ? "on" : ""}` }, "✓");
          check.addEventListener("click", (ev) => {
            ev.stopPropagation();
            void onToggleEpisode({ traktId: e.traktId, season: season.number, number: e.number });
          });

          const still = stillUrl(e.still, "w185");
          const countdown = !aired && e.airDate ? daysUntilBadge(e.airDate) : null;
          const row = el(
            "div",
            { class: `episode-row ${aired ? "" : "unaired"}` },
            still
              ? (() => {
                  const img = el("img", { class: "ep-thumb", loading: "lazy", alt: "" });
                  img.src = still;
                  return img;
                })()
              : null,
            el("span", { class: "ep-num" }, epCode(season.number, e.number)),
            el("span", { class: "ep-title" }, e.title ?? ""),
            countdown ?? check,
          );
          if (e.overview || e.airDate) {
            row.classList.add("expandable");
            row.addEventListener("click", () => {
              expandedEpisodes.has(epKey) ? expandedEpisodes.delete(epKey) : expandedEpisodes.add(epKey);
              renderContent();
            });
          }
          seasonBox.append(row);
          if (expandedEpisodes.has(epKey)) {
            const watchedAt = watched ? episodeWatchedAt(lib, show.traktId, season.number, e.number) : null;
            const watchedLine = watchedAt
              ? `Watched ${new Date(watchedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
              : null;
            seasonBox.append(
              el(
                "div",
                { class: "ep-overview" },
                e.airDate || watchedLine
                  ? el("div", { class: "ep-airdate" }, [e.airDate ? `Aired ${e.airDate}` : null, watchedLine].filter(Boolean).join("  ·  "))
                  : null,
                e.overview ?? "No description available.",
              ),
            );
          }
        }
      }
      return seasonBox;
    };

    for (const group of seasonGroups(ordered)) {
      seasonsWrap.append("band" in group ? renderBand(group) : renderSeason(group));
    }

    const tabBar = el("div", { class: "show-tabs" });
    for (const tab of ["about", "episodes"] as const) {
      const b = el("button", { class: `show-tab ${activeTab === tab ? "active" : ""}` }, tab.toUpperCase());
      b.addEventListener("click", () => {
        activeTab = tab;
        renderContent();
      });
      tabBar.append(b);
    }

    if (activeTab === "about") {
      body.replaceChildren(header, tabBar, aboutView());
    } else {
      const strip = continueStrip();
      body.replaceChildren(header, tabBar, ...(strip ? [strip] : []), seasonsWrap);
    }
  }

  renderContent();
}
