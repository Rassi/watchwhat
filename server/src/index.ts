/**
 * WatchWhat sync — an append-only event log on Cloudflare D1, plus settings.
 *
 * The server never interprets an event. It appends what it is handed and returns
 * what it holds after a cursor; every decision about what an event *means* stays
 * on the client, where the local state machine already lives. That is what lets
 * two devices go offline, both append, and simply merge on reconnect — no
 * locking, no reconciliation, nothing here to keep in step with the client.
 *
 * The one thing it does enforce is shape. A malformed row would survive in the
 * log forever and break replay on every device that pulls it, so a batch is
 * rejected whole rather than half-written.
 *
 * `/settings` is the exception to "append-only", and only that: it stores named
 * values that get overwritten, so that a new device needs nothing typed into it
 * but this Worker's URL and token. It still does not interpret — a key is a
 * string and a value is opaque JSON, so adding a setting needs no deploy here.
 */

export interface Env {
  DB: D1Database;
  /** Long random bearer token; set with `wrangler secret put SYNC_TOKEN`. */
  SYNC_TOKEN: string;
}

/** As it goes over the wire. `seq` is assigned by the server, so reads have it and writes don't. */
interface SyncEvent {
  id: string;
  device: string;
  ts: string;
  kind: string;
  body: unknown;
}

/**
 * One page of history. Deliberately small enough that the ~3,764-event backfill
 * pulls in pages rather than one response the phone has to hold at once.
 */
const PAGE_SIZE = 500;

/** Per request, not per sync — the client chunks the backfill to match. */
const MAX_APPEND = 1000;

/** D1 caps bound parameters per batch; 6 per row leaves this far clear of it. */
const INSERT_CHUNK = 200;

const ALLOWED_ORIGINS = [
  "https://rassi.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

/** Fixed destination for `/justwatch`. Never taken from the request — see `handleJustWatch`. */
const JUSTWATCH_ENDPOINT = "https://apis.justwatch.com/graphql";

/** A GraphQL document from this client is a few hundred bytes; this is only a sanity bound. */
const MAX_QUERY_CHARS = 8192;

/**
 * Sanity bounds for `/settings`. The real list is five fields, the longest of
 * which is a ~200-character service list, so these are far above anything the
 * app sends and exist only to stop the table being used as storage.
 */
const MAX_SETTING_KEYS = 100;
const MAX_SETTING_KEY_CHARS = 64;
const MAX_SETTING_VALUE_CHARS = 4096;

/**
 * Bounds for `/titles`. In practice a request carries the near-release handful —
 * about 18 titles — so these are far above anything the app sends.
 */
const MAX_TITLE_IDS = 500;
/** D1 caps bound parameters per statement; a SELECT binds one per id. */
const TITLE_SELECT_CHUNK = 200;
/** One page of `?since=`. Provider blobs are ~2 KB each, so this is a few hundred KB at worst. */
const TITLE_PAGE_SIZE = 100;
/** A country's offers are a few short names; the whole row is well under this. */
const MAX_TITLE_VALUE_CHARS = 16384;

/** "movie:1325734" — kind and TMDB id, never a traktId. */
const TITLE_ID = /^(movie|show):[1-9][0-9]{0,9}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin);

    // The preflight is answered before auth: a 401 without CORS headers reaches
    // the browser as an opaque network error, which hides the real problem.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const route = url.pathname;
    if (route !== "/events" && route !== "/justwatch" && route !== "/settings" && route !== "/titles") {
      return json({ error: "Not found" }, 404, cors);
    }

    if (!(await authorized(request, env))) {
      return json({ error: "Unauthorized" }, 401, cors);
    }

    try {
      if (route === "/justwatch") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
        return await handleJustWatch(request, cors);
      }
      if (route === "/settings") {
        if (request.method === "GET") return await handleGetSettings(env, cors);
        if (request.method === "PUT") return await handlePutSettings(request, env, cors);
        return json({ error: "Method not allowed" }, 405, cors);
      }
      if (route === "/titles") {
        if (request.method === "GET") return await handleGetTitles(url, env, cors);
        if (request.method === "POST") return await handlePostTitles(request, env, cors);
        return json({ error: "Method not allowed" }, 405, cors);
      }
      if (request.method === "GET") return await handleGet(url, env, cors);
      if (request.method === "POST") return await handlePost(request, env, cors);
    } catch (err) {
      // Never echo the failure back — it can quote SQL, and the log is the place for it.
      console.error(err);
      return json({ error: "Internal error" }, 500, cors);
    }
    return json({ error: "Method not allowed" }, 405, cors);
  },
};

/** Events after the cursor, oldest first, plus where the cursor should land next. */
async function handleGet(url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  const since = Number(url.searchParams.get("since") ?? "0");
  if (!Number.isInteger(since) || since < 0) {
    return json({ error: "`since` must be a non-negative integer" }, 400, cors);
  }

  const { results } = await env.DB.prepare(
    "SELECT seq, id, device, ts, kind, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
  )
    .bind(since, PAGE_SIZE + 1) // one extra row answers "is there more?" without a second query
    .all<{ seq: number; id: string; device: string; ts: string; kind: string; body: string }>();

  const rows = results ?? [];
  const more = rows.length > PAGE_SIZE;
  const page = more ? rows.slice(0, PAGE_SIZE) : rows;

  return json(
    {
      events: page.map((r) => ({
        seq: r.seq,
        id: r.id,
        device: r.device,
        ts: r.ts,
        kind: r.kind,
        body: JSON.parse(r.body) as unknown,
      })),
      // Holding the old cursor on an empty page keeps a no-op poll a no-op.
      seq: page.length ? page[page.length - 1].seq : since,
      more,
    },
    200,
    cors,
  );
}

/**
 * Append a batch. `INSERT OR IGNORE` on the client-generated `id` makes a retry
 * after a dropped response harmless, which is what the phone needs on a flaky
 * connection: the outbox can resend freely and duplicates never land.
 */
async function handlePost(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400, cors);
  }

  const raw = (payload as { events?: unknown })?.events;
  if (!Array.isArray(raw)) return json({ error: "Expected { events: [...] }" }, 400, cors);
  if (raw.length > MAX_APPEND) {
    return json({ error: `At most ${MAX_APPEND} events per request` }, 400, cors);
  }

  const events: SyncEvent[] = [];
  for (const [i, candidate] of raw.entries()) {
    const problem = validate(candidate);
    if (problem) return json({ error: `events[${i}]: ${problem}` }, 400, cors);
    events.push(candidate as SyncEvent);
  }

  if (events.length) {
    const insert = env.DB.prepare(
      "INSERT OR IGNORE INTO events (id, device, ts, kind, body) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < events.length; i += INSERT_CHUNK) {
      await env.DB.batch(
        events
          .slice(i, i + INSERT_CHUNK)
          .map((e) => insert.bind(e.id, e.device, e.ts, e.kind, JSON.stringify(e.body))),
      );
    }
  }

  const row = await env.DB.prepare("SELECT MAX(seq) AS seq FROM events").first<{ seq: number | null }>();
  return json({ accepted: events.length, seq: row?.seq ?? 0 }, 200, cors);
}

/** Every setting the server holds, keyed by name. Small enough to never paginate. */
async function handleGetSettings(env: Env, cors: HeadersInit): Promise<Response> {
  return json({ settings: await readSettings(env) }, 200, cors);
}

/**
 * Upsert named settings, last write wins per field.
 *
 * The `WHERE excluded.updated > settings.updated` guard is what makes that
 * actually true rather than merely usual: a device that edited offline and
 * flushes an hour later cannot overwrite a newer value, and because the guard
 * lives in the statement there is no read-modify-write window to lose a race in.
 *
 * The response carries the full post-write state, so a client whose value lost
 * learns the winner in the same round trip instead of staying wrong until its
 * next poll.
 */
async function handlePutSettings(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400, cors);
  }

  const incoming = (payload as { settings?: unknown })?.settings;
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    return json({ error: "Expected { settings: { key: { value, updated } } }" }, 400, cors);
  }

  const entries = Object.entries(incoming as Record<string, unknown>);
  if (entries.length > MAX_SETTING_KEYS) {
    return json({ error: `At most ${MAX_SETTING_KEYS} settings per request` }, 400, cors);
  }

  const rows: { key: string; value: string; updated: string }[] = [];
  for (const [key, candidate] of entries) {
    if (!key.trim() || key.length > MAX_SETTING_KEY_CHARS) {
      return json({ error: `\`${key}\`: key must be non-empty and at most ${MAX_SETTING_KEY_CHARS} characters` }, 400, cors);
    }
    if (typeof candidate !== "object" || candidate === null) {
      return json({ error: `\`${key}\`: must be an object` }, 400, cors);
    }
    const { value, updated } = candidate as { value?: unknown; updated?: unknown };
    // `value` is deliberately unconstrained apart from size — null included, which
    // is how a Reset travels. Only `updated` has to mean something here, because
    // the merge is decided on it.
    if (typeof updated !== "string" || Number.isNaN(Date.parse(updated))) {
      return json({ error: `\`${key}\`: \`updated\` must be an ISO 8601 timestamp` }, 400, cors);
    }
    if (value === undefined) return json({ error: `\`${key}\`: \`value\` is required (use null to unset)` }, 400, cors);
    let encoded: string;
    try {
      encoded = JSON.stringify(value);
    } catch {
      return json({ error: `\`${key}\`: \`value\` must be JSON-serialisable` }, 400, cors);
    }
    if (encoded.length > MAX_SETTING_VALUE_CHARS) {
      return json({ error: `\`${key}\`: \`value\` is too long` }, 400, cors);
    }
    rows.push({ key, value: encoded, updated });
  }

  if (rows.length) {
    const upsert = env.DB.prepare(
      "INSERT INTO settings (key, value, updated) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated " +
        "WHERE excluded.updated > settings.updated",
    );
    await env.DB.batch(rows.map((r) => upsert.bind(r.key, r.value, r.updated)));
  }

  return json({ settings: await readSettings(env) }, 200, cors);
}

async function readSettings(env: Env): Promise<Record<string, { value: unknown; updated: string }>> {
  const { results } = await env.DB.prepare("SELECT key, value, updated FROM settings").all<{
    key: string;
    value: string;
    updated: string;
  }>();

  const out: Record<string, { value: unknown; updated: string }> = {};
  for (const row of results ?? []) {
    out[row.key] = { value: JSON.parse(row.value) as unknown, updated: row.updated };
  }
  return out;
}

/** One title's row as it comes out of SQLite. */
interface TitleRow {
  id: string;
  jw_providers: string | null;
  jw_upcoming: string | null;
  jw_node_id: string | null;
  jw_verified: string | null;
  jw_fetched: string | null;
  tmdb_providers: string | null;
  tmdb_fetched: string | null;
  dates: string | null;
  provider_since: string | null;
}

const TITLE_COLUMNS =
  "id, jw_providers, jw_upcoming, jw_node_id, jw_verified, jw_fetched, " +
  "tmdb_providers, tmdb_fetched, dates, provider_since";

/**
 * How recently either half was fetched. The cursor runs on this rather than on
 * one column, so a JustWatch-only write and a TMDB-only write both advance it and
 * neither can hide behind the other's older timestamp.
 */
const TITLE_CHANGED = "MAX(COALESCE(tmdb_fetched, ''), COALESCE(jw_fetched, ''))";

function encodeTitle(row: TitleRow): Record<string, unknown> {
  return {
    jwProviders: parseOrNull(row.jw_providers),
    jwUpcoming: parseOrNull(row.jw_upcoming),
    jwNodeId: row.jw_node_id,
    jwVerified: row.jw_verified,
    jwFetched: row.jw_fetched,
    tmdbProviders: parseOrNull(row.tmdb_providers),
    tmdbFetched: row.tmdb_fetched,
    dates: parseOrNull(row.dates),
    providerSince: parseOrNull(row.provider_since),
  };
}

/**
 * Two ways to read, for the two things a client needs.
 *
 * `?ids=` answers "what do you know about these titles", which is what the
 * read-through before a refresh asks. Absent ids are simply missing from the
 * reply — a cache miss is not an error, and answering with nulls for 400 unknown
 * titles would be a bigger response than the hits.
 *
 * `?since=` answers "what has changed", which is what convergence asks on every
 * sync. Sending every row instead would be most of a megabyte of provider blobs
 * on a pull that usually has nothing to say, so this mirrors `/events`: a cursor,
 * a page, and a `more` flag to call again.
 */
async function handleGetTitles(url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  const since = url.searchParams.get("since");
  if (since !== null) return await handleGetTitlesSince(since, env, cors);

  const raw = (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return json({ titles: {} }, 200, cors);
  if (raw.length > MAX_TITLE_IDS) return json({ error: `At most ${MAX_TITLE_IDS} ids per request` }, 400, cors);
  for (const id of raw) {
    if (!TITLE_ID.test(id)) return json({ error: `\`${id}\`: expected "movie:123" or "show:123"` }, 400, cors);
  }

  const ids = [...new Set(raw)];
  const titles: Record<string, unknown> = {};
  // Chunked so the bound-parameter cap is a property of this loop rather than of
  // how many films happen to be near release today.
  for (let i = 0; i < ids.length; i += TITLE_SELECT_CHUNK) {
    const chunk = ids.slice(i, i + TITLE_SELECT_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT ${TITLE_COLUMNS} FROM titles WHERE id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<TitleRow>();
    for (const row of results ?? []) titles[row.id] = encodeTitle(row);
  }
  return json({ titles }, 200, cors);
}

/**
 * Rows changed after the cursor, oldest change first, plus where the cursor lands.
 *
 * The cursor is the timestamp itself rather than a sequence number, because these
 * rows are overwritten in place and have no monotonic id to page by. Two rows
 * written in the same millisecond would tie, so the returned cursor is the last
 * row's own timestamp and the comparison is strictly `>` — a tie costs at worst
 * one row re-sent next time, which is idempotent to apply.
 */
async function handleGetTitlesSince(since: string, env: Env, cors: HeadersInit): Promise<Response> {
  if (since !== "" && Number.isNaN(Date.parse(since))) {
    return json({ error: "`since` must be an ISO 8601 timestamp or empty" }, 400, cors);
  }

  const { results } = await env.DB.prepare(
    `SELECT ${TITLE_COLUMNS}, ${TITLE_CHANGED} AS changed FROM titles ` +
      `WHERE ${TITLE_CHANGED} > ? ORDER BY changed ASC LIMIT ?`,
  )
    .bind(since, TITLE_PAGE_SIZE + 1)
    .all<TitleRow & { changed: string }>();

  const rows = results ?? [];
  const more = rows.length > TITLE_PAGE_SIZE;
  const page = more ? rows.slice(0, TITLE_PAGE_SIZE) : rows;

  const titles: Record<string, unknown> = {};
  for (const row of page) titles[row.id] = encodeTitle(row);

  return json({ titles, cursor: page.length ? page[page.length - 1].changed : since, more }, 200, cors);
}

/**
 * Upsert the JustWatch half of a title, newest fetch wins.
 *
 * The guard is on `jw_fetched`, not on arrival order — which is the whole reason
 * this is safe to share at all. A device flushing an hour-old answer cannot
 * overwrite a fresher one, and because the comparison is in the statement there
 * is no read-modify-write window to lose a race in. `IS NULL` covers the row
 * having been created by the TMDB side with no JustWatch data yet.
 *
 * Only outcomes worth remembering arrive here: the client never sends a failure,
 * because "could not reach JustWatch" is a fact about a network rather than about
 * a film.
 */
async function handlePostTitles(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400, cors);
  }

  const incoming = (payload as { titles?: unknown })?.titles;
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    return json({ error: "Expected { titles: { \"movie:123\": { … } } }" }, 400, cors);
  }

  const entries = Object.entries(incoming as Record<string, unknown>);
  if (entries.length > MAX_TITLE_IDS) {
    return json({ error: `At most ${MAX_TITLE_IDS} titles per request` }, 400, cors);
  }

  const jwRows: (string | null)[][] = [];
  const tmdbRows: (string | null)[][] = [];

  for (const [id, candidate] of entries) {
    if (!TITLE_ID.test(id)) return json({ error: `\`${id}\`: expected "movie:123" or "show:123"` }, 400, cors);
    if (typeof candidate !== "object" || candidate === null) return json({ error: `\`${id}\`: must be an object` }, 400, cors);
    const c = candidate as Record<string, unknown>;

    // Either half may be absent: a JustWatch top-up and a TMDB refresh happen on
    // their own schedules and are written independently, each guarded on its own
    // timestamp. A title carrying neither is a client bug worth reporting.
    const hasJw = c.jwFetched !== undefined;
    const hasTmdb = c.tmdbFetched !== undefined;
    if (!hasJw && !hasTmdb) {
      return json({ error: `\`${id}\`: needs \`jwFetched\` or \`tmdbFetched\`` }, 400, cors);
    }

    const encode = (value: unknown): string | null => (value == null ? null : JSON.stringify(value));

    if (hasJw) {
      const { jwProviders, jwUpcoming, jwNodeId, jwVerified, jwFetched } = c;
      if (typeof jwFetched !== "string" || Number.isNaN(Date.parse(jwFetched))) {
        return json({ error: `\`${id}\`: \`jwFetched\` must be an ISO 8601 timestamp` }, 400, cors);
      }
      if (jwVerified !== "ok" && jwVerified !== "search") {
        return json({ error: `\`${id}\`: \`jwVerified\` must be "ok" or "search"` }, 400, cors);
      }
      if (jwNodeId !== null && typeof jwNodeId !== "string") {
        return json({ error: `\`${id}\`: \`jwNodeId\` must be a string or null` }, 400, cors);
      }
      let providers: string | null;
      let upcoming: string | null;
      try {
        providers = encode(jwProviders);
        upcoming = encode(jwUpcoming);
      } catch {
        return json({ error: `\`${id}\`: offers must be JSON-serialisable` }, 400, cors);
      }
      if ((providers?.length ?? 0) + (upcoming?.length ?? 0) > MAX_TITLE_VALUE_CHARS) {
        return json({ error: `\`${id}\`: JustWatch payload is too long` }, 400, cors);
      }
      jwRows.push([id, providers, upcoming, jwNodeId, jwVerified, jwFetched]);
    }

    if (hasTmdb) {
      const { tmdbProviders, dates, providerSince, tmdbFetched } = c;
      if (typeof tmdbFetched !== "string" || Number.isNaN(Date.parse(tmdbFetched))) {
        return json({ error: `\`${id}\`: \`tmdbFetched\` must be an ISO 8601 timestamp` }, 400, cors);
      }
      let providers: string | null;
      let releaseDates: string | null;
      let since: string | null;
      try {
        providers = encode(tmdbProviders);
        releaseDates = encode(dates);
        since = encode(providerSince);
      } catch {
        return json({ error: `\`${id}\`: TMDB payload must be JSON-serialisable` }, 400, cors);
      }
      if ((providers?.length ?? 0) + (releaseDates?.length ?? 0) + (since?.length ?? 0) > MAX_TITLE_VALUE_CHARS) {
        return json({ error: `\`${id}\`: TMDB payload is too long` }, 400, cors);
      }
      tmdbRows.push([id, providers, releaseDates, since, tmdbFetched]);
    }
  }

  const statements = [];
  if (jwRows.length) {
    const upsert = env.DB.prepare(
      "INSERT INTO titles (id, jw_providers, jw_upcoming, jw_node_id, jw_verified, jw_fetched) " +
        "VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "jw_providers = excluded.jw_providers, jw_upcoming = excluded.jw_upcoming, " +
        "jw_node_id = excluded.jw_node_id, jw_verified = excluded.jw_verified, " +
        "jw_fetched = excluded.jw_fetched " +
        "WHERE titles.jw_fetched IS NULL OR excluded.jw_fetched > titles.jw_fetched",
    );
    statements.push(...jwRows.map((r) => upsert.bind(...r)));
  }
  if (tmdbRows.length) {
    const upsert = env.DB.prepare(
      "INSERT INTO titles (id, tmdb_providers, dates, provider_since, tmdb_fetched) " +
        "VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "tmdb_providers = excluded.tmdb_providers, dates = excluded.dates, " +
        "provider_since = excluded.provider_since, tmdb_fetched = excluded.tmdb_fetched " +
        "WHERE titles.tmdb_fetched IS NULL OR excluded.tmdb_fetched > titles.tmdb_fetched",
    );
    statements.push(...tmdbRows.map((r) => upsert.bind(...r)));
  }

  if (statements.length === 0) return json({ received: 0, applied: 0 }, 200, cors);

  const written = await env.DB.batch(statements);
  // `applied` counts writes the freshness guards actually let through, which is not
  // the same as writes received — reporting the latter would call a discarded write
  // a success, and the discard is the interesting case here.
  const applied = written.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  return json({ received: statements.length, applied }, 200, cors);
}

/** A column this server wrote as JSON. Corrupt beats crashing: the client treats null as a miss. */
function parseOrNull(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Forward one GraphQL query to JustWatch.
 *
 * This exists for one reason: **JustWatch sends no `Access-Control-Allow-Origin`
 * for `https://rassi.github.io`, while allowing `http://localhost:5173`.** The
 * browser could therefore reach it from the dev server and nowhere else, so the
 * near-release provider top-up silently did nothing on the deployed app — and
 * failed silently by design, since a failed top-up means "keep TMDB's answer".
 * Server-to-server has no such restriction.
 *
 * **Deliberately not a general proxy.** The destination is fixed above and never
 * taken from the request, and the bearer token is still required. An open relay
 * against someone else's API, on someone else's quota, is a fine way to get this
 * Worker's address blocked — and it would be this one endpoint that did it.
 *
 * This is the only place the server talks to anything but its own database, and
 * it still interprets nothing: the query is the client's, and the response goes
 * back untouched.
 */
async function handleJustWatch(request: Request, cors: HeadersInit): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400, cors);
  }

  const { query, variables } = (payload ?? {}) as { query?: unknown; variables?: unknown };
  if (typeof query !== "string" || !query.trim()) {
    return json({ error: "`query` must be a non-empty string" }, 400, cors);
  }
  if (query.length > MAX_QUERY_CHARS) return json({ error: "`query` is too long" }, 400, cors);
  if (variables !== undefined && (typeof variables !== "object" || variables === null)) {
    return json({ error: "`variables` must be an object" }, 400, cors);
  }

  const upstream = await fetch(JUSTWATCH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Named rather than anonymous: this is an unofficial API being used politely,
      // and a request that identifies itself is one they can ask about rather than
      // simply block. Verified 2026-08-01 that they answer with or without it.
      "User-Agent": "WatchWhat (+https://github.com/Rassi/watchwhat)",
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });

  // Status and body pass through untouched. The client already treats anything
  // that is not a well-formed answer as "no extra information", which is the
  // right behaviour whether JustWatch was down, throttling, or has moved on.
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/**
 * Structural checks only — deliberately nothing about what `kind` may be or what
 * belongs in `body`. Adding an event type should not mean redeploying the server.
 */
function validate(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "must be an object";
  const e = value as Record<string, unknown>;
  for (const field of ["id", "device", "ts", "kind"] as const) {
    if (typeof e[field] !== "string" || !(e[field] as string).trim()) {
      return `\`${field}\` must be a non-empty string`;
    }
  }
  if (e.body === undefined) return "`body` is required";
  try {
    JSON.stringify(e.body);
  } catch {
    return "`body` must be JSON-serialisable";
  }
  return null;
}

/**
 * Compared after hashing, so the comparison is constant-time *and* independent of
 * length — `timingSafeEqual` throws on a length mismatch, which would otherwise
 * leak the token's size to anyone probing.
 */
async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !env.SYNC_TOKEN) return false;

  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.SYNC_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    // The response body varies by caller, so caches must not share it across origins.
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
