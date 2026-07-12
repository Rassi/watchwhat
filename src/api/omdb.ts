/** OMDb (omdbapi.com): IMDb + Rotten Tomatoes ratings by IMDb id. */

import { getSettings } from "../data/settings";

export interface OmdbRatings {
  imdb: string | null;
  rottenTomatoes: string | null;
}

export async function fetchOmdbRatings(imdbId: string): Promise<OmdbRatings | null> {
  const { omdbApiKey } = getSettings();
  if (!omdbApiKey) return null;
  const res = await fetch(`https://www.omdbapi.com/?apikey=${encodeURIComponent(omdbApiKey)}&i=${encodeURIComponent(imdbId)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    Response?: string;
    imdbRating?: string;
    Ratings?: { Source: string; Value: string }[];
  };
  if (data.Response === "False") return null;
  const fromList = (source: string): string | null => data.Ratings?.find((r) => r.Source === source)?.Value ?? null;
  const imdb = data.imdbRating && data.imdbRating !== "N/A" ? data.imdbRating : fromList("Internet Movie Database");
  return { imdb, rottenTomatoes: fromList("Rotten Tomatoes") };
}
