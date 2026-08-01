/**
 * The write half of sync: every local mutation also lands here, and stays until
 * the server has acknowledged it.
 *
 * This is the part that has to be right. Without it, an episode ticked on the
 * train — offline, or with the phone's radio half-asleep — is simply lost: the
 * local write succeeds, the request fails, and nothing ever tries again. So the
 * order is always *write locally, enqueue, then attempt to send*, and a failed
 * send changes nothing except when the next attempt happens.
 *
 * Events are never rewritten or collapsed. Marking watched then unwatched
 * appends two events rather than cancelling out, because the other device may
 * have already seen the first and the log is how it learns about the second.
 */

import { MAX_BATCH, pushEvents, syncConfigured, type OutgoingEvent } from "../api/syncserver";
import { dbDelete, dbGet, dbGetAll, dbGetAllEntries, dbPut } from "./db";
import { getDeviceId, getSettings } from "./settings";

/**
 * The event vocabulary, one entry per client mutation.
 *
 * Bodies carry **TMDB ids, never the local `traktId`**, so a device that has
 * never seen a title can still rehydrate it from TMDB. And because TMDB numbers
 * shows and films in separate namespaces — the same id means two different
 * titles — every body names which it is, either by the field it uses (`show` vs
 * `movie`) or by an explicit `type`.
 */
export type EventKind =
  | "episode.watched"
  | "episode.unwatched"
  | "movie.watched"
  | "movie.unwatched"
  | "watchlist.add"
  | "watchlist.remove"
  | "show.hidden"
  | "show.unhidden"
  | "list.add"
  | "list.remove";

export interface PendingEvent extends OutgoingEvent {
  kind: EventKind;
  body: Record<string, unknown>;
}

const CURSOR_KEY = "cursor";
const CURSOR_URL_KEY = "cursorUrl";

/** The same normalisation `syncserver` applies, so the two always agree. */
const serverUrl = (): string => getSettings().syncUrl.trim().replace(/\/$/, "");

/**
 * How far through the server's log this device has replayed. Device-local by
 * design — it describes this browser's position, not the library's state, which
 * is why the `sync` store stays out of exports.
 *
 * **A seq only means anything against the server that issued it.** Point a device
 * at a different log — a test Worker, or the NAS fallback — and the old number is
 * not just wrong but silently plausible: it fast-forwards past everything below
 * it and reports a clean sync. So the cursor is stored with the URL it was
 * counted against, and a mismatch restarts from the beginning. Replay is
 * idempotent, so re-reading a log this device has already seen costs time and
 * nothing else.
 */
export async function getCursor(): Promise<number> {
  const url = await dbGet<string>("sync", CURSOR_URL_KEY);
  if (url !== serverUrl()) return 0;
  return (await dbGet<number>("sync", CURSOR_KEY)) ?? 0;
}

export async function setCursor(seq: number): Promise<void> {
  await dbPut("sync", CURSOR_KEY, seq);
  await dbPut("sync", CURSOR_URL_KEY, serverUrl());
}

/** ISO timestamp shared by every event of one mutation, so a batch reads as one action. */
export const now = (): string => new Date().toISOString();

/**
 * Queue one event and try to send. Fire-and-forget by design: the caller has
 * already written to IndexedDB and must not be made to wait on the network, nor
 * fail because of it.
 */
export async function enqueue(kind: EventKind, body: Record<string, unknown>): Promise<void> {
  const event: PendingEvent = { id: crypto.randomUUID(), device: getDeviceId(), ts: now(), kind, body };
  await dbPut("outbox", event.id, event);
  void flush();
}

/** How many writes this device is still holding. */
export async function pendingCount(): Promise<number> {
  return (await dbGetAll<PendingEvent>("outbox")).length;
}

let flushing = false;
/** Set when a flush is asked for while one is already running. */
let flushAgain = false;

/**
 * Send everything queued, oldest first, deleting only what the server confirms.
 *
 * Returns the number sent. A failure is not thrown: flush is called from
 * mutation paths and on regaining connectivity, where there is nobody to report
 * to and nothing to do but wait for the next attempt.
 */
export async function flush(): Promise<number> {
  if (flushing) {
    flushAgain = true;
    return 0;
  }
  if (!syncConfigured()) return 0;

  flushing = true;
  let sent = 0;
  try {
    for (;;) {
      // Keys are the event ids, which is what has to be deleted on success.
      const entries = (await dbGetAllEntries("outbox")) as [string, PendingEvent][];
      if (entries.length === 0) break;

      // Oldest first, so the log's order matches the order things happened even
      // when a backlog is being drained.
      entries.sort((a, b) => a[1].ts.localeCompare(b[1].ts));
      const batch = entries.slice(0, MAX_BATCH);

      await pushEvents(batch.map(([, event]) => event));
      // Only now: until the server has them, this device is the only copy.
      await Promise.all(batch.map(([id]) => dbDelete("outbox", id)));
      sent += batch.length;

      if (batch.length < MAX_BATCH) break;
    }
  } catch {
    // Offline, wrong token, server down — all the same from here: leave the
    // queue alone and let the next trigger try again.
  } finally {
    flushing = false;
  }

  if (flushAgain) {
    flushAgain = false;
    return sent + (await flush());
  }
  return sent;
}
