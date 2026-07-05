/**
 * Reconcile a TV Time exporter JSON file (tvtime-series-*.json) against Trakt:
 * find watched episodes and followed-but-unstarted shows that the Trakt import
 * missed, and push them.
 */

import { el, toast } from "./components";
import { addShowToWatchlist, lookupByTvdb, addEpisodesToHistoryAt, type TraktShow } from "../api/trakt";
import { ensureEpisodes, loadLibrary, syncLibrary } from "../data/sync";
import type { Library, ShowRec } from "../data/model";

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

  const diffs: ShowDiff[] = [];
  let done = 0;
  for (const exp of exportShows) {
    onProgress(`Analyzing ${++done}/${exportShows.length}: ${exp.title}`);

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
    if (!traktShow) {
      diffs.push({ export: exp, traktShow: null, missingEpisodes: watchedInExport, needsWatchlist: followedNotStarted });
      continue;
    }

    const watchedRec = lib.watched.get(traktIdOf(traktShow));
    const missingEpisodes = watchedInExport.filter((e) => !(watchedRec?.seasons[e.season]?.[e.number]));

    const onWatchlist = lib.watchlist.some((w) => w.traktId === traktIdOf(traktShow!));
    const needsWatchlist = followedNotStarted && !onWatchlist && !watchedRec;

    diffs.push({ export: exp, traktShow, missingEpisodes, needsWatchlist });
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

    if (diff.missingEpisodes.length > 0) {
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
      "Checks your TV Time export (tvtime-series-….json from the Chrome exporter) against Trakt and pushes anything the import missed: watched episodes (with their original timestamps) and followed-but-unstarted shows.",
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
      const exportShows = JSON.parse(await file.text()) as ExportShow[];
      status.textContent = "Refreshing Trakt data…";
      await syncLibrary(true);
      const lib = await loadLibrary();
      const diffs = await analyze(lib, exportShows, (m) => (status.textContent = m));

      const unmatched = diffs.filter((d) => !d.traktShow);
      const withMissing = diffs.filter((d) => d.traktShow && d.missingEpisodes.length > 0);
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
