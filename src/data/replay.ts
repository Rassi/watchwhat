/**
 * The read half of sync: pull events after the cursor and feed each one back
 * through the same local mutations the UI uses.
 *
 * Nothing here reimplements what a watch *means*. `episode.watched` calls
 * `setEpisodesWatched` exactly as tapping the tick does, only with `replay` set
 * so it isn't appended straight back to the log. That is what made removing
 * Trakt cheap and what keeps the two devices honest: there is one state machine,
 * not one per direction.
 *
 * Events carry TMDB ids, so a title this device has never seen is minted from
 * TMDB on the spot. A fresh device therefore rebuilds the whole library from the
 * log plus TMDB, with no export file involved.
 */

import { fetchMovieSummary, fetchShowSummary } from "../api/tmdb";
import { pullEvents, syncConfigured, type RemoteEvent } from "../api/syncserver";
import { dbPut } from "./db";
import { tmdbKey, type Library, type MovieRec, type ShowRec } from "./model";
import { flush, getCursor, setCursor } from "./outbox";
import { getDeviceId } from "./settings";
import {
  addToWatchlist,
  ensureProgress,
  loadLibrary,
  loadMovies,
  removeFromWatchlist,
  setEpisodesWatched,
  setMovieOnCustomList,
  setMovieOnWatchlist,
  setMovieWatched,
  setShowHidden,
} from "./sync";

export interface SyncResult {
  pushed: number;
  applied: number;
  /** Events that named a title TMDB could not resolve — skipped, cursor still advanced. */
  skipped: number;
}

/** Everything one replay run needs, loaded once rather than per event. */
interface Ctx {
  lib: Library;
  movies: Map<number, MovieRec>;
  showsByTmdb: Map<number, ShowRec>;
  moviesByTmdb: Map<number, MovieRec>;
  /** Shows whose episode list has already been built during this run. */
  progressed: Set<number>;
  skipped: number;
}

async function loadCtx(): Promise<Ctx> {
  const [lib, movies] = await Promise.all([loadLibrary(), loadMovies()]);
  const showsByTmdb = new Map<number, ShowRec>();
  for (const show of lib.shows.values()) if (show.ids.tmdb) showsByTmdb.set(show.ids.tmdb, show);
  const moviesByTmdb = new Map<number, MovieRec>();
  for (const movie of movies.values()) if (movie.ids.tmdb) moviesByTmdb.set(movie.ids.tmdb, movie);
  return { lib, movies, showsByTmdb, moviesByTmdb, progressed: new Set(), skipped: 0 };
}

/**
 * The show for a TMDB id, minted from TMDB if this device has never seen it.
 * Returns null when TMDB can't answer — no key, or an id it doesn't know — and
 * the caller skips the event rather than inventing a title.
 */
async function resolveShow(ctx: Ctx, tmdbId: number): Promise<ShowRec | null> {
  const existing = ctx.showsByTmdb.get(tmdbId);
  if (existing) return existing;

  const summary = await fetchShowSummary(tmdbId);
  if (!summary) return null;
  const rec: ShowRec = {
    traktId: tmdbKey(tmdbId),
    ids: { trakt: tmdbKey(tmdbId), tmdb: tmdbId, imdb: summary.imdb ?? null },
    title: summary.title,
    year: summary.year,
    status: summary.status,
    network: summary.network,
    overview: summary.overview,
    genres: summary.genres,
    runtime: summary.runtime,
    rating: summary.rating,
    firstAired: summary.firstAired,
    trailer: summary.trailer,
  };
  ctx.lib.shows.set(rec.traktId, rec);
  ctx.showsByTmdb.set(tmdbId, rec);
  await dbPut("shows", rec.traktId, rec);
  return rec;
}

async function resolveMovie(ctx: Ctx, tmdbId: number): Promise<MovieRec | null> {
  const existing = ctx.moviesByTmdb.get(tmdbId);
  if (existing) return existing;

  const summary = await fetchMovieSummary(tmdbId);
  if (!summary) return null;
  const rec: MovieRec = {
    traktId: tmdbKey(tmdbId),
    ids: { trakt: tmdbKey(tmdbId), tmdb: tmdbId, imdb: summary.imdb ?? null },
    title: summary.title,
    year: summary.year,
    plays: 0,
    lastWatchedAt: null,
    onWatchlist: false,
    listedAt: null,
    overview: summary.overview,
    runtime: summary.runtime,
    rating: summary.rating,
    genres: summary.genres,
    released: summary.released,
  };
  ctx.movies.set(rec.traktId, rec);
  ctx.moviesByTmdb.set(tmdbId, rec);
  await dbPut("movies", rec.traktId, rec);
  return rec;
}

/**
 * An episode tick needs somewhere to land. A show minted a moment ago has no
 * episode list and no progress record, and `applyLocalWatch` would then drop the
 * watch on the floor — it only ever updates a season that already exists. So the
 * episode list is built from TMDB first, once per show per run.
 */
async function ensureShowProgress(ctx: Ctx, show: ShowRec): Promise<void> {
  if (ctx.progressed.has(show.traktId)) return;
  ctx.progressed.add(show.traktId);
  if (ctx.lib.progress.has(show.traktId)) return;
  await ensureProgress(ctx.lib, [show.traktId]);
}

function num(body: Record<string, unknown>, field: string): number | null {
  const value = body[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Apply one remote event through the ordinary local mutation for it. */
async function apply(ctx: Ctx, event: RemoteEvent): Promise<void> {
  const body = (event.body ?? {}) as Record<string, unknown>;
  const at = typeof body.at === "string" ? body.at : event.ts;
  const opts = { replay: true as const, at };

  switch (event.kind) {
    case "episode.watched":
    case "episode.unwatched": {
      const tmdbId = num(body, "show");
      const season = num(body, "season");
      const number = num(body, "number");
      if (tmdbId === null || season === null || number === null) return void ctx.skipped++;
      const show = await resolveShow(ctx, tmdbId);
      if (!show) return void ctx.skipped++;
      await ensureShowProgress(ctx, show);
      await setEpisodesWatched(
        ctx.lib,
        show.traktId,
        [{ traktId: 0, season, number }],
        event.kind === "episode.watched",
        opts,
      );
      return;
    }

    case "movie.watched":
    case "movie.unwatched": {
      const tmdbId = num(body, "movie");
      if (tmdbId === null) return void ctx.skipped++;
      const movie = await resolveMovie(ctx, tmdbId);
      if (!movie) return void ctx.skipped++;
      await setMovieWatched(ctx.movies, movie, event.kind === "movie.watched", opts);
      return;
    }

    case "watchlist.add":
    case "watchlist.remove": {
      // The one place the media type is carried explicitly: TMDB numbers shows
      // and films separately, so without it the same id means two titles.
      const tmdbId = num(body, "tmdb");
      if (tmdbId === null) return void ctx.skipped++;
      const on = event.kind === "watchlist.add";
      if (body.type === "movie") {
        const movie = await resolveMovie(ctx, tmdbId);
        if (!movie) return void ctx.skipped++;
        await setMovieOnWatchlist(ctx.movies, movie, on, opts);
      } else {
        const show = await resolveShow(ctx, tmdbId);
        if (!show) return void ctx.skipped++;
        if (on) await addToWatchlist(ctx.lib, show, opts);
        else await removeFromWatchlist(ctx.lib, show.traktId, opts);
      }
      return;
    }

    case "show.hidden":
    case "show.unhidden": {
      const tmdbId = num(body, "show");
      if (tmdbId === null) return void ctx.skipped++;
      const show = await resolveShow(ctx, tmdbId);
      if (!show) return void ctx.skipped++;
      await setShowHidden(ctx.lib, show.traktId, event.kind === "show.hidden", opts);
      return;
    }

    case "list.add":
    case "list.remove": {
      const tmdbId = num(body, "movie");
      const list = num(body, "list");
      if (tmdbId === null || list === null) return void ctx.skipped++;
      const movie = await resolveMovie(ctx, tmdbId);
      if (!movie) return void ctx.skipped++;
      await setMovieOnCustomList(ctx.movies, movie, list, event.kind === "list.add", opts);
      return;
    }

    default:
      // An event kind this build doesn't know — a newer version of the app on
      // the other device. Skipping and advancing is right: the log keeps it, and
      // nothing here can guess what it meant.
      ctx.skipped++;
  }
}

/**
 * Fires "applied" when a pull actually changed something.
 *
 * Deliberately not `dataEvents`: that fires on every local tap too, and screens
 * already handle their own taps. This is the case they cannot see — data that
 * arrived from another device while a screen was sitting open. Kept as a signal
 * rather than a direct `refreshRoute` call so the data layer stays clear of the
 * router.
 */
export const syncEvents = new EventTarget();

let pulling = false;

/**
 * Pull and apply everything after the cursor.
 *
 * The cursor advances per page, after that page has been applied, so an
 * interrupted pull resumes where it stopped instead of starting over. Events
 * this device wrote are skipped: they were applied when they were made, and
 * `plays` counters would climb on every one that came back.
 */
export async function pull(): Promise<{ applied: number; skipped: number }> {
  if (pulling || !syncConfigured()) return { applied: 0, skipped: 0 };
  pulling = true;

  const device = getDeviceId();
  let applied = 0;
  let ctx: Ctx | null = null;
  try {
    for (;;) {
      const cursor = await getCursor();
      const page = await pullEvents(cursor);
      const mine = page.events.filter((e) => e.device !== device);
      if (mine.length > 0) {
        ctx ??= await loadCtx();
        for (const event of mine) {
          await apply(ctx, event);
          applied++;
        }
      }
      // Only after the page is applied — a crash mid-page replays it, which the
      // mutations tolerate, where a lost page would go unnoticed forever.
      if (page.seq !== cursor) await setCursor(page.seq);
      if (!page.more) break;
    }
  } catch {
    // Same as the outbox: nothing to report to, and the cursor has not moved
    // past anything unapplied, so the next attempt simply resumes.
  } finally {
    pulling = false;
  }
  if (applied > 0) syncEvents.dispatchEvent(new Event("applied"));
  return { applied, skipped: ctx?.skipped ?? 0 };
}

/** Push what's queued, then pull what's new. Push first so this device's own work can't be clobbered by a slow round-trip. */
export async function syncNow(): Promise<SyncResult> {
  const pushed = await flush();
  const { applied, skipped } = await pull();
  return { pushed, applied, skipped };
}

/**
 * Sync whenever there is a plausible reason to think it might work: at startup,
 * when the network returns, and when the app comes back to the foreground — the
 * phone case, where the tab was suspended and no `online` event ever fires.
 */
export function installSyncTriggers(): void {
  void syncNow();
  addEventListener("online", () => void syncNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncNow();
  });
}
