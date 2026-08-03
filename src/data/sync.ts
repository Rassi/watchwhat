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
import { fetchJustWatchOffers, type JustWatchUpcoming } from "../api/justwatch";
import { announcementWindow, gapQuartiles, type GapQuartiles } from "./releaseEstimate";
import { dbGet, dbGetAll, dbPut } from "./db";
import { enqueue, now } from "./outbox";
import { pullTitles, pullTitlesSince, pushTitles, syncConfigured, type SharedTitle, type TitleWrite } from "../api/syncserver";
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
import { isEnded } from "./model";
import { getSettings } from "./settings";

export const dataEvents = new EventTarget();

/**
 * How a mutation behaves when it is a replayed remote event rather than
 * something the user just did here.
 *
 * `replay` suppresses the append to the outbox — without it, pulling an event
 * would queue it straight back to the server, and the two devices would feed
 * each other the same watch forever.
 *
 * `at` is when it actually happened. Replay must not stamp the local clock on
 * history: an episode watched last Tuesday that arrives today would otherwise
 * resurface the show in "Watch next" and reorder everything around it.
 */
export interface MutationOpts {
  replay?: boolean;
  at?: string;
}

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
  return isEnded(show) ? 7 * 24 * 3600 * 1000 : 12 * 3600 * 1000;
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
    if (isEnded(show) && progress.aired > 0 && progress.completed >= progress.aired) return false;
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
export async function ensureEpisodes(show: ShowRec, opts?: { force?: boolean }): Promise<EpisodesRec> {
  const cached = await dbGet<EpisodesRec>("episodes", show.traktId);
  const ttl = progressTtlMs(show) * 2;

  const rec = cached ?? (await episodesFromProgress(show));
  const stale = opts?.force || !rec.tmdbMergedAt || Date.now() - rec.tmdbMergedAt > ttl;
  if (stale && (await mergeTmdbEpisodes(show, rec))) {
    rec.fetchedAt = Date.now();
    await dbPut("episodes", show.traktId, rec);
  }
  await refreshNextEpisode(show.traktId, rec);
  return rec;
}

/**
 * Re-derive `nextEpisode` now that the episode cache may know more than it did.
 *
 * `nextEpisode` is otherwise only computed during a progress rebuild, from
 * whatever the cache held at that moment — and the two caches refresh on
 * independent schedules. A show whose progress rebuilt before its page had ever
 * been opened gets a next episode with no title and, worse, no air date. A null
 * `firstAired` silently disables the "unstarted new season stays in Watch next"
 * rule in the home screen, so a season that has just landed drops into
 * "Haven't watched for a while" until the progress TTL expires — a week for an
 * ended show. Cheap to recompute, and it costs no request.
 */
async function refreshNextEpisode(traktId: number, episodes: EpisodesRec): Promise<void> {
  const progress = await dbGet<ProgressRec>("progress", traktId);
  if (!progress) return;
  const next = computeNextEpisode(progress, episodes);
  const same =
    next?.season === progress.nextEpisode?.season &&
    next?.number === progress.nextEpisode?.number &&
    next?.firstAired === progress.nextEpisode?.firstAired &&
    next?.title === progress.nextEpisode?.title;
  if (same) return;
  progress.nextEpisode = next;
  await dbPut("progress", traktId, progress);
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

/**
 * Record when each streaming listing was first seen, so "this only just turned up" has an
 * answer. `providers` is replaced wholesale on every refresh, which loses the one fact the
 * Releases screen is built on; this diffs the new set against what was there before.
 *
 * The first stamp for a film is all zeroes — "already there", never news. That is the honest
 * reading: a listing this device has never seen absent cannot be said to have arrived, and
 * the alternative would announce a 2019 film as new the day the library was imported.
 *
 * Rentals are skipped for the same reason they are left out of the service catalogue: a shop
 * carrying a title is not the title becoming watchable.
 */
function stampProviderSightings(movie: MovieRec): void {
  const countries = watchCountryList();
  // Countries dropped from the watch list fall out of both, so their stamps stop being carried
  // around — and a country added back later re-baselines rather than reporting its whole
  // catalogue as having arrived that afternoon.
  const seen = new Set((movie.providerSeen ?? []).filter((cc) => countries.includes(cc)));
  const since = movie.providerSince ?? {};
  const now = Date.now();
  const live = new Set<string>();

  for (const cc of countries) {
    // Never looked here before, so nothing it lists can be said to have arrived.
    const known = seen.has(cc);
    for (const p of movie.providers?.[cc]?.providers ?? []) {
      if (p.kind === "rent") continue;
      const key = `${cc}:${p.name}`;
      live.add(key);
      if (since[key] === undefined) since[key] = known ? now : 0;
    }
    seen.add(cc);
  }

  // A listing that went away loses its stamp, so a film that leaves a service and comes back
  // a year later reads as news again rather than keeping the date of its first run.
  for (const key of Object.keys(since)) if (!live.has(key)) delete since[key];
  movie.providerSince = since;
  movie.providerSeen = [...seen];
}

const PROVIDER_SINCE_SEEDED_KEY = "watchwhat.providerSinceSeeded.v2";

/**
 * Give every film already on this device its provider baseline, once, asking TMDB nothing.
 *
 * Without it the Releases screen takes about two TTLs to say anything: the first refresh of a
 * film only establishes what it already had, so the earliest an arrival could be *noticed* is
 * the refresh after that — a fortnight of an empty section for a feature whose whole job is to
 * be timely. Seeding from the providers already cached collapses that to one TTL.
 *
 * Films never fetched are deliberately skipped rather than seeded empty. An empty baseline
 * claims "this had nothing and then gained something", and for a record TMDB has never been
 * asked about that is a fabrication — it would report the first fetch as an arrival. Left
 * alone, they get an honest baseline when that fetch happens.
 */
export async function seedProviderSince(): Promise<void> {
  if (localStorage.getItem(PROVIDER_SINCE_SEEDED_KEY)) return;
  const movies = await dbGetAll<MovieRec>("movies");
  for (const movie of movies) {
    if (movie.tmdbFetchedAt == null) continue;
    // `providerSeen` missing means either never stamped, or stamped by the first version that
    // kept all ~40 of TMDB's countries. Both want a re-stamp: the second one to shed the
    // countries that are never read.
    if (movie.providerSince !== undefined && movie.providerSeen !== undefined) continue;
    stampProviderSightings(movie);
    await dbPut("movies", movie.traktId, movie);
  }
  localStorage.setItem(PROVIDER_SINCE_SEEDED_KEY, new Date().toISOString());
}

const PROVIDERS_TRIMMED_KEY = "watchwhat.providersTrimmed";

/**
 * Drop cached watch listings for countries that are never read, once, asking TMDB nothing.
 *
 * TMDB answers `watch/providers` for about 40 countries and everything that reads them — the
 * where-to-watch card, the poster badge, the service picker, Releases — iterates the six in
 * settings. Records cached before the fetch was narrowed still carry all of it: 6.9 MB across
 * this library against 0.8 MB for the countries actually consulted, in IndexedDB and in every
 * export. New fetches are already trimmed at the API boundary; this reclaims the back catalogue
 * without waiting a fortnight for TTLs to turn it over.
 */
export async function trimProviderCountries(): Promise<void> {
  if (localStorage.getItem(PROVIDERS_TRIMMED_KEY)) return;
  const countries = watchCountryList();
  // Settings not filled in yet. Trimming to nothing would throw away every listing on the
  // device to save space it is about to want back.
  if (countries.length === 0) return;

  const trim = (rec: { providers?: Record<string, unknown> }): boolean => {
    let changed = false;
    for (const cc of Object.keys(rec.providers ?? {})) {
      if (countries.includes(cc)) continue;
      delete rec.providers![cc];
      changed = true;
    }
    return changed;
  };

  const movies = await dbGetAll<MovieRec>("movies");
  for (const movie of movies) if (trim(movie)) await dbPut("movies", movie.traktId, movie);
  const episodes = await dbGetAll<EpisodesRec>("episodes");
  for (const rec of episodes) if (trim(rec)) await dbPut("episodes", rec.traktId, rec);

  localStorage.setItem(PROVIDERS_TRIMMED_KEY, new Date().toISOString());
}

/** Within a month of any known date — when listings actually move, in either direction. */
function nearRelease(movie: MovieRec): boolean {
  const now = Date.now();
  return knownDates(movie).some((t) => Math.abs(t - now) < 30 * DAY);
}

/**
 * Unwatched, no streaming date known, and inside the stretch where an announcement could
 * plausibly exist — the films whose announcement is the thing being waited for.
 *
 * `nearRelease` cannot cover this: it is computed from the dates, so a film whose digital date has
 * not been announced is never near anything and would never be asked about. That is circular
 * exactly where JustWatch's `upcomingReleases` has an answer TMDB does not.
 *
 * The window comes from the same estimate the movie page shows, which is what keeps this from
 * being a poll. A film nine months from cinemas has nothing booked to find, and one long past its
 * own p75 has stopped following the pattern that would predict it — both are requests against an
 * unofficial API that can only come back empty.
 *
 * It also only widens *which* films are asked about, never how often: these sit in the 7-day
 * bucket in `detailsMaxAge`. Widening the TTL as well is what would make it expensive.
 */
function awaitingRelease(movie: MovieRec, gap: GapQuartiles): boolean {
  if (movie.plays > 0 || movie.streamingRelease) return false;
  const released = movie.released ? new Date(movie.released).getTime() : NaN;
  if (!Number.isFinite(released)) return false;
  const { from, until } = announcementWindow(gap, released);
  const now = Date.now();
  return now >= from && now <= until;
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

/**
 * Let JustWatch's announced dates stand in for TMDB's, where it has them.
 *
 * TMDB files the buy/rent drop and the subscription launch under one release type and separates
 * them only by a free-text note, which is a guess in both directions — "Rakuten TV / TVOD" reads
 * as streaming, and "Apple TV" cannot be told apart from "Apple TV Store". JustWatch answers the
 * same question structurally: the date comes with the package, and the package says whether it is
 * a subscription. These entries are also per watch country by construction, since that is what
 * was asked for.
 *
 * It only ever *announces*. JustWatch empties `upcomingReleases` once a title is out, so nothing
 * here can restate a date that has passed — which is why TMDB stays the fallback rather than
 * being replaced.
 */
function applyUpcoming(movie: MovieRec, upcoming: JustWatchUpcoming[]): void {
  const earliest = (kind: JustWatchUpcoming["kind"]): JustWatchUpcoming | null =>
    upcoming.filter((u) => u.kind === kind).sort((a, b) => (a.date < b.date ? -1 : 1))[0] ?? null;

  const stream = earliest("stream");
  if (stream) movie.streamingRelease = { date: stream.date, country: stream.country, note: stream.service };

  const store = earliest("rent");
  // A date that has already passed while a watch country is still counting down means the film is
  // out somewhere else, not here — so the announced local date is the one worth showing.
  const known = movie.digitalRelease ? new Date(movie.digitalRelease.date).getTime() : null;
  if (store && (known === null || !Number.isFinite(known) || known < Date.now())) {
    movie.digitalRelease = { date: store.date, country: store.country };
  }
}

/**
 * How long another device's JustWatch answer stands in for asking again.
 *
 * Matched to the 6h bucket in `detailsMaxAge` that drives the top-up in the first place, so the
 * shared row is fresh for exactly as long as this device would have considered its own answer
 * fresh. Longer would be a different TTL wearing a disguise.
 */
const SHARED_JW_TTL = 6 * 3600 * 1000;

/**
 * Fetch the shared JustWatch answers for whichever of this batch look likely to want a top-up.
 *
 * **Eligibility is judged on the dates already cached, before TMDB is asked.** After the refresh
 * a film's dates can change and move it in or out of the window, so this can miss one and it can
 * ask about one that turns out not to need it. Both are harmless — a miss just fetches directly
 * and publishes, and the alternative is either one request per film or restructuring the loop
 * into two passes over the network. Neither is worth it for a handful of titles.
 *
 * Failure is not an error here. The shared cache is an optimisation, and a Worker that cannot be
 * reached means every device simply behaves as it did before this existed.
 */
async function pullSharedTopUps(
  movies: Map<number, MovieRec>,
  stale: number[],
  streamGap: GapQuartiles,
): Promise<Map<number, SharedTitle>> {
  const out = new Map<number, SharedTitle>();
  if (!syncConfigured()) return out;

  const byTmdb = new Map<string, number>();
  for (const traktId of stale) {
    const movie = movies.get(traktId);
    if (!movie?.ids.tmdb) continue;
    if (!nearRelease(movie) && !awaitingRelease(movie, streamGap)) continue;
    byTmdb.set(`movie:${movie.ids.tmdb}`, traktId);
  }
  if (byTmdb.size === 0) return out;

  try {
    const rows = await pullTitles([...byTmdb.keys()]);
    for (const [key, row] of Object.entries(rows)) {
      const traktId = byTmdb.get(key);
      // A row can exist with only the TMDB half written — a refresh that was not near enough to
      // a release to top up. That is not an answer to replay here, and treating it as one would
      // report a film as verified against JustWatch when nobody had asked.
      if (traktId === undefined || !row.jwFetched || !row.jwVerified) continue;
      const fetchedAt = Date.parse(row.jwFetched);
      if (!Number.isFinite(fetchedAt)) continue;
      if (Date.now() - fetchedAt > SHARED_JW_TTL) continue; // there, but no fresher than asking
      out.set(traktId, row);
    }
  } catch {
    // Deliberately silent: nothing is broken, there is just no shortcut this time.
  }
  return out;
}

const TITLES_CURSOR_KEY = "watchwhat.titlesCursor";

/** Pages to take in one go, so a first run against a full table cannot spin forever. */
const MAX_CONVERGE_PAGES = 20;

/**
 * Take on whatever another device has learned since last time. **This is what makes two clients
 * agree**, and the read-through before a refresh is not — a device that is about to fetch gets
 * fresh data anyway. The problem was always the device *not* fetching, sitting on an answer up to
 * a seven-day TTL old while the other one had better. So this runs on every sync instead.
 *
 * **`tmdbFetchedAt` is deliberately left alone.** Adopting shared facts is not the same as having
 * refreshed the record: artwork, cast, overview and the trailer come from the same TMDB call and
 * are not in the shared row. Bumping the timestamp would restart this device's TTL and, on a
 * device that always converged before it refreshed, freeze those fields forever. Leaving it means
 * the film still refreshes on its own schedule and simply displays the better answer meanwhile.
 *
 * Returns whether anything changed, so the caller can redraw only when it must.
 */
export async function convergeSharedTitles(): Promise<boolean> {
  if (!syncConfigured()) return false;
  let cursor = localStorage.getItem(TITLES_CURSOR_KEY) ?? "";
  let byTmdb: Map<number, MovieRec> | null = null;
  let changed = false;

  try {
    for (let page = 0; page < MAX_CONVERGE_PAGES; page++) {
      const res = await pullTitlesSince(cursor);
      const rows = Object.entries(res.titles);
      if (rows.length > 0) {
        // Loaded once, and only if a page actually carried something — most pulls are empty.
        byTmdb ??= new Map([...(await loadMovies()).values()].filter((m) => m.ids.tmdb).map((m) => [m.ids.tmdb!, m]));
        for (const [key, row] of rows) {
          const [kind, id] = key.split(":");
          if (kind !== "movie") continue; // shows have no shared fields written yet
          const movie = byTmdb.get(Number(id));
          if (!movie || !adoptSharedTitle(movie, row)) continue;
          await dbPut("movies", movie.traktId, movie);
          changed = true;
        }
      }
      // Only after the page is applied, so a failure resumes rather than skipping it.
      cursor = res.cursor;
      localStorage.setItem(TITLES_CURSOR_KEY, cursor);
      if (!res.more) break;
    }
  } catch {
    // Best-effort, like every other call to the shared table: the cursor has not moved past
    // anything unapplied, so the next sync simply resumes.
  }
  return changed;
}

/** Apply one shared row to a local record. False when it had nothing better to offer. */
function adoptSharedTitle(movie: MovieRec, row: SharedTitle): boolean {
  const fetchedAt = row.tmdbFetched ? Date.parse(row.tmdbFetched) : NaN;
  if (!Number.isFinite(fetchedAt) || !row.tmdbProviders) return false;
  // This device asked more recently than whoever wrote the row, so its own answer is the better
  // one. Newest *fetch* wins here exactly as it does on the server.
  if (movie.tmdbFetchedAt != null && movie.tmdbFetchedAt >= fetchedAt) return false;

  // Rebuilt from the two halves rather than from a stored merge — the merge is additive and
  // never removes, so re-merging onto a previous merge would make JustWatch's additions
  // permanent. This reproduces exactly what the writing device had.
  movie.providers = row.jwProviders ? mergeJustWatch(row.tmdbProviders, row.jwProviders) : row.tmdbProviders;
  movie.providersVersion = PROVIDERS_VERSION;
  movie.digitalRelease = row.dates?.digital ?? null;
  movie.streamingRelease = row.dates?.streaming ?? null;
  if (row.providerSince) movie.providerSince = row.providerSince;
  if (row.jwNodeId) movie.jwNodeId = row.jwNodeId;
  if (row.jwVerified && row.jwFetched) movie.topUp = { at: Date.parse(row.jwFetched), stage: row.jwVerified };
  return true;
}

/** Publish what this device learned, so the other one does not have to ask. Best-effort. */
async function publishSharedTopUps(publish: Record<string, TitleWrite>): Promise<void> {
  if (Object.keys(publish).length === 0 || !syncConfigured()) return;
  try {
    await pushTitles(publish);
  } catch {
    // The answer is already stored locally; sharing it is a bonus, not a commitment.
  }
}

/** TMDB artwork/cast/providers for movies missing or outgrowing their cache, limited concurrency. */
export async function ensureMovieDetails(
  movies: Map<number, MovieRec>,
  traktIds: number[],
  onUpdate?: () => void,
  opts?: { skipWatchedRefresh?: boolean; force?: boolean },
): Promise<void> {
  const wanted = watchCountryList();
  const stale = traktIds.filter((id) => {
    const movie = movies.get(id);
    if (!movie?.ids.tmdb) return false;
    // Asked for by hand, so the TTL has no say: the point of the button is that
    // the cached answer is the thing being disputed.
    if (opts?.force) return true;
    if (movie.tmdbFetchedAt == null) return true;
    // Bulk refreshes leave watched movies alone — their details are fetched
    // once and only re-fetched when the movie page itself is opened.
    if (opts?.skipWatchedRefresh && movie.plays > 0) return false;
    if (movie.digitalRelease === undefined) return true; // backfill new field
    if (movie.streamingRelease === undefined) return true; // backfill new field
    if (movie.providersVersion !== PROVIDERS_VERSION) return true; // cached before rent was kept
    // A watch country added since this record was cached has no listings stored for it, because
    // providers are now kept only for the countries in settings. `providerSeen` being absent
    // means the record predates that field rather than missing a country — `seedProviderSince`
    // fills it in without a request, so refetching here instead would put the whole library
    // through TMDB the first time this runs.
    if (movie.providerSeen && wanted.some((cc) => !movie.providerSeen!.includes(cc))) return true;
    return Date.now() - movie.tmdbFetchedAt > detailsMaxAge(movie);
  });
  if (stale.length === 0) return;

  // Once for the whole batch: the window is a property of the library, not of any one film.
  const streamGap = gapQuartiles(movies.values(), "stream");
  const shared = opts?.force ? new Map<number, SharedTitle>() : await pullSharedTopUps(movies, stale, streamGap);
  const publish: Record<string, TitleWrite> = {};
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
    // Near a release with the dates TMDB just returned, or still waiting for the date itself —
    // the two windows where TMDB is known to be behind, and nothing else, which keeps this off
    // the other ~320 titles. A hand-asked refresh always tops up, whatever the dates say: someone
    // pressing the button is reporting that TMDB looks wrong, which is why this fallback exists.
    if (movie.ids.tmdb && (opts?.force || nearRelease(movie) || awaitingRelease(movie, streamGap))) {
      // Another device asked recently enough — replay its answer rather than asking again. This
      // is the whole point of the shared table: the top-up runs on a 6h cadence for the
      // near-release handful, so two devices otherwise pay for the same question twice.
      const cached = shared.get(traktId);
      if (cached?.jwFetched && cached.jwVerified) {
        movie.jwNodeId = cached.jwNodeId;
        if (cached.jwProviders) movie.providers = mergeJustWatch(movie.providers ?? {}, cached.jwProviders);
        if (cached.jwUpcoming) applyUpcoming(movie, cached.jwUpcoming);
        // Adopted rather than observed, so the card says the same thing on both devices — which
        // is exactly the "a warning on one device means nothing about another" gotcha, gone.
        movie.topUp = { at: Date.parse(cached.jwFetched), stage: cached.jwVerified };
      } else {
        const { offers, upcoming, outcome, nodeId } = await fetchJustWatchOffers(
          movie.title,
          movie.ids.tmdb,
          watchCountryList(),
          movie.jwNodeId,
        );
        // Written back even when null: an id that stopped resolving is worse than none, since it
        // costs a wasted request before the search it was meant to save.
        movie.jwNodeId = nodeId;
        if (offers) movie.providers = mergeJustWatch(movie.providers ?? {}, offers);
        if (upcoming) applyUpcoming(movie, upcoming);
        // Kept per title rather than read from the global health record afterwards: this loop runs
        // four movies at once, so the shared record belongs to whichever finished last.
        movie.topUp = outcome;
        // Only a real answer is worth sharing. `reach` and `offers` describe this device's
        // network or a schema change, not the film, and publishing one would hand a second
        // device a problem it does not have.
        if (outcome.stage === "ok" || outcome.stage === "search") {
          publish[`movie:${movie.ids.tmdb}`] = {
            ...publish[`movie:${movie.ids.tmdb}`],
            jwProviders: offers,
            jwUpcoming: upcoming,
            jwNodeId: nodeId,
            jwVerified: outcome.stage,
            jwFetched: new Date(outcome.at).toISOString(),
          };
        }
      }
    }
    // After the JustWatch merge, so a listing that only JustWatch knows about is stamped on the
    // day it actually appeared rather than whenever TMDB catches up.
    stampProviderSightings(movie);
    movie.tmdbFetchedAt = Date.now();
    await dbPut("movies", traktId, movie);
    // Share what TMDB just said, so a device whose own TTL has not expired can show it rather
    // than sitting on a week-old answer. `extras.providersByCountry` and not `movie.providers`:
    // the shared column holds TMDB's answer *before* the JustWatch merge, and `mergeJustWatch`
    // builds a new object rather than adding to this one, so it is still unmerged here.
    publish[`movie:${movie.ids.tmdb}`] = {
      ...publish[`movie:${movie.ids.tmdb}`],
      tmdbProviders: extras.providersByCountry,
      // Read after the merge and after `applyUpcoming`, which is the point: these are the dates
      // the other device should end up with, not the ones TMDB alone reported.
      dates: { digital: movie.digitalRelease ?? null, streaming: movie.streamingRelease ?? null },
      providerSince: movie.providerSince ?? null,
      tmdbFetched: new Date(movie.tmdbFetchedAt).toISOString(),
    };
    notify.tick();
  });
  notify.done();
  await publishSharedTopUps(publish);
}

export async function setMovieWatched(
  movies: Map<number, MovieRec>,
  movie: MovieRec,
  watched: boolean,
  opts?: MutationOpts,
): Promise<void> {
  const at = opts?.at ?? new Date().toISOString();
  // A film has no per-episode flag to compare against, so the event's own
  // timestamp is its identity: the same watch arriving twice is the same watch.
  // Without this, re-pulling the log adds a play per replay — and unlike a
  // rewatch tapped here, that is never something that happened.
  if (opts?.replay && watched && movie.plays > 0 && movie.lastWatchedAt === at) return;
  movie.plays = watched ? movie.plays + 1 : 0;
  movie.lastWatchedAt = watched ? at : null;
  movies.set(movie.traktId, movie);
  await dbPut("movies", movie.traktId, movie);
  if (movie.ids.tmdb && !opts?.replay) {
    await enqueue(watched ? "movie.watched" : "movie.unwatched", { movie: movie.ids.tmdb, at });
  }
  emitChange();
}

export async function setMovieOnWatchlist(
  movies: Map<number, MovieRec>,
  movie: MovieRec,
  onList: boolean,
  opts?: MutationOpts,
): Promise<void> {
  const at = opts?.at ?? new Date().toISOString();
  movie.onWatchlist = onList;
  movie.listedAt = onList ? at : null;
  movies.set(movie.traktId, movie);
  await dbPut("movies", movie.traktId, movie);
  if (movie.ids.tmdb && !opts?.replay) {
    await enqueue(onList ? "watchlist.add" : "watchlist.remove", { type: "movie", tmdb: movie.ids.tmdb, at });
  }
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
  opts?: MutationOpts,
): Promise<void> {
  const without = (movie.customLists ?? []).filter((id) => id !== listId);
  // Removing first keeps a replayed add from listing the same movie twice.
  movie.customLists = on ? [...without, listId] : without;
  movies.set(movie.traktId, movie);
  await dbPut("movies", movie.traktId, movie);
  if (movie.ids.tmdb && !opts?.replay) {
    await enqueue(on ? "list.add" : "list.remove", { movie: movie.ids.tmdb, list: listId, at: opts?.at ?? now() });
  }
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
  at?: string,
): void {
  const nowIso = at ?? new Date().toISOString();

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
    let season = progress?.seasons.find((s) => s.number === ep.season);
    let entry = season?.episodes.find((e) => e.number === ep.number);

    // Already in the state being asked for, so this changes nothing — and must
    // therefore count nothing. Incrementing `plays` regardless is what made a
    // replayed log inflate every total on a device that already had the
    // history, while the episode flags themselves stayed correct.
    if (entry && entry.completed === watched) continue;

    // An episode this device's progress has never heard of, because its cache is
    // older than the event — the ordinary case when a replayed log is newer than
    // the local metadata. The watch has to land anyway: the cursor advances past
    // this event either way, so anything dropped here is dropped permanently.
    // Same reasoning as the fallback in `progressFromEpisodes`, which keeps a
    // watched episode that the episode list cannot describe.
    if (!entry && watched && progress) {
      if (!season) {
        season = { number: ep.season, aired: 0, completed: 0, episodes: [] };
        progress.seasons.push(season);
        progress.seasons.sort((a, b) => a.number - b.number);
      }
      entry = { number: ep.number, completed: false, watchedAt: null };
      season.episodes.push(entry);
      season.episodes.sort((a, b) => a.number - b.number);
      season.aired++;
      if (ep.season > 0) progress.aired++; // totals exclude specials
    }
    // Nothing to unwatch, so there is no play to take back either.
    if (progress && !entry) continue;

    if (watchedRec) {
      watchedRec.plays = Math.max(0, watchedRec.plays + (watched ? 1 : -1));
      if (watched) watchedRec.lastWatchedAt = nowIso;
    }
    if (progress && season && entry) {
      entry.completed = watched;
      entry.watchedAt = watched ? nowIso : null;
      season.completed += watched ? 1 : -1;
      if (ep.season > 0) progress.completed += watched ? 1 : -1; // totals exclude specials
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
  opts?: MutationOpts,
): Promise<void> {
  const at = opts?.at ?? new Date().toISOString();
  applyLocalWatch(lib, showTraktId, episodes, watched, await dbGet<EpisodesRec>("episodes", showTraktId), at);
  await persistShowState(lib, showTraktId);
  // One event per episode, for exactly the set that was asked for — replaying
  // them makes the same call on the other device, so the two land identically.
  // "Mark the season" therefore arrives as a season's worth of events, which is
  // also what makes a later single-episode unwatch expressible.
  const tmdb = lib.shows.get(showTraktId)?.ids.tmdb;
  if (tmdb && !opts?.replay) {
    const kind = watched ? "episode.watched" : "episode.unwatched";
    for (const ep of episodes) await enqueue(kind, { show: tmdb, season: ep.season, number: ep.number, at });
  }
  emitChange();
}

export async function addToWatchlist(lib: Library, show: ShowRec, opts?: MutationOpts): Promise<void> {
  // Search hands over either a record already in the library or a freshly
  // minted one; either way keep whatever the cache already knew.
  const rec = { ...show, ...lib.shows.get(show.traktId) };
  const at = opts?.at ?? new Date().toISOString();
  lib.shows.set(rec.traktId, rec);
  // Filtered first so this is idempotent: replaying an add for a show already
  // listed must not leave two entries for it.
  lib.watchlist = [{ traktId: rec.traktId, listedAt: at }, ...lib.watchlist.filter((e) => e.traktId !== rec.traktId)];
  await Promise.all([dbPut("shows", rec.traktId, rec), dbPut("meta", "watchlist", lib.watchlist)]);
  if (rec.ids.tmdb && !opts?.replay) await enqueue("watchlist.add", { type: "show", tmdb: rec.ids.tmdb, at });
  emitChange();
}

/** Stop/resume tracking a show (Library's Stopped bucket). */
export async function setShowHidden(
  lib: Library,
  traktId: number,
  hidden: boolean,
  opts?: MutationOpts,
): Promise<void> {
  if (!lib.shows.has(traktId)) return;
  if (hidden) lib.hidden.add(traktId);
  else lib.hidden.delete(traktId);
  await dbPut("meta", "hidden", [...lib.hidden]);
  const tmdb = lib.shows.get(traktId)?.ids.tmdb;
  if (tmdb && !opts?.replay) {
    await enqueue(hidden ? "show.hidden" : "show.unhidden", { show: tmdb, at: opts?.at ?? now() });
  }
  emitChange();
}

export async function removeFromWatchlist(lib: Library, showTraktId: number, opts?: MutationOpts): Promise<void> {
  if (!lib.shows.has(showTraktId)) return;
  lib.watchlist = lib.watchlist.filter((e) => e.traktId !== showTraktId);
  await dbPut("meta", "watchlist", lib.watchlist);
  const tmdb = lib.shows.get(showTraktId)?.ids.tmdb;
  if (tmdb && !opts?.replay) {
    await enqueue("watchlist.remove", { type: "show", tmdb, at: opts?.at ?? now() });
  }
  emitChange();
}
