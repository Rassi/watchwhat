/** UI pieces shared between the show and movie pages. */

import { el } from "./components";
import { getSettings } from "../data/settings";
import { posterUrl } from "../api/tmdb";
import type { CastMemberRec } from "../data/model";

export type ProvidersRecord = Record<
  string,
  { link: string | null; providers: { name: string; logo: string | null; kind: string }[] }
>;

/** Loose provider-name match: lowercase, strip punctuation/spaces, "plus" -> "+". */
function normalizeService(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bplus\b/g, "+")
    .replace(/[^a-z0-9+]/g, "");
}

function watchCountries(): string[] {
  return getSettings().watchCountries.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
}

/**
 * Tests a provider name against the user's own services, in a given country. A subscription
 * is not worldwide — a Netflix account in one country is no help in another — so an entry may
 * be limited with "Netflix@DK/US". A bare entry counts everywhere.
 */
function myServiceMatcher(): (name: string, country: string) => boolean {
  const mine = getSettings()
    .myServices.split(",")
    .map((raw) => {
      const [namePart, countryPart] = raw.split("@");
      const name = normalizeService(namePart);
      const countries = (countryPart ?? "").split("/").map((c) => c.trim().toUpperCase()).filter(Boolean);
      return { name, countries: countries.length > 0 ? countries : null };
    })
    .filter((m) => m.name !== "");
  return (name: string, country: string): boolean => {
    const normalized = normalizeService(name);
    return mine.some(
      (m) =>
        (normalized.includes(m.name) || m.name.includes(normalized)) &&
        (m.countries === null || m.countries.includes(country)),
    );
  };
}

export function whereToWatchCard(providers: ProvidersRecord | undefined): HTMLElement | null {
  if (!providers) return null;
  const countries = watchCountries();
  const haveIt = myServiceMatcher();
  const flag = (cc: string): string =>
    cc.length === 2 ? String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : cc;

  const rows: HTMLElement[] = [];
  for (const cc of countries) {
    const entry = providers[cc];
    const chips = el("div", { class: "wtw-chips" });
    if (!entry) {
      chips.append(el("span", { class: "wtw-none" }, "Not streaming here"));
    } else {
      // De-duplicate providers that appear under several kinds, keeping the cheapest listing
      // (a service offering both a subscription and a rental is not a rental).
      const seen = new Map<string, { name: string; logo: string | null; kind: string }>();
      for (const p of entry.providers) {
        const existing = seen.get(p.name);
        if (!existing || (existing.kind === "rent" && p.kind !== "rent")) seen.set(p.name, p);
      }
      // Cheapest first: yours, then free to anyone, then subscriptions you'd have to buy,
      // then per-title rentals.
      const rank = (p: { name: string; kind: string }): number => {
        if (p.kind === "rent") return 3;
        if (haveIt(p.name, cc)) return 0;
        return p.kind === "free" || p.kind === "ads" ? 1 : 2;
      };
      const list = [...seen.values()].sort((a, b) => rank(a) - rank(b));
      const rentChips: HTMLElement[] = [];
      for (const p of list) {
        const rent = p.kind === "rent";
        const free = !rent && (p.kind === "free" || p.kind === "ads");
        const suffix = rent ? " (rent or buy)" : p.kind === "free" ? " (free)" : p.kind === "ads" ? " (free, with ads)" : "";
        const chip = el(
          "a",
          {
            class: `provider-chip ${rent ? "rent" : haveIt(p.name, cc) ? "have" : free ? "free" : ""}`,
            href: entry.link ?? "#",
            target: "_blank",
            rel: "noopener",
            title: `${p.name}${suffix} — details on JustWatch`,
          },
          p.logo
            ? (() => {
                const img = el("img", { loading: "lazy", alt: "" });
                img.src = posterUrl(p.logo, "w92")!;
                return img;
              })()
            : null,
          p.name,
          rent ? el("span", { class: "chip-rent", title: "Costs extra — rent or buy" }, "$") : null,
          free ? el("span", { class: "chip-free" }, p.kind === "ads" ? "FREE · ADS" : "FREE") : null,
        );
        if (rent) rentChips.push(chip);
        else chips.append(chip);
      }
      // Rentals are the longest and least useful part of a row, so they fold away — unless
      // renting is the only way to watch it here, when hiding them would empty the row.
      if (rentChips.length > 0 && chips.childElementCount > 0) {
        const group = el("span", { class: "wtw-rent-group hidden" }, ...rentChips);
        const toggle = el("button", { class: "wtw-more", type: "button" }, `+${rentChips.length} to rent`);
        toggle.addEventListener("click", () => {
          const hidden = group.classList.toggle("hidden");
          toggle.textContent = hidden ? `+${rentChips.length} to rent` : "Hide rentals";
        });
        chips.append(group, toggle);
      } else {
        chips.append(...rentChips);
      }
    }
    rows.push(el("div", { class: "wtw-country" }, el("span", { class: "wtw-flag", title: cc }, flag(cc)), chips));
  }
  if (rows.length === 0) return null;
  return el(
    "div",
    { class: "card" },
    el("h2", {}, "Where to watch"),
    ...rows,
    el("p", { class: "wtw-attrib" }, "Streaming data by JustWatch via TMDB"),
  );
}

/**
 * "mine" = on a service you pay for, "free" = free to anyone (possibly with ads),
 * "stream" = needs a subscription you don't have, "rent" = costs extra per title.
 */
export type WatchBadge = "mine" | "free" | "stream" | "rent";

/**
 * Best badge for a poster, ranked the same way the chips are: by what it would cost you.
 * Rent only wins when nothing streams it, so paying per title is never suggested over
 * something already included.
 */
export function watchBadge(providers: ProvidersRecord | undefined): WatchBadge | null {
  if (!providers) return null;
  const haveIt = myServiceMatcher();
  let free = false;
  let stream = false;
  let rent = false;
  for (const cc of watchCountries()) {
    for (const p of providers[cc]?.providers ?? []) {
      if (p.kind === "rent") rent = true;
      else if (haveIt(p.name, cc)) return "mine";
      else if (p.kind === "free" || p.kind === "ads") free = true;
      else stream = true;
    }
  }
  return free ? "free" : stream ? "stream" : rent ? "rent" : null;
}

export function castStripCard(cast: CastMemberRec[] | undefined): HTMLElement | null {
  if (!cast?.length) return null;
  const strip = el("div", { class: "cast-strip" });
  for (const member of cast) {
    const photo = posterUrl(member.profile, "w185");
    strip.append(
      el(
        "a",
        {
          class: "cast-card",
          // TMDB credits carry no per-person IMDb id; exact name search lands right.
          href: `https://www.imdb.com/find/?q=${encodeURIComponent(member.name)}&s=nm&exact=true&ref_=fn_nme_ex`,
          target: "_blank",
          rel: "noopener",
          title: `${member.name} on IMDb`,
        },
        photo
          ? (() => {
              const img = el("img", { loading: "lazy", alt: member.name });
              img.src = photo;
              return img;
            })()
          : el("div", { class: "cast-photo-placeholder" }, member.name[0] ?? "?"),
        el("div", { class: "cast-name" }, member.name),
        el("div", { class: "cast-role" }, member.character ?? ""),
      ),
    );
  }
  return el("div", { class: "card" }, el("h2", {}, "Cast"), strip);
}
