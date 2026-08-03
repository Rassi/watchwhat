/**
 * External ids for a title. `trakt` is the store key and no longer means
 * anything to anyone: real Trakt ids for titles added before the API shut
 * down, `-tmdbId` for everything since. `tmdb` is the one that still resolves,
 * and every record carries it — that's what makes the `trakt` field safe to
 * leave alone rather than migrating 577 stored records to rename a key.
 */
export interface TitleIds {
  trakt: number;
  slug?: string;
  tvdb?: number | null;
  imdb?: string | null;
  tmdb?: number | null;
}

/**
 * Records found through TMDB are keyed by the negation of their TMDB id, which
 * cannot collide with a real Trakt id, so titles from both eras sit in one
 * store and every `traktId` field keeps working as "the record's key".
 */
export const tmdbKey = (tmdbId: number): number => -tmdbId;

export const isTmdbKeyed = (key: number): boolean => key < 0;

/** Cached show metadata + TMDB artwork. */
export interface ShowRec {
  traktId: number;
  ids: TitleIds;
  title: string;
  year: number | null;
  /** Lowercased: "returning series" | "ended" | "canceled" | "in production" | ... */
  status?: string;
  network?: string;
  overview?: string;
  airedEpisodes?: number;
  genres?: string[];
  runtime?: number | null;
  /**
   * Weekly broadcast slot. The one field with no replacement — TMDB doesn't
   * publish it — so it survives only on records cached while Trakt was alive
   * and is never set again.
   */
  airs?: { day: string | null; time: string | null } | null;
  /** Community rating 0..10 (TMDB's; Trakt's on records not refreshed since). */
  rating?: number | null;
  firstAired?: string | null;
  /** YouTube trailer URL (null = none found; undefined = not looked up yet) */
  trailer?: string | null;
  /** IMDb / Rotten Tomatoes ratings from OMDb. */
  extRatings?: { imdb: string | null; rottenTomatoes: string | null; fetchedAt: number };
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

/** Per-show watched summary. Per-episode state lives in ProgressRec. */
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
 * Per-episode watched flags + aired counts, rebuilt from TMDB air dates.
 * Seasons include specials (season 0); the aired/completed totals here count
 * non-special seasons only. Episode lists contain only episodes that have
 * aired — plus any watched episode TMDB has since stopped listing.
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
    episodes: { number: number; completed: boolean; watchedAt?: string | null }[];
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

/** Episode titles per season, with TMDB stills/overviews/air dates. */
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

/** A movie: watch state + metadata + TMDB artwork/cast/providers, one record. */
export interface MovieRec {
  traktId: number;
  ids: TitleIds;
  title: string;
  year: number | null;
  plays: number;
  lastWatchedAt: string | null;
  onWatchlist: boolean;
  listedAt: string | null;
  /** Keys of the custom personal lists containing this movie. */
  customLists?: number[];
  overview?: string;
  runtime?: number | null;
  rating?: number | null;
  genres?: string[];
  released?: string | null;
  trailer?: string | null;
  /** IMDb / Rotten Tomatoes ratings from OMDb. */
  extRatings?: { imdb: string | null; rottenTomatoes: string | null; fetchedAt: number };
  /** Earliest announced digital/streaming release from TMDB (null = none announced). */
  digitalRelease?: { date: string; country: string } | null;
  /** Digital release whose note names the services, e.g. "Disney+ / Hulu" — the streaming date. */
  streamingRelease?: { date: string; country: string; note: string } | null;
  // TMDB
  poster?: string | null;
  backdrop?: string | null;
  cast?: CastMemberRec[];
  providers?: Record<string, { link: string | null; providers: { name: string; logo: string | null; kind: string }[] }>;
  /** Which provider kinds the cached `providers` were fetched with; see PROVIDERS_VERSION. */
  providersVersion?: number;
  /**
   * This title's JustWatch node id (`tm1433295`), saved so a repeat top-up costs one request
   * rather than three. Derived and per-device like `providers`, so it is not in the event log.
   */
  jwNodeId?: string | null;
  /**
   * How the last JustWatch top-up for this title went, so the card can say when its listing is
   * TMDB's alone. Absent means never attempted, which is the normal state — the top-up only runs
   * near a release or on demand. Per-device like `providers` themselves, and for the same reason.
   */
  topUp?: { at: number; stage: "reach" | "search" | "offers" | "ok" };
  tmdbFetchedAt?: number;
}

export interface MovieListRec {
  traktId: number;
  name: string;
  slug: string;
}

/** Everything the screens need, loaded from IndexedDB in one go. */
export interface Library {
  shows: Map<number, ShowRec>;
  watched: Map<number, WatchedRec>;
  progress: Map<number, ProgressRec>;
  watchlist: WatchlistEntry[];
  hidden: Set<number>;
}
