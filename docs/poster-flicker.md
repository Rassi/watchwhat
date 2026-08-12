# The poster flicker

Reopening the home-screen app after a night away, the posters that were already
on screen blink out and come back. Seen by eye many times; never once caught by
instrumentation. **Unresolved, and dormant since roughly 2026-08-08.**

This page exists because the harness that chased it was deleted on 2026-08-12
(`src/ui/debugflicker.ts`, its Settings card, `setPosterBuster` in
`api/tmdb.ts`, `posterCacheStats` in `ui/components.ts` — all in the history if
they are wanted back). Four recordings produced only negative results, and
negative results are worth more as prose than as code sitting in the launch
path. Start here rather than from scratch.

## What the event is

The user is on iOS, running WatchWhat as a standalone home-screen app. He has
**never force-quit before seeing it** — so the path that matters is iOS
*resuming* a suspended page, not reloading it. A recorder wired only to
`main.ts` can sit armed straight through the event and catch nothing, which is
why the harness grew a `visibilitychange` watcher late.

Three things are true at once on the open where it happens, and they are not
equally fakeable:

| Ingredient | Fakeable? |
|---|---|
| Library past its TTL, so a bulk refresh runs | Yes — age `fetchedAt` |
| Cold process | Only by force-quitting, which is the wrong path |
| Purged HTTP cache | **No** — see the finding below |

## What has been ruled out

All from the 2026-08-10 recording (`mode: real`, `path: launch`, 16.1h away,
library 29h stale — genuinely the right conditions):

- **Decoded-bitmap pressure, at least at this size.** Peak 21 MB of decoded
  posters. Note the harness reported `bitmapMB` and `pinnedMB` as separate
  figures and its verdict added them into "21MB plus 21MB" — they were always
  the same number, because every poster in the document is also pinned by the
  reuse cache. The real peak was 21 MB, not 42.
- **Bitmaps being purged and re-decoded.** `decodeMs` of an already-loaded
  poster sat at 0–1 ms for the full 30 s. A bitmap WebKit had thrown away costs
  tens of ms to rebuild. Nothing was being rebuilt.
- **iOS killing the web process.** `launchGaps` were 14.7 min, 43 min, 5.6 min,
  18 min, 8.6 h, 16.1 h. Repeated kills show as a run of gaps seconds apart.
  None.
- **Grid churn.** 5 rebuilds, worst frame 17 ms once past first paint.

## The finding that killed the approach

**After 16 hours away, iOS had not purged the HTTP cache.** The 31 poster
requests came back with a median of **0 ms** and a max of 1 ms.

The harness's whole "real" mode was built on the premise that only genuine hours
away can produce a cold cache, so it waited for a 6h+ gap and recorded whatever
came back. This recording is that wait paying out — and the cache was still
warm, so there was again no window for anything to flicker in. **Waiting does
not stage the event.** Anything that tries this again needs to fake the cold
cache (busted URLs) or find some other lever entirely.

A related trap: the harness classified a run warm on `api.medianMs < 25`, and
this run measured 23 — a two-millisecond margin. Its own notes said a cached
read is *single-figure* ms. 23 ms across 80 calls with a 267 ms max looks like
conditional revalidation going to the network cheaply, not cache hits. The
posters were warm; the API traffic probably was not. A binary warm/cold flag
hid that distinction.

## Still open, and worth suspecting

- **The poster reuse cache may be causing what it prevents.** `posterImgs` in
  `ui/components.ts` holds up to `POSTER_IMG_LIMIT = 500` live `<img>` nodes,
  each keeping its decoded bitmap alive — a w342 poster is ~700 KB of RGBA, so a
  full cache pins on the order of **350 MB**. The 21 MB measured above is *not*
  reassuring: it is only what one home screen holds (104 nodes). Browsing a few
  hundred titles before backgrounding the app is a different measurement, and
  nobody has taken it. These nodes are mostly detached, so they never show up in
  a sweep of the document.
- **Late layout movement.** In the clean run, `inView` moved 12 → 13 → 10 → 13
  → 12 between t=4.5 s and t=8 s with the rebuild count static. `up` tracked it
  exactly, so no picture blanked — but something still shifts the grid five to
  eight seconds after launch.

## If it comes back

Record on `visibilitychange`, not on launch. Fake the cold cache rather than
waiting for one. Measure the reuse cache after heavy browsing, not on a fresh
home screen. And check `decodeMs` first — it is one number, it needs no memory
API, and it separates "the bytes were re-fetched" from "the bitmap was thrown
away" on its own.
