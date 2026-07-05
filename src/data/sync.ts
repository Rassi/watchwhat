/**
 * Sync engine: Trakt is the source of truth, IndexedDB is the cache.
 *
 * - `syncLibrary()` is gated on /sync/last_activities so an app open with no
 *   remote changes costs one API call.
 * - Per-show progress (aired/completed/next episode, computed server-side by
 *   Trakt from air dates) is refreshed lazily: when the show's watched state
 *   changed, or a TTL expired (so newly aired episodes show up).
 * - Mutations update the cache optimistically, then hit Trakt, then re-pull
 *   that show's progress; failures trigger a forced resync.
 */

import * as trakt from "../api/trakt";
import { fetchShowImages } from "../api/tmdb";
import { dbBulkPut, dbClear, dbGet, dbGetAll, dbPut } from "./db";
import type { EpisodesRec, Library, ProgressRec, ShowRec, WatchedRec, WatchlistEntry } from "./model";
import { isAuthenticated } from "./settings";

export const dataEvents = new EventTarget();

function emitChange(): void {
  dataEvents.dispatchEvent(new Event("change"));
}

// ---------- conversions ----------

function toShowRec(show: trakt.TraktShow, existing?: ShowRec): ShowRec {
  return {
    traktId: show.ids.trakt,
    ids: show.ids,
    title: show.title,
    year: show.year,
    status: show.status ?? existing?.status,
    network: show.network ?? existing?.network,
    overview: show.overview ?? existing?.overview,
    airedEpisodes: show.aired_episodes ?? existing?.airedEpisodes,
    poster: existing?.poster,
    backdrop: existing?.backdrop,
    imagesFetchedAt: existing?.imagesFetchedAt,
  };
}

function toWatchedRec(w: trakt.WatchedShow): WatchedRec {
  const seasons: WatchedRec["seasons"] = {};
  for (const s of w.seasons) {
    seasons[s.number] = {};
    for (const e of s.episodes) seasons[s.number][e.number] = e.plays;
  }
  return {
    traktId: w.show.ids.trakt,
    plays: w.plays,
    lastWatchedAt: w.last_watched_at,
    lastUpdatedAt: w.last_updated_at,
    seasons,
  };
}

function toProgressRec(traktId: number, p: trakt.ShowProgress): ProgressRec {
  return {
    traktId,
    fetchedAt: Date.now(),
    aired: p.aired,
    completed: p.completed,
    lastWatchedAt: p.last_watched_at,
    seasons: p.seasons.map((s) => ({
      number: s.number,
      aired: s.aired,
      completed: s.completed,
      episodes: s.episodes.map((e) => ({ number: e.number, completed: e.completed })),
    })),
    nextEpisode: p.next_episode
      ? {
          traktId: p.next_episode.ids.trakt,
          season: p.next_episode.season,
          number: p.next_episode.number,
          title: p.next_episode.title,
          firstAired: p.next_episode.first_aired ?? null,
        }
      : null,
  };
}

// ---------- library load & sync ----------

export async function loadLibrary(): Promise<Library> {
  const [shows, watched, progress, watchlist, hidden] = await Promise.all([
    dbGetAll<ShowRec>("shows"),
    dbGetAll<WatchedRec>("watched"),
    dbGetAll<ProgressRec>("progress"),
    dbGet<WatchlistEntry[]>("meta", "watchlist"),
    dbGet<number[]>("meta", "hidden"),
  ]);
  return {
    shows: new Map(shows.map((s) => [s.traktId, s])),
    watched: new Map(watched.map((w) => [w.traktId, w])),
    progress: new Map(progress.map((p) => [p.traktId, p])),
    watchlist: watchlist ?? [],
    hidden: new Set(hidden ?? []),
  };
}

/** Pull from Trakt if anything changed remotely. Returns true if the cache was updated. */
export async function syncLibrary(force = false): Promise<boolean> {
  if (!isAuthenticated()) return false;

  const acts = await trakt.getLastActivities();
  const prev = await dbGet<trakt.LastActivities>("meta", "lastActivities");
  const changed =
    force ||
    !prev ||
    prev.episodes.watched_at !== acts.episodes.watched_at ||
    prev.watchlist.updated_at !== acts.watchlist.updated_at ||
    prev.shows.hidden_at !== acts.shows.hidden_at;

  if (!changed) return false;

  const [watchedShows, watchlistItems, hiddenShows] = await Promise.all([
    trakt.getWatchedShows(),
    trakt.getWatchlistShows(),
    trakt.getHiddenShows(),
  ]);

  const existingShows = new Map((await dbGetAll<ShowRec>("shows")).map((s) => [s.traktId, s]));

  const showEntries: [number, ShowRec][] = [];
  const allShows = [
    ...watchedShows.map((w) => w.show),
    ...watchlistItems.map((i) => i.show),
    ...hiddenShows,
  ];
  for (const show of allShows) {
    showEntries.push([show.ids.trakt, toShowRec(show, existingShows.get(show.ids.trakt))]);
  }

  await dbClear("watched");
  await Promise.all([
    dbBulkPut("shows", showEntries),
    dbBulkPut("watched", watchedShows.map((w) => [w.show.ids.trakt, toWatchedRec(w)] as [number, WatchedRec])),
    dbPut("meta", "watchlist", watchlistItems.map((i): WatchlistEntry => ({ traktId: i.show.ids.trakt, listedAt: i.listed_at }))),
    dbPut("meta", "hidden", hiddenShows.map((s) => s.ids.trakt)),
    dbPut("meta", "lastActivities", acts),
  ]);

  emitChange();
  return true;
}

// ---------- lazy per-show data ----------

function progressTtlMs(show: ShowRec | undefined): number {
  const ended = show?.status === "ended" || show?.status === "canceled";
  return ended ? 7 * 24 * 3600 * 1000 : 12 * 3600 * 1000;
}

function progressIsStale(lib: Library, traktId: number): boolean {
  const progress = lib.progress.get(traktId);
  if (!progress) return true;
  const watched = lib.watched.get(traktId);
  if (watched && watched.lastWatchedAt !== progress.lastWatchedAt) return true;
  return Date.now() - progress.fetchedAt > progressTtlMs(lib.shows.get(traktId));
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Ensure progress records exist and are fresh for the given shows.
 * Fetches in the background with limited concurrency; `onUpdate` fires after
 * each batch of updates so the UI can re-render progressively.
 */
export async function ensureProgress(lib: Library, traktIds: number[], onUpdate?: () => void): Promise<void> {
  const stale = traktIds.filter((id) => progressIsStale(lib, id));
  if (stale.length === 0) return;

  let pendingNotify = 0;
  await mapWithConcurrency(stale, 4, async (traktId) => {
    try {
      const rec = toProgressRec(traktId, await trakt.getShowProgress(traktId));
      lib.progress.set(traktId, rec);
      await dbPut("progress", traktId, rec);
      if (++pendingNotify >= 5) {
        pendingNotify = 0;
        onUpdate?.();
      }
    } catch {
      // Leave stale/missing; next render tries again.
    }
  });
  if (pendingNotify > 0) onUpdate?.();
}

/** Ensure TMDB artwork paths for the given shows (30-day TTL). */
export async function ensureImages(lib: Library, traktIds: number[], onUpdate?: () => void): Promise<void> {
  const maxAge = 30 * 24 * 3600 * 1000;
  const missing = traktIds.filter((id) => {
    const show = lib.shows.get(id);
    if (!show || !show.ids.tmdb) return false;
    return show.imagesFetchedAt == null || (show.poster == null && Date.now() - show.imagesFetchedAt > maxAge);
  });
  if (missing.length === 0) return;

  let pendingNotify = 0;
  await mapWithConcurrency(missing, 4, async (traktId) => {
    const show = lib.shows.get(traktId)!;
    const images = await fetchShowImages(show.ids.tmdb!);
    if (!images) return; // no key / transient failure
    show.poster = images.poster;
    show.backdrop = images.backdrop;
    show.imagesFetchedAt = Date.now();
    await dbPut("shows", traktId, show);
    if (++pendingNotify >= 8) {
      pendingNotify = 0;
      onUpdate?.();
    }
  });
  if (pendingNotify > 0) onUpdate?.();
}

/** Episode titles/ids for the show page (24h TTL for airing shows, 7d for ended). */
export async function ensureEpisodes(show: ShowRec): Promise<EpisodesRec> {
  const cached = await dbGet<EpisodesRec>("episodes", show.traktId);
  const ttl = progressTtlMs(show) * 2;
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached;

  try {
    const seasons = await trakt.getSeasons(show.traktId);
    const rec: EpisodesRec = {
      traktId: show.traktId,
      fetchedAt: Date.now(),
      seasons: seasons.map((s) => ({
        number: s.number,
        episodes: s.episodes.map((e) => ({
          traktId: e.ids.trakt,
          season: e.season,
          number: e.number,
          title: e.title,
        })),
      })),
    };
    await dbPut("episodes", show.traktId, rec);
    return rec;
  } catch (e) {
    if (cached) return cached; // offline — serve stale
    throw e;
  }
}

// ---------- mutations ----------

export interface EpisodeRef {
  traktId: number;
  season: number;
  number: number;
}

function applyLocalWatch(lib: Library, showTraktId: number, episodes: EpisodeRef[], watched: boolean): void {
  const nowIso = new Date().toISOString();

  let watchedRec = lib.watched.get(showTraktId);
  if (!watchedRec && watched) {
    watchedRec = { traktId: showTraktId, plays: 0, lastWatchedAt: nowIso, lastUpdatedAt: nowIso, seasons: {} };
    lib.watched.set(showTraktId, watchedRec);
  }
  const progress = lib.progress.get(showTraktId);

  for (const ep of episodes) {
    if (watchedRec) {
      const season = (watchedRec.seasons[ep.season] ??= {});
      if (watched) {
        season[ep.number] = (season[ep.number] ?? 0) + 1;
        watchedRec.plays++;
        watchedRec.lastWatchedAt = nowIso;
      } else if (season[ep.number]) {
        watchedRec.plays = Math.max(0, watchedRec.plays - season[ep.number]);
        delete season[ep.number];
      }
    }
    if (progress && ep.season > 0) {
      const season = progress.seasons.find((s) => s.number === ep.season);
      const entry = season?.episodes.find((e) => e.number === ep.number);
      if (season && entry && entry.completed !== watched) {
        entry.completed = watched;
        season.completed += watched ? 1 : -1;
        progress.completed += watched ? 1 : -1;
      }
    }
  }
  if (progress) {
    progress.lastWatchedAt = watchedRec?.lastWatchedAt ?? progress.lastWatchedAt;
    progress.nextEpisode = null; // unknown until refetch; UI falls back gracefully
  }
}

async function persistShowState(lib: Library, showTraktId: number): Promise<void> {
  const watched = lib.watched.get(showTraktId);
  const progress = lib.progress.get(showTraktId);
  await Promise.all([
    watched ? dbPut("watched", showTraktId, watched) : Promise.resolve(),
    progress ? dbPut("progress", showTraktId, progress) : Promise.resolve(),
  ]);
}

/**
 * Mark/unmark episodes: optimistic cache update, Trakt write, then a fresh
 * progress pull for the show (correct aired counts + next episode).
 */
export async function setEpisodesWatched(
  lib: Library,
  showTraktId: number,
  episodes: EpisodeRef[],
  watched: boolean,
): Promise<void> {
  applyLocalWatch(lib, showTraktId, episodes, watched);
  await persistShowState(lib, showTraktId);
  emitChange();

  try {
    const ids = episodes.map((e) => e.traktId);
    if (watched) await trakt.addEpisodesToHistory(ids);
    else await trakt.removeEpisodesFromHistory(ids);
  } catch (e) {
    // Server rejected — rebuild cache from Trakt so we don't drift.
    await syncLibrary(true).catch(() => {});
    throw e;
  }

  try {
    const rec = toProgressRec(showTraktId, await trakt.getShowProgress(showTraktId));
    lib.progress.set(showTraktId, rec);
    // Keep watched/progress lastWatchedAt consistent to avoid an immediate re-fetch.
    const watchedRec = lib.watched.get(showTraktId);
    if (watchedRec && rec.lastWatchedAt) watchedRec.lastWatchedAt = rec.lastWatchedAt;
    await persistShowState(lib, showTraktId);
    // Adopt the new server state as our baseline so the next app open doesn't full-resync.
    const acts = await trakt.getLastActivities();
    await dbPut("meta", "lastActivities", acts);
    const remoteWatched = (await trakt.getWatchedShows()).find((w) => w.show.ids.trakt === showTraktId);
    if (remoteWatched) await dbPut("watched", showTraktId, toWatchedRec(remoteWatched));
    emitChange();
  } catch {
    // Refresh failed; cache is optimistic but close enough. Next sync fixes it.
  }
}

export async function addToWatchlist(lib: Library, show: trakt.TraktShow): Promise<void> {
  await trakt.addShowToWatchlist(show.ids);
  const rec = toShowRec(show, lib.shows.get(show.ids.trakt));
  lib.shows.set(rec.traktId, rec);
  lib.watchlist = [{ traktId: rec.traktId, listedAt: new Date().toISOString() }, ...lib.watchlist];
  await Promise.all([
    dbPut("shows", rec.traktId, rec),
    dbPut("meta", "watchlist", lib.watchlist),
    dbPut("meta", "lastActivities", await trakt.getLastActivities()),
  ]);
  emitChange();
}

export async function removeFromWatchlist(lib: Library, showTraktId: number): Promise<void> {
  const show = lib.shows.get(showTraktId);
  if (!show) return;
  await trakt.removeShowFromWatchlist(show.ids);
  lib.watchlist = lib.watchlist.filter((e) => e.traktId !== showTraktId);
  await Promise.all([
    dbPut("meta", "watchlist", lib.watchlist),
    dbPut("meta", "lastActivities", await trakt.getLastActivities()),
  ]);
  emitChange();
}
