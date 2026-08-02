/**
 * Providers straight from JustWatch, for titles TMDB has not caught up on.
 *
 * TMDB's provider data *is* JustWatch data, but the ingest lags — and not uniformly: a record
 * can be refreshed (rental listings changing) while a new subscription listing is still missing.
 * TMDB offers no way to detect that, since watch providers never appear in its /changes feed, so
 * the only options are to wait or to ask the source. Around a release, which is exactly when the
 * answer matters, this is the difference between "rent for 4.99" and "already included in
 * Disney+".
 *
 * This is JustWatch's own web API rather than a published one: no versioning, no contract. Every
 * caller must treat a failure as "no extra information" and keep TMDB's answer.
 */

import { getSettings } from "../data/settings";

const ENDPOINT = "https://apis.justwatch.com/graphql";
const HEALTH_KEY = "watchwhat.justwatch.health";

/** Outcome of the most recent real top-up, so Settings can report from actual use. */
export interface JustWatchHealth {
  at: number;
  ok: boolean;
  /** Where it got to: which stage produced the outcome. */
  stage: "reach" | "search" | "offers" | "ok";
  detail: string;
  /** monetizationType values seen with no mapping — the quiet way offers get dropped. */
  unknownKinds?: string[];
}

export function getJustWatchHealth(): JustWatchHealth | null {
  try {
    const raw = localStorage.getItem(HEALTH_KEY);
    return raw ? (JSON.parse(raw) as JustWatchHealth) : null;
  } catch {
    return null;
  }
}

function recordHealth(health: JustWatchHealth): void {
  try {
    localStorage.setItem(HEALTH_KEY, JSON.stringify(health));
  } catch {
    /* storage full or blocked — health reporting is not worth failing a fetch over */
  }
}

/** JustWatch monetization types mapped onto our kinds; anything unlisted is ignored. */
const KINDS: Record<string, "stream" | "free" | "ads" | "rent"> = {
  FLATRATE: "stream",
  FLATRATE_UPSELL: "stream",
  FREE: "free",
  ADS: "ads",
  RENT: "rent",
  BUY: "rent",
  // CINEMA is deliberately absent: a listing for a cinema near you is not a way to stream it.
};

/**
 * Presentation types that are not streaming at all. Matched by substring rather than enumerated:
 * the variants multiply (DVD, BLURAY, BLURAY_4K, …) and a missed one shows a disc as a rental.
 */
function isPhysical(presentationType: string): boolean {
  const t = presentationType.toUpperCase();
  return t.includes("DVD") || t.includes("BLURAY") || t.includes("BLU_RAY") || t.includes("PHYSICAL");
}

export interface JustWatchOffer {
  name: string;
  kind: "stream" | "free" | "ads" | "rent";
}

/**
 * Where to send a query.
 *
 * **JustWatch sends no `Access-Control-Allow-Origin` for `https://rassi.github.io`,
 * while allowing `http://localhost:5173`** (measured 2026-08-01), so calling it
 * from the browser works on the dev server and nowhere else — which meant the
 * deployed app never once got a top-up, silently. The sync Worker forwards it
 * server-side, where CORS does not apply.
 *
 * Direct is kept as the fallback rather than removed: it is what makes the dev
 * server work with no token configured, and it is the path that still functions
 * if the Worker is ever retired.
 */
function target(): { url: string; headers: Record<string, string> } {
  const { syncUrl, syncToken } = getSettings();
  if (syncUrl.trim() && syncToken.trim()) {
    return {
      url: `${syncUrl.trim().replace(/\/$/, "")}/justwatch`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncToken.trim()}` },
    };
  }
  return { url: ENDPOINT, headers: { "Content-Type": "application/json" } };
}

async function post<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const { url, headers } = target();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: T; errors?: unknown[] };
  if (json.errors?.length || !json.data) return null;
  return json.data;
}

const SEARCH = `query S($country: Country!, $language: Language!, $q: String!) {
  popularTitles(country: $country, first: 5, filter: {searchQuery: $q}) {
    edges { node { id ... on MovieOrShow { content(country: $country, language: $language) { externalIds { tmdbId } } } } }
  }
}`;

/**
 * JustWatch has no lookup by TMDB id, so the title is searched and the result confirmed by the
 * tmdbId it reports back — never by title text, which would happily match a remake or a sequel.
 */
async function findNodeId(title: string, tmdbId: number, searchCountries: string[]): Promise<string | null> {
  interface SearchData {
    popularTitles: { edges: { node: { id: string; content?: { externalIds?: { tmdbId?: number | string } } } }[] };
  }
  for (const country of searchCountries) {
    const data = await post<SearchData>(SEARCH, { country, language: "en", q: title });
    const hit = data?.popularTitles.edges.find(
      (e) => String(e.node.content?.externalIds?.tmdbId ?? "") === String(tmdbId),
    );
    if (hit) return hit.node.id;
  }
  return null;
}

export interface JustWatchCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * Exercises every part of the contract this file depends on, and asserts on the shape of what
 * comes back. A bare reachability ping is close to worthless here: the endpoint staying up says
 * nothing about whether `externalIds`, `monetizationType` or `package.clearName` still exist
 * under those names, and it is a rename that would quietly stop the top-ups.
 *
 * Availability is deliberately not asserted. A canary title dropping off a service is normal and
 * is not a schema problem, so "reachable but no offers" reports as a warning, not a failure.
 */
export async function checkJustWatch(countries: string[]): Promise<JustWatchCheck[]> {
  const checks: JustWatchCheck[] = [];
  // The 2006 original: a fixed, long-lived title, and its sequel makes it a real test of whether
  // results are still being confirmed by id rather than by title text.
  const CANARY = { title: "The Devil Wears Prada", tmdbId: 350 };
  const wanted = countries.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));

  try {
    const ping = await post<{ __typename: string }>("{__typename}", {});
    checks.push({ label: "Endpoint reachable", ok: ping !== null, detail: ping ? "GraphQL responded" : "No usable response" });
    if (!ping) return checks;
  } catch (e) {
    checks.push({ label: "Endpoint reachable", ok: false, detail: e instanceof Error ? e.message : "Request failed" });
    return checks;
  }

  interface SearchData {
    popularTitles: { edges: { node: { id: string; content?: { externalIds?: { tmdbId?: number | string } } } }[] };
  }
  const search = await post<SearchData>(SEARCH, { country: wanted[0] ?? "US", language: "en", q: CANARY.title });
  const edges = search?.popularTitles?.edges;
  if (!Array.isArray(edges)) {
    checks.push({ label: "Title search", ok: false, detail: "Response shape changed — no popularTitles.edges array" });
    return checks;
  }
  checks.push({ label: "Title search", ok: true, detail: `${edges.length} result(s) for "${CANARY.title}"` });

  const hit = edges.find((e) => String(e.node.content?.externalIds?.tmdbId ?? "") === String(CANARY.tmdbId));
  checks.push({
    label: "TMDB id matching",
    ok: hit !== undefined,
    detail: hit ? `Confirmed tmdbId ${CANARY.tmdbId} by id` : `No result reported tmdbId ${CANARY.tmdbId} — externalIds may have moved`,
  });
  if (!hit) return checks;

  const aliases = wanted
    .map((cc) => `${cc.toLowerCase()}: offers(country: ${cc}, platform: WEB) { monetizationType presentationType package { clearName } }`)
    .join("\n      ");
  interface OfferRow {
    monetizationType: string;
    presentationType?: string;
    package: { clearName: string };
  }
  const offers = await post<{ node: Record<string, OfferRow[] | undefined> }>(
    `query O($id: ID!) { node(id: $id) { ... on MovieOrShow {\n      ${aliases}\n  } } }`,
    { id: hit.node.id },
  );
  if (!offers?.node) {
    checks.push({ label: "Offers query", ok: false, detail: "No node returned — offers field or country aliasing may have changed" });
    return checks;
  }
  const rows = wanted.flatMap((cc) => offers.node[cc.toLowerCase()] ?? []);
  const withCountries = wanted.filter((cc) => (offers.node[cc.toLowerCase()] ?? []).length > 0);
  checks.push({
    label: "Offers query",
    ok: true,
    detail: `${rows.length} offer(s) across ${withCountries.join(", ") || "no countries"}`,
  });

  const named = rows.filter((r) => typeof r.package?.clearName === "string" && r.package.clearName !== "");
  checks.push({
    label: "Provider names",
    ok: rows.length === 0 || named.length > 0,
    detail: rows.length === 0 ? "Nothing to check — no offers returned" : `${named.length}/${rows.length} carry package.clearName`,
  });

  const seen = [...new Set(rows.map((r) => r.monetizationType).filter(Boolean))];
  const unknown = seen.filter((t) => !KINDS[t] && t !== "CINEMA");
  checks.push({
    label: "Monetization types",
    ok: unknown.length === 0,
    detail: unknown.length === 0 ? `All recognised: ${seen.join(", ") || "none seen"}` : `Unmapped: ${unknown.join(", ")}`,
  });

  return checks;
}

/**
 * What happened, for the caller to store against the title it asked about.
 *
 * The global health record cannot answer this: `ensureMovieDetails` refreshes several movies
 * concurrently, so reading the shared record after a call would happily attribute one film's
 * failure to another. Per-title outcomes have to come back with the result.
 */
export interface JustWatchOutcome {
  at: number;
  stage: JustWatchHealth["stage"];
}

export interface JustWatchResult {
  offers: Record<string, JustWatchOffer[]> | null;
  outcome: JustWatchOutcome;
}

/**
 * Offers per country for one title; `offers` is null if anything at all went wrong. Countries are
 * aliased into a single query rather than requested one at a time — six round trips per title
 * would make this too expensive to do automatically.
 */
export async function fetchJustWatchOffers(
  title: string,
  tmdbId: number,
  countries: string[],
): Promise<JustWatchResult> {
  const done = (stage: JustWatchHealth["stage"], offers: Record<string, JustWatchOffer[]> | null): JustWatchResult => ({
    offers,
    outcome: { at: Date.now(), stage },
  });
  const wanted = countries.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  // No countries configured is not a JustWatch problem, so it must not be recorded as one.
  if (wanted.length === 0) return { offers: null, outcome: { at: Date.now(), stage: "ok" } };
  try {
    // US first: the largest catalogue, so the likeliest to know a title at all.
    const searchIn = [...new Set(["US", ...wanted])];
    const nodeId = await findNodeId(title, tmdbId, searchIn.slice(0, 2));
    if (!nodeId) {
      // Not necessarily breakage: a title genuinely absent from JustWatch looks the same as a
      // renamed search field. Which it is shows up in whether *every* title starts failing.
      recordHealth({ at: Date.now(), ok: false, stage: "search", detail: `No JustWatch match for "${title}"` });
      return done("search", null);
    }

    const aliases = wanted
      .map(
        (cc) =>
          `${cc.toLowerCase()}: offers(country: ${cc}, platform: WEB) { monetizationType presentationType package { clearName } }`,
      )
      .join("\n      ");
    interface OfferRow {
      monetizationType: string;
      presentationType?: string;
      package: { clearName: string };
    }
    const data = await post<{ node: Record<string, OfferRow[] | undefined> }>(
      `query O($id: ID!) { node(id: $id) { ... on MovieOrShow {\n      ${aliases}\n  } } }`,
      { id: nodeId },
    );
    if (!data?.node) {
      recordHealth({ at: Date.now(), ok: false, stage: "offers", detail: "Offers query returned no node" });
      return done("offers", null);
    }

    const unknownKinds = new Set<string>();
    const out: Record<string, JustWatchOffer[]> = {};
    for (const cc of wanted) {
      const rows = data.node[cc.toLowerCase()] ?? [];
      // One package can appear several times per country (tiers, presentation types); keep the
      // cheapest kind, matching how the rest of the app de-duplicates providers.
      const best = new Map<string, JustWatchOffer["kind"]>();
      for (const row of rows) {
        const kind = KINDS[row.monetizationType];
        const name = row.package?.clearName?.trim();
        // CINEMA is a deliberate omission, not a gap; anything else unmapped is worth surfacing,
        // because a renamed or added type silently drops real offers.
        if (!kind && row.monetizationType && row.monetizationType !== "CINEMA") unknownKinds.add(row.monetizationType);
        if (!kind || !name) continue;
        // JustWatch counts discs under BUY, which is how "Amazon DVD / Blu-ray" and high-street
        // retailers turn up. This is a where-to-*watch* list, so physical copies are dropped.
        if (isPhysical(row.presentationType ?? "")) continue;
        const cost = (k: JustWatchOffer["kind"]): number => (k === "free" || k === "ads" ? 0 : k === "rent" ? 2 : 1);
        const existing = best.get(name);
        if (existing === undefined || cost(kind) < cost(existing)) best.set(name, kind);
      }
      if (best.size > 0) out[cc] = [...best].map(([name, kind]) => ({ name, kind }));
    }
    const countries = Object.keys(out);
    recordHealth({
      at: Date.now(),
      ok: countries.length > 0,
      stage: countries.length > 0 ? "ok" : "offers",
      detail:
        countries.length > 0
          ? `${title}: offers in ${countries.join(", ")}`
          : `${title}: matched, but no usable offers in any watch country`,
      ...(unknownKinds.size > 0 ? { unknownKinds: [...unknownKinds] } : {}),
    });
    // "Matched, but nothing on offer here" is a real answer, not a breakage — a film genuinely
    // absent from every configured country looks exactly like this. So the per-title outcome is
    // `ok` even where the global health record calls it a miss: nothing needs the user's attention.
    return done("ok", countries.length > 0 ? out : null);
  } catch (e) {
    // Unofficial API: a failure just means TMDB's answer stands.
    recordHealth({
      at: Date.now(),
      ok: false,
      stage: "reach",
      detail: e instanceof Error ? `${e.name}: ${e.message}` : "Request failed",
    });
    return done("reach", null);
  }
}
