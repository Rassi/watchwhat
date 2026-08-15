# Discover

Films you don't own yet. Everything else in the app reads your library; this one
screen reads TMDB, and the whole design problem is deciding which twenty of TMDB's
several thousand recent films are worth putting in front of you.

It replaces two Trakt pages that went away with the API — `/discover` and
`/discover/recommended` — and the brief was a Rotten Tomatoes habit: their
*movies at home, audience upright, sorted newest* browse, filtered on the popcorn
score to weed out the bad ones. What follows is mostly the story of why that
filter could not be rebuilt, and what stands in its place.

## The three views

**POPULAR** is three queries merged, deduplicated and ranked together:

| Query | Window | Marked as |
|---|---|---|
| `/discover/movie` | digital release, last 90 days | its TMDB score |
| `/discover/movie` | digital release, next 90 days | `Coming soon` |
| `/trending/movie/week` | none — global chart | `Trending` |

Three requests on first load, one per *Load more* — only the first query
paginates. The other two are single-page by nature: trending is a chart of twenty,
and the forward window holds four titles worth showing.

**NEW** is the same window read the other way round — not what is big, but what
just arrived, week by week. Two queries per week, and a quality cut. It has its
own section below.

**FOR YOU** asks `/movie/{id}/recommendations` about your twelve most recently
watched films and ranks whatever keeps coming back, count first and TMDB's score
only breaking ties. TMDB has no endpoint that reads a whole library, so this is
the closest thing to Trakt's recommendations that exists without one.

Its one control, *Ignore horror I've watched*, filters the **question** rather
than the answer: a horror film you watched stops being asked "what's like this?",
and the scan reaches further back so twelve are still asked. On by default,
because one late-night horror otherwise turns the whole screen into a genre feed
— unticking it put *The Conjuring*, *The Taking of Deborah Logan*, *Haunter*,
*The Cell*, *Saw* and *Eraserhead* back into the first thirty. Horror can still
arrive through a seed that merely shares a director or a cast (*Succubus*, *The
Invisible Man* and *Lights Out* survive the filter), which is the intended
behaviour: the box is about what you're asking, not a genre ban.

### What the filter costs

Nothing, in practice. FOR YOU is twelve `/movie/{id}/recommendations` calls with
the box either way; the filter changes which twelve films are asked about, not
how many requests are spent.

A seed's genres come off its own record. Every path that creates a MovieRec
already sets them — across a 371-film library there is not one record without —
so the fallback that fetches a missing set has nothing to do. Where it does fire
it costs one `/movie/{id}` per record lacking genres, a batch of twelve in
parallel, and the scan stops after 48 films so a library that really is all
horror can't walk itself.

That fallback **writes what it fetches** (`ensureMovieGenres`), so a gap costs one
request ever rather than one per session. This is not the "Discover caches
nothing" rule bending: that rule is about not creating records for other people's
films, and this fills a field on a film already in your library. Like every other
TMDB-derived field it goes through `saveMovieFields` — merged onto the stored
record rather than over it, and local-only, so the outbox stays empty and no
other device hears about it.

`fetchMovieExtras` was already paying for `genres` on every detail refresh and
parsing them away; it now keeps them, and `genres` joined `TMDB_DERIVED_FIELDS`.
So records converge on TMDB's spelling as they refresh, at no extra request.

Nothing on this screen is written to IndexedDB. These are other people's films
until you put one on a list, and caching them would push every title you scrolled
past once into the sync log and every export.

## Dimming what you have already opened

Added 2026-08-15. Clicking a card in any of the three views records the film as
inspected, and its poster is faded from then on, on every device. The point is
what is left bright: on a screen you visit weekly, the four new arrivals are
otherwise indistinguishable from the twenty you already dismissed.

It is the one thing Discover stores, and it does not break the rule above — a
look is a fact about **you**, not a copy of someone else's film, and it is an id
and a timestamp rather than a record.

**Where it lives** (`src/data/inspected.ts`, `inspected` table, `/inspected` on
the Worker):

- **Not an event.** `replay.ts` mints an unseen title from TMDB so a fresh device
  can rebuild the library from the log alone — so an event naming a film you
  merely glanced at would *create* it, one record and one request per device. That
  is the exact failure "Discover writes nothing" exists to prevent.
- **Not a settings field.** Settings are last-write-wins per key, so two devices
  each marking different films would silently discard one set.
- **Not a column on `titles`.** That table is a cache: rebuildable, disposable.
  This cannot be re-derived from anywhere.
- **In localStorage as well as D1**, because `paint()` runs synchronously before
  the router restores scroll — an `await` in that path makes the page jump. D1 is
  the sync backing, merged on every `syncNow` and repainted through the existing
  `applied` event.

**Marked on click in Discover, deliberately, not on opening a movie page.** This
stays a record of what *this screen* offered you and you chose to look at; opening
the same film later from Search says nothing about that. It also keeps the table
to films you don't own, rather than a row for every trip through your own library.

**What it cannot tell you** is what you looked at and rejected on the poster
alone, which is most of a grid. Marking everything rendered would fade the whole
screen after one visit, so the honest scope is "opened", not "considered".

## NEW, and why it is not POPULAR sorted differently

Added 2026-08-15. POPULAR answers "what is worth watching that reached home
lately"; NEW answers "what arrived, most recent first". They read the same window
and share the same base query, and everything below is what makes the second
question harder than it sounds.

### There is no way to sort by, or even read, the date a film reached home

`sort_by` offers `primary_release_date` — the cinema date — and nothing else about
dates. That much was already known. What was **wrong** in an earlier draft of this
file, and is worth stating plainly because it looks so plausible: setting `region`
does *not* make the response report the date it matched on.

Measured 2026-08-15 over 294 films. For 21 of them the returned `release_date` is
not the day the window caught:

| Film | Matched | `release_date` says | US release types |
|---|---|---|---|
| Michael | 10 Aug | 9 June | theatrical 20 Apr, digital 9 June, **TV 10 Aug** |
| Five Nights at Freddy's 2 | 3 Aug | 23 Dec 2025 | digital 23 Dec 2025 |
| A Poet | 7 Aug | 24 Mar | digital 24 Mar |

So the hit reports the film's own US release while the *filter* matched a later
digital or TV listing. Ordering by arrival cannot come from sorting, and cannot
come from reading the hits. **It can only come from the question**: whatever
period you ask about is the only thing you know about the films that come back.

### A week per question, asked twice

The honest build is a query per day, walking backwards — exact to the day, seven
requests a week. The cheap build is one query per week, which loses the day but
costs one. NEW does neither quite: **one week per window, asked twice**, sorting
`popularity.desc` and then `vote_count.desc`.

The second sort is the whole trick. Ranked by attention, a week's page of twenty
is the loud films; ranked by vote count, it is the ones that had a cinema run.
Against a full day-by-day walk of the same three weeks as ground truth:

| | Requests | Films after the cut |
|---|---|---|
| Day-walk, 21 days | 21 | 40 |
| Weekly windows, two sorts | 6 | 40 |

**Recall was 40 of 40.** Nothing was lost but the ordering inside a week, which is
why the screen groups by week — *This week*, *Last week*, *Week of 26 July* — and
ranks by popularity within one. Two weeks on first load, one per *Load more*, out
to a quarter.

### The quality cut, and why a vote floor is right here and wrong on POPULAR

A window of US digital releases is **299 films over three weeks, median vote count
zero**. Most never saw a cinema: wrestling cards, TV movies, films with a poster
and eight votes. Sorted by date rather than by attention, they are the whole
screen. A cut is not optional here the way it is on POPULAR, where popularity
already sinks them.

The rule is `(popularity >= 10 OR votes >= 100)`, vetoed by
`votes >= 100 AND score < 6.0`. 299 films become 40.

**This contradicts "a vote floor is an age filter" above, and both are true.** That
warning is about films new *in cinemas*, which have had no time to gather votes. A
film reaching home has usually finished a theatrical run months earlier and
arrives already rated — *Michael* lands with 4 008 votes at 8.7, *Demon Slayer*
with 1 831, *Supergirl* with 1 838. On this window a vote count is not a proxy for
age; it is a proxy for **having had a cinema release at all**.

Which is why it is an `OR` and not an `AND`:

- **Popularity** catches what has just landed and is being looked at before anyone
  has voted — *Borderline* at 10 votes, which any vote floor would have cut.
- **Votes** catch the film with a real audience and no buzz — *A Poet*, 8.8 from
  117 votes at popularity 3.4, invisible to any attention-based cut.

The score is a **veto, never an entry ticket**, and only where enough people voted
for it to mean anything. It fires on three films in three weeks — *Winnie-the-Pooh:
Blood and Honey 2* (5.8), *Bambi: The Reckoning* (5.8), *Peter Pan's Neverland
Nightmare* (5.7) — which is precisely the category it exists for. A low score on
four votes is not evidence and is left alone.

What none of this can do is judge a film nobody has watched yet. A few weak titles
ride in on popularity alone, and that is the ceiling: on a screen about the last
seven days, there is no source — TMDB, Rotten Tomatoes or otherwise — that has an
opinion yet.

### What was considered and not built

- **JustWatch's `newTitles(country:, date:, filter:)`**, which is the feed behind
  their own New page and the only source that knows *"landed on a service in
  Denmark on this date"* — real arrivals, per country, per day, with `tmdbId`,
  poster and provider attached, and the Worker already proxies arbitrary GraphQL
  so it would work deployed. Rejected on dependency rather than on quality: it is
  an unofficial API already carrying the near-release provider top-ups, which
  matter more, and a browse feed would multiply the calls made against it. It is
  also the wrong question — see below.
- **The [Streaming Availability API](https://www.movieofthenight.com/about/api)**
  (`/changes?change_type=new`), the licensed version of the same thing. Another
  key, another proxy route, 100 requests/day free.
- **Danish arrivals.** NEW is dated against **US** releases, deliberately. Films
  reach home there first and most of the services in use are US ones, so "new" in
  Denmark would mean weeks late. `watchCountries` was reordered to put US first at
  the same time — its first entry is the primary region, which is what the *On my
  services* filter asks about.

## Why popularity, and nothing else

Every filter this screen started with was a proxy for "is this worth my time", and
each proxy failed in its own way.

**A vote floor is an age filter.** Votes accumulate. A film three weeks old has
few of them however big it is — which is exactly wrong on a screen about films
three weeks old. `vote_count.gte=100` was cutting *Borderline* at 10 votes and
*The Debt Collector* at 55, both of which TMDB's own popularity put inside the top
twenty of the month.

> Narrower than it reads, and NEW relies on the exception: this holds for a film
> that has *just* come out, not for one that reached home after a cinema run and
> arrives with thousands of votes already. A vote floor used **as an OR alongside
> popularity** rather than as a gate is sound — see the NEW section above.

**A score floor hides the small films.** TMDB's score is its own users voting
0–10, and it is the *only* score TMDB publishes — nothing from IMDb, Rotten
Tomatoes or Metacritic, and no endpoint that would add them. For anything below
studio scale the sample is tiny and disagrees with everyone else:

| Film | RT audience | TMDB |
|---|---|---|
| The Shadow of the Sun | 100% | 0.0 / **0 votes** |
| Kill Code | 94% | 4.7 / 17 |
| Lucky Strike | 69% | 6.7 / **7** |
| Maddie's Secret | 67% | 5.0 / **4** |
| Masters of the Universe | 86% | 7.3 / 1544 |

There is no floor that admits the top four and excludes titles with no usable
score at all. That is the gap, not a bug.

**Sorting by score is unusable without a floor.** `sort_by=vote_average.desc`
returns ten films at 10.0 from a single vote each. Offering the option at all was
a trap, so it is gone.

`popularity` is what all of that was reaching for. TMDB computes it from one day's
views, votes, favourites and watchlist adds, so it is already high the week a film
lands, and it *ranks* the window rather than excluding anything from it. Scores
still appear on the cards — to be read, not to be a gate.

It is not a stable measure. TMDB documents no scale for it, and the value is a
film's share of yesterday's attention rather than a property of the film. Anything
in the code comparing against an absolute popularity number says so.

## Four traps, all of them in the query

**Release dates match any country unless `region` is set.** Without it a film out
in the US since June still matches a window covering next month, because some
small territory's digital date falls in it. This is why widening the forward
cutoff appeared to do nothing: the "upcoming" films it let in were Supergirl (IL),
Masters of the Universe (PH) and Obsession (IL) — all already listed.

`region=US` is about which country *has data*, not where the user lives. The same
30-day digital window returns **452 films for US and 8 for DK**, and the eight are
local documentaries. Where a film can actually be watched from Denmark is a
question the provider data answers, not the release dates.

**Catalogue reads as new.** A service adding *Heat* (1995) or *Brazil* (1985)
registers a digital release that week. Ordering by true digital date once filled
the feed with films from the eighties. Rotten Tomatoes' shelf carries none of it,
hence `primary_release_date.gte` at three years.

**Mockbusters game popularity directly.** Popularity measures attention and a
deliberate name-collision *is* attention. The Asylum's "The Odyssey" is 86 minutes
on a budget of nothing, and TMDB gave it a popularity of 239 off eight votes
because people searching for Nolan's landed on it. No score or vote floor reaches
them — their "Master of the Universe" had 40 votes and popularity 125. Excluding
the company (`without_companies=1311`) is the only cut that costs nothing real.

**Genre names come in two vocabularies.** TMDB title-cases and spaces them
(`Science Fiction`, `Horror`); every record cached while Trakt was alive carries
its slugs (`science-fiction`, `horror`). The horror filter matched nothing at all
until both were flattened to one key — the same casing trap as the show statuses.

**The forward window needs its own query.** Not for volume — because a single
widened window comes back with no way to tell which results are already out.
Asking separately means everything the second query returns is, by construction,
still ahead, which is what earns the badge. That set is shallow (60 films in every
80 sit below popularity 3), so it also carries a floor of its own.

## What TMDB cannot do

**There is no sort on the digital release date.** `sort_by` offers
`primary_release_date`, which is the cinema date. Within a short window it is a
fair proxy, because digital follows cinema by a fairly steady month or three, but
a film with a long gap sorts as old: *Demon Slayer* opened in cinemas a full year
before it streamed. Asking day by day and walking backwards *does* give true
digital order, and was built and then deleted — it cost one request per day of
window for an ordering nobody had asked for.

**Discover responses carry no *usable* release dates.** There is a `release_date`
on every hit, and setting `region` genuinely changes what it holds — but it is the
film's own US release, not the digital or TV listing the window matched, so it
cannot say when something reached home. Measured 2026-08-15; the table in the NEW
section has the cases. Saying *when* an upcoming film lands still costs a
`/release_dates` request per film — twenty extra calls to turn "Coming soon" into
"Coming 10 Aug". Not worth it; the film's own page has the date.

**Twenty results a page, always.** Widening the window never returns *more*, it
returns *better*, because more films compete for the same twenty slots. The
popularity floor of page 1 rises 43.8 → 99.5 → 124.8 across 14, 30 and 90 days —
and then stops. A six-month window gives a page identical to the three-month one.
Ninety days is where it saturates, which is why the window is a constant and not a
control.

## The Rotten Tomatoes score, and why it isn't here

The popcorn score is the one thing the original brief wanted that none of this
provides. Assessed 2026-08-09:

| Source | Verdict |
|---|---|
| **OMDb** | Already wired for the movie page, but its "Rotten Tomatoes" value is the **critic** Tomatometer, not the audience score. Coverage on new films is thin — across an 18-title RT shelf it had an IMDb rating for 11, a Metascore for 11, and an RT critic score for **3**. Where it does have IMDb data it is far better populated than TMDB (*Maddie's Secret*: 6.9 from 584 against TMDB's 5.0 from 4) but it contradicts RT as often as it agrees — *Kill Code* is 94% on RT and **4.3** on IMDb. |
| **MDBList** | The only real route. `POST /rating/movie/audience` returns the popcorn score in batch, keyed by TMDB id, 10 ids a request on a free key (1 000/day). Needs the Worker as a proxy — no CORS. The keyless `mdblist.com/lists/…/json` export is a red herring: bare ids, no posters, no scores, and still no CORS. |
| **IMDb** | No route. No public API, the charts return HTTP 202 with an empty body to non-browser clients, and the bulk datasets carry ratings but no popularity. |
| **Rotten Tomatoes** | No route. `/napi/browse/…` 404s; the browse page is server-rendered HTML with the scores inline, so it is scrapeable, and against their terms. |

If it is ever wanted, MDBList is the door, and [the shared title
cache](shared-title-cache.md) is where the scores would live so the daily budget
is spent once per film rather than once per view.

## Deliberately absent

- **A "hide watched & listed" default of on.** Cards badge `SEEN` and `LISTED`
  instead; hiding them by default made a short list look like a quiet month.
- **A section for the upcoming films.** They interleave by popularity, which means
  they sit low — unreleased films score low on a metric that counts viewing. The
  list is sorted once on the first batch and later pages are appended, so nothing
  already on screen moves, and they stay where they landed.
- **Shows.** Movies only, so far.

---

# Planned: a NEW RELEASES tab

Sitting after POPULAR, answering the one question POPULAR structurally cannot:
**what landed on streaming most recently, in order**. Researched 2026-08-09, not
yet built.

## Why it needs a different data source

POPULAR ranks by attention and only ever *filters* on dates, because TMDB has no
sort on the digital release date — the whole reason the day-walk was built and
deleted. So "newest streaming, in order" cannot be asked of TMDB at all:

| Endpoint | Why not |
|---|---|
| `/discover/movie?sort_by=primary_release_date.desc` | The cinema date. *Demon Slayer* opened a year before it streamed. |
| `/movie/now_playing`, `/movie/upcoming` | Cinemas, not streaming. |
| Day-walk over `release_date.gte`/`.lte` | Works, but one request per day of window. Rejected once already. |

**JustWatch can, and it is already a dependency** — `src/api/justwatch.ts`, proxied
through the Worker at `/justwatch` because JustWatch sends no CORS header.

## The endpoint

`newTitleBuckets` — undocumented, found by probing, since introspection is
disabled and the schema is unpublished. Buckets are keyed `date_packageId` (the
`cursor` is that string, base64) and arrive **date-descending**, which is the
ordering the whole tab needs. Its sibling `newTitles` returns the same titles
flat and in no useful order — a single page cannot be sorted into a true "newest"
list, so use the buckets.

One query returns everything a card needs:

```graphql
newTitleBuckets(country: "US", first: 16, filter: {
  objectTypes: [MOVIE],
  monetizationTypes: [FLATRATE, FREE, ADS],
  releaseYear: { min: <this year - 3> }        # IntFilter { min, max }
}) { edges { cursor node { edges { node { ... on Movie {
  content(country: "US", language: "en") {
    title originalReleaseYear posterUrl
    externalIds { tmdbId }
    scoring { imdbScore imdbVotes tmdbScore tmdbPopularity jwRating tomatoMeter }
  }
  offers(country: "US", platform: WEB, filter: { monetizationTypes: [FLATRATE, FREE, ADS] }) {
    availableFromTime package { clearName }
  }
} } } } } }
```

Measured on US: 16 buckets → 43 distinct films, **every one with a `tmdbId` and a
`posterUrl`**. `first: 30` fails with `TOO_BIG`; 16 is safe.

`scoring` is the find. It carries `tmdbPopularity`, so the same notability cut
POPULAR uses is available without a second request — and `tomatoMeter`, the RT
**critic** score. There is no audience score (`tomatoAudience`, `audienceScore`,
`popcornScore` all probed, none exist), so MDBList remains the only popcorn route.

## Two problems, both measured, both fixable in the query

**Catalogue swamps it.** Unfiltered, a US page is 1947, 1950, 1961, 1985 — ad-supported
services adding back-catalogue daily. Worse in the US than DK for exactly that
reason. `releaseYear: { min: … }` is the fix, same three-year rule as POPULAR.

**With recency applied it becomes a firehose of nobodies** — Hallmark-style TV
movies and direct-to-streaming filler, because "newest" with no notability signal
is mostly volume. A `scoring.tmdbPopularity` floor, as `FORWARD_MIN_POPULARITY`
already does, is the cut, and it costs nothing extra.

## Region

**US first.** Not DK, though DK works and returns real Danish arrival dates that
TMDB cannot supply at all (TMDB: 452 films a month for US against 8 for DK). US is
what he asked for; DK is a natural second, and the country is a single argument, so
this is a setting rather than a rewrite.

## Risks to weigh before building

- **JustWatch is unofficial.** The existing rule in `justwatch.ts` is that every
  caller treats failure as "no extra information" and keeps TMDB's answer. A whole
  tab cannot degrade that way — when the schema shifts, the tab is empty, not
  merely less precise. This is a different risk posture from a provider top-up.
- **It needs the Worker.** No CORS, so no sync token means no tab. Every other
  screen works without one.
- **Pagination is by bucket, not by title.** Sixteen buckets gave 43 films, but a
  bucket is one service on one day, so the yield per page is not stable.
