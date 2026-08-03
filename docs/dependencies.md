# External dependencies: load, limits, and what to watch

WatchWhat is local-first — IndexedDB is authoritative and every page paints from
it before any network call happens. Everything below is therefore *refresh*
traffic, not load-bearing traffic: if all four services vanished, the app would
keep working with whatever it last cached.

That is also what makes the load easy to get wrong. A list page hands its
refresher a list of *candidates* — the Movies tab passes all 345 films — and the
TTL filter is the only thing standing between that and 345 requests. So the
question "how much does opening a page cost?" is always answered by the TTL
table, never by the candidate count.

## The four services

| Service | Used for | Key | Without it |
|---|---|---|---|
| **TMDB** | Search, summaries, episode lists, air dates, artwork, cast, providers, trailers | Required, per device | The app can only show what it has already stored |
| **OMDb** | IMDb / Rotten Tomatoes ratings | Optional, per device | Those two ratings disappear; nothing else changes |
| **JustWatch** | Provider top-up near a release | None (unofficial API) | TMDB's provider answer stands — see `where-to-watch.md` |
| **Cloudflare Worker + D1** | Sync event log, and the JustWatch proxy | Bearer token, per device | No sync, and no provider top-up in production |

TMDB is the only one that is load-bearing for the app's core job. The other three
are all degradable by design, and all three already fail silently on purpose.

## What happens when you open the app

1. Passcode gate (deployed site only).
2. `installSyncTriggers()` — an immediate sync pull, plus another on `online` and
   on every tab focus (`visibilitychange` → visible).
3. The router paints the landing route **from IndexedDB, with zero network**.
4. *Then* the route fires its background refreshes, every one TTL-filtered, all
   at **concurrency 4** (`mapWithConcurrency`).

## Fan-out per page

| Page | Candidates handed to the refresher | Cost per item |
|---|---|---|
| Watch List | started+visible shows; images for visible | 2 TMDB calls per stale show |
| All Shows | all started shows; images for all shows | 2 TMDB calls per stale show |
| **Movies** (either tab) | **every movie in the library** | 1 TMDB call per stale film, +2–3 JustWatch if near release |
| Show page | that show's episodes + progress | 2 TMDB calls |
| Movie page | that movie, then its OMDb ratings | 1 TMDB + 1 OMDb |

A show refresh is `fetchSeasonNumbers` + `fetchShowExtras`, and the latter chunks
seasons into groups of 20 appends. Measured across the library: **2 calls for 151
shows, 3 for two, 4 for two** (the largest has 46 seasons). Treat a show as 2.

## The TTLs — the actual cost control

**Movies** (`detailsMaxAge`):

| Condition | TTL |
|---|---|
| Watched | 7 days, *and skipped entirely by bulk refreshes* |
| No known release dates | 12 hours |
| Within 30 days of any known date | 6 hours |
| Otherwise | 7 days |

**Shows** (`progressTtlMs` + `progressIsStale`):

| Condition | TTL |
|---|---|
| Ended/canceled **and** fully watched | Exempt from bulk refreshes entirely |
| Ended/canceled | 7 days |
| Still running | 12 hours |
| Watch state changed since last fetch | Immediate, TTL ignored |

**Other:** show/movie artwork 30 days (and only re-fetched if the poster is still
missing); OMDb ratings 7 days; episode records 24h running / 14d ended.

## Measured snapshot — 2026-08-02

Against the real library (345 movies, 232 shows), on the desktop:

**Movies:** 231 watched → skipped in bulk. Of the 114 unwatched: **99 share a
single fetch time**, 11 are near-release, 4 are stragglers. Stale at time of
measuring: **0**.

**Shows:** 154 started. 91 are ended+fully-watched → permanently exempt. 38 are
still running (12h TTL) and **all clustered**; 25 are ended-but-unfinished (7d
TTL), 23 of them clustered. Stale at time of measuring: **37**, so ~75 TMDB calls.

### Bursts are synchronised, and that is inherent

The library was seeded in one go, so records share fetch times and therefore
expire together. **99 unwatched films will go stale within the same minute**, and
the first Movies-tab visit after that is one burst of 99 TMDB calls. The 38
running shows do the same thing every 12 hours.

This is fine, and deliberately not jittered:

- At concurrency 4 with typical latency, a 100-call burst is 4–6 seconds of
  ~15–25 req/s. TMDB removed its hard rate limit (formerly 40 per 10s) in 2019;
  the practical ceiling is around 50/s.
- The bursts are bounded by library size, which grows by a handful a month.
- Spreading them out would mean writing a scheduler, and the failure mode it
  protects against has never occurred.

Worth knowing rather than worth fixing. If TMDB ever starts 429ing, **this is the
first place to look** — and the fix is jitter on `tmdbFetchedAt`, not a lower
concurrency.

## Headroom per service

| Service | Free allowance | Realistic peak use | Headroom |
|---|---|---|---|
| TMDB | No hard limit; ~50 req/s practical | ~100 calls in a 5s burst | Comfortable |
| OMDb | 1,000/day | One call per movie page opened | Enormous |
| JustWatch | None published — unofficial | ~45 requests/day/device | Small numbers, no contract |
| Worker requests | 100,000/day | ~100/day | Effectively unlimited |
| D1 rows read | 5,000,000/day | 63K on the heaviest day (seeding) | 1.3% |
| D1 rows written | 100,000/day | 17K on the heaviest day (seeding) | 17% |

**D1's two allowances are separate** — reads and writes do not share the 100K.
Seeding is the only thing that has ever moved these; steady-state sync is a
handful of rows per pull.

## Things to be aware of

- **JustWatch is the only one with no contract**, so it is the one to actually
  watch. Its load is bounded by two counts, not one: 11 near-release films on a
  **6h** TTL, plus 7 more that are `awaitingRelease` — no streaming date yet, and
  inside the window where one could plausibly have been announced — on a **7-day**
  TTL. Both scale with *how many unreleased films sit in the watchlist*, so if
  that list ever gets long, re-check these numbers.

  At **1 request per top-up** once `jwNodeId` is cached (it was 3), the ceiling is
  ~45/day rather than ~137. That ceiling assumes the app is opened at least four
  times a day, spaced more than 6h apart.

- **The burst is real but small, and bounded by `mapWithConcurrency(…, 4, …)`.**
  Measured 2026-08-03 on a fully-stale library: **38 requests over 3 seconds,
  peak concurrency 4, all 200, median 73 ms.** Warm it is one request per
  eligible title (~18), cold two to three. There is no pacing, jitter, retry or
  backoff anywhere, and the Worker proxies straight through without queueing —
  so this shape is the shape, and it is short enough not to need managing.

  Two things would make it worse, in order: **the missing in-flight guard below**
  can double it to 8-wide, and a cold cache after `jwNodeId` is cleared triples
  the count. Neither is worth pre-empting at these numbers, but both are worth
  recognising if JustWatch ever starts refusing.

  **A refusal now costs one request, not four.** See `where-to-watch.md` on
  `refused` vs `rejected` — without that split, throttling accelerated the client
  into the limit and wiped the id cache on the way.

- **Nothing here runs on a timer.** `ensureMovieDetails` fires on route render
  only — the Movies list, the Watchlist, a movie page — plus `refreshRouteInPlace`
  after a sync applies something. **A TTL is therefore a ceiling, not a schedule**:
  it decides whether an app open causes a refresh, and app opens are the real rate
  limiter. Measured on the desktop 2026-08-03: 96 of the unwatched films last
  fetched in a single burst 114 hours earlier, so the 6h TTL had not bound once in
  five days. Widening a TTL only helps a device opened *more often* than it. It is
  also the only service whose breakage is invisible by default; see
  `where-to-watch.md` for how the card now surfaces it.

- **Never build a "refresh everything" sweep.** Forcing is what skips the
  `nearRelease` check, so a sweep would put every film in the library through the
  unofficial endpoint at 2–3 requests each, in a burst, from one IP — now via the
  Worker whose address also carries sync. Every refresh path is per-title and on
  demand for a reason.

- **There is no in-flight guard on the bulk refreshes** (known, accepted as of
  2026-08-02). `pull()` protects itself with a `pulling` flag, but
  `ensureMovieDetails` / `ensureProgress` / `ensureImages` do not, and a record
  only stops looking stale once it has been written back. So a second call while
  the first is still running re-selects the same records.

  This is reachable by a specific sequence: `syncEvents "applied"` →
  `refreshRouteInPlace()` → `dispatch()` re-renders the route and re-fires its
  lazy loads. Opening a device after using the phone is exactly that — the burst
  starts, the pull lands a few hundred ms later, and the burst runs again from
  the top. It is a doubling rather than a cascade, and it writes the same data
  twice rather than wrong data, which is why it is filed here instead of fixed.
  If it ever needs fixing: a module-level in-flight `Set` of ids, checked in the
  stale filter.

- **Watched films and finished ended shows are the reason any of this is cheap.**
  They are 231 of 345 movies and 91 of 154 started shows — roughly two-thirds of
  the library, permanently excluded from bulk refreshes. Any change that makes
  them eligible again triples the cost of a list page.

- **No key means no calls at all.** A device without a TMDB key issues none of
  this traffic; it just shows stale data. That makes "it stopped updating" and
  "the key is missing" look identical from the outside.

## Re-measuring

Paste into the console on any device with the library loaded. Read-only.

Reading the output: a tall single bar in either histogram is one synchronised
burst, and its position is how many hours ago it was fetched — compare that
against the TTL table to see when it next fires. **The show histogram includes
the permanently-exempt ended+fully-watched cohort**, which shows up as a large
bucket hundreds of hours old (88 shows at ~504h when this was written). That one
is inert by design; ignore it.

```js
const db = await new Promise(r => { const q = indexedDB.open("watchwhat"); q.onsuccess = () => r(q.result); });
const all = s => new Promise(r => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => r(q.result); });
const [movies, shows, progress, watched] = await Promise.all(["movies","shows","progress","watched"].map(all));
const now = Date.now(), DAY = 864e5, S = new Map(shows.map(x => [x.traktId, x])), P = new Map(progress.map(x => [x.traktId, x]));
const dates = m => [m.released, m.digitalRelease?.date, m.streamingRelease?.date].filter(d => typeof d === "string").map(d => +new Date(d)).filter(Number.isFinite);
const near = m => dates(m).some(t => Math.abs(t - now) < 30 * DAY);
const age = m => m.plays > 0 ? 7*DAY : dates(m).length === 0 ? 12*36e5 : near(m) ? 6*36e5 : 7*DAY;
const movieStale = movies.filter(m => m.ids?.tmdb && m.plays === 0 && (m.tmdbFetchedAt == null || now - m.tmdbFetchedAt > age(m)));
const showStale = watched.filter(w => w.plays > 0).filter(w => {
  const p = P.get(w.traktId), sh = S.get(w.traktId);
  if (!p) return true;
  const ended = sh?.status === "ended" || sh?.status === "canceled";
  if (ended && p.aired > 0 && p.completed >= p.aired) return false;
  return now - p.fetchedAt > (ended ? 7*DAY : 12*36e5);
});
// Clustering: how many share a fetch hour. A tall single bar is one synchronised burst.
const hist = arr => arr.reduce((a, t) => (t != null && (a[Math.floor((now - t) / 36e5)] = (a[Math.floor((now - t) / 36e5)] || 0) + 1), a), {});
// Both gates, since either one is enough to trigger a top-up. The window mirrors
// announcementWindow(): 45 days before cinemas, until p75 + 90 after.
const awaiting = m => { const r = +new Date(m.released ?? ""); return m.plays === 0 && !m.streamingRelease &&
  Number.isFinite(r) && now >= r - 45*DAY && now <= r + (119 + 90)*DAY; };
const tops = movieStale.filter(m => near(m) || awaiting(m));
console.table({
  moviesStaleNow: movieStale.length, justWatchThisBurst: tops.length * 3,
  ofWhichAwaitingOnly: tops.filter(m => !near(m)).length,
  justWatchPerDay: Math.round(tops.reduce((s, m) => s + (DAY / age(m)) * 3, 0)),
  showsStaleNow: showStale.length, tmdbCallsIfShowsOpened: showStale.length * 2,
});
// Release-gap quartiles, for the FALLBACK constants in releaseEstimate.ts.
const gaps = pick => movies.map(m => [+new Date(m.released), +new Date(pick(m) ?? "")])
  .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a > now - 5*365*DAY)
  .map(([a, b]) => Math.round((b - a) / DAY)).filter(d => d >= 0 && d <= 400).sort((a, b) => a - b);
const q = d => d.length ? [.25,.5,.75].map(p => d[Math.floor(p * d.length)]).join(" / ") : "no sample";
console.log("theatrical→digital p25/median/p75:", q(gaps(m => m.digitalRelease?.date)));
console.log("theatrical→streaming p25/median/p75:", q(gaps(m => m.streamingRelease?.date)));
console.log("unwatched movie fetch ages (h):", hist(movies.filter(m => m.plays === 0).map(m => m.tmdbFetchedAt)));
console.log("started show fetch ages (h):", hist(watched.filter(w => w.plays > 0).map(w => P.get(w.traktId)?.fetchedAt)));
```
