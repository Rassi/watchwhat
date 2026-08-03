/** UI pieces shared between the show and movie pages. */

import { dialog, el, toast, withSyncIndicator } from "./components";
import { getSettings } from "../data/settings";
import { posterUrl } from "../api/tmdb";
import { setMovieOnCustomList, setMovieOnWatchlist } from "../data/sync";
import type { CastMemberRec, MovieListRec, MovieRec } from "../data/model";
import { openServiceChoice } from "./serviceChoice";

export type ProvidersRecord = Record<
  string,
  { link: string | null; providers: { name: string; logo: string | null; kind: string }[] }
>;

/**
 * Compare provider names ignoring spelling, not identity: lowercase, strip
 * punctuation and spaces, "plus" -> "+". This is what lets an entry written
 * "Paramount+" match TMDB's "Paramount Plus" — the same service, spelled two
 * ways — while still keeping it distinct from "Paramount Plus Premium".
 */
export function normalizeService(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bplus\b/g, "+")
    .replace(/[^a-z0-9+]/g, "");
}

/**
 * Whether this device can actually *draw* a flag, measured rather than guessed.
 *
 * There are no flag characters in Unicode. "🇩🇰" is two regional indicators, D and
 * K, which a font may choose to fuse into one flag glyph — Apple's do, and Windows
 * ships none at all, so the pair falls back to two boxed letters reading as "DK".
 * A user-agent test would be answering a different question; this asks the only one
 * that matters by measuring the pair against a single indicator. Fused, it is one
 * glyph and about as wide as one; unfused it is two. Measured on Windows: 1.90.
 *
 * Anything ambiguous falls to the country code, which is the harmless answer —
 * legible everywhere, and what half these devices were showing regardless.
 */
let flagSupport: boolean | null = null;

function drawsFlagEmoji(): boolean {
  if (flagSupport === null) {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return (flagSupport = false);
    ctx.font = "16px sans-serif";
    const pair = ctx.measureText("\u{1F1E9}\u{1F1F0}").width;
    const one = ctx.measureText("\u{1F1E9}").width;
    flagSupport = one > 0 && pair < one * 1.5;
  }
  return flagSupport;
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
 * match, so "-Paramount Plus Basic with Ads" still overrides a plain "Paramount Plus".
 *
 * **Names must match exactly** (after `normalizeService`). This used to be a substring test in
 * either direction, so that a hand-written "Prime" could stand for all three Amazon variants —
 * convenient to type, but it made an entry's reach invisible: "Paramount+" quietly claimed
 * seven providers including resellers, and "Max" would claim Cinemax. The picker now writes
 * TMDB's own spellings, one entry per provider, so there is nothing left to guess at.
 */
export function matchServiceRule(rules: ServiceRule[], name: string, country: string): ServiceRule | null {
  const normalized = normalizeService(name);
  const hits = rules.filter(
    (r) => r.name === normalized && (r.countries === null || r.countries.includes(country)),
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

/**
 * Roughly how old the cached answer is. Deliberately vague at the top end: the
 * only decision it informs is whether re-checking is worth a request, and "6
 * days ago" and "6 days and 4 hours ago" answer that identically. The exact
 * timestamp is on the tooltip for when it does matter.
 */
function agoLabel(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export interface WhereToWatchOpts {
  /** When this device last fetched the provider data, for the freshness line. */
  fetchedAt?: number | null;
  /**
   * How the last JustWatch top-up went, for movies that attempted one. Shows never
   * have this — they have no JustWatch path at all.
   */
  topUp?: { at: number; stage: "reach" | "search" | "offers" | "ok" } | null;
  /**
   * Re-check now, ignoring the TTL. The caller owns what "changed" means, so it
   * also owns saying nothing moved; this only reports a request that failed.
   */
  onRefresh?: () => Promise<void>;
  /** A chip changed `myServices`, so the whole card's colours are stale. */
  onServicesChanged?: () => void;
}

/**
 * Why a failed top-up is worth saying out loud here rather than only in Settings: a stale listing
 * is invisible by construction. A film that moved onto a subscription looks exactly like a film
 * that did not, so nothing prompts you to go and check — the card has to volunteer it.
 *
 * Only genuine breakage warns. "JustWatch has no match for this title" is routine and would cry
 * wolf on a good share of an older library, so it downgrades to a neutral note on the freshness
 * line: enough to tell a verified listing from an unverified one, not enough to alarm.
 */
function topUpWarning(stage: "reach" | "search" | "offers" | "ok"): string | null {
  if (stage === "reach") return "Couldn't reach JustWatch — this is TMDB's listing alone, and may be behind.";
  if (stage === "offers") return "JustWatch answered in a shape this app didn't understand — this is TMDB's listing alone, and may be behind.";
  return null;
}

/**
 * The refresh control. Providers are the one part of a title that goes stale
 * invisibly — a film moving from rental to a subscription you already pay for
 * looks exactly like a film that has not moved, and the cache can be a week old.
 */
function refreshButton(onRefresh: () => Promise<void>): HTMLElement {
  const btn = el(
    "button",
    { class: "wtw-refresh", type: "button", title: "Check the providers again now, ignoring the cache" },
    "↻",
  );
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("busy");
    void onRefresh()
      .catch(() => toast("Could not refresh the provider data", "error"))
      .finally(() => {
        // A refresh that changed anything has already replaced this button along
        // with the rest of the page, so these touch a detached node and do no harm.
        btn.disabled = false;
        btn.classList.remove("busy");
      });
  });
  return btn;
}

export function whereToWatchCard(providers: ProvidersRecord | undefined, opts?: WhereToWatchOpts): HTMLElement | null {
  if (!providers) return null;
  const countries = watchCountries();
  const verdict = serviceVerdicts();

  // A flag on the devices that can draw one, the plain code on the rest.
  const flags = drawsFlagEmoji();
  const label = (cc: string): string =>
    flags && cc.length === 2
      ? String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65))
      : cc;

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
        // A rental chip is a plain label: "one of mine" means a subscription, and
        // there is nothing useful to say about a store you buy single films from.
        // Everything else is a button, because deciding whether a service is yours
        // is a question that arrives *here*, looking at a title, far more often than
        // it arrives in Settings. Neither carries the listing link any more — that
        // belongs to the country, and now sits on the row's code.
        const chip = el(
          rent ? "span" : "button",
          rent
            ? { class: "provider-chip rent", title: `${p.name}${suffix}` }
            : {
                class: `provider-chip ${v === "mine" ? "have" : free ? "free" : ""}`,
                type: "button",
                title: `${p.name}${suffix} — tap to say whether it's one of yours`,
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
        if (rent) {
          rentChips.push(chip);
        } else {
          chip.addEventListener("click", () => {
            void openServiceChoice(p.name, cc, entry.link).then((changed) => {
              if (changed) opts?.onServicesChanged?.();
            });
          });
          chips.append(chip);
        }
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
    // The country code carries the listing link, because that is what the link
    // actually is: one TMDB page per country, not per service. It sat on every chip
    // in the row before, which both repeated it and mislabelled it as JustWatch.
    const prefix = entry?.link
      ? el(
          "a",
          {
            class: `wtw-cc link${flags ? " flag" : ""}`,
            href: entry.link,
            target: "_blank",
            rel: "noopener",
            title: `All ${cc} listings for this title on TMDB`,
          },
          label(cc),
        )
      : el("span", { class: `wtw-cc${flags ? " flag" : ""}`, title: cc }, label(cc));
    rows.push(el("div", { class: "wtw-country" }, prefix, chips));
  }
  if (rows.length === 0) return null;

  const attrib = el("p", { class: "wtw-attrib" }, "Streaming data by JustWatch via TMDB");
  if (opts?.fetchedAt) {
    attrib.append(
      el(
        "span",
        { class: "wtw-updated", title: `This device last checked ${new Date(opts.fetchedAt).toLocaleString()}` },
        ` · checked ${agoLabel(opts.fetchedAt)}`,
      ),
    );
  }
  // A search miss says something real — this listing was never confirmed against JustWatch — but
  // it is not a fault, so it rides the freshness line instead of a warning.
  if (opts?.topUp?.stage === "search") {
    attrib.append(
      el(
        "span",
        { class: "wtw-updated", title: "JustWatch had no match for this title, so this is TMDB's listing alone" },
        " · TMDB only",
      ),
    );
  }

  const warning = opts?.topUp ? topUpWarning(opts.topUp.stage) : null;
  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "wtw-head" },
      el("h2", {}, "Where to watch"),
      opts?.onRefresh ? refreshButton(opts.onRefresh) : null,
    ),
    warning
      ? el(
          "p",
          { class: "wtw-warn", title: `Last attempted ${new Date(opts!.topUp!.at).toLocaleString()}` },
          warning,
        )
      : null,
    ...rows,
    attrib,
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
      // A blocked service counts for nothing at all. It used to drop to "streams somewhere",
      // which was true but unreadable: at poster size the grey ▶ and the green one are the
      // same shape, and its tooltip said "Available for streaming" about the one service you
      // had just said you can't use. So a title whose only streamer is blocked now falls
      // through to the rent badge, or to no badge — the chips on the title page are where
      // "it's here, but not for you" gets said.
      if (v === "blocked") continue;
      if (p.kind === "free" || p.kind === "ads") free = true;
      else stream = true;
    }
  }
  return free ? "free" : stream ? "stream" : rent ? "rent" : null;
}

/**
 * The ratings line, each score a link to the site that gave it.
 *
 * IMDb and TMDB have ids, so they land on the title itself. Rotten Tomatoes is
 * bought from OMDb as a bare percentage with no id or slug attached, so the best
 * that can be offered is a search for the title — still one tap from the page.
 * TMDB comes last: it is the one nobody asked for, kept because it is the only
 * score that is always there.
 */
export function ratingsLine(item: {
  title: string;
  rating?: number | null;
  extRatings?: { imdb: string | null; rottenTomatoes: string | null };
  ids: { imdb?: string | null; tmdb?: number | null };
  kind: "tv" | "movie";
}): HTMLElement | null {
  const bits: (Node | string)[] = [];
  const add = (text: string, href: string | null): void => {
    if (bits.length > 0) bits.push("  ·  ");
    bits.push(href ? el("a", { class: "rating-link", href, target: "_blank", rel: "noopener" }, text) : text);
  };

  if (item.extRatings?.imdb) {
    add(`IMDb ${item.extRatings.imdb}`, item.ids.imdb ? `https://www.imdb.com/title/${item.ids.imdb}/` : null);
  }
  if (item.extRatings?.rottenTomatoes) {
    add(
      `🍅 ${item.extRatings.rottenTomatoes}`,
      `https://www.rottentomatoes.com/search?search=${encodeURIComponent(item.title)}`,
    );
  }
  if (item.rating) {
    add(
      `★ ${item.rating.toFixed(1)} TMDB`,
      item.ids.tmdb ? `https://www.themoviedb.org/${item.kind}/${item.ids.tmdb}` : null,
    );
  }

  return bits.length > 0 ? el("p", { class: "about-rating" }, ...bits) : null;
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
