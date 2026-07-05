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

/** Per-show watched state from /sync/watched/shows (account-wide, one call). */
export interface WatchedRec {
  traktId: number;
  plays: number;
  lastWatchedAt: string;
  lastUpdatedAt: string;
  /** season -> episode -> play count */
  seasons: Record<number, Record<number, number>>;
}

export interface NextEpisodeRec {
  traktId: number;
  season: number;
  number: number;
  title: string | null;
  firstAired: string | null;
}

/** Aired/completed counts from /shows/:id/progress/watched (specials excluded). */
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

/** Episode titles/ids per season from /shows/:id/seasons?extended=episodes. */
export interface EpisodesRec {
  traktId: number;
  fetchedAt: number;
  seasons: {
    number: number;
    episodes: { traktId: number; season: number; number: number; title: string | null }[];
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
