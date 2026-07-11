import type { TraktIds } from "../api/trakt";

/** Cached show metadata (from Trakt ?extended=full) + TMDB artwork. */
export interface ShowRec {
  traktId: number;
  ids: TraktIds;
  title: string;
  year: number | null;
  /** Trakt status: "returning series" | "ended" | "canceled" | "in production" | ... */
  status?: string;
  network?: string;
  overview?: string;
  airedEpisodes?: number;
  genres?: string[];
  runtime?: number | null;
  airs?: { day: string | null; time: string | null } | null;
  /** Trakt community rating 0..10 */
  rating?: number | null;
  firstAired?: string | null;
  poster?: string | null;
  backdrop?: string | null;
  imagesFetchedAt?: number;
}

export interface CastMemberRec {
  tmdbId?: number;
  name: string;
  character: string | null;
  profile: string | null;
}

/**
 * Per-show watched summary from /sync/watched/shows. Per-episode watched
 * state lives in ProgressRec (Trakt's 2026 API removed seasons from the
 * watched list endpoint).
 */
export interface WatchedRec {
  traktId: number;
  plays: number;
  lastWatchedAt: string;
  lastUpdatedAt: string;
}

export interface NextEpisodeRec {
  traktId: number;
  season: number;
  number: number;
  title: string | null;
  firstAired: string | null;
}

/**
 * Per-episode watched flags + aired counts from /shows/:id/progress/watched.
 * Seasons include specials (season 0); the aired/completed totals here are
 * recomputed client-side over non-special seasons only. Episode lists contain
 * only episodes that have aired.
 */
export interface ProgressRec {
  traktId: number;
  fetchedAt: number;
  aired: number;
  completed: number;
  /** Mirrors the show's last_watched_at at fetch time — mismatch with WatchedRec marks this stale. */
  lastWatchedAt: string | null;
  seasons: {
    number: number;
    aired: number;
    completed: number;
    episodes: { number: number; completed: boolean }[];
  }[];
  nextEpisode: NextEpisodeRec | null;
}

export interface EpisodeInfo {
  traktId: number;
  season: number;
  number: number;
  title: string | null;
  // from TMDB (when a key is configured)
  overview?: string | null;
  still?: string | null;
  airDate?: string | null;
  /** TMDB community rating 0..10 */
  rating?: number | null;
}

/**
 * Episode titles/ids per season from /shows/:id/seasons?extended=episodes,
 * enriched with TMDB stills/overviews/air dates when available.
 */
export interface EpisodesRec {
  traktId: number;
  fetchedAt: number;
  /** Set when TMDB details were merged in. */
  tmdbMergedAt?: number;
  /** Main cast from TMDB aggregate credits. */
  cast?: CastMemberRec[];
  /** Watch providers by country (JustWatch data via TMDB). */
  providers?: Record<string, { link: string | null; providers: { name: string; logo: string | null; kind: string }[] }>;
  seasons: {
    number: number;
    episodes: EpisodeInfo[];
  }[];
}

export interface WatchlistEntry {
  traktId: number;
  listedAt: string;
}

/** A movie: watch state + Trakt metadata + TMDB artwork/cast/providers, one record. */
export interface MovieRec {
  traktId: number;
  ids: TraktIds;
  title: string;
  year: number | null;
  plays: number;
  lastWatchedAt: string | null;
  onWatchlist: boolean;
  listedAt: string | null;
  /** Original TV Time added date (from the export) — Trakt's listed_at was flattened by the import. */
  tvtimeAddedAt?: string;
  // Trakt ?extended=full
  overview?: string;
  runtime?: number | null;
  rating?: number | null;
  genres?: string[];
  released?: string | null;
  // TMDB
  poster?: string | null;
  backdrop?: string | null;
  cast?: CastMemberRec[];
  providers?: Record<string, { link: string | null; providers: { name: string; logo: string | null; kind: string }[] }>;
  tmdbFetchedAt?: number;
}

/** Everything the screens need, loaded from IndexedDB in one go. */
export interface Library {
  shows: Map<number, ShowRec>;
  watched: Map<number, WatchedRec>;
  progress: Map<number, ProgressRec>;
  watchlist: WatchlistEntry[];
  hidden: Set<number>;
}
