/**
 * Every streaming service that actually turns up in your library, tallied from the cached
 * TMDB provider data. Typing service names by hand means guessing at spelling ("Disney+" vs
 * "Disney Plus") for a matcher you can't see; picking from what your own titles list means
 * the name is right by construction.
 */

import { dbGetAll } from "./db";
import type { MovieRec, EpisodesRec } from "./model";

export interface ProviderSighting {
  /** Provider name exactly as TMDB spells it. */
  name: string;
  /** Which of the user's watch countries it appeared in, most frequent first. */
  countries: string[];
  /** Cached titles listing it, across those countries. */
  count: number;
  /** True when every sighting was free/ads — the ones that claim to cost nothing. */
  free: boolean;
}

/**
 * Rentals are left out: an "Apple TV Store" is not a service you subscribe to or block, and
 * per-title stores are the bulk of the raw list. A provider offering both keeps its
 * subscription sightings and loses its rental ones.
 */
export async function providerCatalogue(countries: string[]): Promise<ProviderSighting[]> {
  // A show's providers hang off its episodes record, not the show itself.
  const [movies, shows] = await Promise.all([dbGetAll<MovieRec>("movies"), dbGetAll<EpisodesRec>("episodes")]);
  const wanted = new Set(countries.map((c) => c.trim().toUpperCase()).filter(Boolean));
  const tally = new Map<string, { name: string; perCountry: Map<string, number>; free: number; total: number }>();

  for (const rec of [...movies, ...shows]) {
    for (const [cc, entry] of Object.entries(rec.providers ?? {})) {
      if (!wanted.has(cc)) continue;
      // One title listing a service twice in a country (tiers, resellers) is still one sighting.
      const seen = new Set<string>();
      for (const p of entry.providers ?? []) {
        if (p.kind === "rent" || seen.has(p.name)) continue;
        seen.add(p.name);
        const row = tally.get(p.name) ?? { name: p.name, perCountry: new Map(), free: 0, total: 0 };
        row.perCountry.set(cc, (row.perCountry.get(cc) ?? 0) + 1);
        row.total += 1;
        if (p.kind === "free" || p.kind === "ads") row.free += 1;
        tally.set(p.name, row);
      }
    }
  }

  return [...tally.values()]
    .map((row) => ({
      name: row.name,
      countries: [...row.perCountry.entries()].sort((a, b) => b[1] - a[1]).map(([cc]) => cc),
      count: row.total,
      free: row.free === row.total,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
