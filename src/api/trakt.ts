/** Typed Trakt API client (https://trakt.docs.apiary.io) with device-code auth. */

import { getSettings, getTokens, saveTokens, clearTokens, type Tokens } from "../data/settings";

const BASE = "https://api.trakt.tv";

export class TraktError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- shared object shapes ----------

export interface TraktIds {
  trakt: number;
  slug?: string;
  tvdb?: number | null;
  imdb?: string | null;
  tmdb?: number | null;
}

export interface TraktShow {
  title: string;
  year: number | null;
  ids: TraktIds;
  // present with ?extended=full
  status?: string;
  overview?: string;
  network?: string;
  aired_episodes?: number;
  first_aired?: string | null;
  genres?: string[];
  runtime?: number | null;
  airs?: { day: string | null; time: string | null; timezone: string | null };
  rating?: number | null;
}

/**
 * Item of /sync/watched/shows. Since Trakt's 2026 API changes this endpoint
 * is always paginated and no longer returns per-episode seasons data — per-
 * episode watched state comes from /shows/:id/progress/watched instead.
 */
export interface WatchedShow {
  plays: number;
  last_watched_at: string;
  last_updated_at: string;
  show: TraktShow;
}

export interface WatchlistItem {
  listed_at: string;
  show: TraktShow;
}

export interface LastActivities {
  all: string;
  episodes: { watched_at: string; watchlisted_at: string; paused_at?: string };
  shows: { rated_at: string; watchlisted_at: string; hidden_at?: string };
  movies: { watched_at: string; watchlisted_at: string; rated_at?: string };
  watchlist: { updated_at: string };
}

export interface TraktMovie {
  title: string;
  year: number | null;
  ids: TraktIds;
  // present with ?extended=full
  overview?: string;
  runtime?: number | null;
  rating?: number | null;
  genres?: string[];
  released?: string | null;
}

export interface WatchedMovie {
  plays: number;
  last_watched_at: string;
  movie: TraktMovie;
}

export interface MovieWatchlistItem {
  listed_at: string;
  movie: TraktMovie;
}

export interface EpisodeSummary {
  season: number;
  number: number;
  title: string | null;
  ids: TraktIds;
  // with ?extended=full
  first_aired?: string | null;
  overview?: string | null;
  runtime?: number | null;
}

export interface ShowProgress {
  aired: number;
  completed: number;
  last_watched_at: string | null;
  seasons: {
    number: number;
    title?: string;
    aired: number;
    completed: number;
    episodes: { number: number; completed: boolean; last_watched_at: string | null }[];
  }[];
  next_episode: EpisodeSummary | null;
  last_episode: EpisodeSummary | null;
}

export interface SeasonWithEpisodes {
  number: number;
  ids: TraktIds;
  episodes: EpisodeSummary[];
}

export interface SearchResult {
  type: string;
  score: number;
  show: TraktShow;
}

// ---------- low-level request ----------

interface RequestOpts {
  method?: string;
  body?: unknown;
  auth?: boolean;
  query?: Record<string, string | number | boolean>;
  /** internal: set when retrying after a token refresh */
  isRetry?: boolean;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<{ data: T; headers: Headers }> {
  const settings = getSettings();
  if (!settings.traktClientId) throw new TraktError(0, "Trakt API credentials not configured");

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": settings.traktClientId,
  };

  if (opts.auth !== false) {
    const tokens = await ensureFreshTokens();
    headers["Authorization"] = `Bearer ${tokens.accessToken}`;
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && opts.auth !== false && !opts.isRetry) {
    await refreshTokens();
    return request<T>(path, { ...opts, isRetry: true });
  }
  if (res.status === 429 && !opts.isRetry) {
    const wait = Number(res.headers.get("Retry-After") ?? "2");
    await sleep((wait + 1) * 1000);
    return request<T>(path, { ...opts, isRetry: true });
  }
  if (!res.ok) {
    throw new TraktError(res.status, `Trakt ${opts.method ?? "GET"} ${path} failed: ${res.status}`);
  }
  const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  return { data, headers: res.headers };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- auth: device code flow ----------

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const { traktClientId } = getSettings();
  const { data } = await request<DeviceCode>("/oauth/device/code", {
    method: "POST",
    auth: false,
    body: { client_id: traktClientId },
  });
  return data;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}

function storeTokenResponse(t: TokenResponse): Tokens {
  const tokens: Tokens = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: (t.created_at + t.expires_in) * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

/**
 * Poll for the device token until the user approves (resolves), the code
 * expires/is denied (throws), or `signal` aborts (throws DOMException).
 */
export async function pollForDeviceToken(code: DeviceCode, signal?: AbortSignal): Promise<void> {
  const { traktClientId, traktClientSecret } = getSettings();
  const deadline = Date.now() + code.expires_in * 1000;
  let interval = code.interval * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");

    const res = await fetch(`${BASE}/oauth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code.device_code,
        client_id: traktClientId,
        client_secret: traktClientSecret,
      }),
    });

    if (res.ok) {
      storeTokenResponse((await res.json()) as TokenResponse);
      return;
    }
    if (res.status === 400) continue; // pending — keep polling
    if (res.status === 429) {
      interval += 1000;
      continue;
    }
    if (res.status === 404) throw new TraktError(404, "Invalid device code");
    if (res.status === 409) throw new TraktError(409, "Code already approved");
    if (res.status === 410) throw new TraktError(410, "Code expired — try again");
    if (res.status === 418) throw new TraktError(418, "Login was denied on trakt.tv");
    throw new TraktError(res.status, `Device token polling failed: ${res.status}`);
  }
  throw new TraktError(410, "Code expired — try again");
}

export async function refreshTokens(): Promise<Tokens> {
  const { traktClientId, traktClientSecret } = getSettings();
  const tokens = getTokens();
  if (!tokens) throw new TraktError(401, "Not logged in to Trakt");

  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: tokens.refreshToken,
      client_id: traktClientId,
      client_secret: traktClientSecret,
      redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    clearTokens();
    throw new TraktError(res.status, "Trakt session expired — please log in again");
  }
  return storeTokenResponse((await res.json()) as TokenResponse);
}

async function ensureFreshTokens(): Promise<Tokens> {
  const tokens = getTokens();
  if (!tokens) throw new TraktError(401, "Not logged in to Trakt");
  // Refresh a day before expiry.
  if (Date.now() > tokens.expiresAt - 24 * 3600 * 1000) return refreshTokens();
  return tokens;
}

export function logout(): void {
  clearTokens();
}

// ---------- endpoints ----------

export async function getLastActivities(): Promise<LastActivities> {
  return (await request<LastActivities>("/sync/last_activities")).data;
}

/** Fetch every page of a paginated collection endpoint. */
async function getAllPages<T>(path: string, query: Record<string, string | number | boolean>): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (;;) {
    const { data, headers } = await request<T[]>(path, { query: { ...query, limit: 250, page } });
    out.push(...data);
    const pageCount = Number(headers.get("X-Pagination-Page-Count") ?? "1");
    if (page >= pageCount) return out;
    page++;
  }
}

export async function getWatchedShows(): Promise<WatchedShow[]> {
  return getAllPages<WatchedShow>("/sync/watched/shows", { extended: "full" });
}

export async function getWatchlistShows(): Promise<WatchlistItem[]> {
  return getAllPages<WatchlistItem>("/sync/watchlist/shows", { extended: "full" });
}

export async function getWatchedMovies(): Promise<WatchedMovie[]> {
  return getAllPages<WatchedMovie>("/sync/watched/movies", { extended: "full" });
}

export async function getWatchlistMovies(): Promise<MovieWatchlistItem[]> {
  return getAllPages<MovieWatchlistItem>("/sync/watchlist/movies", { extended: "full" });
}

export async function addMovieToHistory(ids: TraktIds): Promise<void> {
  await request("/sync/history", { method: "POST", body: { movies: [{ ids }] } });
}

export async function removeMovieFromHistory(ids: TraktIds): Promise<void> {
  await request("/sync/history/remove", { method: "POST", body: { movies: [{ ids }] } });
}

export async function addMovieToWatchlist(ids: TraktIds): Promise<void> {
  await request("/sync/watchlist", { method: "POST", body: { movies: [{ ids }] } });
}

export async function removeMovieFromWatchlist(ids: TraktIds): Promise<void> {
  await request("/sync/watchlist/remove", { method: "POST", body: { movies: [{ ids }] } });
}

export interface MovieSearchResult {
  type: string;
  score: number;
  movie: TraktMovie;
}

export async function searchMovies(query: string): Promise<MovieSearchResult[]> {
  return (
    await request<MovieSearchResult[]>("/search/movie", {
      query: { query, extended: "full", limit: 30 },
    })
  ).data;
}

export async function getMovieSummary(movieId: number): Promise<TraktMovie> {
  return (await request<TraktMovie>(`/movies/${movieId}`, { query: { extended: "full" } })).data;
}

/** Shows the user hid from progress ("stopped watching"). */
export async function getHiddenShows(): Promise<TraktShow[]> {
  const items = await getAllPages<{ show: TraktShow }>("/users/hidden/progress_watched", { type: "show" });
  return items.map((i) => i.show);
}

export async function getShowProgress(showId: number): Promise<ShowProgress> {
  return (
    await request<ShowProgress>(`/shows/${showId}/progress/watched`, {
      // specials=true so season 0 watched-flags are available; note Trakt then
      // counts specials in aired/completed totals regardless of count_specials,
      // so totals are recomputed client-side from non-special seasons.
      query: { hidden: false, specials: true, count_specials: false, extended: "full" },
    })
  ).data;
}

export async function getSeasons(showId: number): Promise<SeasonWithEpisodes[]> {
  return (await request<SeasonWithEpisodes[]>(`/shows/${showId}/seasons`, { query: { extended: "episodes" } })).data;
}

export async function getShowSummary(showId: number): Promise<TraktShow> {
  return (await request<TraktShow>(`/shows/${showId}`, { query: { extended: "full" } })).data;
}

export async function addEpisodesToHistory(episodeTraktIds: number[], watchedAt?: string): Promise<void> {
  await request("/sync/history", {
    method: "POST",
    body: { episodes: episodeTraktIds.map((id) => ({ ids: { trakt: id }, ...(watchedAt ? { watched_at: watchedAt } : {}) })) },
  });
}

/** Add episodes to history with individual watched-at timestamps (for imports). */
export async function addEpisodesToHistoryAt(items: { traktId: number; watchedAt?: string }[]): Promise<void> {
  await request("/sync/history", {
    method: "POST",
    body: { episodes: items.map((i) => ({ ids: { trakt: i.traktId }, ...(i.watchedAt ? { watched_at: i.watchedAt } : {}) })) },
  });
}

export async function removeEpisodesFromHistory(episodeTraktIds: number[]): Promise<void> {
  await request("/sync/history/remove", {
    method: "POST",
    body: { episodes: episodeTraktIds.map((id) => ({ ids: { trakt: id } })) },
  });
}

export async function addShowToWatchlist(ids: TraktIds): Promise<void> {
  await request("/sync/watchlist", { method: "POST", body: { shows: [{ ids }] } });
}

export async function removeShowFromWatchlist(ids: TraktIds): Promise<void> {
  await request("/sync/watchlist/remove", { method: "POST", body: { shows: [{ ids }] } });
}

export async function searchShows(query: string): Promise<SearchResult[]> {
  return (
    await request<SearchResult[]>("/search/show", {
      query: { query, extended: "full", limit: 30 },
    })
  ).data;
}

/** "Stop tracking": hide a show from progress (TV Time's remove-show equivalent). */
export async function hideShowFromProgress(ids: TraktIds): Promise<void> {
  await request("/users/hidden/progress_watched", { method: "POST", body: { shows: [{ ids }] } });
}

export async function unhideShowFromProgress(ids: TraktIds): Promise<void> {
  await request("/users/hidden/progress_watched/remove", { method: "POST", body: { shows: [{ ids }] } });
}

export interface CalendarEntry {
  first_aired: string; // UTC timestamp of the airing
  episode: EpisodeSummary;
  show: TraktShow;
}

/** Upcoming episodes for shows the user watches, from startDate (YYYY-MM-DD) for `days`. */
export async function getMyCalendar(startDate: string, days: number): Promise<CalendarEntry[]> {
  return (await request<CalendarEntry[]>(`/calendars/my/shows/${startDate}/${days}`)).data;
}

export async function lookupByTvdb(tvdbId: number): Promise<TraktShow | null> {
  const { data } = await request<{ type: string; show?: TraktShow }[]>(`/search/tvdb/${tvdbId}`, {
    query: { type: "show" },
  });
  return data.find((r) => r.show)?.show ?? null;
}
