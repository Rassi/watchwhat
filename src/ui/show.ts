import type { Route } from "../router";
import { dialog, el, spinner, toast } from "./components";
import { addNeverMarkPrevious, getNeverMarkPrevious } from "../data/settings";
import {
  addToWatchlist,
  ensureEpisodes,
  ensureImages,
  ensureProgress,
  isEpisodeWatched,
  loadLibrary,
  refreshShowSummary,
  removeFromWatchlist,
  setEpisodesWatched,
  type EpisodeRef,
} from "../data/sync";
import type { EpisodeInfo, EpisodesRec, Library, ShowRec } from "../data/model";
import { getShowSummary } from "../api/trakt";
import { backdropUrl, posterUrl, stillUrl } from "../api/tmdb";

function epCode(season: number, number: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `S${pad(season)} | E${pad(number)}`;
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
        // Deep link to a show we haven't cached (e.g. from search).
        const summary = await getShowSummary(traktId);
        show = {
          traktId,
          ids: summary.ids,
          title: summary.title,
          year: summary.year,
          status: summary.status,
          network: summary.network,
          overview: summary.overview,
          airedEpisodes: summary.aired_episodes,
        };
        lib.shows.set(traktId, show);
      }
      await ensureImages(lib, [traktId]);
      const [episodesRec] = await Promise.all([ensureEpisodes(show), ensureProgress(lib, [traktId])]);
      renderPage(body, lib, show, episodesRec);
    } catch (e) {
      body.replaceChildren(
        el("div", { class: "empty-note" }, e instanceof Error ? e.message : "Could not load this show."),
      );
    }
  },
};

function renderPage(body: HTMLElement, lib: Library, show: ShowRec, episodesRec: EpisodesRec): void {
  const expanded = new Set<number>();
  const expandedEpisodes = new Set<string>(); // "season:number" rows showing their description
  let activeTab: "about" | "episodes" = "episodes";
  let ratingsSeason =
    episodesRec.seasons.find((s) => s.number > 0 && s.episodes.some((e) => (e.rating ?? 0) > 0))?.number ?? 1;

  // Older cached shows may predate the metadata fields — backfill once.
  if (show.genres === undefined || !show.overview) {
    void refreshShowSummary(lib, show.traktId).then((rec) => {
      if (rec) {
        show = rec;
        renderContent();
      }
    });
  }
  const progress0 = lib.progress.get(show.traktId);
  const firstOpen = progress0?.nextEpisode?.season ?? progress0?.seasons.find((s) => s.completed < s.aired)?.number;
  if (firstOpen != null) expanded.add(firstOpen);

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
    try {
      await setEpisodesWatched(lib, show.traktId, episodes, watched);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed — Trakt rejected the change", "error");
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
      const choice = await dialog(
        `Mark Season ${seasonNumber} as watched?`,
        `${unwatched.length} episode${unwatched.length === 1 ? "" : "s"} will be marked as watched.`,
        [
          { label: "Mark watched", value: "yes", kind: "primary" },
          { label: "Cancel", value: "no" },
        ],
      );
      if (choice !== "yes") return;
      await mutate(
        unwatched.map((e) => ({ traktId: e.traktId, season: seasonNumber, number: e.number })),
        true,
      );
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

  // ---------- rendering ----------

  /** Next unwatched aired episodes, in watch order (for the Continue tracking strip). */
  const nextUnwatched = (limit: number): EpisodeInfo[] => {
    const out: EpisodeInfo[] = [];
    for (const s of episodesRec.seasons) {
      if (s.number === 0) continue;
      for (const e of s.episodes) {
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
    const season = ratedSeasons.find((s) => s.number === ratingsSeason)!;
    const points = season.episodes.filter((e) => (e.rating ?? 0) > 0);

    const W = 640;
    const H = 200;
    const padLeft = 30;
    const padBottom = 24;
    const padTop = 12;
    const plotW = W - padLeft - 10;
    const plotH = H - padTop - padBottom;
    const x = (i: number) => padLeft + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const y = (rating: number) => padTop + (1 - rating / 10) * plotH;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "ratings-svg");
    const add = (tag: string, attrs: Record<string, string>, text?: string) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      if (text) node.textContent = text;
      svg.append(node);
      return node;
    };
    for (const grid of [2, 4, 6, 8, 10]) {
      add("line", { x1: String(padLeft), y1: String(y(grid)), x2: String(W - 10), y2: String(y(grid)), class: "grid" });
      add("text", { x: String(padLeft - 6), y: String(y(grid) + 3), "text-anchor": "end", class: "axis" }, String(grid));
    }
    if (points.length > 1) {
      add("polyline", {
        points: points.map((e, i) => `${x(i)},${y(e.rating!)}`).join(" "),
        class: "rating-line",
      });
    }
    points.forEach((e, i) => {
      add("circle", { cx: String(x(i)), cy: String(y(e.rating!)), r: "3.5", class: "rating-dot" });
      add("text", { x: String(x(i)), y: String(H - 8), "text-anchor": "middle", class: "axis" }, String(e.number));
    });

    const select = el("select", { class: "season-select" });
    for (const s of ratedSeasons) {
      const opt = el("option", { value: String(s.number) }, `Season ${s.number}`);
      if (s.number === ratingsSeason) opt.setAttribute("selected", "");
      select.append(opt);
    }
    select.addEventListener("change", () => {
      ratingsSeason = Number(select.value);
      renderContent();
    });

    return el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("h2", {}, "Episode ratings"), select),
      svg,
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

    wrap.append(
      el(
        "div",
        { class: "card" },
        el("h2", {}, "Show info"),
        el("p", { class: "about-meta" }, meta.join(" • ")),
        show.rating ? el("p", { class: "about-rating" }, `★ ${show.rating.toFixed(1)}/10`) : null,
        el("p", { class: "about-overview" }, show.overview || "No description available."),
        el("p", { class: "about-facts" }, facts.join("  ·  ")),
      ),
    );

    // Cast
    if (episodesRec.cast?.length) {
      const strip = el("div", { class: "cast-strip" });
      for (const member of episodesRec.cast) {
        const photo = posterUrl(member.profile, "w185");
        strip.append(
          el(
            "div",
            { class: "cast-card" },
            photo
              ? (() => {
                  const img = el("img", { loading: "lazy", alt: member.name });
                  img.src = photo;
                  return img;
                })()
              : el("div", { class: "cast-photo-placeholder" }, member.name[0] ?? "?"),
            el("div", { class: "cast-name" }, member.name),
            el("div", { class: "cast-role" }, member.character ?? ""),
          ),
        );
      }
      wrap.append(el("div", { class: "card" }, el("h2", {}, "Cast"), strip));
    }

    const chart = ratingsChart();
    if (chart) wrap.append(chart);

    // Watchlist membership
    const onList = lib.watchlist.some((e) => e.traktId === show.traktId);
    const started = (lib.watched.get(show.traktId)?.plays ?? 0) > 0;
    if (onList || !started) {
      const btn = el("button", { class: `btn ${onList ? "danger" : "primary"}` }, onList ? "Remove from watchlist" : "Add to watchlist");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          if (onList) {
            await removeFromWatchlist(lib, show.traktId);
            toast(`Removed "${show.title}" from your watchlist`);
          } else {
            await addToWatchlist(lib, { title: show.title, year: show.year, ids: show.ids });
            toast(`Added "${show.title}" to your watchlist`);
          }
        } catch (e) {
          toast(e instanceof Error ? e.message : "Update failed", "error");
        }
        renderContent();
      });
      wrap.append(el("div", { class: "card" }, btn));
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
    if (show.year) headerBits.push(String(show.year));
    if (show.network) headerBits.push(show.network);
    if (show.status) headerBits.push(show.status);

    const fill = el("div", { class: "progress-fill" });
    if (progress && progress.aired > 0) fill.style.width = `${Math.round((progress.completed / progress.aired) * 100)}%`;

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

    for (const season of ordered) {
      if (season.episodes.length === 0) continue;
      const label = season.number === 0 ? "Specials" : `Season ${season.number}`;
      const airedEps = season.episodes.filter((e) => isAired(season.number, e.number));
      const watchedInSeason = airedEps.filter((e) => isWatched(season.number, e.number)).length;
      const complete = airedEps.length > 0 && watchedInSeason === airedEps.length;

      const checkAll = el("button", { class: `check ${complete ? "on" : ""}` }, "✓");
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
      const barFill = el("div", { class: "progress-fill" });
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
            check,
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
            seasonBox.append(
              el(
                "div",
                { class: "ep-overview" },
                e.airDate ? el("div", { class: "ep-airdate" }, `Aired ${e.airDate}`) : null,
                e.overview ?? "No description available.",
              ),
            );
          }
        }
      }
      seasonsWrap.append(seasonBox);
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
