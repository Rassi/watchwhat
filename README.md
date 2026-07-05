# WatchWhat

A personal, TV Time-style TV show tracker: a static web app backed by your own
[Trakt](https://trakt.tv) account. No server, no database to run — deployable to
GitHub Pages, usable from phone and desktop with the same data.

- **Watch list** with TV Time-style sections: *Watch Next* (recently watched,
  "NEW" badge when a new episode just aired), *Haven't watched for a while*,
  and *Haven't started*.
- **Show page** with per-season episode checkmarks and the classic
  "Mark previous episodes?" dialog (all previous / only this season / never for
  this show).
- **Search** to follow new shows (adds to your Trakt watchlist).
- **Reconcile tool** to verify/complete a TV Time → Trakt import from the
  [TV Time out exporter](https://github.com/tzheng-mars/tv-time-out) JSON.

## How it works

The browser talks directly to the Trakt API (watch state, source of truth) and
TMDB (posters). Everything is cached in IndexedDB so the app opens instantly;
a sync gated on `/sync/last_activities` keeps devices consistent. API
credentials live in `localStorage` only — nothing is baked into the build, so
the repo can be public.

## Setup (once, ~2 minutes)

1. Create a free Trakt API app at <https://trakt.tv/oauth/applications/new>
   — any name, redirect URI `urn:ietf:wg:oauth:2.0:oob`.
2. Get a free TMDB API key at <https://www.themoviedb.org/settings/api>.
3. Open the app → **Settings** → paste the Trakt Client ID/Secret and the TMDB
   key → **Connect to Trakt** (enter the code it shows at trakt.tv/activate).

Repeat step 3 on each device (phone, desktop); the data stays in sync via Trakt.

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # production build in dist/
```

Deploys automatically to GitHub Pages on push to `main`
(`.github/workflows/deploy.yml`); enable **Settings → Pages → Source: GitHub
Actions** in the repo once.
