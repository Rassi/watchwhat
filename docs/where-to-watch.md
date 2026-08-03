# Where to watch

The card on a show's About tab and on a movie page listing, per country, the
services a title is on — and whether it is included in something already paid
for, free to anyone, or a per-title rental.

The point is not "is this streaming somewhere", which is nearly always yes. It
is **"can I press play on this tonight without paying again"**, and everything
below exists to answer that one question honestly.

## Where the data comes from

**TMDB is the source of record.** Provider data rides along on the same request
that fetches artwork and cast — one call, not two:

```
/movie/{id}?append_to_response=credits,watch/providers,release_dates,videos
```

TMDB's provider data *is* JustWatch data, licensed; hence the "Streaming data by
JustWatch via TMDB" line on the card, which is an attribution requirement rather
than decoration. **Nothing in the normal path talks to JustWatch directly**, so
the only rate limit that applies is TMDB's, and a page view costs one request
that was being made anyway.

**JustWatch's own API is a top-up, not a source** (`src/api/justwatch.ts`).
TMDB's ingest lags, and not uniformly — a title's record can be refreshed for a
rental price change while a new subscription listing is still missing. TMDB
offers no way to detect this, because watch providers never appear in its
`/changes` feed. So around a release, and only there, the source is asked
directly:

- **Movies only.** `fetchJustWatchOffers` has exactly one call site, inside
  `ensureMovieDetails`. A show's providers are TMDB's answer and nothing else,
  including when the ↻ is pressed — so do not go looking for a broken top-up on
  a show page. There isn't one to break.
- Fires when `nearRelease(movie)` **or `awaitingRelease(movie)`**, or whenever a
  refresh is asked for by hand.
- `apis.justwatch.com/graphql`, which is **JustWatch's own web API, not a
  published one**: no versioning, no contract. Every caller must treat failure as
  "no extra information" and keep TMDB's answer.
- There is no lookup by TMDB id, so the title is searched and the result
  **confirmed by the `tmdbId` it reports back** — never by title text, which
  would happily match a remake or a sequel.

**JustWatch also knows the announced date, and knows it structurally**
(`upcomingReleases`, added 2026-08-03). Per country, it returns `releaseDate`
with the `package` it belongs to, and the package carries its own
`monetizationTypes` — so whether a date means *included* or *costs money* is a
lookup rather than a guess at free text. It is what settles the case TMDB cannot
express: `Apple TV` the store (`packageId 2`, RENT/BUY) and `Apple TV` the
subscription (`packageId 350`, `appletvplus`, FLATRATE) share a display name and
differ only here.

- **It only ever announces.** JustWatch empties the list once a title is out, so
  it can say *"Streaming from"* and never *"Streaming since"*. For anything
  already released the offers are the answer, which is why TMDB's noted date
  stays as the fallback rather than being replaced.
- **`applyUpcoming` in `sync.ts` is where it lands.** A subscription-typed entry
  always wins over TMDB's note. A store-typed one only fills a gap, or replaces a
  date that has *already passed* — a date in the past next to a country still
  counting down means the film is out somewhere else, not here.
- **It costs no extra request**: same node id, same document, aliased alongside
  the offers.

> **The two halves must not share a fate.** A rename inside `upcomingReleases` is
> a *validation* error, and GraphQL fails the whole document for one — which
> would take the provider top-up down with a feature it does not depend on. So
> `offersDocument(countries, withUpcoming)` can build the query without it, and a
> null result is retried once that way. One extra request in the broken case,
> none otherwise, and the Settings canary asserts the field separately.

**The window is wider than "30 days" suggests.** `nearRelease` is ±30 days of
*any* known date, and there are up to three — theatrical `released`,
`digitalRelease.date`, `streamingRelease.date`. That is up to three 60-day
windows, which for a staggered rollout can add up to roughly six months of
eligibility, in bursts rather than one stretch. It is still nearly always
inactive: for a library of mostly older films, only a handful qualify at once.

**`awaitingRelease` covers the gap `nearRelease` cannot.** Unwatched, no
streaming date known, and inside the window where an announcement could
plausibly exist. `nearRelease` is computed from the dates, so a film whose
digital date has not been announced is never near anything and would never be
asked about: circular, exactly where `upcomingReleases` has an answer.

**The window is `announcementWindow`, drawn from the same estimate the movie page
shows** — which is what keeps this from being a poll:

- **From 45 days before cinemas.** Not from the theatrical date itself, tempting
  as that is: a streaming-first film announces ahead of its own premiere.
  *Mayday* had a booked Apple TV+ date **31 days before** its theatrical date, so
  cutting at release would have missed the one case this lookup exists for.
- **Until p75 + 90 days.** Past its own third quartile by a season, a film has
  stopped following the pattern that would predict it, and a weekly poll is no
  longer what will find out — a provider appearing on the normal TMDB path still
  will.

It widens **which** films are asked about, never **how often**: those titles sit
in the 7-day bucket in `detailsMaxAge`. On a 345-film library that is 7 extra
titles for ~3 requests a day against ~132 (measured 2026-08-03; the unbounded
version was 11 titles and ~5). Widening the TTL to match is what would make this
expensive — it would be ~130 more.

> **The load here is not where it looks.** The whole `awaitingRelease` cohort is
> ~2% of JustWatch traffic. The other ~132/day is 11 near-release films on a **6h
> TTL** — so that TTL, not this gate, is the lever if the total ever needs to
> come down.

### The two dates come from one TMDB field, split on a note

TMDB files both the buy/rent drop and the subscription launch under release type
4 (Digital), and nothing in the schema separates them — only the free-text
`note`. So `digitalRelease` is the un-noted entry and `streamingRelease` the
noted one, with two guards that exist because the naive split was wrong in both
directions (found 2026-08-03 on *The Mandalorian and Grogu*):

- **A note naming the transaction is not a service.** `Rakuten TV / TVOD` is a
  rental by definition; read as a subscription it made a film that costs money
  in all six watch countries say *"Streaming since Jul 21"*. `TRANSACTIONAL_NOTE`
  in `src/api/tmdb.ts` files those as buy. It matches whole words, so **SVOD and
  AVOD deliberately do not match `\bvod\b`** — they are the subscription and
  ad-supported spellings.
- **The streaming date never falls back outside `watchCountries`.** A
  subscription is per-country by nature, so a launch somewhere you cannot watch
  says nothing about you. `digitalRelease` still falls back to the earliest
  anywhere; `streamingRelease` returns null rather than guess. *Supergirl* was
  the second case: an Israeli `iTunes / Apple TV` entry, which is a store rather
  than Apple TV+, and neither a country nor a service that applies here.

Being wrong here is asymmetric, which is why both guards err the same way: a
missing date costs a surprise, a false one reads as *"you already pay for this"*
when every listing still charges.

Both guards are still only a defence for the fallback path. Where JustWatch has
an answer, no note is parsed at all.

### Estimating the date nobody has announced

Both sources answer only once a date is *booked* — JustWatch's
`upcomingReleases` is empty even for 2027 titles, and TMDB has no entry until a
distributor files one. That leaves the most common state of an unwatched new
film — out in cinemas, nothing announced — with nothing to say, which is exactly
when the question gets asked. So `src/data/releaseEstimate.ts` guesses, from how
long the gap has actually run for the films in *this* library.

**It is vague in proportion to its distance**, which is the whole design: a guess
that reads like a date is a guess that gets planned around.

| Away | Reads as |
|---|---|
| > 180 days | `sometime in 2027` |
| 90–180 | `early 2027` |
| 30–90 | `around October 2026` |
| < 30 | `around late August` |
| past the p75 window | `no date announced yet` |

- **Never beside the real thing.** `estimateRelease` returns null the moment a
  date of that kind is announced, the film is watched, it is already watchable
  that way in a watch country, or it is more than 400 days old — past that,
  nothing is coming and a date would be fiction.
- **It shows its working.** The tooltip carries the sample it came from
  (*"Estimated from 41 films in your library: digital release came 32–67 days
  after cinemas, 39 typically"*). An estimate that cannot be checked is a rumour.
- **Styled quieter than a booked date** — `.release-estimate` is dimmed and
  italic where `.digital-release` is accent-coloured and bold.
- Below `MIN_SAMPLE` films it falls back to constants measured here on
  2026-08-03: **32–63 days to buy (median 39)**, **46–119 to stream (median
  90)**. That window has been shortening for years, so re-measure rather than
  trusting them to age.

> **The streaming sample is still healing.** Some `streamingRelease` values in
> the cache were set by the old note rule and are store dates wearing the wrong
> hat, so they drag the measured streaming gap down until those records refresh.
> The buy sample was never affected.

**One top-up is 2–3 requests, not one.** A search against US, then against the
first configured country if US missed, then a single offers query with every
country aliased into it. Six round trips per title would have made this too
expensive to do automatically, which is why the aliasing exists.
- It only ever *adds* a provider TMDB is missing, or *downgrades* a kind when
  JustWatch says something is cheaper than TMDB thinks. **Nothing is ever
  removed**: an entry TMDB has and JustWatch does not is far more likely to be a
  search miss than a delisting.

### The top-up did not work in production (found 2026-08-01, fixed 2026-08-02)

**JustWatch sends no `Access-Control-Allow-Origin` for `https://rassi.github.io`,
while allowing `http://localhost:5173`.** So for the app's whole life the top-up
worked only on the dev server, and the deployed app was TMDB-only.

It fails silently by design — a failed top-up means "no extra information" and
TMDB's answer stands — so nothing looked broken. It surfaced as *The Drama*
reading "rent only" on the live site and green on localhost, and even a manual
refresh could not fix it.

Confirmed rather than inferred, from the app's own health record on each origin:

| Origin | `stage` | `detail` |
|---|---|---|
| `http://localhost:5173` | `ok` | The Drama: offers in DK, US, GB, SE, NO, AU |
| `https://rassi.github.io` | `reach` | TypeError: Failed to fetch |

A `mode: "no-cors"` probe from production returns an opaque response, so the
network reaches JustWatch perfectly well — it is CORS refusing to expose the
answer, not a block or an outage.

**Fixed by proxying through the sync Worker** — `POST /justwatch`, which forwards
the query server-side where CORS does not apply. The client uses it whenever a
sync URL and token are configured and falls back to calling JustWatch directly
otherwise, which is what keeps the dev server working with no token.

The proxy is deliberately **not** general: the destination is fixed in the Worker
and never taken from the request, and the bearer token is still required. An open
relay against someone else's API, on someone else's quota, is a fine way to get
the Worker's address blocked.

Deployed and verified on the live site 2026-08-02: *The Drama* picked up its
HBO Max chips and the Settings check passes from `https://rassi.github.io`.
**A device with no sync token configured still cannot top up in production** —
it falls back to calling JustWatch directly, which is exactly the request CORS
refuses. That is the intended trade, but it means the Settings check failing on
a new device is a missing token before it is anything else.

*The Drama* was the case that exposed all of this. TMDB listed it rent/buy only
in the US while JustWatch reported `FLATRATE` on HBO Max — so localhost showed it
as included and the live site charged you for it.

> **Watch the ids here.** The movie route is keyed by `traktId`
> (`#/movie/1083999`), while everything provider-related is TMDB
> (`1325734`). Searching JustWatch for the traktId finds nothing and looks
> exactly like "JustWatch cannot see this title".

Because that endpoint can change under us without warning, Settings can run
`checkJustWatch` — a canary against *The Devil Wears Prada* (2006, chosen because
its sequel makes it a real test of confirming by id rather than by title). It
asserts on the shape of the response, not just reachability: a rename of
`externalIds`, `monetizationType` or `package.clearName` is what would quietly
stop the top-ups, and a bare ping would never notice. "Reachable but no offers"
reports as a warning, not a failure — a title dropping off a service is normal.

## Where it is cached, and for how long

Providers are **per-device and never synced**. They are derived metadata, not
something you did, so they are deliberately outside the event log — see
`sync-plan.md`. Two devices legitimately disagree while their caches are of
different ages, and that is not drift.

| | Stored on | Timestamp | TTL |
|---|---|---|---|
| Movies | `movies` record, `providers` | `tmdbFetchedAt` | watched → 7 days; no known dates → 12h; within 30 days of a release → 6h; otherwise 7 days |
| Shows | `episodes` record, `providers` | `tmdbMergedAt` | ended/canceled → 14 days; still running → 24h |

A show's providers hang off its **episodes** record rather than the show itself,
which is worth knowing before looking for them in the wrong store.

`PROVIDERS_VERSION` forces a re-fetch of records cached before a new provider
kind started being stored — bump it whenever the shape of what is kept changes,
or old caches silently keep answering with less than they should.

## Refreshing by hand

The TTL is the reason a title can read "rent" on one device and green on
another for up to a week. The **↻ on the card** ignores it. On a movie that
means one TMDB request *plus* a JustWatch top-up regardless of the release
dates, because someone pressing the button is reporting that TMDB looks wrong
and that is exactly what the fallback is for. **On a show it is the TMDB request
alone** — shows have no JustWatch path at all. The attribution line says when
this device last checked, with the exact timestamp on its tooltip.

Two behaviours worth not "fixing" later:

- **The show page swaps the card in place** rather than repainting. The show page
  keeps real state in the DOM — which tab is open, which seasons are expanded —
  so a repaint would drop you back on Episodes, having closed the card you just
  pressed.
- **The movie page always repaints after a manual refresh**, even when nothing
  changed, unlike its background refresh which repaints only on a real change. A
  freshness line still reading "5 hours ago" straight after a successful check is
  the one thing it must never say.

Rate limits are a non-issue at this scale: one press is one TMDB request and, on
a movie, 2–3 JustWatch ones, on a single title, at human speed.

**The thing to never build is a "refresh everything" sweep.** Note *why* that is
worse than it sounds: a sweep would force, and forcing is what skips the
`nearRelease` check — so it would not be "the near-release handful", it would be
every film in the library, ~340 of them at 2–3 requests each, in a burst from one
IP, against an unofficial endpoint, now via a Worker whose address also carries
sync. Automatic top-ups are rare by construction; only a sweep would make them
frequent.

## Saying when a listing is unverified

A stale listing is invisible by construction: a film that moved onto a
subscription looks exactly like one that did not, so nothing prompts you to go
and check. Settings can report the last top-up's health, but that is where you
look once you already suspect something — which is the wrong trigger. So the
card volunteers it, from `movie.topUp` (`{ at, stage }`, set wherever a top-up is
attempted).

| `topUp` | Card shows | Because |
|---|---|---|
| absent | nothing | Never attempted — the normal state for most of the library |
| `ok` | nothing | Confirmed against JustWatch |
| `search` | `· TMDB only` on the freshness line | Routine. JustWatch has no match; TMDB's listing stands |
| `reach` / `offers` | a warning above the rows | Actionable: unreachable, or the API changed shape |

Only real breakage warns. A search miss would cry wolf across a good share of an
older library, so it downgrades to a neutral note — enough to tell a verified
listing from an unverified one, not enough to alarm.

Three things here are load-bearing:

- **The outcome comes back from `fetchJustWatchOffers`, not from the global
  health record.** `ensureMovieDetails` refreshes four movies at once, so reading
  the shared record after the call would attribute one film's failure to another.
- **"Matched, but no offers in any watch country" is `ok`, not `offers`.** A film
  genuinely absent from every country you watch in is a real answer. The global
  health record does count it as a miss; the per-title outcome deliberately does
  not, because nothing needs your attention.
- **`topUp.stage` is in the movie page's change snapshot; `topUp.at` is not.** The
  stage appearing or clearing changes what the card says and must repaint. The
  timestamp moves on every attempt, and including it would make "no change"
  impossible to detect on exactly the titles that top up most often.

Shows never set this, having no JustWatch path at all.

## How a chip is decided

Two settings drive the whole card:

- **`watchCountries`** — the countries to show, in order (`DK, US, GB, SE, NO, AU`).
- **`myServices`** — one list saying two different things:
  - `Netflix` — one you have.
  - `Netflix@DK/US` — one you have, **but only in those countries**. A
    subscription is not worldwide; an account in one country is no help in
    another.
  - `-Kanopy` — one you *cannot* use, which never counts as yours and never
    counts as free. This matters because TMDB's "free" means free *to someone*:
    Kanopy and Hoopla want a library card, and a free app may not exist on the
    box you actually watch on.
  - A block beats a plain match, so a narrow `-YouTube Free` still overrides a
    broad `YouTube`. Names match loosely — lowercased, punctuation stripped,
    "plus" folded to "+" — so `Disney+` and `Disney Plus` are the same service.

Then, per country:

1. **De-duplicate by cheapest listing.** A service offering both a subscription
   and a rental is not a rental; one offering both a subscription and a free tier
   is not a subscription. This compares costs rather than testing for "rent",
   because TMDB's order is arbitrary — a `stream` listing arriving before the
   `free` one used to win and quietly hide the free tier.
2. **Rank cheapest-first:** yours → free to anyone → subscriptions you would have
   to buy → per-title rentals. A blocked service sinks in with the subscriptions
   you do not have; it stays listed, because "it's here but not for me" is worth
   knowing.
3. **Rentals always fold away**, even when renting is all a country offers. An
   empty row is not a loss: "Rent or buy only (5)" *is* the entire answer for
   that country, and seven paid chips repeating it across three countries buried
   the rows that did have something included.

`CINEMA` listings are deliberately dropped — a cinema near you is not a way to
stream it — as are physical discs, matched by substring (`DVD`, `BLURAY`,
`BLU_RAY`, `PHYSICAL`) because the variants multiply and a missed one shows a
disc as a rental.

## Gotchas

- **Two devices disagreeing is usually cache age, not a bug.** Check the "checked
  …" line before investigating anything else, and press ↻ before concluding
  something is wrong.
- **A warning on one device means nothing about another.** `topUp` is per-device,
  like `providers` and for the same reason — the phone can top up fine while the
  desktop cannot reach JustWatch at all.
- **A warning does not clear on its own** unless the title is still near a
  release. It is stating something that stays true — this listing was never
  confirmed — so the ↻ is what clears it.
- **Providers are not in the sync log and should not be.** Syncing them would
  propagate one device's stale answer to a device that had a fresher one.
- **A show's providers live on the episodes record**, not the show record.
- **Shows never call JustWatch.** If a show's providers look wrong, TMDB is the
  only thing to blame and the only thing to fix. Shows therefore never get an
  announced streaming date either — `applyUpcoming` is on the movie path only.
- **"Streaming since" can only ever come from TMDB's note**, since JustWatch
  drops a release from `upcomingReleases` the moment it happens. A wrong *since*
  is a note-parsing problem; a wrong *from* is a JustWatch one.
- **The JustWatch endpoint has no contract.** If top-ups quietly stop, run the
  Settings check before assuming the network is at fault — a field rename fails
  silently and looks exactly like "no extra offers".
- **Never sweep.** Every refresh path is per-title and on demand for a reason.
- **`dependencies.md`** has the measured load across all four external services,
  the TTL table that governs it, and how to re-measure it.
