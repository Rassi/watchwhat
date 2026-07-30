/** UI pieces shared between the show and movie pages. */

import { dialog, el, toast, withSyncIndicator } from "./components";
import { getSettings } from "../data/settings";
import { posterUrl } from "../api/tmdb";
import { setMovieOnCustomList, setMovieOnWatchlist } from "../data/sync";
import type { CastMemberRec, MovieListRec, MovieRec } from "../data/model";

export type ProvidersRecord = Record<
  string,
  { link: string | null; providers: { name: string; logo: string | null; kind: string }[] }
>;

/** Loose provider-name match: lowercase, strip punctuation/spaces, "plus" -> "+". */
export function normalizeService(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bplus\b/g, "+")
    .replace(/[^a-z0-9+]/g, "");
}

function watchCountries(): string[] {
  return getSettings().watchCountries.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
}

/**
 * One entry from the "My streaming services" list. Two things can be said about a service,
 * so one list says both: "Netflix@US/DK" is one you have, "-Kanopy" is one you can't use.
 * Blocking matters because TMDB's "free" is free *to someone* — Kanopy and Hoopla want a
 * library card, and a free app may not exist on the box you watch on.
 */
export interface ServiceRule {
  /** The entry exactly as written, so Settings can point at the one that decided a match. */
  text: string;
  /** Normalised name, for matching. */
  name: string;
  /** A "-" entry: never counts as yours, and never counts as free. */
  blocked: boolean;
  /** Countries the entry is limited to, or null for everywhere. */
  countries: string[] | null;
}

export function parseServiceRules(list: string): ServiceRule[] {
  return list
    .split(",")
    .map((raw): ServiceRule => {
      const text = raw.trim();
      const blocked = text.startsWith("-");
      // Split on "@" before normalising, which would strip both "-" and "@".
      const [namePart, countryPart] = (blocked ? text.slice(1) : text).split("@");
      const countries = (countryPart ?? "").split("/").map((c) => c.trim().toUpperCase()).filter(Boolean);
      return { text, name: normalizeService(namePart), blocked, countries: countries.length > 0 ? countries : null };
    })
    .filter((r) => r.name !== "");
}

export function serviceRules(): ServiceRule[] {
  return parseServiceRules(getSettings().myServices);
}

/**
 * The entry that decides a provider in a country, or null for "no opinion". A subscription is
 * not worldwide — a Netflix account in one country is no help in another — so an entry may be
 * limited with "Netflix@DK/US"; a bare entry counts everywhere. A block wins over a plain
 * match, so a narrow "-YouTube Free" still overrides a broad "YouTube".
 */
export function matchServiceRule(rules: ServiceRule[], name: string, country: string): ServiceRule | null {
  const normalized = normalizeService(name);
  const hits = rules.filter(
    (r) =>
      (normalized.includes(r.name) || r.name.includes(normalized)) &&
      (r.countries === null || r.countries.includes(country)),
  );
  return hits.find((r) => r.blocked) ?? hits[0] ?? null;
}

type ServiceVerdict = "mine" | "blocked" | null;

function serviceVerdicts(): (name: string, country: string) => ServiceVerdict {
  const rules = serviceRules();
  return (name, country) => {
    const rule = matchServiceRule(rules, name, country);
    return rule ? (rule.blocked ? "blocked" : "mine") : null;
  };
}

export function whereToWatchCard(providers: ProvidersRecord | undefined): HTMLElement | null {
  if (!providers) return null;
  const countries = watchCountries();
  const verdict = serviceVerdicts();
  const flag = (cc: string): string =>
    cc.length === 2 ? String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : cc;

  const rows: HTMLElement[] = [];
  for (const cc of countries) {
    const entry = providers[cc];
    const chips = el("div", { class: "wtw-chips" });
    if (!entry) {
      chips.append(el("span", { class: "wtw-none" }, "Not streaming here"));
    } else {
      // De-duplicate providers that appear under several kinds, keeping the cheapest listing:
      // a service offering both a subscription and a rental is not a rental, and one offering
      // both a subscription and a free tier is not a subscription. Comparing costs rather than
      // testing for "rent" matters because TMDB's order is arbitrary — a "stream" listing
      // arriving before the "free" one used to win and quietly hide the free tier.
      const cost = (kind: string): number => (kind === "free" || kind === "ads" ? 0 : kind === "rent" ? 2 : 1);
      const seen = new Map<string, { name: string; logo: string | null; kind: string }>();
      for (const p of entry.providers) {
        const existing = seen.get(p.name);
        if (!existing || cost(p.kind) < cost(existing.kind)) seen.set(p.name, p);
      }
      // Cheapest first: yours, then free to anyone, then subscriptions you'd have to buy,
      // then per-title rentals. A blocked service sinks in with the subscriptions you don't
      // have — it stays listed, because "it's here but not for me" is worth knowing.
      const rank = (p: { name: string; kind: string }): number => {
        if (p.kind === "rent") return 3;
        const v = verdict(p.name, cc);
        if (v === "mine") return 0;
        if (v === "blocked") return 2;
        return p.kind === "free" || p.kind === "ads" ? 1 : 2;
      };
      const list = [...seen.values()].sort((a, b) => rank(a) - rank(b));
      const rentChips: HTMLElement[] = [];
      for (const p of list) {
        const rent = p.kind === "rent";
        const v = rent ? null : verdict(p.name, cc);
        const free = !rent && v !== "blocked" && (p.kind === "free" || p.kind === "ads");
        const suffix = rent
          ? " (rent or buy)"
          : v === "blocked"
            ? " — you've marked this as one you can't use"
            : p.kind === "free"
              ? " (free)"
              : p.kind === "ads"
                ? " (free, with ads)"
                : "";
        const chip = el(
          "a",
          {
            class: `provider-chip ${rent ? "rent" : v === "mine" ? "have" : free ? "free" : ""}`,
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
      // Rentals are the longest and least useful part of a row, so they always fold away — even
      // in the countries where renting is all there is. Leaving those expanded used to be
      // justified as "hiding them would empty the row", but an empty row is not a loss: "rent
      // or buy only" is the entire answer for that country, and seven paid chips repeating it
      // across three countries buried the rows that did have something included.
      if (rentChips.length > 0) {
        const sole = chips.childElementCount === 0;
        const group = el("span", { class: "wtw-rent-group hidden" }, ...rentChips);
        const shut = sole ? `Rent or buy only (${rentChips.length})` : `+${rentChips.length} to rent`;
        const toggle = el("button", { class: `wtw-more ${sole ? "sole" : ""}`, type: "button" }, shut);
        toggle.addEventListener("click", () => {
          toggle.textContent = group.classList.toggle("hidden") ? shut : "Hide rentals";
        });
        chips.append(group, toggle);
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

// One listener for every dropdown ever built, rather than one per instance on whatever container
// happened to be current: those die with the route that owned them, and Search throws its results
// away on each keystroke. Clicks inside a dropdown never reach here — the wrap stops them.
let closerInstalled = false;
function installDropdownCloser(): void {
  if (closerInstalled) return;
  closerInstalled = true;
  document.addEventListener("click", () => {
    document.querySelectorAll(".lists-dropdown.open").forEach((d) => d.classList.remove("open"));
  });
}

/**
 * "Lists ▾" — the watchlist and every custom list as one set of toggles, with the counts and
 * confirmations that go with them.
 *
 * The record arrives as a thunk because a search hit need not be cached yet: the first toggle is
 * what creates the record, and every toggle after it has to act on that same object rather than
 * on a second copy that would forget the first change.
 */
export function movieListsDropdown(opts: {
  movies: Map<number, MovieRec>;
  record: () => MovieRec;
  lists: MovieListRec[];
  /** Called after a successful toggle, so the caller can redraw whatever else shows list state. */
  onChange?: () => void;
}): HTMLElement {
  const { movies, record, lists, onChange } = opts;
  installDropdownCloser();

  const wrap = el("div", { class: "lists-dropdown" });
  const button = el("button", { class: "btn" });
  const menu = el("div", { class: "burger-menu" });
  // The wrap sits inside a search row that navigates on click, so nothing in here may bubble.
  wrap.addEventListener("click", (e) => e.stopPropagation());

  const draw = (): void => {
    const rec = movies.get(record().traktId);
    const onWatchlist = rec?.onWatchlist ?? false;
    const custom = rec?.customLists ?? [];
    const count = (onWatchlist ? 1 : 0) + custom.length;
    // Deliberately never "primary": Search's old "+ Add" earned the yellow by being the action,
    // but a disclosure control that opens a menu does not, and one per result made the page a
    // wall of it. The count is the signal worth having, and it points the useful way round.
    button.textContent = count > 0 ? `Lists (${count}) ▾` : "Lists ▾";

    const row = (label: string, on: boolean, apply: (rec: MovieRec) => Promise<void>): HTMLElement => {
      const item = el("button", { class: `burger-item ${on ? "on" : ""}` }, `${on ? "✓" : "○"}  ${label}`);
      item.addEventListener("click", async () => {
        wrap.classList.remove("open");
        try {
          // Removal is the one direction worth a confirmation: it undoes a deliberate act, and on
          // a search row the whole list is one mis-aimed tap away from the row underneath it.
          if (on) {
            const choice = await dialog(`Remove from ${label}?`, `"${record().title}" will be taken off ${label}.`, [
              { label: "Remove", value: "yes", kind: "danger" },
              { label: "Cancel", value: "no" },
            ]);
            if (choice !== "yes") return;
          }
          await withSyncIndicator(apply(record()));
          toast(on ? `Removed from ${label}` : `Added to ${label}`);
        } catch (e) {
          toast(e instanceof Error ? e.message : "Update failed", "error");
        }
        draw();
        onChange?.();
      });
      return item;
    };

    menu.replaceChildren(
      row("Watchlist", onWatchlist, (rec) => setMovieOnWatchlist(movies, rec, !onWatchlist)),
      ...lists.map((list) => {
        const on = custom.includes(list.traktId);
        return row(list.name, on, (rec) => setMovieOnCustomList(movies, rec, list.traktId, !on));
      }),
    );
  };
  draw();

  button.addEventListener("click", () => wrap.classList.toggle("open"));
  wrap.append(button, menu);
  return wrap;
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
  const verdict = serviceVerdicts();
  let free = false;
  let stream = false;
  let rent = false;
  for (const cc of watchCountries()) {
    for (const p of providers[cc]?.providers ?? []) {
      if (p.kind === "rent") {
        rent = true;
        continue;
      }
      const v = verdict(p.name, cc);
      if (v === "mine") return "mine";
      // Blocked drops to plain "streams somewhere" — never the yellow free badge, which is a
      // promise you can watch it for nothing.
      if (v === "blocked") stream = true;
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
