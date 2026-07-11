/** TMDB lookups for posters/backdrops (Trakt serves no images). */

import { getSettings } from "../data/settings";

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/";

export interface ShowImages {
  poster: string | null; // TMDB path like "/abc.jpg"
  backdrop: string | null;
}

export async function fetchShowImages(tmdbId: number): Promise<ShowImages | null> {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) return null;
  const res = await fetch(`${API}/tv/${tmdbId}?api_key=${encodeURIComponent(tmdbApiKey)}`);
  if (res.status === 404) return { poster: null, backdrop: null };
  if (!res.ok) return null; // bad key / network — try again another time
  const data = (await res.json()) as { poster_path: string | null; backdrop_path: string | null };
  return { poster: data.poster_path, backdrop: data.backdrop_path };
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
}

/**
 * Episode details (stills, overviews, air dates) for the given seasons,
 * batched via append_to_response (max 20 appends per request).
 */
export async function fetchSeasonsEpisodes(tmdbId: number, seasonNumbers: number[]): Promise<Map<number, TmdbEpisode[]>> {
  const { tmdbApiKey } = getSettings();
  const out = new Map<number, TmdbEpisode[]>();
  if (!tmdbApiKey) return out;

  for (let i = 0; i < seasonNumbers.length; i += 20) {
    const chunk = seasonNumbers.slice(i, i + 20);
    const append = chunk.map((n) => `season/${n}`).join(",");
    const res = await fetch(
      `${API}/tv/${tmdbId}?api_key=${encodeURIComponent(tmdbApiKey)}&append_to_response=${append}`,
    );
    if (!res.ok) break;
    const data = (await res.json()) as Record<string, { episodes?: TmdbEpisode[] }>;
    for (const n of chunk) {
      const season = data[`season/${n}`];
      if (season?.episodes) out.set(n, season.episodes);
    }
  }
  return out;
}

export function backdropUrl(path: string | null | undefined, size = "w780"): string | null {
  return path ? `${IMG}${size}${path}` : null;
}
