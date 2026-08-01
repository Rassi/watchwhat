# Sync plan — Cloudflare Workers + D1

**Status:** decided 2026-08-01, not started. This document is the handoff into
the session that builds it.

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
1. **Server.** `wrangler init` a Worker in `server/`, D1 schema above, the two
   endpoints, bearer auth, CORS for `https://rassi.github.io`.
2. **Client write path.** Outbox store + append beside each of the seven
   mutations + a flush that retries.
3. **Client read path.** Cursor + replay through the existing local functions.
4. **Backfill.** One-off: turn the existing library into ~3,764 events and push
   from whichever device is declared authoritative. Then the other device pulls
   from `seq: 0`.

Rough effort: 1–2 evenings for 1–3, plus a careful hour on the backfill.

## Gotchas

- **The repo is public.** The sync token must never be committed. It lives as a
  Worker secret (`wrangler secret put`) and, on each device, in `localStorage`
  via a Settings field — the same per-device pattern as the TMDB and OMDb keys.
- **`wrangler login` is interactive.** Claude cannot run it; run it yourself
  (prefix a command with `!` in the Claude Code prompt to run it in-session).
- **Don't break the Pages build.** `tsconfig.json` has `"include": ["src"]` and
  `npm run build` runs `tsc` at the root, so a `server/` directory with its own
  tsconfig is safe — but check `npm run build` still passes after adding it.
- **CORS will be the first confusing hour** — the `OPTIONS` preflight must be
  answered and the auth header allowed.
- Mixed content is *not* an issue here (Workers are HTTPS); it would have been
  the main trap on the NAS route.

## Open decisions

- **Which device seeds the backfill.** The desktop currently holds 232 shows /
  344 movies / 154 watched-show records. The phone has not been counted. Compare
  export toast counts on both **before** seeding, because the loser's divergence
  is discarded.
- Whether the Settings sync card also exposes a "force full re-pull" for
  recovery, or whether clearing the cursor is enough.

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
