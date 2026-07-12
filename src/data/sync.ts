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
import { fetchMovieExtras, fetchShowExtras, fetchShowImages } from "../api/tmdb";
import { dbBulkPut, dbClear, dbGet, dbGetAll, dbPut } from "./db";
import type { EpisodesRec, Library, MovieRec, ProgressRec, ShowRec, WatchedRec, WatchlistEntry } from "./model";
import { getSettings, isAuthenticated } from "./settings";

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
    // `||` not `??`: Trakt sometimes returns "" — don't clobber a TMDB-sourced overview
    overview: show.overview || existing?.overview,
    airedEpisodes: show.aired_episodes ?? existing?.airedEpisodes,
    genres: show.genres ?? existing?.genres,
    runtime: show.runtime ?? existing?.runtime,
    airs: show.airs ? { day: show.airs.day, time: show.airs.time } : existing?.airs,
    rating: show.rating ?? existing?.rating,
    firstAired: show.first_aired ?? existing?.firstAired,
    trailer: show.trailer !== undefined ? show.trailer : existing?.trailer,
    poster: existing?.poster,
    backdrop: existing?.backdrop,
    imagesFetchedAt: existing?.imagesFetchedAt,
  };
}

function toWatchedRec(w: trakt.WatchedShow): WatchedRec {
  return {
    traktId: w.show.ids.trakt,
    plays: w.plays,
    lastWatchedAt: w.last_watched_at,
    lastUpdatedAt: w.last_updated_at,
  };
}

function toProgressRec(traktId: number, p: trakt.ShowProgress): ProgressRec {
  // Recompute totals over regular seasons — Trakt counts specials in its
  // totals whenever specials are included in the response.
  const regular = p.seasons.filter((s) => s.number > 0);
  const nextEp = p.next_episode && p.next_episode.season > 0 ? p.next_episode : null;
  return {
    traktId,
    fetchedAt: Date.now(),
    aired: regular.reduce((n, s) => n + s.aired, 0),
    completed: regular.reduce((n, s) => n + s.completed, 0),
    lastWatchedAt: p.last_watched_at,
    seasons: p.seasons.map((s) => ({
      number: s.number,
      aired: s.aired,
      completed: s.completed,
      episodes: s.episodes.map((e) => ({ number: e.number, completed: e.completed, watchedAt: e.last_watched_at ?? null })),
    })),
    nextEpisode: nextEp
      ? {
          traktId: nextEp.ids.trakt,
          season: nextEp.season,
          number: nextEp.number,
          title: nextEp.title,
          firstAired: nextEp.first_aired ?? null,
        }
      : null,
  };
}

/** Per-episode watched flag, from the progress cache. */
export function isEpisodeWatched(lib: Library, showTraktId: number, season: number, episode: number): boolean {
  const progress = lib.progress.get(showTraktId);
  const s = progress?.seasons.find((x) => x.number === season);
  return s?.episodes.find((e) => e.number === episode)?.completed ?? false;
}

/** When an episode was (last) watched, if known. */
export function episodeWatchedAt(lib: Library, showTraktId: number, season: number, episode: number): string | null {
  const progress = lib.progress.get(showTraktId);
  const s = progress?.seasons.find((x) => x.number === season);
  return s?.episodes.find((e) => e.number === episode)?.watchedAt ?? null;
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
  // Cached before per-episode watchedAt was recorded — refresh started shows once.
  if (
    (watched?.plays ?? 0) > 0 &&
    !progress.seasons.some((s) => s.episodes.some((e) => e.watchedAt !== undefined))
  ) {
    return true;
  }
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
    if (!show.overview && images.overview) show.overview = images.overview;
    show.imagesFetchedAt = Date.now();
    await dbPut("shows", traktId, show);
    if (++pendingNotify >= 8) {
      pendingNotify = 0;
      onUpdate?.();
    }
  });
  if (pendingNotify > 0) onUpdate?.();
}

/** Merge TMDB stills/overviews/air dates/ratings + cast into an episodes record (best effort). */
async function mergeTmdbEpisodes(show: ShowRec, rec: EpisodesRec): Promise<boolean> {
  if (!show.ids.tmdb || !getSettings().tmdbApiKey) return false;
  const extras = await fetchShowExtras(
    show.ids.tmdb,
    rec.seasons.map((s) => s.number),
  );
  if (extras.episodesBySeason.size === 0 && extras.cast.length === 0) return false;
  for (const season of rec.seasons) {
    const tmdbEps = extras.episodesBySeason.get(season.number);
    if (!tmdbEps) continue;
    for (const ep of season.episodes) {
      const t = tmdbEps.find((x) => x.episode_number === ep.number);
      if (!t) continue;
      ep.overview = t.overview;
      ep.still = t.still_path;
      ep.airDate = t.air_date;
      ep.rating = t.vote_average ?? null;
      ep.title ??= t.name;
    }
  }
  rec.cast = extras.cast;
  rec.providers = extras.providersByCountry;
  rec.tmdbMergedAt = Date.now();
  return true;
}

/** Episode titles/ids for the show page (24h TTL for airing shows, 7d for ended). */
export async function ensureEpisodes(show: ShowRec): Promise<EpisodesRec> {
  const cached = await dbGet<EpisodesRec>("episodes", show.traktId);
  const ttl = progressTtlMs(show) * 2;

  if (cached && Date.now() - cached.fetchedAt < ttl) {
    // Cached from before a TMDB key was configured (or before cast/ratings/
    // person-ids were collected) — enrich it now.
    const needsMerge =
      !cached.tmdbMergedAt ||
      cached.cast === undefined ||
      cached.cast.some((c) => c.tmdbId === undefined) ||
      cached.providers === undefined;
    if (needsMerge && (await mergeTmdbEpisodes(show, cached))) {
      await dbPut("episodes", show.traktId, cached);
    }
    return cached;
  }

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
    await mergeTmdbEpisodes(show, rec);
    await dbPut("episodes", show.traktId, rec);
    return rec;
  } catch (e) {
    if (cached) return cached; // offline — serve stale
    throw e;
  }
}

// ---------- movies ----------

function toMovieRec(movie: trakt.TraktMovie, existing: MovieRec | undefined, state: Partial<MovieRec>): MovieRec {
  return {
    traktId: movie.ids.trakt,
    ids: movie.ids,
    title: movie.title,
    year: movie.year,
    plays: 0,
    lastWatchedAt: null,
    onWatchlist: false,
    listedAt: null,
    tvtimeAddedAt: existing?.tvtimeAddedAt,
    overview: movie.overview || existing?.overview,
    runtime: movie.runtime ?? existing?.runtime,
    rating: movie.rating ?? existing?.rating,
    genres: movie.genres ?? existing?.genres,
    released: movie.released ?? existing?.released,
    trailer: movie.trailer !== undefined ? movie.trailer : existing?.trailer,
    poster: existing?.poster,
    backdrop: existing?.backdrop,
    cast: existing?.cast,
    providers: existing?.providers,
    tmdbFetchedAt: existing?.tmdbFetchedAt,
    ...state,
  };
}

export async function loadMovies(): Promise<Map<number, MovieRec>> {
  const movies = await dbGetAll<MovieRec>("movies");
  return new Map(movies.map((m) => [m.traktId, m]));
}

/** Pull movies from Trakt if changed remotely (gated on last_activities like shows). */
export async function syncMovies(force = false): Promise<boolean> {
  if (!isAuthenticated()) return false;

  const acts = await trakt.getLastActivities();
  const prev = await dbGet<trakt.LastActivities>("meta", "movieActivities");
  const changed =
    force ||
    !prev ||
    prev.movies.watched_at !== acts.movies.watched_at ||
    prev.movies.watchlisted_at !== acts.movies.watchlisted_at ||
    prev.watchlist.updated_at !== acts.watchlist.updated_at;
  if (!changed) return false;

  const [watched, watchlist] = await Promise.all([trakt.getWatchedMovies(), trakt.getWatchlistMovies()]);
  const existing = await loadMovies();

  const entries = new Map<number, MovieRec>();
  for (const w of watched) {
    entries.set(
      w.movie.ids.trakt,
      toMovieRec(w.movie, existing.get(w.movie.ids.trakt), { plays: w.plays, lastWatchedAt: w.last_watched_at }),
    );
  }
  for (const item of watchlist) {
    const id = item.movie.ids.trakt;
    const rec = entries.get(id) ?? toMovieRec(item.movie, existing.get(id), {});
    rec.onWatchlist = true;
    rec.listedAt = item.listed_at;
    entries.set(id, rec);
  }

  await dbClear("movies");
  await dbBulkPut("movies", [...entries.entries()]);
  await dbPut("meta", "movieActivities", acts);
  emitChange();
  return true;
}

/** TMDB artwork/cast/providers for movies missing them (7-day TTL), limited concurrency. */
export async function ensureMovieDetails(
  movies: Map<number, MovieRec>,
  traktIds: number[],
  onUpdate?: () => void,
): Promise<void> {
  const maxAge = 7 * 24 * 3600 * 1000;
  const stale = traktIds.filter((id) => {
    const movie = movies.get(id);
    return movie?.ids.tmdb && (movie.tmdbFetchedAt == null || Date.now() - movie.tmdbFetchedAt > maxAge);
  });
  if (stale.length === 0) return;

  let pendingNotify = 0;
  await mapWithConcurrency(stale, 4, async (traktId) => {
    const movie = movies.get(traktId)!;
    const extras = await fetchMovieExtras(movie.ids.tmdb!);
    if (!extras) return;
    movie.poster = extras.poster;
    movie.backdrop = extras.backdrop;
    if (!movie.overview && extras.overview) movie.overview = extras.overview;
    movie.cast = extras.cast;
    movie.providers = extras.providersByCountry;
    movie.tmdbFetchedAt = Date.now();
    await dbPut("movies", traktId, movie);
    if (++pendingNotify >= 8) {
      pendingNotify = 0;
      onUpdate?.();
    }
  });
  if (pendingNotify > 0) onUpdate?.();
}

export async function setMovieWatched(movies: Map<number, MovieRec>, movie: MovieRec, watched: boolean): Promise<void> {
  if (watched) await trakt.addMovieToHistory(movie.ids);
  else await trakt.removeMovieFromHistory(movie.ids);
  movie.plays = watched ? movie.plays + 1 : 0;
  movie.lastWatchedAt = watched ? new Date().toISOString() : null;
  movies.set(movie.traktId, movie);
  await Promise.all([
    dbPut("movies", movie.traktId, movie),
    trakt.getLastActivities().then((acts) => dbPut("meta", "movieActivities", acts)),
  ]);
  emitChange();
}

export async function setMovieOnWatchlist(movies: Map<number, MovieRec>, movie: MovieRec, onList: boolean): Promise<void> {
  if (onList) await trakt.addMovieToWatchlist(movie.ids);
  else await trakt.removeMovieFromWatchlist(movie.ids);
  movie.onWatchlist = onList;
  movie.listedAt = onList ? new Date().toISOString() : null;
  movies.set(movie.traktId, movie);
  await Promise.all([
    dbPut("movies", movie.traktId, movie),
    trakt.getLastActivities().then((acts) => dbPut("meta", "movieActivities", acts)),
  ]);
  emitChange();
}

/** Refresh a movie's Trakt metadata (trailer/genres etc.) into the cache. */
export async function refreshMovieSummary(movies: Map<number, MovieRec>, traktId: number): Promise<MovieRec | undefined> {
  const existing = movies.get(traktId);
  if (!existing) return undefined;
  try {
    const summary = await trakt.getMovieSummary(traktId);
    const rec = toMovieRec(summary, existing, {
      plays: existing.plays,
      lastWatchedAt: existing.lastWatchedAt,
      onWatchlist: existing.onWatchlist,
      listedAt: existing.listedAt,
      tvtimeAddedAt: existing.tvtimeAddedAt,
    });
    movies.set(traktId, rec);
    await dbPut("movies", traktId, rec);
    return rec;
  } catch {
    return existing;
  }
}

/** Refresh a show's Trakt metadata (genres/airs/rating etc.) into the cache. */
export async function refreshShowSummary(lib: Library, traktId: number): Promise<ShowRec | undefined> {
  try {
    const summary = await trakt.getShowSummary(traktId);
    const rec = toShowRec(summary, lib.shows.get(traktId));
    if (!rec.overview && rec.ids.tmdb) {
      const images = await fetchShowImages(rec.ids.tmdb);
      if (images?.overview) rec.overview = images.overview;
    }
    lib.shows.set(traktId, rec);
    await dbPut("shows", traktId, rec);
    return rec;
  } catch {
    return lib.shows.get(traktId);
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
    watchedRec = { traktId: showTraktId, plays: 0, lastWatchedAt: nowIso, lastUpdatedAt: nowIso };
    lib.watched.set(showTraktId, watchedRec);
  }
  const progress = lib.progress.get(showTraktId);

  for (const ep of episodes) {
    if (watchedRec) {
      watchedRec.plays = Math.max(0, watchedRec.plays + (watched ? 1 : -1));
      if (watched) watchedRec.lastWatchedAt = nowIso;
    }
    if (progress) {
      const season = progress.seasons.find((s) => s.number === ep.season);
      const entry = season?.episodes.find((e) => e.number === ep.number);
      if (season && entry && entry.completed !== watched) {
        entry.completed = watched;
        entry.watchedAt = watched ? nowIso : null;
        season.completed += watched ? 1 : -1;
        if (ep.season > 0) progress.completed += watched ? 1 : -1; // totals exclude specials
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

/** Stop/resume tracking a show (Trakt "hidden from progress"; Library's Stopped bucket). */
export async function setShowHidden(lib: Library, traktId: number, hidden: boolean): Promise<void> {
  const show = lib.shows.get(traktId);
  if (!show) return;
  if (hidden) await trakt.hideShowFromProgress(show.ids);
  else await trakt.unhideShowFromProgress(show.ids);
  if (hidden) lib.hidden.add(traktId);
  else lib.hidden.delete(traktId);
  await Promise.all([
    dbPut("meta", "hidden", [...lib.hidden]),
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
