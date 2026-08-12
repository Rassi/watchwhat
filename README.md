# WatchWhat

A personal, TV Time-style TV show and film tracker: a static web app that keeps
your library in the browser and fetches everything it shows from
[TMDB](https://www.themoviedb.org). The app itself needs no server and deploys to
GitHub Pages; syncing between devices is optional and runs on a ~100-line
Cloudflare Worker in `server/`.

- **Watch list** with TV Time-style sections: *Watch Next* (recently watched,
  "NEW" badge when a new episode just aired), *Haven't watched for a while*,
  and *Haven't started*.
- **Show page** with per-season episode checkmarks and the classic
  "Mark previous episodes?" dialog (all previous / only this season / never for
  this show).
- **Movies** with a watchlist, custom lists, and a *Releases* tab for films
  you're waiting on.
- **Discover** — films you don't own yet. *Popular* merges what reached home
  lately, what is about to, and what is trending; *For You* asks TMDB what
  resembles your twelve most recent films. See [docs/discover.md](docs/discover.md).
- **Search** across TMDB to follow something new.
- **Where to watch**, cast, trailers, episode ratings, "Movies like this", and
  IMDb/Rotten Tomatoes scores with an optional OMDb key.

## How it works

IndexedDB *is* the library — it is not a cache of anything, and every screen
renders from it. A write lands there first and is answered from there; if sync is
on, a copy of the *event* is queued for the log afterwards, so losing the network
costs you nothing but the sharing. TMDB supplies search, metadata, episode lists,
air dates, artwork, cast and watch providers; OMDb optionally adds IMDb and
Rotten Tomatoes ratings. API keys live in `localStorage` only — nothing is baked
into the build, so the repo can be public.

WatchWhat was originally backed by a Trakt account. Trakt deleted the API app on
2026-07-30 and made API registration VIP-only, so the app was rebuilt to stand on
its own; the last Trakt code was removed on 2026-08-01. Two things Trakt used to
compute on its servers are now worked out locally: which episodes have aired
(from TMDB air dates, re-evaluated against today's date on every refresh) and
which episode you're up to.

**Sync is optional and off until you configure it.** A device with no sync
settings is entirely self-contained. Point one at the Worker (Settings → Sync,
server URL + token) and it pushes an append-only log of what you did — watches,
list changes — that other devices replay. It syncs *events*, not a snapshot, so
two devices that both changed something merge rather than one overwriting the
other. Your API keys and preferences ride along, so a second device needs only
those two fields. The server lives in `server/` (Cloudflare Workers + D1); see
[docs/sync-plan.md](docs/sync-plan.md).

The same Worker proxies JustWatch for the where-to-watch top-ups, and holds a
shared title cache so two devices don't pay for the same lookup twice — see
[docs/shared-title-cache.md](docs/shared-title-cache.md).

Settings also has an export/import to move a library between devices without
sync (import *replaces*, it does not merge).

The original TV Time → Trakt migration is done and its reconcile tool has been
removed; the exports it read are kept in `tvtime/` as the only surviving copy of
that history, and the tool itself is recoverable from git if ever needed.

## Setup (once, ~1 minute)

1. Get a free TMDB API key at <https://www.themoviedb.org/settings/api>
   (the "API Key (v3 auth)" value).
2. Open the app → **Settings** → paste it in.
3. Optional: a free [OMDb key](https://www.omdbapi.com/apikey.aspx) for IMDb and
   Rotten Tomatoes ratings.

The TMDB key is not optional in practice: without it a device can only browse
what it has already stored, with no search, no episode lists and no new-episode
detection.

On a device that syncs, this is a one-time setup for the *first* device only —
after that, entering the sync server URL and token is enough and the keys arrive
with the first pull. Without sync, repeat the steps above per browser.

## Passcode gate

The deployed app asks for a passcode once per browser (skipped on
localhost). It's a light deterrent — the repo is public, and nothing
sensitive ships in the build (API keys stay in each browser's
localStorage). Change it in `src/app-config.ts`:

```sh
printf %s "your-new-passcode" | sha256sum   # paste the hash into PASSCODE_SHA256
```

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # production build in dist/
```

Deploys automatically to GitHub Pages on push to `main`
(`.github/workflows/deploy.yml`); enable **Settings → Pages → Source: GitHub
Actions** in the repo once.

The sync server is separate and deploys on its own — see
[server/README.md](server/README.md). The app does not depend on it building or
running.

Design notes worth reading before changing anything in these areas:
[discover.md](docs/discover.md), [where-to-watch.md](docs/where-to-watch.md),
[sync-plan.md](docs/sync-plan.md),
[shared-title-cache.md](docs/shared-title-cache.md),
[dependencies.md](docs/dependencies.md) (the measured API load and the TTLs
governing it), [poster-flicker.md](docs/poster-flicker.md) (an unsolved iOS bug,
and what four recordings ruled out).

This product uses the TMDB API but is not endorsed or certified by TMDB.
