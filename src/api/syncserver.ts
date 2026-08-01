/**
 * Client for the sync Worker (`server/` in this repo).
 *
 * Two calls over one append-only log. Everything here throws on failure rather
 * than swallowing it: the outbox decides what to retry, and a push that quietly
 * "succeeded" after a 500 would drop the events it was holding.
 */

import { getSettings } from "../data/settings";

/** An event as the server hands it back — the same shape plus its assigned seq. */
export interface RemoteEvent {
  seq: number;
  id: string;
  device: string;
  ts: string;
  kind: string;
  body: unknown;
}

export interface OutgoingEvent {
  id: string;
  device: string;
  ts: string;
  kind: string;
  body: unknown;
}

export interface EventPage {
  events: RemoteEvent[];
  seq: number;
  /** More waiting beyond this page — call again with the returned seq. */
  more: boolean;
}

/** The server caps a batch at 1000; the backfill relies on this matching. */
export const MAX_BATCH = 1000;

export function syncConfigured(): boolean {
  const { syncUrl, syncToken } = getSettings();
  return !!syncUrl.trim() && !!syncToken.trim();
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const { syncUrl, syncToken } = getSettings();
  if (!syncUrl.trim() || !syncToken.trim()) throw new Error("Sync is not configured");

  const res = await fetch(`${syncUrl.trim().replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${syncToken.trim()}` },
  });
  if (!res.ok) {
    // The Worker answers errors as JSON; fall back to the status if it didn't.
    const detail = await res
      .json()
      .then((b) => (b as { error?: string })?.error)
      .catch(() => null);
    throw new Error(detail ?? `Sync server returned ${res.status}`);
  }
  return res.json();
}

/** Append a batch. Re-sending an id the server already has is a no-op there. */
export async function pushEvents(events: OutgoingEvent[]): Promise<{ accepted: number; seq: number }> {
  return (await request("/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  })) as { accepted: number; seq: number };
}

/** One page of events after the cursor. */
export async function pullEvents(since: number): Promise<EventPage> {
  return (await request(`/events?since=${since}`)) as EventPage;
}

/**
 * Round-trip that proves URL, token and CORS all line up — what the Settings
 * "Test" button calls, so a wrong token is found on the spot rather than the
 * first time something is marked watched.
 *
 * Reads from the device's own cursor rather than from 0: on a device that is
 * already caught up it transfers nothing, and what it reports ("12 waiting") is
 * the number actually worth knowing.
 */
export async function testConnection(since: number): Promise<EventPage> {
  return pullEvents(since);
}
