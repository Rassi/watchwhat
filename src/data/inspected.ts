/**
 * Which films you have already opened from Discover, so their posters can be dimmed and a
 * grid you have seen before reads as "these four are new since last time".
 *
 * **In localStorage, not IndexedDB, and that is load-bearing.** Discover paints synchronously
 * inside `render` so the grid has its full height before the router restores the scroll
 * position — an `await` anywhere in that path arrives too late and the page jumps. Every read
 * here is therefore off an in-memory map, filled once at module load.
 *
 * It is *also* in D1, because "I have already looked at this" is a fact about a person rather
 * than a device, and the phone knowing what the desktop rejected is most of the value. The two
 * halves never disagree in a way that needs resolving: this is a set that only grows, so
 * merging is a union and the later of two timestamps wins for a film marked twice. That is why
 * it is a table of its own rather than a settings field, where last-write-wins would quietly
 * drop one device's marks — and why it is not an event, which would mint a full record from
 * TMDB on every device for a film that was merely glanced at. See `server/schema.sql`.
 *
 * Nothing here is exported to the transfer file. A look is not part of your library.
 */

import { pullInspectedSince, pushInspected, syncConfigured } from "../api/syncserver";

const KEY = "watchwhat.inspected";
const CURSOR_KEY = "watchwhat.inspected.cursor";
const PENDING_KEY = "watchwhat.inspected.pending";

/**
 * How many looks to remember. Twenty or thirty films a week is about a thousand a year, so
 * this is years of browsing; it exists so a runaway cannot fill localStorage, not because
 * anyone is expected to reach it. Oldest go first, which is also the right order for the
 * feature — a film you opened two years ago being bright again is not a lie worth avoiding.
 */
const LIMIT = 20_000;

/** `"movie:1234"` -> ISO 8601 of the most recent look. */
type Marks = Record<string, string>;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

let marks: Marks = read<Marks>(KEY, {});
/** Marks made here that the server has not acknowledged. Same job as the outbox, smaller. */
let pending: Marks = read<Marks>(PENDING_KEY, {});

function persist(): void {
  try {
    if (Object.keys(marks).length > LIMIT) {
      const kept = Object.entries(marks)
        .sort((a, b) => b[1].localeCompare(a[1]))
        .slice(0, LIMIT);
      marks = Object.fromEntries(kept);
    }
    localStorage.setItem(KEY, JSON.stringify(marks));
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    /* Storage full or blocked. A lost dim is not worth failing a navigation over. */
  }
}

/** The key both this and the shared title cache use. Never a traktId. */
export const inspectedKey = (tmdbId: number): string => `movie:${tmdbId}`;

export function isInspected(tmdbId: number): boolean {
  return marks[inspectedKey(tmdbId)] !== undefined;
}

/**
 * Record a look, and try to publish it immediately.
 *
 * The push is deliberately unawaited and its failure ignored: the caller is a click that is
 * about to navigate, and the mark is already local and already queued. Whatever fails now goes
 * out with the next sync, which is the same bargain the outbox makes.
 */
export function markInspected(tmdbId: number): void {
  const id = inspectedKey(tmdbId);
  const at = new Date().toISOString();
  marks[id] = at;
  pending[id] = at;
  persist();
  void flushInspected();
}

/** Send what is queued. Anything that fails stays queued. */
async function flushInspected(): Promise<void> {
  if (!syncConfigured() || Object.keys(pending).length === 0) return;
  const sending = { ...pending };
  try {
    await pushInspected(sending);
  } catch {
    return; // still pending, next sync tries again
  }
  // Only clear what was actually sent: a click during the request must not be dropped.
  for (const [id, at] of Object.entries(sending)) if (pending[id] === at) delete pending[id];
  persist();
}

/**
 * Push what this device recorded, then take in what the others did. Returns whether anything
 * arrived, so the caller can repaint an open screen.
 *
 * Push first for the same reason `syncNow` does: a slow round-trip must not be able to make
 * this device look like it knows less than it does.
 */
export async function convergeInspected(): Promise<boolean> {
  if (!syncConfigured()) return false;
  await flushInspected();

  let cursor = read<string>(CURSOR_KEY, "");
  let changed = false;
  try {
    for (let page = 0; page < 20; page++) {
      const answer = await pullInspectedSince(cursor);
      for (const [id, at] of Object.entries(answer.inspected)) {
        // Later look wins; an id already known at the same or a newer time is not news.
        if (marks[id] === undefined || marks[id] < at) {
          marks[id] = at;
          changed = true;
        }
      }
      cursor = answer.cursor;
      if (!answer.more) break;
    }
  } catch {
    // Offline, or the server is down. What is already local still dims correctly.
    return changed;
  }

  if (changed) persist();
  try {
    localStorage.setItem(CURSOR_KEY, JSON.stringify(cursor));
  } catch {
    /* see persist() */
  }
  return changed;
}
