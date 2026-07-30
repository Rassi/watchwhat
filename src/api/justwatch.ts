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

const ENDPOINT = "https://apis.justwatch.com/graphql";

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

async function post<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

/**
 * Offers per country for one title, or null if anything at all went wrong. Countries are aliased
 * into a single query rather than requested one at a time — six round trips per title would make
 * this too expensive to do automatically.
 */
export async function fetchJustWatchOffers(
  title: string,
  tmdbId: number,
  countries: string[],
): Promise<Record<string, JustWatchOffer[]> | null> {
  const wanted = countries.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  if (wanted.length === 0) return null;
  try {
    // US first: the largest catalogue, so the likeliest to know a title at all.
    const searchIn = [...new Set(["US", ...wanted])];
    const nodeId = await findNodeId(title, tmdbId, searchIn.slice(0, 2));
    if (!nodeId) return null;

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
    if (!data?.node) return null;

    const out: Record<string, JustWatchOffer[]> = {};
    for (const cc of wanted) {
      const rows = data.node[cc.toLowerCase()] ?? [];
      // One package can appear several times per country (tiers, presentation types); keep the
      // cheapest kind, matching how the rest of the app de-duplicates providers.
      const best = new Map<string, JustWatchOffer["kind"]>();
      for (const row of rows) {
        const kind = KINDS[row.monetizationType];
        const name = row.package?.clearName?.trim();
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
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null; // unofficial API: a failure just means TMDB's answer stands
  }
}
