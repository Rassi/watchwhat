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
 * Notes that name the transaction, not a service: the entry is a buy/rent date that happens to
 * carry a note. Matched as whole words so SVOD and AVOD — which are subscription and ad-supported
 * — are left alone; only the transactional spellings are listed.
 */
const TRANSACTIONAL_NOTE = /\b(tvod|pvod|dto|vod|rent|rental|buy|purchase|premium video on demand|download to own)\b/i;

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
  const userCountries = getSettings().watchCountries.split(",").map((c) => c.trim().toUpperCase());
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
      if (note && !TRANSACTIONAL_NOTE.test(note)) {
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
      for (const [country, entry] of Object.entries(data["watch/providers"].results)) {
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
