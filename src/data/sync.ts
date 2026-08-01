/**
 * Data engine. IndexedDB is the library — there is no server behind it, so a
 * write that lands here is done, and nothing below should report a failure for
 * having nowhere to sync to.
 *
 * Trakt used to be the source of truth this reconciled against, and computed
 * two things server-side that had to be reimplemented when it went away:
 * which episodes have aired (from air dates, now TMDB's) and which episode is
 * next. Both are recomputed locally, every time, against today's date —
 * see `refreshShowFromTmdb` and `computeNextEpisode`.
 *
 * Stored records are still keyed by `traktId` and still carry `ids.trakt`.
 * Those are now just opaque local ids: real ones for titles added before the
 * shutdown, `-tmdbId` for everything since. Renaming them would mean
 * rewriting every stored record for no functional gain, so they stay.
 */

import { fetchMovieExtras, fetchSeasonNumbers, fetchShowExtras, fetchShowImages, fetchShowSummary } from "../api/tmdb";
import { fetchOmdbRatings } from "../api/omdb";
import { fetchJustWatchOffers } from "../api/justwatch";
import { dbGet, dbGetAll, dbPut } from "./db";
import type {
  EpisodesRec,
  Library,
  MovieListRec,
  MovieRec,
  NextEpisodeRec,
  ProgressRec,
  ShowRec,
  WatchedRec,
  WatchlistEntry,
} from "./model";
import { getSettings } from "./settings";

export const dataEvents = new EventTarget();

function emitChange(): void {
  dataEvents.dispatchEvent(new Event("change"));
}

// ---------- conversions ----------

/**
 * The next unwatched aired episode, worked out from the cached progress alone.
 * Trakt computes this server-side; recomputing it here is what keeps a card
 * advancing to the next episode after you mark one watched, instead of going
 * blank until a refetch that may never come.
 *
 * Progress only lists episodes that have aired, so the first uncompleted one is
 * by definition watchable now. Title and air date come from the episodes cache,
 * which is only populated once a show's page has been opened — for a show it
 * hasn't, the season and number are still right and the UI renders those fine.
 */
function computeNextEpisode(progress: ProgressRec, episodes?: EpisodesRec): NextEpisodeRec | null {
  const seasons = progress.seasons.filter((s) => s.number > 0).sort((a, b) => a.number - b.number);
  for (const season of seasons) {
    const next = [...season.episodes].sort((a, b) => a.number - b.number).find((e) => !e.completed);
    if (!next) continue;
    const info = episodes?.seasons.find((s) => s.number === season.number)?.episodes.find((e) => e.number === next.number);
    return {
      // Only Trakt knows the episode's own id, and nothing reads it off this
      // record — the show page addresses episodes through the episodes cache.
      traktId: info?.traktId ?? 0,
      season: season.number,
      number: next.number,
      title: info?.title ?? null,
      firstAired: info?.airDate ?? null,
    };
  }
  return null;
}

/** Watched episodes of one show, keyed season×number, valued by when. */
type WatchedEpisodes = Map<string, string | null>;

const epKey = (season: number, number: number): string => `${season}x${number}`;

function watchedEpisodesOf(progress: ProgressRec | undefined): WatchedEpisodes {
  const out: WatchedEpisodes = new Map();
  for (const season of progress?.seasons ?? []) {
    for (const ep of season.episodes) if (ep.completed) out.set(epKey(season.number, ep.number), ep.watchedAt ?? null);
  }
  return out;
}

/**
 * A progress record built from episode air dates rather than from Trakt.
 * Counts only episodes that have aired — TMDB lists unaired ones too, and
 * treating those as aired would make every progress bar read short.
 *
 * `watched` carries the existing watch state across a rebuild. An episode in it
 * is kept even when TMDB gives no air date: the watch happened, whatever TMDB
 * thinks, and dropping it would quietly erase history.
 */
function progressFromEpisodes(traktId: number, episodes: EpisodesRec, watched?: WatchedEpisodes): ProgressRec {
  const today = new Date().toISOString().slice(0, 10);
  const hasAired = (airDate: string | null | undefined): boolean => !!airDate && airDate <= today;
  const seasons = episodes.seasons.map((s) => {
    const kept = s.episodes.filter((e) => hasAired(e.airDate) || watched?.has(epKey(s.number, e.number)));
    const eps = kept.map((e) => {
      const at = watched?.get(epKey(s.number, e.number));
      return { number: e.number, completed: at !== undefined, watchedAt: at ?? null };
    });
    return { number: s.number, aired: eps.length, completed: eps.filter((e) => e.completed).length, episodes: eps };
  });

  // Last line of defence for watch history. TMDB does not always list what
  // Trakt did — it has no specials for Silo, for instance — and an episode
  // whose whole season disappeared would otherwise be dropped here without
  // trace. Whatever was watched stays counted, even if nothing can describe it.
  const covered = new Set(seasons.flatMap((s) => s.episodes.map((e) => epKey(s.number, e.number))));
  for (const [key, at] of watched ?? []) {
    if (covered.has(key)) continue;
    const [sn, en] = key.split("x").map(Number);
    let season = seasons.find((s) => s.number === sn);
    if (!season) {
      season = { number: sn, aired: 0, completed: 0, episodes: [] };
      seasons.push(season);
    }
    season.episodes.push({ number: en, completed: true, watchedAt: at });
    season.episodes.sort((a, b) => a.number - b.number);
    season.aired++;
    season.completed++;
  }
  seasons.sort((a, b) => a.number - b.number);

  const regular = seasons.filter((s) => s.number > 0);
  return {
    traktId,
    fetchedAt: Date.now(),
    aired: regular.reduce((n, s) => n + s.aired, 0),
    completed: regular.reduce((n, s) => n + s.completed, 0),
    lastWatchedAt: null,
    seasons,
    nextEpisode: null,
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

// ---------- lazy per-show data ----------

function progressTtlMs(show: ShowRec | undefined): number {
  const ended = show?.status === "ended" || show?.status === "canceled";
  return ended ? 7 * 24 * 3600 * 1000 : 12 * 3600 * 1000;
}

function progressIsStale(lib: Library, traktId: number, skipFinishedTtl = false): boolean {
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
  // Bulk refreshes skip ended shows the user completed: their progress can't
  // change except through watching (caught by the mismatch check above) or a
  // revival (which flips status via the metadata sync, ending the exemption).
  if (skipFinishedTtl) {
    const show = lib.shows.get(traktId);
    const ended = show?.status === "ended" || show?.status === "canceled";
    if (ended && progress.aired > 0 && progress.completed >= progress.aired) return false;
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
 * Batches `onUpdate` calls from a bulk fetch: the first result repaints
 * immediately, then at most one repaint per 300ms, plus a final one when the
 * batch ends. Views rebuild their whole grid per update, so notifying every few
 * items made a big refresh (a week-stale library) janky on a phone.
 */
function batchNotify(onUpdate?: () => void): { tick: () => void; done: () => void } {
  let pending = 0;
  let lastAt = 0;
  return {
    tick: () => {
      pending++;
      if (Date.now() - lastAt < 300) return;
      lastAt = Date.now();
      pending = 0;
      onUpdate?.();
    },
    done: () => {
      if (pending > 0) onUpdate?.();
    },
  };
}

/**
 * Ensure progress records exist and are fresh for the given shows.
 * Fetches in the background with limited concurrency; `onUpdate` fires after
 * each batch of updates so the UI can re-render progressively.
 */
/**
 * Rebuild a show's episode list and progress from TMDB.
 *
 * This is what replaces Trakt's server-side progress. Trakt decided which
 * episodes had aired, so without it a cached progress record freezes: episodes
 * that air later stay greyed out as unaired and can never be ticked, and whole
 * new seasons never appear at all. Air dates come from TMDB instead, and
 * aired-ness is recomputed against today's date every time this runs.
 *
 * Watch state is carried across, keyed on season×number rather than on any id,
 * because episodes added from TMDB have no Trakt id to match on.
 */
async function refreshShowFromTmdb(lib: Library, traktId: number): Promise<boolean> {
  const show = lib.shows.get(traktId);
  if (!show?.ids.tmdb) return false;

  const seasonNumbers = await fetchSeasonNumbers(show.ids.tmdb);
  if (seasonNumbers.length === 0) return false;
  const extras = await fetchShowExtras(show.ids.tmdb, seasonNumbers);
  if (extras.episodesBySeason.size === 0) return false;

  const cached = await dbGet<EpisodesRec>("episodes", traktId);
  // Trakt's episode ids are no longer obtainable, so keep the ones already held.
  const knownIds = new Map<string, number>();
  for (const s of cached?.seasons ?? []) {
    for (const e of s.episodes) if (e.traktId) knownIds.set(epKey(s.number, e.number), e.traktId);
  }

  const episodes: EpisodesRec = {
    traktId,
    fetchedAt: Date.now(),
    tmdbMergedAt: Date.now(),
    cast: extras.cast.length > 0 ? extras.cast : cached?.cast,
    providers: Object.keys(extras.providersByCountry).length > 0 ? extras.providersByCountry : cached?.providers,
    seasons: seasonNumbers.map((number) => ({
      number,
      episodes: (extras.episodesBySeason.get(number) ?? []).map((t) => ({
        traktId: knownIds.get(epKey(number, t.episode_number)) ?? 0,
        season: number,
        number: t.episode_number,
        title: t.name,
        overview: t.overview,
        still: t.still_path,
        airDate: t.air_date,
        rating: t.vote_average ?? null,
      })),
    })),
  };

  const previous = lib.progress.get(traktId);
  const watched = watchedEpisodesOf(previous);

  // Keep watched episodes TMDB no longer lists, with their titles and stills, so
  // they still render rather than surviving only as a number in the totals.
  const present = new Set(episodes.seasons.flatMap((s) => s.episodes.map((e) => epKey(s.number, e.number))));
  for (const s of cached?.seasons ?? []) {
    for (const e of s.episodes) {
      if (!watched.has(epKey(s.number, e.number)) || present.has(epKey(s.number, e.number))) continue;
      const season = episodes.seasons.find((x) => x.number === s.number);
      if (season) season.episodes.push(e);
      else episodes.seasons.push({ number: s.number, episodes: [e] });
    }
  }
  for (const s of episodes.seasons) s.episodes.sort((a, b) => a.number - b.number);
  episodes.seasons.sort((a, b) => a.number - b.number);

  const progress = progressFromEpisodes(traktId, episodes, watched);
  progress.lastWatchedAt = lib.watched.get(traktId)?.lastWatchedAt ?? previous?.lastWatchedAt ?? null;
  progress.nextEpisode = computeNextEpisode(progress, episodes);

  lib.progress.set(traktId, progress);
  await Promise.all([dbPut("episodes", traktId, episodes), dbPut("progress", traktId, progress)]);
  return true;
}

export async function ensureProgress(
  lib: Library,
  traktIds: number[],
  onUpdate?: () => void,
  opts?: { skipFinishedTtl?: boolean },
): Promise<void> {
  const stale = traktIds.filter((id) => progressIsStale(lib, id, opts?.skipFinishedTtl));
  if (stale.length === 0) return;

  const notify = batchNotify(onUpdate);
  // Each show costs two TMDB calls, and TMDB is happy with four in flight.
  await mapWithConcurrency(stale, 4, async (traktId) => {
    try {
      if (await refreshShowFromTmdb(lib, traktId)) notify.tick();
    } catch {
      // Leave stale/missing; next render tries again.
    }
  });
  notify.done();
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

  const notify = batchNotify(onUpdate);
  await mapWithConcurrency(missing, 4, async (traktId) => {
    const show = lib.shows.get(traktId)!;
    const images = await fetchShowImages(show.ids.tmdb!);
    if (!images) return; // no key / transient failure
    show.poster = images.poster;
    show.backdrop = images.backdrop;
    if (!show.overview && images.overview) show.overview = images.overview;
    show.imagesFetchedAt = Date.now();
    await dbPut("shows", traktId, show);
    notify.tick();
  });
  notify.done();
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
    // Nothing to patch means the season list came from TMDB rather than Trakt,
    // so TMDB is also where the episodes themselves have to come from.
    if (season.episodes.length === 0) {
      season.episodes = tmdbEps.map((t) => ({
        traktId: 0, // Trakt issues no ids for these; local watch state keys on season+number
        season: season.number,
        number: t.episode_number,
        title: t.name,
        overview: t.overview,
        still: t.still_path,
        airDate: t.air_date,
        rating: t.vote_average ?? null,
      }));
      continue;
    }
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

/**
 * Episode numbers for a show, from its cached progress. Only aired episodes are
 * recorded there, so an unaired episode is missing until TMDB is asked — which
 * is the trade for a show page that works with no Trakt at all.
 */
async function episodesFromProgress(show: ShowRec): Promise<EpisodesRec> {
  const progress = await dbGet<ProgressRec>("progress", show.traktId);
  let seasons = (progress?.seasons ?? []).map((s) => ({
    number: s.number,
    episodes: s.episodes.map((e) => ({ traktId: 0, season: s.number, number: e.number, title: null })),
  }));
  // A show added from TMDB search has no progress either — ask TMDB which
  // seasons exist and let the merge below fill them in.
  if (seasons.length === 0 && show.ids.tmdb) {
    seasons = (await fetchSeasonNumbers(show.ids.tmdb)).map((number) => ({ number, episodes: [] }));
  }
  return {
    traktId: show.traktId,
    fetchedAt: 0, // never treated as fresh: a real fetch should replace this
    seasons,
  };
}

/**
 * Episode titles for the show page (24h TTL for airing shows, 7d for ended).
 *
 * Serves what's cached, and builds a skeleton from progress the first time a
 * show page is opened so it lists episodes rather than erroring. TMDB fills in
 * titles, stills and air dates — it needs only its own key.
 */
export async function ensureEpisodes(show: ShowRec): Promise<EpisodesRec> {
  const cached = await dbGet<EpisodesRec>("episodes", show.traktId);
  const ttl = progressTtlMs(show) * 2;

  const rec = cached ?? (await episodesFromProgress(show));
  const stale = !rec.tmdbMergedAt || Date.now() - rec.tmdbMergedAt > ttl;
  if (stale && (await mergeTmdbEpisodes(show, rec))) {
    rec.fetchedAt = Date.now();
    await dbPut("episodes", show.traktId, rec);
  }
  return rec;
}

// ---------- movies ----------

export async function loadMovies(): Promise<Map<number, MovieRec>> {
  const movies = await dbGetAll<MovieRec>("movies");
  return new Map(movies.map((m) => [m.traktId, m]));
}

export async function loadMovieLists(): Promise<MovieListRec[]> {
  return (await dbGet<MovieListRec[]>("meta", "movieLists")) ?? [];
}

/**
 * Bump whenever a new provider kind starts being stored, so cached records fetched under the
 * old shape refetch instead of silently missing it for up to a TTL. 2 added rent.
 */
const PROVIDERS_VERSION = 2;

const DAY = 24 * 3600 * 1000;

function watchCountryList(): string[] {
  return getSettings().watchCountries.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
}

/** Every date we know about, as timestamps. */
function knownDates(movie: MovieRec): number[] {
  return [movie.released, movie.digitalRelease?.date, movie.streamingRelease?.date]
    .filter((d): d is string => typeof d === "string")
    .map((d) => new Date(d).getTime())
    .filter((t) => Number.isFinite(t));
}

/** Within a month of any known date — when listings actually move, in either direction. */
function nearRelease(movie: MovieRec): boolean {
  const now = Date.now();
  return knownDates(movie).some((t) => Math.abs(t - now) < 30 * DAY);
}

/**
 * How long cached TMDB details stay good. Providers only really move around a release: a title
 * landing on a subscription this week can change daily, while a film from 1984 has said all it
 * is going to say. Watched films are settled by definition — you already saw it.
 */
function detailsMaxAge(movie: MovieRec): number {
  if (movie.plays > 0) return 7 * DAY;
  // Nothing announced yet — the dates themselves are what we are waiting for.
  if (knownDates(movie).length === 0) return 12 * 3600 * 1000;
  return nearRelease(movie) ? 6 * 3600 * 1000 : 7 * DAY;
}

/**
 * Fold JustWatch's offers into TMDB's, for the near-release titles where TMDB's ingest lags.
 * TMDB stays the source of record: this only adds providers it is missing and downgrades a kind
 * when JustWatch says something is cheaper than TMDB thinks. Nothing is ever removed — an entry
 * TMDB has and JustWatch does not is far more likely to be a search miss than a delisting.
 */
function mergeJustWatch(
  tmdb: NonNullable<MovieRec["providers"]>,
  extra: Record<string, { name: string; kind: string }[]>,
): NonNullable<MovieRec["providers"]> {
  const cost = (k: string): number => (k === "free" || k === "ads" ? 0 : k === "rent" ? 2 : 1);
  const merged: NonNullable<MovieRec["providers"]> = { ...tmdb };
  for (const [cc, offers] of Object.entries(extra)) {
    const entry = merged[cc] ?? { link: null, providers: [] };
    const providers = [...entry.providers];
    for (const offer of offers) {
      const at = providers.findIndex((p) => p.name === offer.name);
      if (at === -1) providers.push({ name: offer.name, logo: null, kind: offer.kind });
      else if (cost(offer.kind) < cost(providers[at].kind)) providers[at] = { ...providers[at], kind: offer.kind };
    }
    merged[cc] = { link: entry.link, providers };
  }
  // Logos are TMDB paths, which JustWatch does not supply. A provider already seen in another
  // country carries the same logo, so borrow it rather than render a bare chip.
  const logos = new Map<string, string>();
  for (const entry of Object.values(merged)) {
    for (const p of entry.providers) if (p.logo && !logos.has(p.name)) logos.set(p.name, p.logo);
  }
  for (const entry of Object.values(merged)) {
    for (const p of entry.providers) if (!p.logo) p.logo = logos.get(p.name) ?? null;
  }
  return merged;
}

/** TMDB artwork/cast/providers for movies missing or outgrowing their cache, limited concurrency. */
export async function ensureMovieDetails(
  movies: Map<number, MovieRec>,
  traktIds: number[],
  onUpdate?: () => void,
  opts?: { skipWatchedRefresh?: boolean },
): Promise<void> {
  const stale = traktIds.filter((id) => {
    const movie = movies.get(id);
    if (!movie?.ids.tmdb) return false;
    if (movie.tmdbFetchedAt == null) return true;
    // Bulk refreshes leave watched movies alone — their details are fetched
    // once and only re-fetched when the movie page itself is opened.
    if (opts?.skipWatchedRefresh && movie.plays > 0) return false;
    if (movie.digitalRelease === undefined) return true; // backfill new field
    if (movie.streamingRelease === undefined) return true; // backfill new field
    if (movie.providersVersion !== PROVIDERS_VERSION) return true; // cached before rent was kept
    return Date.now() - movie.tmdbFetchedAt > detailsMaxAge(movie);
  });
  if (stale.length === 0) return;

  const notify = batchNotify(onUpdate);
  await mapWithConcurrency(stale, 4, async (traktId) => {
    const movie = movies.get(traktId)!;
    const extras = await fetchMovieExtras(movie.ids.tmdb!);
    if (!extras) return;
    movie.poster = extras.poster;
    movie.backdrop = extras.backdrop;
    if (!movie.overview && extras.overview) movie.overview = extras.overview;
    movie.trailer = extras.trailer;
    movie.cast = extras.cast;
    movie.providers = extras.providersByCountry;
    movie.providersVersion = PROVIDERS_VERSION;
    movie.digitalRelease = extras.digitalRelease;
    movie.streamingRelease = extras.streamingRelease;
    // Only near a release, and only with the dates TMDB just returned: this is the one window
    // where TMDB is known to be behind, and it keeps the extra request off the other ~340 titles.
    if (movie.ids.tmdb && nearRelease(movie)) {
      const offers = await fetchJustWatchOffers(movie.title, movie.ids.tmdb, watchCountryList());
      if (offers) movie.providers = mergeJustWatch(movie.providers ?? {}, offers);
    }
    movie.tmdbFetchedAt = Date.now();
    await dbPut("movies", traktId, movie);
    notify.tick();
  });
  notify.done();
}

export async function setMovieWatched(movies: Map<number, MovieRec>, movie: MovieRec, watched: boolean): Promise<void> {
  movie.plays = watched ? movie.plays + 1 : 0;
  movie.lastWatchedAt = watched ? new Date().toISOString() : null;
  movies.set(movie.traktId, movie);
  await dbPut("movies", movie.traktId, movie);
  emitChange();
}

export async function setMovieOnWatchlist(movies: Map<number, MovieRec>, movie: MovieRec, onList: boolean): Promise<void> {
  movie.onWatchlist = onList;
  movie.listedAt = onList ? new Date().toISOString() : null;
  movies.set(movie.traktId, movie);
  await dbPut("movies", movie.traktId, movie);
  emitChange();
}

const EXT_RATINGS_TTL = 7 * 24 * 3600 * 1000;

/** IMDb/Rotten Tomatoes ratings via OMDb, fetched on page open (7-day cache). Returns true if updated. */
export async function ensureShowExtRatings(lib: Library, show: ShowRec): Promise<boolean> {
  if (!getSettings().omdbApiKey || !show.ids.imdb) return false;
  if (show.extRatings && Date.now() - show.extRatings.fetchedAt < EXT_RATINGS_TTL) return false;
  const ratings = await fetchOmdbRatings(show.ids.imdb);
  if (!ratings) return false;
  show.extRatings = { ...ratings, fetchedAt: Date.now() };
  lib.shows.set(show.traktId, show);
  await dbPut("shows", show.traktId, show);
  return true;
}

export async function ensureMovieExtRatings(movies: Map<number, MovieRec>, movie: MovieRec): Promise<boolean> {
  if (!getSettings().omdbApiKey || !movie.ids.imdb) return false;
  if (movie.extRatings && Date.now() - movie.extRatings.fetchedAt < EXT_RATINGS_TTL) return false;
  const ratings = await fetchOmdbRatings(movie.ids.imdb);
  if (!ratings) return false;
  movie.extRatings = { ...ratings, fetchedAt: Date.now() };
  movies.set(movie.traktId, movie);
  await dbPut("movies", movie.traktId, movie);
  return true;
}

/**
 * Refresh a show's headline metadata (genres, overview, trailer, status) from
 * TMDB. Records cached in the Trakt era predate some of these fields, and a
 * running show's status changes; the show page calls this when it spots a gap.
 */
export async function refreshShowSummary(lib: Library, traktId: number): Promise<ShowRec | undefined> {
  const existing = lib.shows.get(traktId);
  if (!existing?.ids.tmdb) return existing;
  try {
    const summary = await fetchShowSummary(existing.ids.tmdb);
    if (!summary) return existing;
    const rec: ShowRec = {
      ...existing,
      // `||` not `??`: an empty string from either side must not win over real text.
      title: summary.title || existing.title,
      year: summary.year ?? existing.year,
      status: summary.status ?? existing.status,
      network: summary.network ?? existing.network,
      overview: summary.overview || existing.overview,
      genres: summary.genres ?? existing.genres,
      runtime: summary.runtime ?? existing.runtime,
      rating: summary.rating ?? existing.rating,
      firstAired: summary.firstAired ?? existing.firstAired,
      trailer: summary.trailer,
      ids: { ...existing.ids, imdb: summary.imdb ?? existing.ids.imdb },
    };
    lib.shows.set(traktId, rec);
    await dbPut("shows", traktId, rec);
    return rec;
  } catch {
    return existing;
  }
}

/** Toggle a movie on/off one of the user's custom lists. */
export async function setMovieOnCustomList(
  movies: Map<number, MovieRec>,
  movie: MovieRec,
  listId: number,
  on: boolean,
): Promise<void> {
  movie.customLists = on
    ? [...(movie.customLists ?? []), listId]
    : (movie.customLists ?? []).filter((id) => id !== listId);
  movies.set(movie.traktId, movie);
  await dbPut("movies", movie.traktId, movie);
  emitChange();
}

// ---------- mutations ----------

export interface EpisodeRef {
  traktId: number;
  season: number;
  number: number;
}

function applyLocalWatch(
  lib: Library,
  showTraktId: number,
  episodes: EpisodeRef[],
  watched: boolean,
  episodeInfo?: EpisodesRec,
): void {
  const nowIso = new Date().toISOString();

  let watchedRec = lib.watched.get(showTraktId);
  if (!watchedRec && watched) {
    watchedRec = { traktId: showTraktId, plays: 0, lastWatchedAt: nowIso, lastUpdatedAt: nowIso };
    lib.watched.set(showTraktId, watchedRec);
  }
  // A show added from TMDB search has no progress record — Trakt built those.
  // Seed one from the episode list so the tick has somewhere to land.
  if (!lib.progress.get(showTraktId) && episodeInfo) {
    lib.progress.set(showTraktId, progressFromEpisodes(showTraktId, episodeInfo));
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
    progress.nextEpisode = computeNextEpisode(progress, episodeInfo);
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

/** Mark/unmark episodes. The cache write is the whole job. */
export async function setEpisodesWatched(
  lib: Library,
  showTraktId: number,
  episodes: EpisodeRef[],
  watched: boolean,
): Promise<void> {
  applyLocalWatch(lib, showTraktId, episodes, watched, await dbGet<EpisodesRec>("episodes", showTraktId));
  await persistShowState(lib, showTraktId);
  emitChange();
}

export async function addToWatchlist(lib: Library, show: ShowRec): Promise<void> {
  // Search hands over either a record already in the library or a freshly
  // minted one; either way keep whatever the cache already knew.
  const rec = { ...show, ...lib.shows.get(show.traktId) };
  lib.shows.set(rec.traktId, rec);
  lib.watchlist = [{ traktId: rec.traktId, listedAt: new Date().toISOString() }, ...lib.watchlist];
  await Promise.all([dbPut("shows", rec.traktId, rec), dbPut("meta", "watchlist", lib.watchlist)]);
  emitChange();
}

/** Stop/resume tracking a show (Library's Stopped bucket). */
export async function setShowHidden(lib: Library, traktId: number, hidden: boolean): Promise<void> {
  if (!lib.shows.has(traktId)) return;
  if (hidden) lib.hidden.add(traktId);
  else lib.hidden.delete(traktId);
  await dbPut("meta", "hidden", [...lib.hidden]);
  emitChange();
}

export async function removeFromWatchlist(lib: Library, showTraktId: number): Promise<void> {
  if (!lib.shows.has(showTraktId)) return;
  lib.watchlist = lib.watchlist.filter((e) => e.traktId !== showTraktId);
  await dbPut("meta", "watchlist", lib.watchlist);
  emitChange();
}
