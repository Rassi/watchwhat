/**
 * WatchWhat sync — an append-only event log on Cloudflare D1.
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin);

    // The preflight is answered before auth: a 401 without CORS headers reaches
    // the browser as an opaque network error, which hides the real problem.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const route = url.pathname;
    if (route !== "/events" && route !== "/justwatch") return json({ error: "Not found" }, 404, cors);

    if (!(await authorized(request, env))) {
      return json({ error: "Unauthorized" }, 401, cors);
    }

    try {
      if (route === "/justwatch") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
        return await handleJustWatch(request, cors);
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
