/**
 * "Roughly when will I be able to watch this" for films that have not announced it yet.
 *
 * TMDB and JustWatch both answer only once a date is booked — JustWatch's `upcomingReleases` is
 * empty even for 2027 titles, and TMDB has no entry until a distributor files one. That leaves
 * the most common state of an unwatched new film, *out in cinemas, nothing announced*, with
 * nothing to say at all, which is exactly when the question gets asked.
 *
 * So this estimates from the one thing already known: how long the gap has actually been for the
 * films in this library. It is deliberately vague, and vague in proportion — a guess six months
 * out is stated as a season, the same guess three weeks out as a part of a month. An announced
 * date always replaces it; nothing here ever competes with a real one.
 */

import { getSettings } from "./settings";
import type { MovieRec } from "./model";

const DAY = 24 * 3600 * 1000;

/** What is being waited for: a purchase, or a subscription including it. */
export type ReleaseKind = "buy" | "stream";

export interface ReleaseEstimate {
  kind: ReleaseKind;
  /** Middle of the window — the median gap applied to this film's theatrical date. */
  at: number;
  /** The quartile window it came from. */
  low: number;
  high: number;
  /** How precisely to say it, from how far away it is. */
  precision: "year" | "season" | "month" | "part";
  /** The window has elapsed and still nothing is announced. */
  overdue: boolean;
  /** Plain-English basis, for the tooltip — an estimate that cannot show its working is a rumour. */
  basis: string;
}

/**
 * Fallbacks for a library too small to speak for itself, measured across this one on 2026-08-03
 * (n=32 buy, n=26 stream, films from 2023 on). Re-measure with the snippet in `dependencies.md`
 * rather than trusting these to age well: the theatrical-to-digital window has been shortening
 * for years, and these are the median and quartiles of a moving target.
 */
const FALLBACK: Record<ReleaseKind, { p25: number; median: number; p75: number }> = {
  buy: { p25: 32, median: 39, p75: 63 },
  stream: { p25: 46, median: 90, p75: 119 },
};

/** Below this, the library's own gaps are noise and the measured fallback is the better guess. */
const MIN_SAMPLE = 8;

/** Gaps beyond this are a re-release or a catalogue backfill, not a rollout. */
const MAX_GAP_DAYS = 400;

/** Only recent films describe the window films are getting *now*. */
const SAMPLE_WINDOW_DAYS = 5 * 365;

function announced(movie: MovieRec, kind: ReleaseKind): string | null | undefined {
  return kind === "buy" ? movie.digitalRelease?.date : movie.streamingRelease?.date;
}

function days(a: number, b: number): number {
  return Math.round((b - a) / DAY);
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** How long the gap has actually run, in days, across the library's recent films. */
function sampleGaps(movies: Iterable<MovieRec>, kind: ReleaseKind): number[] {
  const now = Date.now();
  const out: number[] = [];
  for (const m of movies) {
    const released = m.released ? new Date(m.released).getTime() : NaN;
    const date = announced(m, kind);
    const to = date ? new Date(date).getTime() : NaN;
    if (!Number.isFinite(released) || !Number.isFinite(to)) continue;
    if (released < now - SAMPLE_WINDOW_DAYS * DAY) continue;
    const gap = days(released, to);
    if (gap < 0 || gap > MAX_GAP_DAYS) continue;
    out.push(gap);
  }
  return out.sort((a, b) => a - b);
}

/** Already watchable that way in a country actually watched in — nothing left to estimate. */
function alreadyAvailable(movie: MovieRec, kind: ReleaseKind): boolean {
  const countries = getSettings().watchCountries.split(",").map((c) => c.trim().toUpperCase());
  for (const [country, entry] of Object.entries(movie.providers ?? {})) {
    if (!countries.includes(country.toUpperCase())) continue;
    for (const p of entry.providers) {
      // Any listing at all settles "when can I pay for this". Only a subscription, a free tier or
      // an ad-supported one settles "when is it included" — a rental never does.
      if (kind === "buy" || p.kind !== "rent") return true;
    }
  }
  return false;
}

/**
 * A guess at when `kind` becomes possible, or null when there is nothing to guess about — it is
 * announced, already watchable, watched, has no theatrical date, or is old enough that no
 * rollout is coming.
 */
export function estimateRelease(movies: Iterable<MovieRec>, movie: MovieRec, kind: ReleaseKind): ReleaseEstimate | null {
  if (movie.plays > 0 || announced(movie, kind)) return null;
  const released = movie.released ? new Date(movie.released).getTime() : NaN;
  if (!Number.isFinite(released)) return null;
  const now = Date.now();
  // Long past its window with nothing booked: the answer is "no idea", and saying that as a date
  // would be worse than saying nothing.
  if (released < now - MAX_GAP_DAYS * DAY) return null;
  if (alreadyAvailable(movie, kind)) return null;

  const gaps = sampleGaps(movies, kind);
  const enough = gaps.length >= MIN_SAMPLE;
  const q = enough
    ? { p25: percentile(gaps, 0.25), median: percentile(gaps, 0.5), p75: percentile(gaps, 0.75) }
    : FALLBACK[kind];

  const at = released + q.median * DAY;
  const high = released + q.p75 * DAY;
  const away = days(now, at);
  const precision = away > 180 ? "year" : away > 90 ? "season" : away > 30 ? "month" : "part";

  return {
    kind,
    at,
    low: released + q.p25 * DAY,
    high,
    precision,
    overdue: now > high,
    basis: enough
      ? `Estimated from ${gaps.length} films in your library: ${kind === "buy" ? "digital release" : "streaming"} came ${q.p25}–${q.p75} days after cinemas, ${q.median} typically.`
      : `Estimated from a typical ${q.p25}–${q.p75} day gap after cinemas — too few films in your library to measure your own.`,
  };
}

/**
 * The estimate in words, at the precision it deserves. Nothing here ever prints a day: a guess
 * that reads like a date is a guess that gets planned around.
 */
export function describeEstimate(est: ReleaseEstimate): string {
  const when = new Date(est.at);
  const month = when.toLocaleDateString(undefined, { month: "long" });
  const year = when.getFullYear();
  if (est.overdue) return "no date announced yet";
  switch (est.precision) {
    case "year":
      return `sometime in ${year}`;
    case "season": {
      // Thirds of a year read better than "Q3" and claim less.
      const third = when.getMonth() < 4 ? "early" : when.getMonth() < 8 ? "mid" : "late";
      return `${third} ${year}`;
    }
    case "month":
      return `around ${month} ${year}`;
    case "part": {
      const third = when.getDate() <= 10 ? "early" : when.getDate() <= 20 ? "mid" : "late";
      return `around ${third} ${month}`;
    }
  }
}
