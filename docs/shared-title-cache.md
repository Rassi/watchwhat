# Shared title cache

> **Status (2026-08-03): Phase 1 built, Phase 2 not.** The `titles` table, the
> `/titles` route and the JustWatch read-through all exist. Everything under
> "Phase 2" below — sharing TMDB providers, the announced dates, `provider_since`,
> and the convergence trigger — does not. The TMDB columns exist in the table and
> nothing reads or writes them.
>
> **Phase 1 does not make two devices agree.** It shares the JustWatch top-up so
> the second device stops paying for the same question; the divergence that
> prompted this document is TMDB-derived and needs Phase 2. See the note under
> "Order of work".

A third D1 table holding what a title's external sources say about it — watch
providers, the JustWatch node id, the announced dates — so that two devices stop
asking the same questions at different times and getting different answers.

## Why this reverses an earlier decision

`where-to-watch.md` says providers are "per-device and never synced… derived
metadata, not something you did, so they are deliberately outside the event log".

**The reasoning was right and the conclusion was too broad.** Being unfit for the
event log is an argument about the *log*, not about D1. The `settings` table
already exists for mutable state that cannot go in an append-only log; this is
the same shape of exception for a different reason.

The doc's one technical objection — *"syncing them would propagate one device's
stale answer to a device that had a fresher one"* — is real for naive
last-write-wins, where writes are ordered by arrival. It disappears when the row
carries `fetched_at` and the rule is **newest fetch wins** rather than newest
write. Staleness then cannot propagate by construction.

**The data is genuinely global.** "Who streams *Amélie* in DK" has one answer for
everyone. What is *not* global is the interpretation — whether a chip reads as
yours, free, or blocked — and that is driven by `myServices`, which already syncs
through the `settings` table. So the split falls out cleanly: **share the facts,
interpret them locally.**

**It is also not a retreat from local-first.** IndexedDB stays the render path and
nothing here is on the critical path for drawing a screen. This is a tier
*above* the local cache, not a replacement for it: Worker unreachable means stale
but working, exactly as today.

### What prompted it

Three titles reading differently on `localhost:5173` and
`https://rassi.github.io` on 2026-08-03, with identical code deployed:

| Title | localhost | live |
|---|---|---|
| Supergirl | no `streamingRelease` → *Expected* | dated → *Coming soon* |
| The Mandalorian and Grogu | no qualifying provider → *Expected* | already available → absent |
| Amélie | `digitalRelease` 2014-06-12 → ranked last | dated Jan 28 → made the top ten |

Not a bug — two independent caches of different ages, which the existing doc
correctly calls "cache age, not drift". But the Releases screen made it visible
in a way the where-to-watch card never did, because it *sorts* by these dates and
puts the disagreement at the top of the page.

## What moves

One new table, alongside `events` and `settings`:

As built (`server/schema.sql`):

```sql
CREATE TABLE IF NOT EXISTS titles (
  id              TEXT PRIMARY KEY,   -- "movie:1325734" — kind and TMDB id in one key

  -- Phase 2. Nothing writes these yet.
  tmdb_providers  TEXT,               -- JSON, watch countries only
  tmdb_fetched    TEXT,
  dates           TEXT,               -- JSON: digitalRelease + streamingRelease
  provider_since  TEXT,               -- JSON: "DK:Netflix" -> when first seen

  -- Phase 1. The cached result of one fetchJustWatchOffers call.
  jw_providers    TEXT,               -- JSON: country -> offers
  jw_upcoming     TEXT,               -- JSON: announced releases, same request
  jw_node_id      TEXT,               -- never changes, so it never expires
  jw_verified     TEXT,               -- 'ok' | 'search'
  jw_fetched      TEXT                -- ISO 8601. Newest wins.
);
```

Two deviations from the original sketch, both deliberate:

- **A single text `id` rather than `(kind, tmdb_id)`.** A batch read is then
  `WHERE id IN (?, ?, …)` instead of a pile of OR'd pairs, and it matches how the
  client already addresses a title.
- **`jw_upcoming` is its own column.** It arrives on the same JustWatch request as
  the offers and feeds `applyUpcoming`. Without it, a device adopting a shared row
  would get the providers but silently lose the announced date — worse than not
  using the cache at all. The row caches the *whole* result of the call, which is
  what makes replaying it equivalent to having made it.

The whole table is created up front even though half of it is unused, because
`CREATE TABLE IF NOT EXISTS` makes re-running `schema.sql` the migration story and
`ALTER TABLE` against a live database does not.

Shows populate the TMDB columns only — they have no JustWatch path at all, by
design, and that does not change.

## What deliberately does not move

- **The event log.** Derived data still never goes in it. That part of the
  original design was correct and stays.
- **IndexedDB as the render path.** Every screen still draws from local storage.
- **`myServices` / `watchCountries`.** Already in `settings`.
- **Interpretation.** `matchServiceRule`, the cheapest-first ranking, the
  blocked-service rules — all per-user, all stay client-side.
- **Device connectivity.** See the `topUp` split below.
- **Artwork, cast, overview, OMDb ratings.** Also derived and also global, but
  they are not what motivated this and they are cheap. Widening later is
  possible; doing it now is scope for its own sake.

## How it plugs in

New route `GET /titles?ids=movie:1325734,…` — batched, because the Movies grid
touches hundreds of titles — and `POST /titles` to write back. Then
`ensureMovieDetails` becomes read-through:

1. Local record fresh by its own TTL → **done, no network.**
2. Stale → ask `/titles` for the whole batch. A row fresher than local → adopt.
   **No TMDB or JustWatch request.**
3. Still stale → fetch TMDB (plus JustWatch if near release), merge locally,
   store, write back.

**The server never decides freshness.** It stores facts with timestamps; the
client applies the TTL policy, because that policy depends on user state —
`detailsMaxAge` varies by whether *you* have watched the film. Writes resolve by
**newest `*_fetched` wins**, never by arrival order.

### Convergence needs its own trigger

Step 1 above is what keeps the app fast, and it is also what would quietly defeat
the whole feature: a device whose local copy is *fresh but older* never consults
the shared row, and goes on showing its own answer for up to a full TTL — seven
days for a settled film. The table would sit there, correct and unread, with the
symptom unchanged.

So the freshness check has to be driven by something other than a cache miss.
**Piggyback it on the existing sync pull** — `installSyncTriggers` already runs on
startup and on pull-to-refresh. One batched `/titles` request at each of those
points converges the devices at exactly the moments they already sync.

## Order of work

**Phase 1 — the JustWatch half** (`jw_node_id`, `jw_providers`, `jw_upcoming`,
`jw_verified`). **Built.**
Smallest change and the biggest reduction in risk: JustWatch is the only
dependency with no contract, it is already proxied through the Worker for CORS
reasons, and `jw_node_id` alone saves the 1–2 search requests every device pays
on every cold title. The merge stays client-side and the TMDB path is untouched.

**Phase 2 — the TMDB half** (`tmdb_providers`, `dates`, `provider_since`), plus
the convergence trigger above. **Not built.**

### How Phase 1 actually behaves

`pullSharedTopUps` runs once per `ensureMovieDetails` batch, before the loop, and
asks only about the films that look likely to want a top-up. `publishSharedTopUps`
runs once after it. So a batch costs at most two extra requests however many films
it covers, and zero when sync is unconfigured or nothing is eligible.

- **Eligibility is judged on the dates already cached, before TMDB is asked.** A
  refresh can move a film in or out of the window afterwards, so this can miss one
  and can ask about one that turns out not to need it. Both are harmless: a miss
  fetches directly and publishes its answer. The alternative is a request per film,
  or splitting the loop into two passes over the network, and neither is worth it
  for a handful of titles.
- **Failures are never published.** Only `ok` and `search` are written. `reach` and
  `offers` describe this device's network or a schema change, and publishing one
  would hand a second device a problem it does not have.
- **Adopting a row sets `topUp` from it**, so the card says the same thing on both
  devices. That is the "a warning on one device means nothing about another" gotcha
  already gone for the shared half, ahead of the full `topUp` split below.
- **A hand-pressed ↻ skips the shared row entirely** and writes back afterwards.
- **The whole thing is best-effort.** Both calls swallow their errors: an
  unreachable Worker means every device behaves exactly as it did before this
  existed, which is also what a device with no sync URL configured does.

> **Phase 1 does not fix the divergence that prompted this.** All three cases in
> the table above are TMDB-derived — two dates and a provider set. The phases are
> ordered by API risk, not by that symptom. If cross-device agreement is the
> goal, Phase 2 is the phase that delivers it and Phase 1 is a prerequisite only
> in the sense of being easier.

## `topUp` splits rather than survives

`movie.topUp` (`{ at, stage }`) currently welds together two different kinds of
fact, and the shared table separates them:

| stage | what it says | where it goes |
|---|---|---|
| `ok` | JustWatch confirmed this title's offers | `jw_verified` — global |
| `search` | JustWatch has no match for this title | `jw_verified` — global |
| `reach` | could not reach JustWatch (CORS, 429, Worker down) | Settings canary |
| `offers` | JustWatch answered in an unrecognised shape | Settings canary |

The first two are properties of the *title* and are true everywhere. The last two
describe a *fetch attempt*, and once the Worker is the thing fetching, they
describe the Worker.

**This removes a documented gotcha rather than adding one.** Today
`where-to-watch.md` has to warn that "a warning on one device means nothing about
another" — an asymmetry that exists only because there was nowhere shared to
record the answer. With a shared row every device reports the same honest
"unverified", and the warning means something.

The card then needs two states, not four: verified, or TMDB's alone, with the
reason on the tooltip. The `reach`/`offers` distinction is diagnostic detail that
matters when something is broken, which is what `checkJustWatch` in Settings is
already for.

## Invariants that must survive the move

> **Never store the merged blob.** `mergeJustWatch` is strictly additive — it
> pushes providers TMDB lacks and downgrades a `kind`, and **never removes
> anything**. That is safe today only because every refresh assigns
> `movie.providers = extras.providersByCountry` from a *fresh* TMDB fetch before
> merging, so the merge base is never a previous merge. Store the merged result
> and let clients read it as their base, and JustWatch's additions become
> permanent: a provider it once reported, that both sources have since dropped,
> would survive every later refresh forever. Slow, silent, and in the one feature
> whose entire purpose is "can I press play tonight without paying again". Hence
> two columns, merged at read time.

- **A cached miss must expire.** Storing `jw_verified = 'search'` *is* caching a
  miss, which `where-to-watch.md` warns against — but its objection was
  permanence ("an unreleased film JustWatch does not know yet will be known
  later"). With `jw_fetched` beside it and the same TTL as everything else, it
  heals itself.
- **The manual ↻ bypasses the shared row too**, then writes back. Someone
  pressing it is reporting that the cached answer is wrong, and a shared cache is
  still a cache.
- **The repaint snapshot tracks verification state, never its timestamp.**
  `movie.ts` deliberately includes `topUp.stage` and excludes `topUp.at`: the
  timestamp moves on every attempt, and including it makes "nothing changed"
  undetectable on exactly the titles that top up most often. Whatever replaces
  the field inherits that rule.
- **Still no "refresh everything" sweep.** A shared cache makes one cheaper. It
  does not make it less of a burst from a single IP against an unofficial
  endpoint.

## `provider_since` belongs here more than it belongs locally

Added client-side on 2026-08-03 to answer "when did this film become watchable",
stamped when *this device* first saw a listing. That is a per-device proxy for
what is really a global fact.

Two devices that refreshed on different days will label the same film "3 days
ago" and "2 weeks ago" on the Releases screen, and a device offline for a month
reports its entire catalogue as having arrived the day it came back. Sharing the
stamp fixes both, and is strictly better than the local version — the per-device
stamp was a workaround for not having anywhere to put a global one.

The zero-means-baseline rule carries over unchanged: a listing first seen at the
moment tracking began cannot be said to have arrived, and must never read as
news.

## What would still differ between devices

| | TTL | matters? |
|---|---|---|
| poster / backdrop / cast / overview | 30 days | cosmetic, rarely visible |
| OMDb IMDb + RT ratings (`extRatings`) | 7 days | cosmetic |
| whether a device can reach the Worker | n/a | correctly per-device |

## Cost

~600 titles is ~600 rows, against D1's 5 GB and 100k writes/day, and Workers'
100k requests/day. The batched read is one request per sync, not one per title.
Nothing here is close to a limit.

The failure mode to design for is not capacity, it is the Worker being
unreachable — which must degrade to the local cache and then to a direct TMDB
call, never to a blank card.

## Gotchas

- **This is a cache, not a source.** A row is worth exactly as much as its
  `fetched_at`. Nothing should ever treat a row's existence as authoritative.
- **Two devices disagreeing is still possible** between sync pulls, and still not
  a bug. The convergence check narrows the window; it does not close it.
- **Providers are still not in the event log.** If a future change finds itself
  wanting to put them there, re-read the top of `schema.sql` first.
- **Shows have no JustWatch columns populated, ever.** An empty `jw_providers` on
  a show is correct, not a failed top-up.
- **A row is keyed by TMDB id, not `traktId`.** The movie route uses `traktId`
  (`#/movie/1083999`) while everything provider-related is TMDB (`1325734`), and
  `where-to-watch.md` already records this as a live source of confusion.
