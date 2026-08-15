# The poster flicker

Reopening the home-screen app after a night away, the posters that were already
on screen blink out and come back. Seen by eye many times; never once caught by
instrumentation. **Unresolved.**

**It is not an iOS problem.** On 2026-08-15 it happened in desktop Chrome, in a
tab that had been open since the 12th, on navigating to `#/releases`. Same
picture: posters out for a few seconds, five or so blinks, text and layout
untouched, then all back at once. Everything below about iOS still holds, but
the cause has to be something both engines do.

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

## The desktop sighting, and what it settled (2026-08-15)

Caught in a tab that could be inspected while it was still there. Two readings
from it, both of which narrow the field considerably:

- **Coming back cost nothing.** The last request to `image.tmdb.org` was 164
  seconds before the posters returned. Nothing was re-fetched.
- **The DOM never showed it.** All 26 posters read `complete: true`,
  `naturalWidth: 342`, full height, while the screen showed nothing. This is why
  four recordings found nothing: the harness watched `complete && naturalWidth >
  0`, and both stay true straight through a blank. **Any future instrument that
  reads those two properties is measuring the wrong thing.**

So the bytes are held, the elements are correct, and the pixels are absent. That
is a paint or decode failure, not a loading one.

### The reuse cache is not the cause, though it is a real fragility

Suspect number one below can now be retired as the explanation, having been
tested directly. With the cache deliberately shrunk to 10 entries, every rebuild
recreated the whole visible grid — 104 fresh nodes against 26 — so eviction does
force recreation, and a recreated node must decode before it paints. But under
the real conditions:

- 541 distinct poster URLs in one session, comfortably past `POSTER_IMG_LIMIT`,
  so the cache *was* evicting;
- then a Releases refresh that rebuilt the grid ~50 times in 14 seconds;
- **fresh nodes: 26, once, on the first render. Zero across the ~50 rebuilds
  that followed.**

Once the visible posters are re-created they are the most recently used, and
nothing evicts them again while the storm runs. Eviction can explain a single
blank on arrival. It cannot explain five blinks over several seconds.

### The amplifier is the rebuild storm

`renderContent` on Releases is called on every `ensureMovieDetails` batch, and
`batchNotify` throttled that only to one per 300ms. Measured against a stale
library with a cold API: **19 full grid rebuilds in 20 seconds**, each one a
`replaceChildren` followed by rebuilding every card. The library screen does the
same on `ensureProgress`.

(An earlier pass put this at "about fifty". That counted MutationRecords with any
removal, and moving a cached `<img>` into its new card emits one of those from
the old parent — so it was counting posters, not renders. Count records that
remove several children at once and add none.)

Whatever makes a poster take a moment to paint, doing it nineteen times in
twenty seconds is what turns it into a visible flicker — and it fits the shape of
the symptom, which stops the moment the refresh does. Cutting the rebuild count
is worth doing on its own terms and does not depend on knowing the paint-level
cause.

**Cut on 2026-08-15.** Each grid now describes what it is about to draw and
draws it only if that description changed (`renderGate` in `ui/components.ts`),
and `batchNotify`'s throttle went from 300ms to 1s. Same measurement as above,
same 100 API calls: **19 rebuilds → 1**. Updates still land — blanking 24
posters and reloading the library filled them all back in through 7 coalesced
repaints. Whether this removes the flicker is unknown until it is next seen;
if it does not, the amplifier is gone and the paint-level cause is still there
to find.

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

`decodeMs` on an already-loaded, on-screen poster is the one measurement left
that can see this, because the loading-level ones provably cannot. Sample it a
few times a second **in a foregrounded tab** — a backgrounded one does not paint,
Chrome does not run `requestAnimationFrame` in it, and `decode()` there tells you
nothing. That constraint is why the desktop sighting could not be reproduced
under automation: the driven tab is never the focused one.

The console snippet for a real tab, which needs no build change:

```js
window.__flick = { log: [], seen: new WeakSet() };
setInterval(async () => {
  const imgs = [...document.querySelectorAll('img.poster')];
  let fresh = 0;
  for (const i of imgs) if (!__flick.seen.has(i)) { __flick.seen.add(i); fresh++; }
  const v = imgs.filter(i => { const r = i.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && i.complete && i.naturalWidth > 0; }).slice(0, 3);
  if (!v.length) return;
  const t = performance.now();
  await Promise.all(v.map(i => i.decode().catch(() => {})));
  const ms = Math.round(performance.now() - t);
  if (ms > 20 || fresh) __flick.log.push([new Date().toLocaleTimeString(), 'decode=' + ms, 'fresh=' + fresh]);
}, 250);
```

A spike with `fresh=0` means the bitmap was thrown away and rebuilt from bytes
already held. A spike with `fresh>0` means the reuse cache evicted the node —
back to the section above, and check how many distinct posters the session has
been through.
