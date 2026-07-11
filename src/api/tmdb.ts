/** TMDB lookups for posters/backdrops (Trakt serves no images). */

import { getSettings } from "../data/settings";

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/";

export interface ShowImages {
  poster: string | null; // TMDB path like "/abc.jpg"
  backdrop: string | null;
  /** TMDB description — fallback when Trakt's overview is empty. */
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
  cast: TmdbCastMember[];
  providersByCountry: Record<string, TmdbCountryProviders>;
}

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
    `${API}/movie/${tmdbId}?api_key=${encodeURIComponent(tmdbApiKey)}&append_to_response=credits,watch/providers`,
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
      results?: Record<string, { link?: string; flatrate?: RawProviderEntry[]; free?: RawProviderEntry[]; ads?: RawProviderEntry[] }>;
    };
  };
  const out: TmdbMovieExtras = {
    poster: data.poster_path,
    backdrop: data.backdrop_path,
    overview: data.overview || null,
    cast: (data.credits?.cast ?? [])
      .slice(0, 15)
      .map((c) => ({ tmdbId: c.id, name: c.name, character: c.character ?? null, profile: c.profile_path })),
    providersByCountry: {},
  };
  for (const [country, entry] of Object.entries(data["watch/providers"]?.results ?? {})) {
    const providers: TmdbProvider[] = [
      ...(entry.flatrate ?? []).map((p): TmdbProvider => ({ name: p.provider_name, logo: p.logo_path, kind: "stream" })),
      ...(entry.free ?? []).map((p): TmdbProvider => ({ name: p.provider_name, logo: p.logo_path, kind: "free" })),
      ...(entry.ads ?? []).map((p): TmdbProvider => ({ name: p.provider_name, logo: p.logo_path, kind: "ads" })),
    ];
    if (providers.length > 0) out.providersByCountry[country] = { link: entry.link ?? null, providers };
  }
  return out;
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
  /** "stream" (subscription) | "free" | "ads" */
  kind: "stream" | "free" | "ads";
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
