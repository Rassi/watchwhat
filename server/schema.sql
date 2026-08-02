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
CREATE TABLE IF NOT EXISTS settings (
  key     TEXT PRIMARY KEY,
  -- JSON. The literal `null` is meaningful and distinct from an absent row: it
  -- is "explicitly back on the default", which is what a Reset has to be able to
  -- propagate. Without it the other device would just re-push its old value.
  value   TEXT NOT NULL,
  updated TEXT NOT NULL   -- ISO 8601, so `>` compares chronologically as text
);
