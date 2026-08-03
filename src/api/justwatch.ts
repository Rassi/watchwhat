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
 * An announced digital release that has not happened yet — the structured answer to the question
 * TMDB only hints at through a free-text note.
 *
 * `kind` is decided from the package's own `monetizationTypes`, not from the name: JustWatch
 * models "Apple TV+" (`appletvplus`, FLATRATE) and "Apple TV Store" (RENT/BUY) as different
 * packages, so whether a date means "included" or "costs money" is a lookup rather than a guess.
 */
export interface JustWatchUpcoming {
  date: string;
  country: string;
  service: string;
  kind: "stream" | "rent";
}

/**
 * Upcoming releases are only ever *upcoming*: JustWatch empties the list once a title is out, so
 * this can say "streaming from" and never "streaming since". For anything already released the
 * offers are the answer, which is what the rest of this file fetches.
 */
const UPCOMING_SELECTION = `upcomingReleases(releaseTypes: [DIGITAL]) {
        releaseDate
        package { clearName monetizationTypes }
      }`;

interface UpcomingRow {
  releaseDate?: string | null;
  package?: { clearName?: string | null; monetizationTypes?: string[] | null } | null;
}

/** One country's announced digital releases, keeping the cheapest kind per service. */
function upcomingFrom(rows: UpcomingRow[], country: string): JustWatchUpcoming[] {
  const out: JustWatchUpcoming[] = [];
  for (const row of rows) {
    const date = row.releaseDate?.trim();
    const service = row.package?.clearName?.trim();
    if (!date || !service) continue;
    const types = row.package?.monetizationTypes ?? [];
    // A package offering a subscription is a subscription launch even if it also rents: the
    // question being answered is "will I have to pay again", and the answer there is no.
    const kind = types.some((t) => KINDS[t] === "stream" || KINDS[t] === "free" || KINDS[t] === "ads") ? "stream" : "rent";
    out.push({ date, country, service, kind });
  }
  return out;
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

  // The full document, upcoming releases included, so a rename in either half shows up here
  // rather than as top-ups quietly getting less useful.
  let withUpcoming = true;
  let offers = await post<{ node: Record<string, CountryBlock> }>(offersDocument(wanted, true), {
    id: hit.node.id,
    language: "en",
  });
  if (!offers?.node) {
    withUpcoming = false;
    offers = await post<{ node: Record<string, CountryBlock> }>(offersDocument(wanted, false), { id: hit.node.id });
  }
  if (!offers?.node) {
    checks.push({ label: "Offers query", ok: false, detail: "No node returned — offers field or country aliasing may have changed" });
    return checks;
  }
  const node = offers.node;
  const offersIn = (cc: string): OfferRow[] => {
    const block = node[`o_${cc.toLowerCase()}`];
    return Array.isArray(block) ? block : [];
  };
  // Availability is not asserted — the canary is 2006 and has nothing upcoming anywhere, which is
  // the normal answer. What must hold is that the field still resolves and still returns a list.
  const upcomingBlocks = wanted
    .map((cc) => node[`u_${cc.toLowerCase()}`])
    .filter((b): b is { upcomingReleases?: UpcomingRow[] | null } => b !== undefined && !Array.isArray(b));
  checks.push({
    label: "Upcoming releases",
    ok: withUpcoming && upcomingBlocks.some((b) => Array.isArray(b.upcomingReleases)),
    detail: !withUpcoming
      ? "Document rejected with upcomingReleases — announced streaming dates are off; offers still work"
      : upcomingBlocks.some((b) => Array.isArray(b.upcomingReleases))
        ? `Field resolves in ${upcomingBlocks.length} country block(s)`
        : "Resolved but returned no list — upcomingReleases may have changed shape",
  });
  const rows = wanted.flatMap(offersIn);
  const withCountries = wanted.filter((cc) => offersIn(cc).length > 0);
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
  /** Announced digital releases across the watch countries; null if the query could not be run. */
  upcoming: JustWatchUpcoming[] | null;
  outcome: JustWatchOutcome;
}

interface OfferRow {
  monetizationType: string;
  presentationType?: string;
  package: { clearName: string };
}

/** One country's slot in the aliased query: an offers array, or the content block. */
type CountryBlock = OfferRow[] | { upcomingReleases?: UpcomingRow[] | null } | undefined;

/**
 * Offers and upcoming releases for every country, aliased into one document.
 *
 * `withUpcoming: false` is the same query this file has always sent. It exists because the two
 * halves must not share a fate: a rename inside `upcomingReleases` is a *validation* error, which
 * fails the whole document, and that would take the provider top-up down with a feature it does
 * not depend on. Asking again without it costs one request in the broken case and none otherwise.
 */
function offersDocument(countries: string[], withUpcoming: boolean): string {
  const blocks = countries
    .map((cc) => {
      const key = cc.toLowerCase();
      const offers = `o_${key}: offers(country: ${cc}, platform: WEB) { monetizationType presentationType package { clearName } }`;
      return withUpcoming ? `${offers}\n      u_${key}: content(country: ${cc}, language: $language) { ${UPCOMING_SELECTION} }` : offers;
    })
    .join("\n      ");
  const args = withUpcoming ? "$id: ID!, $language: Language!" : "$id: ID!";
  return `query O(${args}) { node(id: $id) { ... on MovieOrShow {\n      ${blocks}\n  } } }`;
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
  const done = (
    stage: JustWatchHealth["stage"],
    offers: Record<string, JustWatchOffer[]> | null,
    upcoming: JustWatchUpcoming[] | null = null,
  ): JustWatchResult => ({
    offers,
    upcoming,
    outcome: { at: Date.now(), stage },
  });
  const wanted = countries.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  // No countries configured is not a JustWatch problem, so it must not be recorded as one.
  if (wanted.length === 0) return { offers: null, upcoming: null, outcome: { at: Date.now(), stage: "ok" } };
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

    let askedForUpcoming = true;
    let data = await post<{ node: Record<string, CountryBlock> }>(offersDocument(wanted, true), {
      id: nodeId,
      language: "en",
    });
    if (!data?.node) {
      // Retry without the newer half before calling this a failure — see `offersDocument`.
      askedForUpcoming = false;
      data = await post<{ node: Record<string, CountryBlock> }>(offersDocument(wanted, false), { id: nodeId });
    }
    if (!data?.node) {
      recordHealth({ at: Date.now(), ok: false, stage: "offers", detail: "Offers query returned no node" });
      return done("offers", null);
    }
    const node = data.node;
    const offersIn = (cc: string): OfferRow[] => {
      const block = node[`o_${cc.toLowerCase()}`];
      return Array.isArray(block) ? block : [];
    };
    const upcomingIn = (cc: string): JustWatchUpcoming[] => {
      const block = node[`u_${cc.toLowerCase()}`];
      if (!block || Array.isArray(block)) return [];
      return upcomingFrom(block.upcomingReleases ?? [], cc);
    };

    const unknownKinds = new Set<string>();
    const upcoming: JustWatchUpcoming[] = [];
    const out: Record<string, JustWatchOffer[]> = {};
    for (const cc of wanted) {
      upcoming.push(...upcomingIn(cc));
      const rows = offersIn(cc);
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
    const soon = upcoming.length > 0 ? `; ${upcoming.length} announced release(s)` : "";
    recordHealth({
      at: Date.now(),
      ok: countries.length > 0,
      stage: countries.length > 0 ? "ok" : "offers",
      detail:
        (countries.length > 0
          ? `${title}: offers in ${countries.join(", ")}${soon}`
          : `${title}: matched, but no usable offers in any watch country${soon}`) +
        // Not a failure — the offers still arrived — but it is the only trace that the field this
        // now depends on has moved. The Settings canary is what tests it deliberately.
        (askedForUpcoming ? "" : " (upcomingReleases unavailable)"),
      ...(unknownKinds.size > 0 ? { unknownKinds: [...unknownKinds] } : {}),
    });
    // "Matched, but nothing on offer here" is a real answer, not a breakage — a film genuinely
    // absent from every configured country looks exactly like this. So the per-title outcome is
    // `ok` even where the global health record calls it a miss: nothing needs the user's attention.
    return done("ok", countries.length > 0 ? out : null, askedForUpcoming ? upcoming : null);
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
