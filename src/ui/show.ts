import type { Route } from "../router";
import { dialog, el, spinner, toast } from "./components";
import { addNeverMarkPrevious, getNeverMarkPrevious } from "../data/settings";
import { ensureEpisodes, ensureImages, ensureProgress, loadLibrary, setEpisodesWatched, type EpisodeRef } from "../data/sync";
import type { EpisodesRec, Library, ShowRec } from "../data/model";
import { getShowSummary } from "../api/trakt";
import { backdropUrl } from "../api/tmdb";

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
  const progress0 = lib.progress.get(show.traktId);
  const firstOpen = progress0?.nextEpisode?.season ?? progress0?.seasons.find((s) => s.completed < s.aired)?.number;
  if (firstOpen != null) expanded.add(firstOpen);

  const rerender = (): void => renderContent();

  // ---------- helpers over current lib state ----------

  const isWatched = (season: number, number: number): boolean => {
    const plays = lib.watched.get(show.traktId)?.seasons[season]?.[number] ?? 0;
    return plays > 0;
  };

  const airedSet = (): Map<number, Set<number>> | null => {
    const progress = lib.progress.get(show.traktId);
    if (!progress) return null;
    return new Map(progress.seasons.map((s) => [s.number, new Set(s.episodes.map((e) => e.number))]));
  };

  const isAired = (season: number, number: number): boolean => {
    if (season === 0) return true; // specials: no aired info (excluded from progress) — allow marking
    const aired = airedSet();
    return aired ? (aired.get(season)?.has(number) ?? false) : true;
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
          const check = el("button", { class: `check ${watched ? "on" : ""}` }, "✓");
          check.addEventListener("click", () => void onToggleEpisode({ traktId: e.traktId, season: season.number, number: e.number }));
          seasonBox.append(
            el(
              "div",
              { class: `episode-row ${aired ? "" : "unaired"}` },
              el("span", { class: "ep-num" }, epCode(season.number, e.number)),
              el("span", { class: "ep-title" }, e.title ?? ""),
              check,
            ),
          );
        }
      }
      seasonsWrap.append(seasonBox);
    }

    body.replaceChildren(header, seasonsWrap);
  }

  renderContent();
}
