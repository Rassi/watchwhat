# Discover

Films you don't own yet. Everything else in the app reads your library; this one
screen reads TMDB, and the whole design problem is deciding which twenty of TMDB's
several thousand recent films are worth putting in front of you.

It replaces two Trakt pages that went away with the API — `/discover` and
`/discover/recommended` — and the brief was a Rotten Tomatoes habit: their
*movies at home, audience upright, sorted newest* browse, filtered on the popcorn
score to weed out the bad ones. What follows is mostly the story of why that
filter could not be rebuilt, and what stands in its place.

## The two views

**POPULAR** is three queries merged, deduplicated and ranked together:

| Query | Window | Marked as |
|---|---|---|
| `/discover/movie` | digital release, last 90 days | its TMDB score |
| `/discover/movie` | digital release, next 90 days | `Coming soon` |
| `/trending/movie/week` | none — global chart | `Trending` |

Three requests on first load, one per *Load more* — only the first query
paginates. The other two are single-page by nature: trending is a chart of twenty,
and the forward window holds four titles worth showing.

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

## Why popularity, and nothing else

Every filter this screen started with was a proxy for "is this worth my time", and
each proxy failed in its own way.

**A vote floor is an age filter.** Votes accumulate. A film three weeks old has
few of them however big it is — which is exactly wrong on a screen about films
three weeks old. `vote_count.gte=100` was cutting *Borderline* at 10 votes and
*The Debt Collector* at 55, both of which TMDB's own popularity put inside the top
twenty of the month.

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

**Discover responses carry no release dates.** Saying *when* an upcoming film
lands costs a `/release_dates` request per film — twenty extra calls to turn
"Coming soon" into "Coming 10 Aug". Not worth it; the film's own page has the
date.

**Twenty results a page, always.** Widening the window never returns *more*, it
returns *better*, because more films compete for the same twenty slots. The
popularity floor of page 1 rises 43.8 → 99.5 → 124.8 across 14, 30 and 90 days —
and then stops. A six-month window gives a page identical to the three-month one.
Ninety days is where it saturates, which is why the window is a constant and not a
control.

## The Rotten Tomatoes score, and why it isn't here

The popcorn score is the one thing the original brief wanted that none of this
provides. Assessed 2026-08-04:

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
