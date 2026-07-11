/**
 * Reconcile a TV Time exporter JSON file (tvtime-series-*.json) against Trakt:
 * find watched episodes and followed-but-unstarted shows that the Trakt import
 * missed, and push them.
 */

import { el, toast } from "./components";
import {
  addShowToWatchlist,
  lookupByTvdb,
  addEpisodesToHistoryAt,
  lookupMovieByImdb,
  addMoviesToHistoryAt,
  addMoviesToWatchlist,
  type TraktIds,
  type TraktShow,
} from "../api/trakt";
import { ensureEpisodes, ensureProgress, isEpisodeWatched, loadLibrary, loadMovies, syncLibrary, syncMovies } from "../data/sync";
import { dbPut } from "../data/db";
import type { Library, MovieRec, ShowRec } from "../data/model";

interface ExportEpisode {
  number: number;
  is_watched: boolean;
  watched_at: string | null;
}

interface ExportShow {
  id: { tvdb: number | null };
  title: string;
  status: string; // up_to_date | continuing | not_started_yet | watch_later | stopped
  seasons: { number: number; is_specials: boolean; episodes: ExportEpisode[] }[];
}

interface MissingEpisode {
  season: number;
  number: number;
  watchedAt: string | null;
}

interface ShowDiff {
  export: ExportShow;
  traktShow: TraktShow | ShowRec | null;
  missingEpisodes: MissingEpisode[];
  needsWatchlist: boolean;
  /** Progress could not be fetched — skip pushing episodes to avoid duplicates. */
  unverified?: boolean;
}

/** "2019-12-12 20:02:22" (UTC, no zone marker) -> ISO 8601 */
function toIso(watchedAt: string | null): string | undefined {
  if (!watchedAt) return undefined;
  return watchedAt.includes("T") ? watchedAt : watchedAt.replace(" ", "T") + "Z";
}

function traktIdOf(show: TraktShow | ShowRec): number {
  return "traktId" in show ? show.traktId : show.ids.trakt;
}

async function analyze(lib: Library, exportShows: ExportShow[], onProgress: (msg: string) => void): Promise<ShowDiff[]> {
  const byTvdb = new Map<number, ShowRec>();
  for (const show of lib.shows.values()) {
    if (show.ids.tvdb) byTvdb.set(show.ids.tvdb, show);
  }

  // Pass 1: match every export show to a Trakt show.
  const matched: { exp: ExportShow; traktShow: TraktShow | ShowRec | null; watchedInExport: MissingEpisode[]; followedNotStarted: boolean }[] = [];
  let done = 0;
  for (const exp of exportShows) {
    onProgress(`Matching ${++done}/${exportShows.length}: ${exp.title}`);

    const watchedInExport: MissingEpisode[] = exp.seasons.flatMap((s) =>
      s.episodes.filter((e) => e.is_watched).map((e) => ({ season: s.number, number: e.number, watchedAt: e.watched_at })),
    );
    const followedNotStarted =
      (exp.status === "not_started_yet" || exp.status === "watch_later") && watchedInExport.length === 0;

    let traktShow: TraktShow | ShowRec | null = byTvdb.get(exp.id.tvdb!) ?? null;
    if (!traktShow) {
      // Not in the local library — look it up on Trakt (also catches shows the import missed entirely).
      try {
        traktShow = await lookupByTvdb(exp.id.tvdb!);
      } catch {
        traktShow = null;
      }
    }
    matched.push({ exp, traktShow, watchedInExport, followedNotStarted });
  }

  // Pass 2: per-episode watched state lives in the progress endpoint — fetch it
  // for every matched show that has watched episodes in the export.
  const needProgress = matched
    .filter((m) => m.traktShow && m.watchedInExport.length > 0)
    .map((m) => traktIdOf(m.traktShow!));
  let fetched = 0;
  onProgress(`Fetching progress for ${needProgress.length} shows…`);
  await ensureProgress(lib, needProgress, () => onProgress(`Fetching progress… ${Math.min((fetched += 5), needProgress.length)}/${needProgress.length}`));

  // Pass 3: diff.
  const diffs: ShowDiff[] = [];
  for (const { exp, traktShow, watchedInExport, followedNotStarted } of matched) {
    if (!traktShow) {
      diffs.push({ export: exp, traktShow: null, missingEpisodes: watchedInExport, needsWatchlist: followedNotStarted });
      continue;
    }
    const traktId = traktIdOf(traktShow);

    const hasProgress = lib.progress.has(traktId);
    const missingEpisodes = hasProgress
      ? watchedInExport.filter((e) => !isEpisodeWatched(lib, traktId, e.season, e.number))
      : watchedInExport;

    const onWatchlist = lib.watchlist.some((w) => w.traktId === traktId);
    const needsWatchlist = followedNotStarted && !onWatchlist && !lib.watched.has(traktId);

    diffs.push({
      export: exp,
      traktShow,
      missingEpisodes,
      needsWatchlist,
      unverified: watchedInExport.length > 0 && !hasProgress,
    });
  }
  return diffs;
}

async function push(lib: Library, diffs: ShowDiff[], onProgress: (msg: string) => void): Promise<{ episodes: number; listed: number; failed: string[] }> {
  let episodes = 0;
  let listed = 0;
  const failed: string[] = [];

  for (const diff of diffs) {
    if (!diff.traktShow) continue;
    const traktId = traktIdOf(diff.traktShow);

    if (diff.unverified) {
      failed.push(`"${diff.export.title}": progress unavailable — episodes skipped to avoid duplicates`);
    } else if (diff.missingEpisodes.length > 0) {
      onProgress(`Pushing ${diff.missingEpisodes.length} episodes of "${diff.export.title}"…`);
      try {
        const show: ShowRec =
          lib.shows.get(traktId) ?? { traktId, ids: diff.traktShow.ids, title: diff.export.title, year: null };
        const episodesRec = await ensureEpisodes(show);
        const bySeasonEp = new Map<string, number>();
        for (const s of episodesRec.seasons) {
          for (const e of s.episodes) bySeasonEp.set(`${s.number}:${e.number}`, e.traktId);
        }
        const items: { traktId: number; watchedAt?: string }[] = [];
        const unmapped: MissingEpisode[] = [];
        for (const me of diff.missingEpisodes) {
          const epTraktId = bySeasonEp.get(`${me.season}:${me.number}`);
          if (epTraktId) items.push({ traktId: epTraktId, watchedAt: toIso(me.watchedAt) });
          else unmapped.push(me);
        }
        if (items.length > 0) {
          await addEpisodesToHistoryAt(items);
          episodes += items.length;
        }
        if (unmapped.length > 0) {
          failed.push(`"${diff.export.title}": ${unmapped.length} episodes not found on Trakt (numbering mismatch)`);
        }
      } catch {
        failed.push(`"${diff.export.title}": pushing episodes failed`);
      }
    }

    if (diff.needsWatchlist) {
      onProgress(`Adding "${diff.export.title}" to watchlist…`);
      try {
        await addShowToWatchlist(diff.traktShow.ids);
        listed++;
      } catch {
        failed.push(`"${diff.export.title}": adding to watchlist failed`);
      }
    }
  }
  return { episodes, listed, failed };
}

// ---------- movies ----------

interface ExportMovie {
  id: { imdb: string | null };
  created_at: string;
  title: string;
  year: number | null;
  watched_at: string | null;
  is_watched: boolean;
}

interface MovieDiff {
  export: ExportMovie;
  traktIds: TraktIds | null;
  missingWatched: boolean;
  needsWatchlist: boolean;
}

async function analyzeMovies(
  movies: Map<number, MovieRec>,
  exportMovies: ExportMovie[],
  onProgress: (msg: string) => void,
): Promise<MovieDiff[]> {
  const byImdb = new Map<string, MovieRec>();
  for (const movie of movies.values()) {
    if (movie.ids.imdb) byImdb.set(movie.ids.imdb, movie);
  }

  const diffs: MovieDiff[] = [];
  let done = 0;
  for (const exp of exportMovies) {
    onProgress(`Matching ${++done}/${exportMovies.length}: ${exp.title}`);
    let rec = exp.id.imdb ? (byImdb.get(exp.id.imdb) ?? null) : null;
    let traktIds = rec?.ids ?? null;
    if (!rec && exp.id.imdb) {
      // Not in the local library — the import may have missed it entirely.
      try {
        traktIds = (await lookupMovieByImdb(exp.id.imdb))?.ids ?? null;
      } catch {
        traktIds = null;
      }
    }
    diffs.push({
      export: exp,
      traktIds,
      missingWatched: exp.is_watched && (rec?.plays ?? 0) === 0,
      needsWatchlist: !exp.is_watched && !(rec?.onWatchlist ?? false) && (rec?.plays ?? 0) === 0,
    });
  }
  return diffs;
}

/** Store TV Time added dates on matching movie records (drives watchlist ordering). */
async function applyTvtimeAddedDates(exportMovies: ExportMovie[]): Promise<number> {
  const movies = await loadMovies();
  const byImdb = new Map(exportMovies.filter((m) => m.id.imdb).map((m) => [m.id.imdb!, m.created_at]));
  let applied = 0;
  for (const movie of movies.values()) {
    const addedAt = movie.ids.imdb ? byImdb.get(movie.ids.imdb) : undefined;
    if (addedAt && movie.tvtimeAddedAt !== addedAt) {
      movie.tvtimeAddedAt = addedAt;
      await dbPut("movies", movie.traktId, movie);
      applied++;
    }
  }
  return applied;
}

function movieReconcileReport(
  status: HTMLElement,
  report: HTMLElement,
  movies: Map<number, MovieRec>,
  diffs: MovieDiff[],
  exportMovies: ExportMovie[],
): void {
  const unmatched = diffs.filter((d) => !d.traktIds);
  const missingWatched = diffs.filter((d) => d.traktIds && d.missingWatched);
  const needList = diffs.filter((d) => d.traktIds && d.needsWatchlist);

  status.textContent = "";
  const lines: HTMLElement[] = [
    el("p", {}, `✔ ${diffs.length} movies in export, ${diffs.length - unmatched.length} matched on Trakt.`),
    el(
      "p",
      {},
      missingWatched.length === 0
        ? "✔ No missing watched movies — Trakt has your full movie history."
        : `⚠ ${missingWatched.length} watched movies missing on Trakt.`,
    ),
    el(
      "p",
      {},
      needList.length === 0
        ? "✔ All unwatched movies are on your movie watchlist."
        : `⚠ ${needList.length} movies missing from the watchlist.`,
    ),
  ];
  for (const d of missingWatched.slice(0, 30)) lines.push(el("p", {}, ` · ${d.export.title} (${d.export.year ?? "?"})`));
  for (const d of unmatched) lines.push(el("p", {}, `✖ Not found on Trakt: ${d.export.title} (${d.export.id.imdb ?? "no imdb id"})`));
  report.replaceChildren(...lines);

  if (missingWatched.length > 0 || needList.length > 0) {
    const pushBtn = el(
      "button",
      { class: "btn primary" },
      `Push ${missingWatched.length} watched + ${needList.length} watchlist movies to Trakt`,
    );
    pushBtn.addEventListener("click", async () => {
      pushBtn.disabled = true;
      try {
        if (missingWatched.length > 0) {
          status.textContent = `Pushing ${missingWatched.length} watched movies…`;
          await addMoviesToHistoryAt(
            missingWatched.map((d) => ({ ids: d.traktIds!, watchedAt: d.export.watched_at ?? undefined })),
          );
        }
        if (needList.length > 0) {
          status.textContent = `Adding ${needList.length} movies to the watchlist…`;
          await addMoviesToWatchlist(needList.map((d) => d.traktIds!));
        }
        status.textContent = "Refreshing from Trakt…";
        await syncMovies(true);
        const applied = await applyTvtimeAddedDates(exportMovies);
        status.textContent = "";
        report.replaceChildren(
          el("p", {}, `Done: ${missingWatched.length} watched movies and ${needList.length} watchlist items pushed.`),
          el("p", {}, `TV Time added-dates stored for ${applied} movies (used for watchlist ordering).`),
        );
        toast("Movie reconcile complete");
      } catch (e) {
        status.textContent = "";
        toast(e instanceof Error ? e.message : "Push failed", "error");
        pushBtn.disabled = false;
      }
    });
    report.append(pushBtn);
  } else {
    void movies;
  }
}

export function reconcileCard(): HTMLElement {
  const fileInput = el("input", { type: "file", accept: ".json,application/json" });
  const analyzeBtn = el("button", { class: "btn primary" }, "Analyze");
  const status = el("p", {});
  const report = el("div", {});
  const card = el(
    "div",
    { class: "card" },
    el("h2", {}, "TV Time reconcile"),
    el(
      "p",
      {},
      "Checks a TV Time export (tvtime-series-….json or tvtime-movies-….json from the Chrome exporter) against Trakt and pushes anything the import missed — watched items keep their original timestamps. The movies file also restores TV Time's added-dates for watchlist ordering.",
    ),
    el("div", { class: "field" }, fileInput),
    analyzeBtn,
    status,
    report,
  );

  analyzeBtn.addEventListener("click", async () => {
    const file = fileInput.files?.[0];
    if (!file) {
      toast("Choose the tvtime-series JSON file first", "error");
      return;
    }
    analyzeBtn.disabled = true;
    report.replaceChildren();
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>[];
      const first = parsed[0];

      if (first && "is_watched" in first && !("seasons" in first)) {
        // Movies export
        const exportMovies = parsed as unknown as ExportMovie[];
        status.textContent = "Refreshing movies from Trakt…";
        await syncMovies(true);
        const movies = await loadMovies();
        const diffs = await analyzeMovies(movies, exportMovies, (m) => (status.textContent = m));
        const applied = await applyTvtimeAddedDates(exportMovies);
        movieReconcileReport(status, report, movies, diffs, exportMovies);
        report.prepend(el("p", {}, `✔ TV Time added-dates stored for ${applied} movies.`));
        analyzeBtn.disabled = false;
        return;
      }

      const exportShows = parsed as unknown as ExportShow[];
      status.textContent = "Refreshing Trakt data…";
      await syncLibrary(true);
      const lib = await loadLibrary();
      const diffs = await analyze(lib, exportShows, (m) => (status.textContent = m));

      const unmatched = diffs.filter((d) => !d.traktShow);
      const unverified = diffs.filter((d) => d.traktShow && d.unverified);
      const withMissing = diffs.filter((d) => d.traktShow && !d.unverified && d.missingEpisodes.length > 0);
      const needList = diffs.filter((d) => d.traktShow && d.needsWatchlist);
      const totalMissing = withMissing.reduce((n, d) => n + d.missingEpisodes.length, 0);

      status.textContent = "";
      const lines: HTMLElement[] = [
        el("p", {}, `✔ ${diffs.length} shows in export, ${diffs.length - unmatched.length} matched on Trakt.`),
        el("p", {}, totalMissing === 0 ? "✔ No missing watched episodes — Trakt has your full history." : `⚠ ${totalMissing} watched episodes missing on Trakt across ${withMissing.length} shows:`),
      ];
      for (const d of withMissing.slice(0, 30)) {
        lines.push(el("p", {}, ` · ${d.export.title}: ${d.missingEpisodes.length} episodes`));
      }
      lines.push(el("p", {}, needList.length === 0 ? "✔ All unstarted followed shows are on your watchlist." : `⚠ ${needList.length} followed shows missing from the watchlist.`));
      for (const d of unverified) {
        lines.push(el("p", {}, `? Could not verify ${d.export.title} (progress fetch failed) — run Analyze again`));
      }
      for (const d of unmatched) {
        lines.push(el("p", {}, `✖ Not found on Trakt: ${d.export.title} (tvdb ${d.export.id.tvdb})`));
      }
      report.replaceChildren(...lines);

      if (totalMissing > 0 || needList.length > 0) {
        const pushBtn = el("button", { class: "btn primary" }, `Push ${totalMissing} episodes + ${needList.length} watchlist items to Trakt`);
        pushBtn.addEventListener("click", async () => {
          pushBtn.disabled = true;
          const result = await push(lib, diffs, (m) => (status.textContent = m));
          status.textContent = "";
          report.replaceChildren(
            el("p", {}, `Done: ${result.episodes} episodes and ${result.listed} watchlist items pushed.`),
            ...result.failed.map((f) => el("p", {}, `✖ ${f}`)),
          );
          await syncLibrary(true).catch(() => {});
          toast("Reconcile complete");
        });
        report.append(pushBtn);
      }
    } catch (e) {
      status.textContent = "";
      toast(e instanceof Error ? e.message : "Could not read that file", "error");
    }
    analyzeBtn.disabled = false;
  });

  return card;
}
