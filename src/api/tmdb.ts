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
  name: string;
  character: string | null;
  profile: string | null; // TMDB image path
}

export interface TmdbShowExtras {
  episodesBySeason: Map<number, TmdbEpisode[]>;
  cast: TmdbCastMember[];
}

interface TmdbCreditsCast {
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
  const out: TmdbShowExtras = { episodesBySeason: new Map(), cast: [] };
  if (!tmdbApiKey) return out;

  for (let i = 0; i < seasonNumbers.length; i += 20) {
    const chunk = seasonNumbers.slice(i, i + 20);
    const appends = chunk.map((n) => `season/${n}`);
    if (i === 0) appends.push("aggregate_credits");
    const res = await fetch(
      `${API}/tv/${tmdbId}?api_key=${encodeURIComponent(tmdbApiKey)}&append_to_response=${appends.join(",")}`,
    );
    if (!res.ok) break;
    const data = (await res.json()) as Record<string, unknown> & {
      aggregate_credits?: { cast?: TmdbCreditsCast[] };
    };
    for (const n of chunk) {
      const season = data[`season/${n}`] as { episodes?: TmdbEpisode[] } | undefined;
      if (season?.episodes) out.episodesBySeason.set(n, season.episodes);
    }
    if (data.aggregate_credits?.cast) {
      out.cast = data.aggregate_credits.cast
        .slice(0, 15)
        .map((c) => ({ name: c.name, character: c.roles?.[0]?.character ?? c.character ?? null, profile: c.profile_path }));
    }
  }
  return out;
}

export function backdropUrl(path: string | null | undefined, size = "w780"): string | null {
  return path ? `${IMG}${size}${path}` : null;
}
