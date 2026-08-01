# WatchWhat

A personal, TV Time-style TV show and film tracker: a static web app that keeps
your library in the browser and fetches everything it shows from
[TMDB](https://www.themoviedb.org). No server, no database to run — deployable to
GitHub Pages.

- **Watch list** with TV Time-style sections: *Watch Next* (recently watched,
  "NEW" badge when a new episode just aired), *Haven't watched for a while*,
  and *Haven't started*.
- **Show page** with per-season episode checkmarks and the classic
  "Mark previous episodes?" dialog (all previous / only this season / never for
  this show).
- **Movies** with a watchlist and custom lists.
- **Search** across TMDB to follow something new.
- **Where to watch**, cast, trailers, episode ratings, and IMDb/Rotten Tomatoes
  scores with an optional OMDb key.

## How it works

IndexedDB *is* the library — it is not a cache of anything. Writes land there and
stop there. TMDB supplies search, metadata, episode lists, air dates, artwork,
cast and watch providers; OMDb optionally adds IMDb and Rotten Tomatoes ratings.
API keys live in `localStorage` only — nothing is baked into the build, so the
repo can be public.

WatchWhat was originally backed by a Trakt account. Trakt deleted the API app on
2026-07-30 and made API registration VIP-only, so the app was rebuilt to stand on
its own; the last Trakt code was removed on 2026-08-01. Two things Trakt used to
compute on its servers are now worked out locally: which episodes have aired
(from TMDB air dates, re-evaluated against today's date on every refresh) and
which episode you're up to.

**There is currently no sync between devices.** Each device is independent, and
Settings has an export/import to move a library from one to another (import
*replaces*, it does not merge). Closing this properly is planned — see
[docs/sync-plan.md](docs/sync-plan.md).

The original TV Time → Trakt migration is done and its reconcile tool has been
removed; the exports it read are kept in `tvtime/` as the only surviving copy of
that history, and the tool itself is recoverable from git if ever needed.

## Setup (once, ~1 minute)

1. Get a free TMDB API key at <https://www.themoviedb.org/settings/api>
   (the "API Key (v3 auth)" value).
2. Open the app → **Settings** → paste it in.
3. Optional: a free [OMDb key](https://www.omdbapi.com/apikey.aspx) for IMDb and
   Rotten Tomatoes ratings.

Repeat on each device — keys are per-browser. The TMDB key is not optional in
practice: without it a device can only browse what it has already stored, with no
search, no episode lists and no new-episode detection.

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

This product uses the TMDB API but is not endorsed or certified by TMDB.
