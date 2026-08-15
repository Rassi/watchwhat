-- The server-side data model: an append-only log of what happened, plus a small
-- mutable table of settings. Two tables because they want opposite things — the
-- log must never be rewritten, and a setting is nothing but its latest value.
--
-- Re-running this file against a live database is safe and additive: every
-- statement is IF NOT EXISTS, which is how a new table gets deployed.

-- Nothing here is ever updated or deleted. An unwatch is its own event, not a
-- change to the watch it undoes, which is what keeps the merge order-independent.

CREATE TABLE IF NOT EXISTS events (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,  -- the sync cursor
  id     TEXT UNIQUE NOT NULL,               -- client-generated UUID; makes retries idempotent
  device TEXT NOT NULL,
  ts     TEXT NOT NULL,                      -- when it happened, not when it was received
  kind   TEXT NOT NULL,
  body   TEXT NOT NULL                       -- JSON
);

-- `seq > ?` is the only read the client ever makes, and the PK already orders it.
-- The UNIQUE on `id` is what INSERT OR IGNORE relies on.
--
-- Note that `seq` is monotonic but NOT contiguous: an ignored duplicate still
-- consumes a rowid, so a resent batch leaves gaps. A cursor comparing `seq > ?`
-- does not care; anything counting or assuming +1 steps would be wrong.

-- Settings, deliberately NOT in the log above.
--
-- A setting is mutable state, and putting a row that gets overwritten into an
-- append-only table would break the one property the whole merge rests on. It
-- also has to be readable *before* replay starts: replay mints unseen titles
-- from TMDB, so a TMDB key arriving partway through the log would silently skip
-- everything ahead of it.
--
-- One row per field rather than a single blob, for three reasons: a field with
-- no row keeps following the default compiled into the app, exactly as an absent
-- key does in the client's localStorage; two devices editing different fields
-- both survive; and the shape matches the client's partial-settings map as-is.
-- Facts a title's external sources report about it, shared so that two devices
-- stop asking the same questions at different times and getting different
-- answers. Also deliberately NOT in the log, and for a different reason than
-- settings: this is a *cache*, and a cache in an append-only table would grow
-- without bound while only its newest row ever mattered.
--
-- See docs/shared-title-cache.md. Phase 1 populates the `jw_*` columns only;
-- the rest are created now so that Phase 2 needs no ALTER against a live
-- database. Unused columns cost nothing and a migration costs attention.
--
-- `id` is "movie:1325734" — kind and TMDB id in one text key, so a batch read is
-- `WHERE id IN (?, ?, …)` rather than a pile of OR'd pairs. **TMDB ids, never
-- traktId**: the movie route is keyed by traktId and confusing the two here would
-- look exactly like a title JustWatch cannot see.
CREATE TABLE IF NOT EXISTS titles (
  id              TEXT PRIMARY KEY,

  -- Phase 2. Nothing writes these yet.
  tmdb_providers  TEXT,   -- JSON, watch countries only
  tmdb_fetched    TEXT,
  dates           TEXT,   -- JSON: digitalRelease + streamingRelease
  provider_since  TEXT,   -- JSON: "DK:Netflix" -> when the listing was first seen

  -- Phase 1. The cached result of one fetchJustWatchOffers call.
  --
  -- Kept SEPARATE from tmdb_providers rather than pre-merged: mergeJustWatch is
  -- purely additive and never removes, which is safe only because every refresh
  -- re-merges onto a *fresh* TMDB answer. A merged blob read back as its own base
  -- would make JustWatch's additions permanent.
  jw_providers    TEXT,   -- JSON: country -> offers
  jw_upcoming     TEXT,   -- JSON: announced releases, from the same request
  jw_node_id      TEXT,   -- JustWatch's own id; never changes, so it never expires
  -- 'ok' | 'search'. Failures are never stored: an outage is a fact about a
  -- device's network, not about the title, and caching one would hand a second
  -- device a problem it does not have.
  jw_verified     TEXT,
  jw_fetched      TEXT    -- ISO 8601; the whole freshness contract. Newest wins.
);

-- Films opened from Discover, so their posters can be dimmed on every device and
-- a week-old grid reads as "these six are new since I last looked".
--
-- A third store rather than a column on `titles`, and the distinction is the
-- point: `titles` is a *cache* of what outside services say about a film, and
-- throwing it away costs nothing but requests. This is the only record that a
-- person looked at something, it cannot be re-derived from anywhere, and it must
-- survive anything that clears a cache.
--
-- Deliberately NOT in the event log either, for a sharper reason than settings:
-- replay mints an unseen title from TMDB so a fresh device can rebuild the
-- library from the log alone. An event naming a film that was merely glanced at
-- would therefore *create* it — a full record, one TMDB request, on every device
-- — which is exactly what "Discover writes nothing" exists to prevent.
--
-- Merging needs no conflict rule worth the name: this is a set that only ever
-- grows, so two devices marking different films both win, and the same film
-- marked twice keeps the later look. That is why it is not a settings blob,
-- where last-write-wins would silently drop one device's marks.
--
-- `id` is "movie:1325734", the same key `titles` uses. Shows are not in Discover
-- yet; when they are, they need no schema change.
CREATE TABLE IF NOT EXISTS inspected (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL   -- ISO 8601, most recent look; also the `?since=` cursor
);

CREATE TABLE IF NOT EXISTS settings (
  key     TEXT PRIMARY KEY,
  -- JSON. The literal `null` is meaningful and distinct from an absent row: it
  -- is "explicitly back on the default", which is what a Reset has to be able to
  -- propagate. Without it the other device would just re-push its old value.
  value   TEXT NOT NULL,
  updated TEXT NOT NULL   -- ISO 8601, so `>` compares chronologically as text
);
