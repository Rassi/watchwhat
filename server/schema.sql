-- The whole server-side data model: one append-only log.
--
-- Nothing is ever updated or deleted. An unwatch is its own event, not a change
-- to the watch it undoes, which is what keeps the merge order-independent.

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
