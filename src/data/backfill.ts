/**
 * One-off: turn the library already on this device into the log's first events.
 *
 * The server starts empty, so without this the other device would sync only
 * what happens from now on and years of history would exist on exactly one
 * machine. This reads the current *state* and emits the events that would have
 * produced it — roughly 3,764 of them.
 *
 * **Event ids are derived from the fact, not generated.** `seed:ep:1396:1:1` is
 * the id for "watched Breaking Bad S1E1" no matter which device builds it or how
 * many times. Since the server ignores an id it already holds, that makes the
 * whole backfill safely repeatable: a push that dies at event 2,000 is fixed by
 * running it again, and running it twice over does nothing the second time.
 * Random ids would instead double every `plays` counter on the other device —
 * the one mistake here that would be tedious to unpick.
 *
 * State, not history: this can only say *that* something was watched, at the
 * best timestamp on record. Nothing is lost that the library still knows.
 */

import { MAX_BATCH, pushEvents, syncConfigured, type OutgoingEvent } from "../api/syncserver";
import type { EventKind } from "./outbox";
import type { MovieRec, ProgressRec } from "./model";
import { dbGetAll } from "./db";
import { getDeviceId } from "./settings";
import { loadLibrary, loadMovies } from "./sync";

export interface BackfillPlan {
  events: OutgoingEvent[];
  counts: { episodes: number; movies: number; watchlist: number; hidden: number; lists: number };
}

export interface BackfillProgress {
  sent: number;
  total: number;
}

/**
 * A timestamp for something the library never recorded one for. The epoch would
 * be honest but sorts every such entry to the dawn of time and, worse, reads as
 * a real date in the UI. `null`-ish history is better represented as "as far
 * back as this library goes", so undated entries land before everything dated
 * without pretending to a specific day.
 */
const UNDATED = "1970-01-01T00:00:00.000Z";

function event(id: string, kind: EventKind, body: Record<string, unknown>, at: string, device: string): OutgoingEvent {
  return { id, device, ts: at, kind, body };
}

/**
 * The `list.add` events for a library, dated from the memberships themselves.
 *
 * `seed2:` and not `seed:` because the first seeding sent every one of these stamped
 * `1970-01-01` — list membership carried no date to send — and the server's `INSERT OR IGNORE`
 * means an id it already holds can never be corrected in place. A fresh id is the only way to
 * retract a fact in an append-only log: both events replay, the later one wins, and the date
 * comes out right on every device. The old rows stay where they are, which is the point.
 *
 * Split out from `planBackfill` so the repair pass can send exactly these and nothing else.
 * Same ids from either route, so running both does the work once.
 */
function listEvents(movies: Iterable<MovieRec>, device: string): OutgoingEvent[] {
  const events: OutgoingEvent[] = [];
  for (const movie of movies) {
    const tmdb = movie.ids.tmdb;
    if (!tmdb) continue;
    for (const list of movie.customLists ?? []) {
      // `listedAt` as a second chance, not as the answer: `seedListAddedAt` normally fills
      // `listAddedAt` from it at startup, and if that has somehow not run, reading it here
      // directly still beats sending UNDATED under an id that can never be corrected again.
      const at = movie.listAddedAt?.[list] ?? movie.listedAt ?? UNDATED;
      events.push(event(`seed2:list:${tmdb}:${list}`, "list.add", { movie: tmdb, list, at }, at, device));
    }
  }
  return events;
}

/**
 * Build every event the current library implies. Pure — nothing is sent, so the
 * caller can show the counts and let the user decide.
 */
export async function planBackfill(): Promise<BackfillPlan> {
  const device = getDeviceId();
  const [lib, movies, progressRecs] = await Promise.all([
    loadLibrary(),
    loadMovies(),
    dbGetAll<ProgressRec>("progress"),
  ]);

  const events: OutgoingEvent[] = [];
  const counts = { episodes: 0, movies: 0, watchlist: 0, hidden: 0, lists: 0 };

  // A show's TMDB id is what goes over the wire; a record without one cannot be
  // described to another device at all, so it is skipped rather than guessed at.
  const showTmdb = new Map<number, number>();
  for (const show of lib.shows.values()) if (show.ids.tmdb) showTmdb.set(show.traktId, show.ids.tmdb);

  for (const progress of progressRecs) {
    const tmdb = showTmdb.get(progress.traktId);
    if (!tmdb) continue;
    for (const season of progress.seasons) {
      for (const ep of season.episodes) {
        if (!ep.completed) continue;
        events.push(
          event(
            `seed:ep:${tmdb}:${season.number}:${ep.number}`,
            "episode.watched",
            { show: tmdb, season: season.number, number: ep.number, at: ep.watchedAt ?? UNDATED },
            ep.watchedAt ?? UNDATED,
            device,
          ),
        );
        counts.episodes++;
      }
    }
  }

  for (const entry of lib.watchlist) {
    const tmdb = showTmdb.get(entry.traktId);
    if (!tmdb) continue;
    events.push(
      event(
        `seed:wl:show:${tmdb}`,
        "watchlist.add",
        { type: "show", tmdb, at: entry.listedAt },
        entry.listedAt,
        device,
      ),
    );
    counts.watchlist++;
  }

  for (const traktId of lib.hidden) {
    const tmdb = showTmdb.get(traktId);
    if (!tmdb) continue;
    // Never dated locally — hidden is a bare set of ids.
    events.push(event(`seed:hidden:${tmdb}`, "show.hidden", { show: tmdb, at: UNDATED }, UNDATED, device));
    counts.hidden++;
  }

  for (const movie of movies.values()) {
    const tmdb = movie.ids.tmdb;
    if (!tmdb) continue;

    if (movie.plays > 0) {
      const at = movie.lastWatchedAt ?? UNDATED;
      // Only one event however many plays: the id is per-film, so a rewatch
      // cannot be expressed here without inventing ids that would then differ
      // between runs. The other device learns it was seen, not how often.
      events.push(event(`seed:movie:${tmdb}`, "movie.watched", { movie: tmdb, at }, at, device));
      counts.movies++;
    }

    if (movie.onWatchlist) {
      const at = movie.listedAt ?? UNDATED;
      events.push(
        event(`seed:wl:movie:${tmdb}`, "watchlist.add", { type: "movie", tmdb, at }, at, device),
      );
      counts.watchlist++;
    }
  }

  const lists = listEvents(movies.values(), device);
  events.push(...lists);
  counts.lists = lists.length;

  // Oldest first, so the log reads in the order things happened.
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { events, counts };
}

/**
 * Just the list memberships, re-sent with the dates they actually have.
 *
 * A one-off for a log seeded before list membership carried a date: everything else in it was
 * dated correctly the first time, so pushing four thousand episode events to correct sixty-two
 * list ones would be all cost and no effect. Safe to run repeatedly for the same reason the
 * full seeding is — the ids are derived from the fact, so the second run changes nothing.
 */
export async function planListDateRepair(): Promise<BackfillPlan> {
  const device = getDeviceId();
  const movies = await loadMovies();
  const events = listEvents(movies.values(), device);
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { events, counts: { episodes: 0, movies: 0, watchlist: 0, hidden: 0, lists: events.length } };
}

/**
 * Push a plan in server-sized chunks.
 *
 * Deliberately bypasses the outbox: that is for the trickle of ordinary changes,
 * and dropping thousands of events into it would mean holding the whole backfill
 * in IndexedDB as well. Since the ids are deterministic, a failure needs no
 * queue to recover from — run it again.
 */
export async function pushBackfill(
  plan: BackfillPlan,
  onProgress?: (progress: BackfillProgress) => void,
): Promise<number> {
  if (!syncConfigured()) throw new Error("Sync is not configured");
  let sent = 0;
  for (let i = 0; i < plan.events.length; i += MAX_BATCH) {
    const chunk = plan.events.slice(i, i + MAX_BATCH);
    await pushEvents(chunk);
    sent += chunk.length;
    onProgress?.({ sent, total: plan.events.length });
  }
  return sent;
}

/** A one-line summary of what would be sent, for the confirmation. */
export function describePlan(counts: BackfillPlan["counts"]): string {
  const parts = [
    `${counts.episodes} watched episodes`,
    `${counts.movies} watched films`,
    `${counts.watchlist} watchlist entries`,
    counts.hidden ? `${counts.hidden} stopped shows` : "",
    counts.lists ? `${counts.lists} list entries` : "",
  ].filter(Boolean);
  return parts.join(", ");
}
