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

- Fires when `nearRelease(movie)` — within 30 days of a known release date — or
  whenever a refresh is asked for by hand.
- `apis.justwatch.com/graphql`, which is **JustWatch's own web API, not a
  published one**: no versioning, no contract. Every caller must treat failure as
  "no extra information" and keep TMDB's answer.
- There is no lookup by TMDB id, so the title is searched and the result
  **confirmed by the `tmdbId` it reports back** — never by title text, which
  would happily match a remake or a sequel.
- It only ever *adds* a provider TMDB is missing, or *downgrades* a kind when
  JustWatch says something is cheaper than TMDB thinks. **Nothing is ever
  removed**: an entry TMDB has and JustWatch does not is far more likely to be a
  search miss than a delisting.

### ⚠️ The top-up does not work in production (found 2026-08-01)

**JustWatch sends no `Access-Control-Allow-Origin` for `https://rassi.github.io`,
while allowing `http://localhost:5173`.** So the top-up has only ever worked on
the dev server, and the deployed app has always been TMDB-only.

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
another for up to a week. The **↻ on the card** ignores it: one TMDB request,
plus a JustWatch top-up regardless of the release dates, because someone
pressing the button is reporting that TMDB looks wrong and that is exactly what
the fallback is for. The attribution line says when this device last checked,
with the exact timestamp on its tooltip.

Two behaviours worth not "fixing" later:

- **The show page swaps the card in place** rather than repainting. The show page
  keeps real state in the DOM — which tab is open, which seasons are expanded —
  so a repaint would drop you back on Episodes, having closed the card you just
  pressed.
- **The movie page always repaints after a manual refresh**, even when nothing
  changed, unlike its background refresh which repaints only on a real change. A
  freshness line still reading "5 hours ago" straight after a successful check is
  the one thing it must never say.

Rate limits are a non-issue at this scale: it is one request per press, against
TMDB, on a single title. The thing to never build is a "refresh everything"
sweep — ~340 films through the unofficial JustWatch endpoint is how you get
blocked.

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
- **Providers are not in the sync log and should not be.** Syncing them would
  propagate one device's stale answer to a device that had a fresher one.
- **A show's providers live on the episodes record**, not the show record.
- **The JustWatch endpoint has no contract.** If top-ups quietly stop, run the
  Settings check before assuming the network is at fault — a field rename fails
  silently and looks exactly like "no extra offers".
- **Never sweep.** Every refresh path is per-title and on demand for a reason.
