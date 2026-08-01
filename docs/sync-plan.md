# Sync plan — Cloudflare Workers + D1

**Status:** built, deployed and seeded, 2026-08-01. All four steps are done and
the production log holds 4,195 events. What remains is operational, not code —
see "Still to do".

WatchWhat has been fully local-first since 2026-08-01 (commit `e1f4676` removed
the last Trakt code). Every device holds the complete library in IndexedDB and
writes only to IndexedDB. **There is no sync**, so the desktop and the iPhone are
both authoritative and drift apart. Closing that is the only significant work
left on the app.

## The decision

**Cloudflare Workers + D1.** Free, always up, TLS and CORS handled, nothing
exposed at home, ~100 lines of server.

Ruled out, with reasons, so they don't get relitigated:

- **DS214play + Python** — free and no purchase, and the design would work
  unchanged (the API contract is identical, which is what makes this reversible).
  But it needs DDNS + Let's Encrypt + a port open to the internet, and Tailscale
  instead would mean the VPN must be active for a home-screen web app to sync.
  Keep as the fallback if Cloudflare ever changes terms — it is a URL change and
  a re-seed, not a migration.
- **Supabase** — free projects pause after 7 days of inactivity. Disqualifying
  there because PostgREST *was* the backend. (Cloudflare has no equivalent
  policy; checked 2026-08-01, see "Verified facts".)
- **.NET on a 64-bit host** — his day-job language, but no free always-on host he
  already has. Revisit only if a Plus-series NAS appears.
- **MongoDB Atlas** — the browser cannot reach it since the Data API retired in
  Sept 2025; needs a serverless layer in front, at which point Mongo adds nothing.

## Design: append-only event log

Not a state blob. Whole-blob last-writer-wins silently eats the other device's
changes, which is exactly the failure this exists to prevent.

```sql
CREATE TABLE events (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,  -- the sync cursor
  id     TEXT UNIQUE NOT NULL,               -- client-generated UUID
  device TEXT NOT NULL,
  ts     TEXT NOT NULL,                      -- when it happened, not when received
  kind   TEXT NOT NULL,
  body   TEXT NOT NULL                       -- JSON
);
```

Two endpoints:

- `GET /events?since=<seq>` → events after the cursor, plus the new max seq.
- `POST /events` → batch append, `INSERT OR IGNORE` on `id`.

Auth: one long random bearer token, constant-time compared.

**Keep the server dumb.** It never interprets an event. Two devices can be
offline, both append, and the union merges with no locking and no server logic.
Client-generated UUIDs make retries idempotent for free — which matters on a
phone with a flaky connection.

### Event vocabulary

Maps 1:1 onto the seven client mutations (see below):

| kind | body |
|---|---|
| `episode.watched` / `episode.unwatched` | `{ show: <tmdbId>, season, number, at }` |
| `movie.watched` / `movie.unwatched` | `{ movie: <tmdbId>, at }` |
| `watchlist.add` / `watchlist.remove` | `{ type: "show"\|"movie", tmdb, at }` |
| `show.hidden` / `show.unhidden` | `{ show: <tmdbId>, at }` |
| `list.add` / `list.remove` | `{ movie: <tmdbId>, list, at }` |

**Bodies carry TMDB ids, never the local `traktId` key.** Two already-populated
devices would work either way, but a fresh device must be able to rehydrate from
TMDB alone.

**⚠️ TMDB ids are namespaced per media type.** A show and a film can share the
same numeric id, so every event must say which it is. Locally this is invisible
because shows and movies live in separate object stores and `tmdbKey()` maps both
to `-id`; over the wire it would silently corrupt.

## Client-side work

The local state machine already exists and is what replay reuses — this is the
part that made removing Trakt cheap rather than expensive:

`computeNextEpisode`, `progressFromEpisodes`, `watchedEpisodesOf`,
`applyLocalWatch`, `persistShowState` (all in `src/data/sync.ts`).

The seven mutation entry points, each of which currently writes locally and
emits, and each of which needs one line to append an event:

`setEpisodesWatched`, `addToWatchlist`, `setShowHidden`, `removeFromWatchlist`,
`setMovieWatched`, `setMovieOnWatchlist`, `setMovieOnCustomList`.

**The outbox is the part to build carefully.** Events go into an IndexedDB
`outbox` store alongside the local write, and are cleared only once the server
acks them. Without it, an episode ticked on the train is simply lost. Replay on
the read side is: pull events after the cursor, feed each through the same local
mutation functions, advance the cursor.

## Steps

0. ~~Pick the host~~ — done, Cloudflare.
1. ~~**Server.**~~ — done 2026-08-01, `server/`, see its README. Scaffolded by
   hand rather than `wrangler init` (interactive). Verified against local D1:
   auth rejects, a resent batch reports `accepted` without advancing `seq`, reads
   page at 500 carrying the cursor, and the preflight answers only the allowed
   origins. **Not deployed yet** — that needs `wrangler login`.
2. ~~**Client write path.**~~ — done 2026-08-01. `src/data/outbox.ts` (queue,
   flush, cursor), `src/api/syncserver.ts` (the two calls), an append in each of
   the seven mutations, and a Sync card in Settings. Verified in Chrome against a
   local Worker, including that events queued while it was down went out on the
   next flush.
3. ~~**Client read path.**~~ — done 2026-08-01, `src/data/replay.ts`. Cursor +
   replay through the existing local mutations, which now take a `MutationOpts`
   of `{ replay, at }`. Verified with a second origin (`127.0.0.1:5173` vs
   `localhost:5173`, separate IndexedDB) standing in for a second device: an
   empty library rebuilt itself from the log alone.
4. ~~**Backfill.**~~ — built 2026-08-01, `src/data/backfill.ts` plus a "Seed the
   server from this device…" action in Settings. **Run against production the
   same day, from the iPhone** rather than the desktop as planned, because the
   phone had the more recent ticks and the film *Her*. The live log holds
   **4,195 events** (3,764 watched episodes, 231 films, 138 watchlist entries,
   62 list entries), all from the one device.

   Ids are derived from the fact — `seed:ep:1396:1:1` — not generated, so the
   whole thing is safely repeatable: a push that dies at event 2,000 is fixed by
   running it again. Verified by pushing all 4,173 twice; the log still held
   4,173 rows.

   **Still do the phone export first.** That file is the only copy of whatever
   it has marked since 2026-07-30, and `importBackup` clears each store before
   writing. Diffing it against the desktop afterwards gives the exact list of
   stragglers to re-tick, which beats recalling them.

Rough effort: 1–2 evenings for 1–3, plus a careful hour on the backfill.

## Running the backfill

1. Paste the token into Settings → Sync on **both** devices and Save.
2. **Export the phone to a file** and keep it. Everything below assumes the
   desktop wins.
3. Desktop → Settings → Sync → **Seed the server from this device…**, confirm.
4. Bring the phone up to date, either way round:
   - **Import the desktop's export, then Sync now.** Fast, no TMDB traffic. Safe
     since replay became idempotent — it was not before, see below.
   - **Or let it rebuild from the log alone.** Correct but slow: every show it
     has never seen is fetched from TMDB and its episode list built, which for
     232 shows is thousands of requests. Fine on the desktop, unpleasant on a
     phone.
5. Re-tick the stragglers from the phone's export.

**Replay is idempotent, but that took a fix.** `plays` used to move on every
episode event rather than on an actual change of state, so replaying history
onto a device that already had it doubled every total — silently, since the
episode ticks themselves stayed correct. Three consecutive full replays now
leave the numbers alone. If either counter ever starts climbing, this is the
first place to look.

## Not sync problems (checked 2026-08-01)

Three things looked like sync discrepancies after the first real seed and none
of them were. Worth knowing before chasing the next one.

- **`localhost:5173` is a different device.** It is a separate browser origin
  from `rassi.github.io`, so a separate IndexedDB *and* a separate Settings —
  including its own sync token, which it does not have. It will keep showing a
  pre-sync library, in a different order, until it is configured too. Compare the
  live site against the phone, not the dev server.
- **Providers are never synced.** "Where to watch" is per-device TMDB/JustWatch
  cache on a TTL, so the same title can read free on one device and rent on
  another. That is cache age, not drift, and syncing it would be wrong — it is
  derived metadata, not something the user did.
- **A stale `nextEpisode.firstAired` moves shows between sections.** Fixed in
  `refreshNextEpisode`; see the gotcha below.

## Two real bugs the first cross-device comparison found (2026-08-01)

Both were found from one symptom: the dev origin showed Location, Location,
Location at 183/351 where the live site showed 203/370. Neither was visible
from a single device, and both reported a clean sync while losing data.

- **The cursor was not tied to a server.** The dev origin's cursor was still at
  4173 from testing against the local Worker. Pointed at production it asked for
  `since=4173`, got the 22 events above it, applied those, and jumped to 4195 —
  skipping 4,173 events it had never seen, and saying it was up to date. Fixed by
  storing the URL alongside the cursor and restarting from zero on a mismatch.
  **Deploying that fix makes every existing device re-pull once**, because none
  of them has a recorded URL — which is also how they get the second fix applied
  retroactively.
- **A replayed watch was dropped if the local episode cache had never heard of
  the episode.** `applyLocalWatch` found no entry, so the idempotency guard did
  not fire, `plays` was incremented, and the branch that marks the episode did
  nothing. The cursor then advanced past the event, so the loss was permanent and
  showed up only as a `plays` count drifting above `completed`. Fixed by creating
  the season and episode on the spot.

**The log is not the union of the libraries.** Only the phone was seeded, so
watches that exist solely on another device were never appended and cannot
propagate — the live site has at least one Location episode the log does not.
Seeding again from the desktop fixes this: the ids are derived from the fact, so
a second seed appends only what is genuinely new.

## Still to do

- Re-seed from the desktop so the log becomes the union of both libraries.
- Re-tick the stragglers from the phone export.

## Gotchas

- **The repo is public.** The sync token must never be committed. It lives as a
  Worker secret (`wrangler secret put`) and, on each device, in `localStorage`
  via a Settings field — the same per-device pattern as the TMDB and OMDb keys.
- **`wrangler login` is interactive.** Claude cannot run it; run it yourself
  (prefix a command with `!` in the Claude Code prompt to run it in-session).
- **Don't break the Pages build.** `tsconfig.json` has `"include": ["src"]` and
  `npm run build` runs `tsc` at the root, so a `server/` directory with its own
  tsconfig is safe — but check `npm run build` still passes after adding it.
- ~~**CORS will be the first confusing hour**~~ — handled in the Worker, and the
  preflight is answered *before* auth on purpose: a 401 without CORS headers
  reaches the browser as an opaque network error that hides the real cause.
- **`seq` is monotonic but not contiguous.** Deleted rows certainly leave gaps,
  and an ignored duplicate sometimes does — re-pushing 2 events left a gap of 2,
  while re-pushing all 4,173 of the backfill left none, so it depends on the
  path SQLite takes. Don't reason about the mechanism; just never write a client
  that counts on +1 steps. The `seq > ?` cursor doesn't care.
- **The local D1 database is keyed by `database_id`.** Changing it in
  `wrangler.toml` — as pasting the real id after `d1 create` does — silently
  points `wrangler dev` at a fresh, empty database. Re-run `npm run schema:local`
  or every request 500s with `no such table: events`.
- **`nextEpisode` is only as good as the episode cache was when progress last
  rebuilt.** The two caches refresh on independent schedules, so a show whose
  progress rebuilt before its page had ever been opened gets a next episode with
  no air date — which silently disables the untouched-new-season rule and drops a
  season that just landed into "Haven't watched for a while". `ensureEpisodes`
  now recomputes it (`refreshNextEpisode`). This is device-local and has nothing
  to do with sync, but it presents exactly like a sync bug: two devices showing
  the same show in different sections.
- **A store is only ever created in `onupgradeneeded`.** A database that reaches
  a version without one can otherwise never gain it, and every read throws
  `NotFoundError` forever — which happened once while building step 2, cause
  never established. `openDb` now checks the store list after opening and
  reopens one version higher to repair it, so adding a store later needs no
  version bump. Don't "simplify" that second pass away.
- Mixed content is *not* an issue here (Workers are HTTPS); it would have been
  the main trap on the NAS route.

## Open decisions

- ~~Which device seeds the backfill~~ — **decided 2026-08-01: the desktop**, which
  holds 232 shows / 344 movies / 154 watched-show records. The phone is the
  authoritative library in principle, but little was marked on it after Trakt
  access ended on 2026-07-30, so the divergence is about two days' worth and is
  cheaper to re-enter by hand than to reconcile in code.
- Whether the Settings sync card also exposes a "force full re-pull" for
  recovery, or whether clearing the cursor is enough. **Still not built**, but
  less pressing now: changing the server URL forces one automatically, which is
  what repaired both devices after the two bugs above. Clearing the cursor by
  hand remains insufficient on its own — replay skips events whose `device`
  matches this one, so a device re-pulling from 0 skips its own history. Clearing
  site data does work, because that drops the `watchwhat.deviceId` in
  localStorage too and the device comes back under a new name.

## Verified facts (2026-08-01)

- **D1 free tier:** 5 GB storage, 5M rows read/day, 100k rows written/day.
- **No inactivity policy.** Cloudflare documents no pausing, hibernation or
  deletion of idle D1 databases; the only idle language is billing
  ("if you are not running queries against your database, you are not billed for
  compute"). Workers have no provisioned instance to suspend.
- **Headroom:** the 3,764-event backfill is ~4% of one day's write allowance
  (~450 KB); steady state is a handful of events a day and reads that usually
  return nothing.
- **Every record already carries `ids.tmdb`** — all 232 shows and all 344 movies,
  measured directly from IndexedDB. This is why no re-keying is needed and why
  event bodies can use TMDB ids immediately.

## If the old Trakt sync code is ever wanted as reference

```sh
git show e1f4676^:src/data/sync.ts    # syncLibrary, syncMovies, adoptBaseline
git show e1f4676^:src/api/trakt.ts    # the API client and OAuth device flow
```

Note that its shape is deliberately *not* what this design wants: it pulled
everything and bulk-replaced (`dbClear` + `dbBulkPut`) on the assumption that one
server held the truth. With two peers merging, that is the bug.
