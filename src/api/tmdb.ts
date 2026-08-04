/** TMDB: search, metadata, episode lists, artwork, cast and watch providers. */

import { getSettings } from "../data/settings";

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/";

export interface ShowImages {
  poster: string | null; // TMDB path like "/abc.jpg"
  backdrop: string | null;
  /** TMDB description — fallback when the record has no overview yet. */
  overview: string | null;
}

export async function fetchShowImages(tmdbId: number): Promise<ShowImages | null> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) return null;
  const res = await fetch(`${API}/tv/${tmdbId}?api_key=${encodeURIComponent(tmdbApiKey)}`);
  if (res.status === 404) return { poster: null, backdrop: null, overview: null };
  if (!res.ok) return null; // bad key / network — try again another time
  const data = (await res.json()) as { poster_path: string | null; backdrop_path: string | null; overview: string | null };
  return { poster: data.poster_path, backdrop: data.backdrop_path, overview: data.overview || null };
}

export interface TmdbMovieExtras {
  poster: string | null;
  backdrop: string | null;
  overview: string | null;
  trailer: string | null;
  cast: TmdbCastMember[];
  providersByCountry: Record<string, TmdbCountryProviders>;
  /** Earliest digital release that is not a subscription launch — when it can be bought or rented. */
  digitalRelease: { date: string; country: string } | null;
  /** Digital release noted with the services, e.g. "Disney+ / Hulu", in a watch country only. */
  streamingRelease: { date: string; country: string; note: string } | null;
}

/**
 * The countries watch listings are kept for.
 *
 * TMDB answers `watch/providers` for roughly 40 countries and nothing reads more than these:
 * the where-to-watch card, the poster badge, the service picker and the Releases screen all
 * iterate this same list. Storing the rest cost 6.9 MB across the library against 0.8 MB for
 * the ones actually consulted — data kept only to be skipped by an `if`, in every record and
 * every export. Release *dates* are deliberately not filtered this way: `buyGlobal` falls back
 * to the earliest announcement anywhere on purpose.
 */
function watchCountries(): string[] {
  return getSettings().watchCountries.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
}

/**
 * Notes that name the transaction, not a service: the entry is a buy/rent date that happens to
 * carry a note. Matched as whole words so SVOD and AVOD — which are subscription and ad-supported
 * — are left alone; only the transactional spellings are listed.
 */
const TRANSACTIONAL_NOTE = /\b(tvod|pvod|dto|vod|rent|rental|buy|purchase|premium video on demand|download to own)\b/i;

/**
 * Notes that name a *storefront* rather than a subscription — the other half of the same
 * problem. `TRANSACTIONAL_NOTE` catches an entry that says what the transaction is; this catches
 * one that says only where to buy it, which reads as a service and is not one. *Supergirl* is
 * the case that proved it: an `iTunes / Apple TV` entry filed as a streaming launch, so a film
 * every country still charged for sat in Releases under "Coming soon" with a rental badge beside
 * the date contradicting it.
 *
 * **Bare `Apple TV` and bare `YouTube` are deliberately absent.** Each names both a store and a
 * subscription — Apple TV the storefront against Apple TV+, YouTube against YouTube Premium —
 * and TMDB's free text cannot tell them apart. Filing a real subscription launch as a purchase
 * is the expensive direction: a missing date costs a surprise, a wrong one reads as "you still
 * have to pay" for something already included. The spelling that actually turns up,
 * `iTunes / Apple TV`, is caught by `itunes` without touching Apple TV+.
 *
 * Whole words throughout, so `Amazon Video` (the store) matches while `Amazon Prime Video` (the
 * subscription) does not.
 */
const STOREFRONT_NOTE =
  /\b(itunes|google play|youtube movies|vudu|fandango at home|microsoft store|amazon video|rakuten tv|sky store|chili|blockbuster|sf anytime|viaplay store|maxdome store)\b/i;

/** A note that describes buying rather than subscribing, by either route. */
const buysRatherThanStreams = (note: string): boolean => TRANSACTIONAL_NOTE.test(note) || STOREFRONT_NOTE.test(note);

/** Poster path only — for movie search results. */
export async function fetchMoviePoster(tmdbId: number): Promise<string | null> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) return null;
  const res = await fetch(`${API}/movie/${tmdbId}?api_key=${encodeURIComponent(tmdbApiKey)}`);
  if (!res.ok) return null;
  return ((await res.json()) as { poster_path: string | null }).poster_path;
}

/** Movie artwork + cast + watch providers, one request. */
export async function fetchMovieExtras(tmdbId: number): Promise<TmdbMovieExtras | null> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) return null;
  const res = await fetch(
    `${API}/movie/${tmdbId}?api_key=${encodeURIComponent(tmdbApiKey)}&append_to_response=credits,watch/providers,release_dates,videos`,
  );
  if (!res.ok) return null;
  interface RawProviderEntry {
    provider_name: string;
    logo_path: string | null;
  }
  const data = (await res.json()) as {
    poster_path: string | null;
    backdrop_path: string | null;
    overview: string | null;
    credits?: { cast?: { id: number; name: string; character?: string | null; profile_path: string | null }[] };
    "watch/providers"?: {
      results?: Record<
        string,
        { link?: string; flatrate?: RawProviderEntry[]; free?: RawProviderEntry[]; ads?: RawProviderEntry[]; rent?: RawProviderEntry[] }
      >;
    };
    release_dates?: {
      results?: { iso_3166_1: string; release_dates?: { release_date: string; type: number; note?: string }[] }[];
    };
    videos?: RawVideos;
  };

  // TMDB files two different events under type 4 (Digital): the buy/rent drop, and the date it
  // starts streaming on a subscription. Nothing in the schema separates them — only the
  // free-text note ("Disney+ / Hulu") marks the streaming one. So they are split on exactly
  // that, and kept apart rather than collapsed to one "digital" date, because they answer
  // different questions: when can I pay for this, versus when is it included in something I
  // already have. The noted date also lands here well before watch/providers catches up, so it
  // is often the only advance warning available.
  // The buy date prefers the user's countries and falls back to the earliest anywhere; the
  // streaming one does not fall back at all. See below for why.
  const userCountries = watchCountries();
  let buyUser: { date: string; country: string } | null = null;
  let buyGlobal: { date: string; country: string } | null = null;
  let noteUser: { date: string; country: string; note: string } | null = null;
  for (const region of data.release_dates?.results ?? []) {
    for (const rel of region.release_dates ?? []) {
      if (rel.type !== 4 || !rel.release_date) continue;
      const candidate = { date: rel.release_date, country: region.iso_3166_1 };
      const mine = userCountries.includes(candidate.country);
      const note = rel.note?.trim();
      // A note describing the *transaction* rather than a service is a buy/rent entry that
      // happens to be annotated, so it must not be read as a subscription launch. "Rakuten TV /
      // TVOD" is the case that proved it: TVOD is transactional by definition, and reading it as
      // streaming made a rent-only film claim "Streaming since Jul 21" while every country still
      // charged for it. Note that SVOD and AVOD deliberately do not match \bvod\b.
      if (note && !buysRatherThanStreams(note)) {
        const noted = { ...candidate, note };
        // Only the user's own countries. A subscription is per-country by nature, so a launch in
        // a country you cannot watch in says nothing about yours — and being wrong here is the
        // expensive direction: it reads as "you already have this" when you would have to pay.
        if (mine && (!noteUser || noted.date < noteUser.date)) noteUser = noted;
      } else {
        if (mine && (!buyUser || candidate.date < buyUser.date)) buyUser = candidate;
        if (!buyGlobal || candidate.date < buyGlobal.date) buyGlobal = candidate;
      }
    }
  }

  const out: TmdbMovieExtras = {
    poster: data.poster_path,
    backdrop: data.backdrop_path,
    overview: data.overview || null,
    trailer: trailerFrom(data.videos),
    cast: (data.credits?.cast ?? [])
      .slice(0, 15)
      .map((c) => ({ tmdbId: c.id, name: c.name, character: c.character ?? null, profile: c.profile_path })),
    providersByCountry: {},
    digitalRelease: buyUser ?? buyGlobal,
    streamingRelease: noteUser,
  };
  for (const [country, entry] of Object.entries(data["watch/providers"]?.results ?? {})) {
    if (!userCountries.includes(country)) continue;
    const providers: TmdbProvider[] = [
      ...(entry.flatrate ?? []).map((p): TmdbProvider => ({ name: p.provider_name, logo: p.logo_path, kind: "stream" })),
      ...(entry.free ?? []).map((p): TmdbProvider => ({ name: p.provider_name, logo: p.logo_path, kind: "free" })),
      ...(entry.ads ?? []).map((p): TmdbProvider => ({ name: p.provider_name, logo: p.logo_path, kind: "ads" })),
      // Rent costs money, so it stays visually distinct from anything a subscription covers.
      ...(entry.rent ?? []).map((p): TmdbProvider => ({ name: p.provider_name, logo: p.logo_path, kind: "rent" })),
    ];
    if (providers.length > 0) out.providersByCountry[country] = { link: entry.link ?? null, providers };
  }
  return out;
}

// ---------- search ----------

/** A search hit, in the few fields a result row shows. */
export interface TmdbSearchHit {
  kind: "show" | "movie";
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string | null;
  poster: string | null;
  /** How many people voted — TMDB's only popularity signal, used to break ties. */
  popularity: number;
}

interface RawSearchHit {
  id: number;
  media_type?: string;
  name?: string;
  title?: string;
  first_air_date?: string;
  release_date?: string;
  overview?: string | null;
  poster_path?: string | null;
  popularity?: number;
}

const yearOf = (date: string | undefined): number | null => {
  const year = Number(date?.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
};

function toHit(raw: RawSearchHit, kind: "show" | "movie"): TmdbSearchHit {
  return {
    kind,
    tmdbId: raw.id,
    title: (kind === "show" ? raw.name : raw.title) ?? "",
    year: yearOf(kind === "show" ? raw.first_air_date : raw.release_date),
    overview: raw.overview || null,
    poster: raw.poster_path ?? null,
    popularity: raw.popularity ?? 0,
  };
}

async function search(path: string, query: string): Promise<RawSearchHit[]> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) return [];
  const url = `${API}/search/${path}?api_key=${encodeURIComponent(tmdbApiKey)}&query=${encodeURIComponent(query)}&include_adult=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status === 401 ? "TMDB rejected the API key — check it in Settings." : `TMDB search failed: ${res.status}`);
  return ((await res.json()) as { results?: RawSearchHit[] }).results ?? [];
}

export async function searchTmdbShows(query: string): Promise<TmdbSearchHit[]> {
  return (await search("tv", query)).map((r) => toHit(r, "show"));
}

export async function searchTmdbMovies(query: string): Promise<TmdbSearchHit[]> {
  return (await search("movie", query)).map((r) => toHit(r, "movie"));
}

/** Both kinds at once. `/search/multi` also returns people — dropped here. */
export async function searchTmdbAll(query: string): Promise<TmdbSearchHit[]> {
  return (await search("multi", query))
    .filter((r) => r.media_type === "tv" || r.media_type === "movie")
    .map((r) => toHit(r, r.media_type === "tv" ? "show" : "movie"));
}

/** A show's headline metadata — the fields a ShowRec carries, plus its season list. */
export interface TmdbShowSummary {
  title: string;
  year: number | null;
  status?: string;
  network?: string;
  overview?: string;
  genres?: string[];
  runtime?: number | null;
  rating?: number | null;
  firstAired?: string | null;
  imdb?: string | null;
  trailer: string | null;
  seasonNumbers: number[];
}

interface RawVideos {
  results?: { key: string; site: string; type: string; official?: boolean }[];
}

/**
 * Pick a YouTube trailer, official first. Returns null rather than undefined
 * when there is none: undefined means "never looked", and the show page uses
 * that to decide whether to backfill — so an unset value would make every
 * trailer-less title refetch on every open, forever.
 */
function trailerFrom(videos: RawVideos | undefined): string | null {
  const clips = (videos?.results ?? []).filter((v) => v.site === "YouTube" && v.type === "Trailer");
  const pick = clips.find((v) => v.official) ?? clips[0];
  return pick ? `https://www.youtube.com/watch?v=${pick.key}` : null;
}

/**
 * Trakt spelled statuses lowercase ("ended", "canceled") and several checks
 * still compare against those literals; TMDB sends "Ended" / "Returning
 * Series". Normalising here keeps the vocabulary in one place rather than
 * spreading case-insensitive comparisons through the UI.
 */
const normaliseStatus = (s: string | null | undefined): string | undefined => s?.toLowerCase() || undefined;

export async function fetchShowSummary(tmdbId: number): Promise<TmdbShowSummary | null> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) return null;
  const res = await fetch(`${API}/tv/${tmdbId}?api_key=${encodeURIComponent(tmdbApiKey)}&append_to_response=external_ids,videos`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    name?: string;
    first_air_date?: string;
    status?: string;
    overview?: string | null;
    networks?: { name: string }[];
    genres?: { name: string }[];
    episode_run_time?: number[];
    vote_average?: number;
    seasons?: { season_number: number }[];
    external_ids?: { imdb_id?: string | null };
    videos?: RawVideos;
  };
  return {
    title: data.name ?? "",
    year: yearOf(data.first_air_date),
    status: normaliseStatus(data.status),
    network: data.networks?.[0]?.name,
    overview: data.overview || undefined,
    genres: data.genres?.map((g) => g.name),
    runtime: data.episode_run_time?.[0] ?? null,
    rating: data.vote_average ?? null,
    firstAired: data.first_air_date || null,
    imdb: data.external_ids?.imdb_id ?? null,
    trailer: trailerFrom(data.videos),
    seasonNumbers: (data.seasons ?? []).map((s) => s.season_number).sort((a, b) => a - b),
    // Deliberately no episode count: TMDB's `number_of_episodes` counts every
    // episode it knows about, including unaired ones, where `airedEpisodes`
    // means aired. The progress rebuild derives the real figure from air dates.
  };
}

/**
 * The season numbers TMDB lists for a show. Needed when a show was added from
 * search and so has no episode data of any kind to build a page from.
 */
export async function fetchSeasonNumbers(tmdbId: number): Promise<number[]> {
  return (await fetchShowSummary(tmdbId))?.seasonNumbers ?? [];
}

/** A movie's headline metadata — the fields a MovieRec carries. */
export interface TmdbMovieSummary {
  title: string;
  year: number | null;
  overview?: string;
  runtime?: number | null;
  rating?: number | null;
  genres?: string[];
  released?: string | null;
  imdb?: string | null;
}

export async function fetchMovieSummary(tmdbId: number): Promise<TmdbMovieSummary | null> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) return null;
  const res = await fetch(`${API}/movie/${tmdbId}?api_key=${encodeURIComponent(tmdbApiKey)}&append_to_response=external_ids`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    title?: string;
    release_date?: string;
    overview?: string | null;
    runtime?: number | null;
    vote_average?: number;
    genres?: { name: string }[];
    external_ids?: { imdb_id?: string | null };
    imdb_id?: string | null;
  };
  return {
    title: data.title ?? "",
    year: yearOf(data.release_date),
    overview: data.overview || undefined,
    runtime: data.runtime ?? null,
    rating: data.vote_average ?? null,
    genres: data.genres?.map((g) => g.name),
    released: data.release_date || null,
    imdb: data.external_ids?.imdb_id ?? data.imdb_id ?? null,
  };
}

export function posterUrl(path: string | null | undefined, size = "w342"): string | null {
  return path ? `${IMG}${size}${path}` : null;
}

export function stillUrl(path: string | null | undefined, size = "w300"): string | null {
  return path ? `${IMG}${size}${path}` : null;
}

export interface TmdbEpisode {
  season_number: number;
  episode_number: number;
  name: string | null;
  overview: string | null;
  still_path: string | null;
  air_date: string | null;
  vote_average?: number | null;
}

export interface TmdbCastMember {
  tmdbId: number;
  name: string;
  character: string | null;
  profile: string | null; // TMDB image path
}

export interface TmdbProvider {
  name: string;
  logo: string | null;
  /** "stream" (subscription) | "free" | "ads" | "rent" (paid per title) */
  kind: "stream" | "free" | "ads" | "rent";
}

export interface TmdbCountryProviders {
  /** JustWatch attribution link for this show+country (required by TMDB/JustWatch terms). */
  link: string | null;
  providers: TmdbProvider[];
}

export interface TmdbShowExtras {
  episodesBySeason: Map<number, TmdbEpisode[]>;
  cast: TmdbCastMember[];
  /** Watch providers by ISO country code (JustWatch data via TMDB). */
  providersByCountry: Record<string, TmdbCountryProviders>;
}

interface TmdbCreditsCast {
  id: number;
  name: string;
  character?: string | null;
  roles?: { character: string }[];
  profile_path: string | null;
  order?: number;
}

/**
 * Episode details (stills, overviews, air dates, ratings) for the given
 * seasons plus the main cast — all in batched requests via append_to_response
 * (max 20 appends per request, credits rides along with the first chunk).
 */
export async function fetchShowExtras(tmdbId: number, seasonNumbers: number[]): Promise<TmdbShowExtras> {
  const { tmdbApiKey } = getSettings();
  const out: TmdbShowExtras = { episodesBySeason: new Map(), cast: [], providersByCountry: {} };
  if (!tmdbApiKey) return out;

  // TMDB allows at most 20 appended sub-requests per call — credits/providers count too.
  const groups: string[][] = [];
  let current: string[] = ["aggregate_credits", "watch/providers"];
  for (const n of seasonNumbers) {
    if (current.length >= 20) {
      groups.push(current);
      current = [];
    }
    current.push(`season/${n}`);
  }
  if (current.length > 0) groups.push(current);

  for (const appends of groups) {
    const res = await fetch(
      `${API}/tv/${tmdbId}?api_key=${encodeURIComponent(tmdbApiKey)}&append_to_response=${appends.join(",")}`,
    );
    if (!res.ok) continue;
    interface RawProviderEntry {
      provider_name: string;
      logo_path: string | null;
    }
    const data = (await res.json()) as Record<string, unknown> & {
      aggregate_credits?: { cast?: TmdbCreditsCast[] };
      "watch/providers"?: {
        results?: Record<string, { link?: string; flatrate?: RawProviderEntry[]; free?: RawProviderEntry[]; ads?: RawProviderEntry[] }>;
      };
    };
    for (const append of appends) {
      if (!append.startsWith("season/")) continue;
      const n = Number(append.slice("season/".length));
      const season = data[append] as { episodes?: TmdbEpisode[] } | undefined;
      if (season?.episodes) out.episodesBySeason.set(n, season.episodes);
    }
    if (data.aggregate_credits?.cast) {
      out.cast = data.aggregate_credits.cast
        .slice(0, 15)
        .map((c) => ({ tmdbId: c.id, name: c.name, character: c.roles?.[0]?.character ?? c.character ?? null, profile: c.profile_path }));
    }
    if (data["watch/providers"]?.results) {
      const userCountries = watchCountries();
      for (const [country, entry] of Object.entries(data["watch/providers"].results)) {
        if (!userCountries.includes(country)) continue;
        const providers: TmdbProvider[] = [
          ...(entry.flatrate ?? []).map((p): TmdbProvider => ({ name: p.provider_name, logo: p.logo_path, kind: "stream" })),
          ...(entry.free ?? []).map((p): TmdbProvider => ({ name: p.provider_name, logo: p.logo_path, kind: "free" })),
          ...(entry.ads ?? []).map((p): TmdbProvider => ({ name: p.provider_name, logo: p.logo_path, kind: "ads" })),
        ];
        if (providers.length > 0) out.providersByCountry[country] = { link: entry.link ?? null, providers };
      }
    }
  }
  return out;
}

export function backdropUrl(path: string | null | undefined, size = "w780"): string | null {
  return path ? `${IMG}${size}${path}` : null;
}

// ---------- discover ----------

/**
 * A result from discover, trending or recommendations — the fields a poster card needs.
 *
 * `rating` is TMDB's own registered users voting 0..10, and it is the *only* score TMDB
 * publishes: there is nothing here from IMDb, Metacritic or Rotten Tomatoes, and no
 * endpoint that would add them. That is the whole reason `votes` rides along. Anyone can
 * rate on TMDB, so a forgotten film with four votes averaging 9.3 outranks everything real
 * the moment you sort or filter by score; a vote floor is what makes the score mean anything.
 */
export interface TmdbDiscoverHit {
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string | null;
  poster: string | null;
  rating: number | null;
  votes: number;
  released: string | null;
}

interface RawDiscoverHit {
  id: number;
  title?: string;
  release_date?: string;
  overview?: string | null;
  poster_path?: string | null;
  vote_average?: number;
  vote_count?: number;
}

function toDiscoverHit(raw: RawDiscoverHit): TmdbDiscoverHit {
  return {
    tmdbId: raw.id,
    title: raw.title ?? "",
    year: yearOf(raw.release_date),
    overview: raw.overview || null,
    poster: raw.poster_path ?? null,
    rating: raw.vote_average ?? null,
    votes: raw.vote_count ?? 0,
    released: raw.release_date || null,
  };
}

/**
 * TMDB release types. 4 is Digital and 6 is TV — together, "you can watch this at home
 * tonight", which is what Rotten Tomatoes shelves under *movies at home*. 3 is Theatrical
 * and is deliberately absent: a film still only in cinemas is the thing being excluded.
 */
export const RELEASE_TYPES_AT_HOME = "4|6";

export interface DiscoverMovieQuery {
  /**
   * TMDB sorts by the *primary* (usually theatrical) release date — there is no sort on the
   * digital date, which is the one "newest at home" actually means. Inside a short window it
   * is a fair proxy, because digital follows cinema by a fairly steady month or three, but a
   * film that reaches streaming years late will sort as old. `releasedFrom` is what makes the
   * set right; this only orders it.
   */
  sortBy?: "primary_release_date.desc" | "popularity.desc" | "vote_average.desc";
  /** Floor on TMDB's user score, 0..10. Only meaningful alongside `minVotes`. */
  minRating?: number;
  minVotes?: number;
  /** Pipe-separated TMDB release types; scopes the date window to those releases. */
  releaseTypes?: string;
  releasedFrom?: string;
  releasedTo?: string;
  /** One ISO country code. Required by `providers`. */
  watchRegion?: string;
  /** TMDB provider ids, OR-ed together. */
  providers?: number[];
  page?: number;
}

export interface DiscoverMoviePage {
  hits: TmdbDiscoverHit[];
  page: number;
  totalPages: number;
  totalResults: number;
}

const EMPTY_PAGE: DiscoverMoviePage = { hits: [], page: 1, totalPages: 0, totalResults: 0 };

export async function discoverMovies(query: DiscoverMovieQuery): Promise<DiscoverMoviePage> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) return EMPTY_PAGE;

  const params = new URLSearchParams({
    api_key: tmdbApiKey,
    include_adult: "false",
    include_video: "false",
    page: String(query.page ?? 1),
    sort_by: query.sortBy ?? "primary_release_date.desc",
  });
  if (query.minRating != null) params.set("vote_average.gte", String(query.minRating));
  if (query.minVotes != null) params.set("vote_count.gte", String(query.minVotes));
  if (query.releaseTypes) params.set("with_release_type", query.releaseTypes);
  // `release_date.*` rather than `primary_release_date.*` on purpose: paired with
  // `with_release_type` it filters on the dates of *those* release types, which is the only
  // way to ask "reached digital in the last two months". The primary-date pair would filter
  // on the cinema date and quietly answer a different question.
  if (query.releasedFrom) params.set("release_date.gte", query.releasedFrom);
  if (query.releasedTo) params.set("release_date.lte", query.releasedTo);
  if (query.watchRegion) params.set("watch_region", query.watchRegion);
  if (query.providers?.length) params.set("with_watch_providers", query.providers.join("|"));

  const res = await fetch(`${API}/discover/movie?${params.toString()}`);
  if (!res.ok) {
    throw new Error(
      res.status === 401 ? "TMDB rejected the API key — check it in Settings." : `TMDB discover failed: ${res.status}`,
    );
  }
  const data = (await res.json()) as { results?: RawDiscoverHit[]; page?: number; total_pages?: number; total_results?: number };
  return {
    hits: (data.results ?? []).map(toDiscoverHit),
    page: data.page ?? 1,
    // TMDB refuses pages past 500 whatever it claims here.
    totalPages: Math.min(data.total_pages ?? 0, 500),
    totalResults: data.total_results ?? 0,
  };
}

/** What everyone has been watching. TMDB's trending is global and not personalised. */
export async function fetchTrendingMovies(window: "day" | "week" = "week", page = 1): Promise<DiscoverMoviePage> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) return EMPTY_PAGE;
  const res = await fetch(`${API}/trending/movie/${window}?api_key=${encodeURIComponent(tmdbApiKey)}&page=${page}`);
  if (!res.ok) throw new Error(`TMDB trending failed: ${res.status}`);
  const data = (await res.json()) as { results?: RawDiscoverHit[]; page?: number; total_pages?: number; total_results?: number };
  return {
    hits: (data.results ?? []).map(toDiscoverHit),
    page: data.page ?? 1,
    totalPages: Math.min(data.total_pages ?? 0, 500),
    totalResults: data.total_results ?? 0,
  };
}

/**
 * "More like this one". TMDB has no endpoint that reads a whole library, so a
 * recommendation feed has to be built by asking this about several films and counting
 * which answers keep coming back — see `src/ui/discover.ts`.
 */
export async function fetchMovieRecommendations(tmdbId: number): Promise<TmdbDiscoverHit[]> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) return [];
  const res = await fetch(`${API}/movie/${tmdbId}/recommendations?api_key=${encodeURIComponent(tmdbApiKey)}`);
  if (!res.ok) return []; // one seed failing shouldn't empty the whole row
  return ((await res.json()) as { results?: RawDiscoverHit[] }).results?.map(toDiscoverHit) ?? [];
}

export interface TmdbWatchProvider {
  id: number;
  name: string;
}

/**
 * Every streaming service TMDB knows in one country, with the ids `with_watch_providers`
 * wants. Cached for the session: it is a long, near-static list, and the only thing that
 * changes it is editing My services, which is already a page reload away.
 */
const providerLists = new Map<string, Promise<TmdbWatchProvider[]>>();

export function fetchWatchProviders(region: string): Promise<TmdbWatchProvider[]> {
  const cached = providerLists.get(region);
  if (cached) return cached;
  const pending = (async (): Promise<TmdbWatchProvider[]> => {
    const { tmdbApiKey } = getSettings();
    if (!tmdbApiKey) return [];
    const res = await fetch(
      `${API}/watch/providers/movie?api_key=${encodeURIComponent(tmdbApiKey)}&watch_region=${encodeURIComponent(region)}`,
    );
    if (!res.ok) {
      providerLists.delete(region); // a failed lookup must not be remembered as "none"
      return [];
    }
    const data = (await res.json()) as { results?: { provider_id: number; provider_name: string }[] };
    return (data.results ?? []).map((p) => ({ id: p.provider_id, name: p.provider_name }));
  })();
  providerLists.set(region, pending);
  return pending;
}
