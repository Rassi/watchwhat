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

export function whereToWatchCard(providers: ProvidersRecord | undefined): HTMLElement | null {
  if (!providers) return null;
  const settings = getSettings();
  const countries = settings.watchCountries.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  const mine = settings.myServices.split(",").map(normalizeService).filter(Boolean);
  const haveIt = (name: string): boolean => {
    const normalized = normalizeService(name);
    return mine.some((m) => normalized.includes(m) || m.includes(normalized));
  };
  const flag = (cc: string): string =>
    cc.length === 2 ? String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : cc;

  const rows: HTMLElement[] = [];
  for (const cc of countries) {
    const entry = providers[cc];
    const chips = el("div", { class: "wtw-chips" });
    if (!entry) {
      chips.append(el("span", { class: "wtw-none" }, "Not streaming here"));
    } else {
      // De-duplicate providers that appear under several kinds; sort "mine" first.
      const seen = new Set<string>();
      const list = entry.providers
        .filter((p) => !seen.has(p.name) && seen.add(p.name))
        .sort((a, b) => Number(haveIt(b.name)) - Number(haveIt(a.name)));
      for (const p of list) {
        const chip = el(
          "a",
          {
            class: `provider-chip ${haveIt(p.name) ? "have" : ""}`,
            href: entry.link ?? "#",
            target: "_blank",
            rel: "noopener",
            title: `${p.name}${p.kind === "free" ? " (free)" : p.kind === "ads" ? " (with ads)" : ""} — details on JustWatch`,
          },
          p.logo
            ? (() => {
                const img = el("img", { loading: "lazy", alt: "" });
                img.src = posterUrl(p.logo, "w92")!;
                return img;
              })()
            : null,
          p.name,
        );
        chips.append(chip);
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

/** Streamable on some service in one of the user's configured countries? */
export function isStreamable(providers: ProvidersRecord | undefined): boolean {
  if (!providers) return false;
  const countries = getSettings().watchCountries.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  return countries.some((cc) => (providers[cc]?.providers.length ?? 0) > 0);
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
