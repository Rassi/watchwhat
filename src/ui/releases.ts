/**
 * Releases: one timeline for the films you're waiting on, running past to future —
 * what just became watchable, what has a date, and what can only be guessed at.
 *
 * The screen exists because none of this was answerable from a list sorted by when you added
 * things. A film arriving on a service you pay for is the single most actionable event in the
 * whole app, and until now it announced itself only as a small ▶ appearing on a poster you had
 * no reason to look at again. The future half is here because a tab that is only ever "three
 * films landed" would be empty most weeks — and because `releaseEstimate` was already computing
 * "roughly when can I watch this" for every unreleased film, with nowhere to show it but the
 * individual movie page you had to think to open.
 *
 * Scope is deliberately your own watchlist, not discovery. Everything here comes from records
 * this device has already fetched, so the screen costs no requests of its own.
 *
 * It sits under Movies as a third top tab rather than in the bottom bar, because films are all
 * it can ever cover: progress records hold aired episodes only, so "when does this show come
 * back" would cost a TMDB request per show — the same bill that retired the old Upcoming tab.
 */

import type { Route } from "../router";
import { el, posterCard, sectionHeader } from "./components";
import { ensureMovieDetails, loadMovies } from "../data/sync";
import { isTrackedMovie, type MovieRec } from "../data/model";
import { posterUrl } from "../api/tmdb";
import { getSettings } from "../data/settings";
import { matchServiceRule, parseServiceRules, watchBadge, type ServiceRule } from "./shared";
import { describeEstimate, estimateRelease, type ReleaseEstimate } from "../data/releaseEstimate";
import { moviesTabs } from "./hometabs";

const DAY = 24 * 3600 * 1000;

/**
 * How many recent arrivals to show. A count rather than a date window, deliberately: a window
 * is empty in a quiet month, which is the one thing a top section must never be, and "the last
 * ten things that became watchable" is what the question actually means anyway.
 */
const RECENT_LIMIT = 10;

/** Past this, "3 weeks ago" stops being the useful phrasing and a date reads better. */
const AGO_LIMIT_DAYS = 60;

function watchCountries(): string[] {
  return getSettings().watchCountries.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
}

/** Films you're waiting on: on a list, and not yet watched. */
function pending(movies: Map<number, MovieRec>): MovieRec[] {
  return [...movies.values()].filter((m) => m.plays === 0 && (m.onWatchlist || (m.customLists?.length ?? 0) > 0));
}

/** "HBO Max Amazon Channel" — the same service resold through someone else's billing. */
function isReseller(name: string): boolean {
  return /\b(amazon|apple tv|roku)\s+channel$/i.test(name);
}

interface Available {
  movie: MovieRec;
  /** The service it can be watched on — the thing you actually want to be told. */
  provider: string;
  at: number;
  /** The date came from watching it appear, rather than from a published release date. */
  observed: boolean;
}

/**
 * A film watchable right now at no extra cost, dated as well as this device can date it.
 *
 * Two sources, best first. A `providerSince` stamp is the real thing: this device saw the
 * listing appear, so the date is the arrival itself. Failing that — which is every film until
 * the stamps have had a refresh cycle to accumulate — the published streaming or digital date
 * stands in. That is a claim about the film rather than about your services, so it can be wrong
 * by a country, but it is right far more often than it is not and it is available today.
 *
 * Whichever date is used, availability is decided by the *current* listing. A film that has
 * since left every service you have drops out, however recently it arrived.
 */
function availableNow(movie: MovieRec, rules: ServiceRule[], countries: string[]): Available | null {
  const candidates: { name: string; at: number }[] = [];

  for (const cc of countries) {
    for (const p of movie.providers?.[cc]?.providers ?? []) {
      if (p.kind === "rent") continue; // paying per title is not the film becoming available
      const rule = matchServiceRule(rules, p.name, cc);
      if (rule?.blocked) continue; // a service you've said you can't use is not good news
      const free = p.kind === "free" || p.kind === "ads";
      if (!rule && !free) continue; // streams, but not anywhere you can watch it
      candidates.push({ name: p.name, at: movie.providerSince?.[`${cc}:${p.name}`] ?? 0 });
    }
  }
  if (candidates.length === 0) return null;

  // **Earliest sighting first**, which is the date being asked for: this section says when the
  // film became watchable, not when the last of your services got round to carrying it. Taking
  // the most recent instead made every stamp a ratchet — a film re-dated itself as each slower
  // country's listing was noticed, and the date shown was always whichever country TMDB had
  // ingested last. *The Four Seasons* read "Netflix · yesterday" two days after it was added
  // because Denmark's listing was the last of six to appear.
  //
  // A baseline `0` therefore wins outright, and should: it means the film was already on that
  // service when tracking began, so nothing arrived and the published date below is the honest
  // stand-in. Then plain services ahead of resellers — TMDB lists "HBO Max" and "HBO Max Amazon
  // Channel" separately, and where both are yours the label should name the one you think of it
  // as. Ties keep settings order, so the first watch country wins a genuine tie.
  candidates.sort((a, b) => a.at - b.at || Number(isReseller(a.name)) - Number(isReseller(b.name)));
  const provider = candidates[0].name;
  const stamped = candidates[0].at;
  if (stamped > 0) return { movie, provider, at: stamped, observed: true };

  // No sighting on record — fall back to what the film says about itself.
  const published = [movie.streamingRelease?.date, movie.digitalRelease?.date, movie.released]
    .map((d) => (d ? new Date(d).getTime() : NaN))
    .find((t) => Number.isFinite(t) && t <= Date.now());
  return { movie, provider, at: published ?? 0, observed: false };
}

/** Day-granularity age. Hours would be false precision — TTLs mean the stamp is a day old anyway. */
function agoLabel(at: number): string {
  const days = Math.floor((Date.now() - at) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return `${Math.floor(days / 7)} weeks ago`;
}

/**
 * "Netflix · 3 days ago" for something that landed this month, "Disney Plus · 12 Mar" for
 * something that has been there a while. A relative age is what you want for news and useless
 * for anything older — nobody reads "62 weeks ago" as a time.
 */
function availableLabel(a: Available): string {
  if (a.at <= 0) return a.provider; // no date on record at all — the service alone still helps
  const recent = Date.now() - a.at < AGO_LIMIT_DAYS * DAY;
  return `${a.provider} · ${recent ? agoLabel(a.at) : dateLabel(new Date(a.at).toISOString())}`;
}

/**
 * An estimate in words, with one correction this screen needs and the movie page doesn't.
 *
 * `describeEstimate` prints the middle of the window as a date — "around early July" — which is
 * fine on a film's own page but reads as broken in a list sorted by date, where the first rows
 * are the ones whose middle has already gone past. Those films aren't late yet (the window runs
 * to p75), they're simply due, so they say so.
 */
function estimateLabel(est: ReleaseEstimate): string {
  if (!est.overdue && est.at < Date.now()) return "due any time now";
  return describeEstimate(est);
}

function dateLabel(iso: string): string {
  const when = new Date(iso);
  const sameYear = when.getFullYear() === new Date().getFullYear();
  return when.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

interface Booked {
  movie: MovieRec;
  at: number;
  label: string;
}

/**
 * An announced date still in the future, or null.
 *
 * The streaming date wins over the digital one when both exist: "included in something you pay
 * for" and "available to buy" are different events, and the first is the one being waited for.
 * `streamingRelease` also carries the services in its note, which is what makes the row worth
 * reading at a glance.
 */
function booked(movie: MovieRec): Booked | null {
  const streaming = movie.streamingRelease;
  const digital = movie.digitalRelease;
  const pick = streaming ?? digital;
  if (!pick) return null;
  const at = new Date(pick.date).getTime();
  if (!Number.isFinite(at) || at < Date.now()) return null;
  const where = streaming ? streaming.note.replace(/\s*\/\s*/g, " / ") : "Digital";
  return { movie, at, label: `${where} · ${dateLabel(pick.date)}` };
}

export const releasesRoute: Route = {
  name: "releases",
  // A Movies screen with its own address, like Shows' two tabs — so the bottom bar keeps
  // pointing at Movies while you're here.
  tab: "movies",
  title: "Releases · WatchWhat",
  async render(container) {
    container.append(moviesTabs("releases"));

    const movies = await loadMovies();
    const content = el("div", {});
    container.append(content);

    const card = (movie: MovieRec, note: string): HTMLElement =>
      posterCard({
        title: movie.title,
        href: `#/movie/${movie.traktId}`,
        posterUrl: posterUrl(movie.poster),
        progress: null,
        badge: null,
        watch: watchBadge(movie.providers),
        // Title as subtitle so in-page text search finds films here too, same as the Movies grid.
        subtitle: movie.title,
        note,
      });

    const renderContent = (): void => {
      const rules = parseServiceRules(getSettings().myServices);
      const countries = watchCountries();
      const waiting = pending(movies);
      content.replaceChildren();

      const arrived = waiting
        .map((m) => availableNow(m, rules, countries))
        .filter((a): a is Available => a !== null)
        .sort((a, b) => b.at - a.at)
        .slice(0, RECENT_LIMIT);

      const arrivedIds = new Set(arrived.map((a) => a.movie.traktId));
      const soon = waiting
        .filter((m) => !arrivedIds.has(m.traktId))
        .map(booked)
        .filter((b): b is Booked => b !== null)
        .sort((a, b) => a.at - b.at);

      // Only films with nothing booked get guessed at — `estimateRelease` enforces this too,
      // but filtering here keeps a film from being listed twice on the way past.
      const bookedIds = new Set(soon.map((b) => b.movie.traktId));
      const estimated = waiting
        .filter((m) => !arrivedIds.has(m.traktId) && !bookedIds.has(m.traktId))
        .map((m) => ({ movie: m, est: estimateRelease(movies.values(), m, "stream") }))
        .filter((row): row is { movie: MovieRec; est: ReleaseEstimate } => row.est !== null)
        .sort((a, b) => Number(a.est.overdue) - Number(b.est.overdue) || a.est.at - b.est.at);

      if (arrived.length > 0) {
        content.append(
          sectionHeader("Recently available", {
            title: "Recently available",
            points: [
              "Films on your lists you can watch right now on one of your services, or free — the most recent " +
                `${RECENT_LIMIT}, newest first.`,
              "Rentals don't count: paying per title isn't the film becoming available.",
              "A service you've marked with a “-” in Settings doesn't count either.",
              "Dates start out as the film's published streaming date. Once this device has actually seen a film appear on a service, that sighting is used instead — it's the more honest date, and it catches films that quietly join a catalogue with no announcement.",
            ],
          }),
          el("div", { class: "poster-grid" }, ...arrived.map((a) => card(a.movie, availableLabel(a)))),
        );
      }

      if (soon.length > 0) {
        content.append(
          sectionHeader(`Coming soon (${soon.length})`, {
            title: "Coming soon",
            points: [
              "Films with a release date actually announced, soonest first.",
              "The streaming date is shown when there is one, since that's the date something you already pay for starts including it.",
              "Otherwise it's the digital date — when it can be bought or rented.",
            ],
          }),
          el("div", { class: "poster-grid" }, ...soon.map((b) => card(b.movie, b.label))),
        );
      }

      if (estimated.length > 0) {
        const [expected, overdue] = [estimated.filter((r) => !r.est.overdue), estimated.filter((r) => r.est.overdue)];
        if (expected.length > 0) {
          content.append(
            sectionHeader(`Expected (${expected.length})`, {
              title: "Expected",
              points: [
                "Films out in cinemas with nothing announced yet — so this is an estimate, not a date.",
                expected[0].est.basis,
                "Deliberately vague, and vaguer the further out it is. A film moves to Coming soon the moment a real date turns up.",
              ],
            }),
            el("div", { class: "poster-grid" }, ...expected.map((r) => card(r.movie, estimateLabel(r.est)))),
          );
        }
        if (overdue.length > 0) {
          content.append(
            sectionHeader(`No date yet (${overdue.length})`, {
              title: "No date yet",
              points: [
                "Films that are past the point where most releases have been announced, with still nothing booked.",
                "Guessing further would be making it up, so these just sit here until a date appears.",
              ],
            }),
            el("div", { class: "poster-grid" }, ...overdue.map((r) => card(r.movie, "no date announced"))),
          );
        }
      }

      if (content.childElementCount === 0) {
        content.append(
          el(
            "div",
            { class: "empty-note" },
            movies.size === 0
              ? "No movies here yet — import your data from Settings, or add some via Search."
              : "Nothing on the horizon — everything on your watchlist is either already watchable or too old to be waiting on.",
          ),
        );
      }
    };

    renderContent();
    // Tracked films only — see `isTrackedMovie`. This screen shows nothing else anyway.
    const tracked = [...movies.values()].filter(isTrackedMovie).map((m) => m.traktId);
    void ensureMovieDetails(movies, tracked, renderContent, { skipWatchedRefresh: true });
  },
};
