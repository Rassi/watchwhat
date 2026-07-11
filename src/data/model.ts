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
  poster?: string | null;
  backdrop?: string | null;
  imagesFetchedAt?: number;
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
  seasons: {
    number: number;
    episodes: EpisodeInfo[];
  }[];
}

export interface WatchlistEntry {
  traktId: number;
  listedAt: string;
}

/** Everything the screens need, loaded from IndexedDB in one go. */
export interface Library {
  shows: Map<number, ShowRec>;
  watched: Map<number, WatchedRec>;
  progress: Map<number, ProgressRec>;
  watchlist: WatchlistEntry[];
  hidden: Set<number>;
}
