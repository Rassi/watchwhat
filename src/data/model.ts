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

/**
 * The timestamp for a watch nobody knows the date of: a film seen years ago and marked now,
 * or history that reached the log carrying no date of its own.
 *
 * A sentinel rather than `null` because the timestamp *is* the watch's identity — replay
 * dedups a `movie.watched` event by comparing its `at` against the stored one, so a null
 * would make every pull of the log add another play. It also keeps the event body unchanged,
 * which a device on an older build can still apply.
 *
 * The epoch sorts undated watches behind everything dated, which is what both the Watched
 * grid and the For You seeds want: a film you saw in your twenties should not be what the
 * recommendations are built from. Nothing may ever *render* it — see `isUndated`.
 */
export const UNDATED = "1970-01-01T00:00:00.000Z";

/** True for a watch with no usable date, so the UI can say "watched" and stop there. */
export const isUndated = (at: string | null | undefined): boolean => !at || at === UNDATED;

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

/**
 * A film you actually track, rather than one you merely looked at.
 *
 * Opening a search result deep-links to the movie page, which builds a record from TMDB and
 * caches it — so a film browsed once and never added is stored exactly like one on a list, and
 * used to join the bulk refresh forever. Every screen already shows only tracked films; this is
 * what stops the refreshes covering the rest.
 */
export const isTrackedMovie = (movie: MovieRec): boolean =>
  movie.plays > 0 || movie.onWatchlist || (movie.customLists?.length ?? 0) > 0;

/** Nothing more is coming — the show wrapped or was cancelled. */
export const isEnded = (show: { status?: string } | undefined): boolean =>
  show?.status === "ended" || show?.status === "canceled";

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
  /**
   * When this film joined each custom list, keyed by list id — what those lists are
   * ordered by.
   *
   * Per list rather than folded into `listedAt`: that one belongs to the watchlist, and
   * a film on the watchlist and two lists has three different answers to "when was this
   * added". Ordering every list by the watchlist's date is what let the same film sit
   * first on one device and last on another — membership carried no date of its own, so
   * a device that learned about it from the log had nothing to sort by at all.
   */
  listAddedAt?: Record<number, string>;
  /**
   * Marked as one you actually want to get to, which is what floats it to the top of every
   * watch list it sits on.
   *
   * Deliberately not a list of its own. A list answers "what kind of film is this"; a star
   * answers "of everything I've listed, which ones first" — and as a list it would have to be
   * toggled on the same film in three places to mean the same thing, then sorted somehow
   * against itself.
   */
  starred?: boolean;
  /** When it was starred, so a shelf of starred films still has an order. Cleared on unstar. */
  starredAt?: string | null;
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
   * When each streaming listing was first seen, keyed `"DK:Netflix"` — what makes "this
   * only just turned up" answerable at all. `providers` is overwritten wholesale on every
   * refresh, so without this a film that landed on Netflix last night is indistinguishable
   * from one that has been there for three years.
   *
   * Timestamps are about the *listing*, deliberately not about whether the service is one
   * of yours. Stamping "became available to me" would make adding a service in Settings
   * republish half the watchlist as breaking news; keyed this way, a settings change can
   * only ever reveal arrivals that genuinely happened.
   *
   * `0` means "already there when this film started being tracked" — the honest answer for
   * a listing whose arrival nobody watched, and never news. Derived and per-device like
   * `providers` itself, so it stays out of the event log.
   *
   * Only the countries you watch in are kept. `providers` holds every country TMDB returns,
   * about 40 of them, and stamping all of those cost 558 KB across the library against 71 KB
   * for the six that are ever read — dead weight in every export.
   */
  providerSince?: Record<string, number>;
  /**
   * Which watch countries this film's listings have actually been looked at in, which is what
   * makes a missing `providerSince` key readable. Without it, "no stamp for Netflix DK" is
   * ambiguous between *nobody has checked DK* and *DK was checked and Netflix wasn't there* —
   * and those want opposite answers when Netflix DK later appears: baseline, or news.
   */
  providerSeen?: string[];
  /**
   * When this device first stamped this film, and so the point from which an arrival can be
   * believed at all. See `PROVIDER_SETTLE_MS`: TMDB's provider ingest is per-country and lags,
   * so a single first look is one sample of a feed still filling in, not a picture of what the
   * film was on.
   */
  providerBaselineAt?: number;
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
