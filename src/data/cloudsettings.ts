/**
 * The sync half of settings: the network round trip that `settings.ts` — which
 * stays pure localStorage, with no imports — deliberately has no way to make.
 *
 * Why settings are not events. They are mutable state, so an append-only log is
 * the wrong shape twice over: it would accumulate every API key ever rotated,
 * and, worse, a key arriving partway through replay is too late. Replay mints
 * unseen titles from TMDB and *skips* the ones it cannot resolve while still
 * advancing the cursor, so a device that learned its TMDB key from event 3,000
 * would have silently dropped the 2,999 before it. Settings therefore have to be
 * readable in one call, before any of that starts — which is exactly what
 * `syncNow` does with this.
 */

import { pullSettings, pushSettings, syncConfigured } from "../api/syncserver";
import { mergeCloudSettings, type CloudKey } from "./settings";

/**
 * Pull the server's settings, merge newest-write-wins, push back anything this
 * device changed while the server wasn't listening. Returns the fields whose
 * local value this changed, so the caller can redraw.
 *
 * Failures are swallowed, as everywhere else in sync: there is nobody to report
 * to on a background run, the local cache is still serviceable, and the stamps
 * mean an unsent edit is simply owed again next time rather than lost.
 */
export async function reconcileSettings(): Promise<CloudKey[]> {
  if (!syncConfigured()) return [];

  try {
    const { changed, push } = mergeCloudSettings(await pullSettings());
    if (Object.keys(push).length === 0) return changed;

    // Merge the post-write state too. A field of ours the server rejected as
    // stale comes back as the winner here, so one round trip settles it instead
    // of this device staying wrong until the next poll.
    const after = mergeCloudSettings(await pushSettings(push));
    return [...changed, ...after.changed];
  } catch {
    return [];
  }
}
