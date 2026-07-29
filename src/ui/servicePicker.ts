/**
 * "Choose from my library" — turns the My services text field into a list you tick, built from
 * the providers your own cached titles actually list. Three states per service: one you have,
 * one you can't use, or no opinion.
 */

import { el, dialog } from "./components";
import { providerCatalogue } from "../data/providers";
import type { ProviderSighting } from "../data/providers";
import { normalizeService, parseServiceRules, matchServiceRule } from "./shared";

type PickState = "mine" | "blocked" | "neutral";

interface Pick {
  /** TMDB's spelling, which is what gets written to the field. */
  name: string;
  state: PickState;
  /** Countries the entry is limited to; empty means everywhere. */
  countries: Set<string>;
}

const entryKey = (entry: string): string =>
  normalizeService((entry.startsWith("-") ? entry.slice(1) : entry).split("@")[0]);

function serialize(pick: Pick, order: string[]): string {
  const scope = pick.countries.size > 0 ? `@${order.filter((c) => pick.countries.has(c)).join("/")}` : "";
  return `${pick.state === "blocked" ? "-" : ""}${pick.name}${scope}`;
}

/**
 * Rewrites only the services the user actually touched. Everything else survives verbatim,
 * including hand-written entries the picker has no row for ("Prime@US/DK" is nobody's
 * TMDB spelling), so opening the picker can never quietly rewrite the list.
 */
function applyPicks(current: string, picks: Map<string, Pick>, order: Map<string, string[]>): string {
  const out: string[] = [];
  const used = new Set<string>();
  for (const entry of current.split(",").map((s) => s.trim()).filter(Boolean)) {
    const key = entryKey(entry);
    const pick = picks.get(key);
    if (!pick) {
      out.push(entry);
      continue;
    }
    used.add(key);
    if (pick.state !== "neutral") out.push(serialize(pick, order.get(key) ?? []));
  }
  for (const [key, pick] of picks) {
    if (!used.has(key) && pick.state !== "neutral") out.push(serialize(pick, order.get(key) ?? []));
  }
  return out.join(", ");
}

/** Resolves with the new services string, or null if cancelled. */
export async function pickServices(current: string, watchCountries: string): Promise<string | null> {
  const countries = watchCountries.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  const catalogue = await providerCatalogue(countries);
  if (catalogue.length === 0) {
    await dialog(
      "No services cached yet",
      "Nothing in your library has streaming data yet. Open a few titles (or let a sync finish) and try again.",
      [{ label: "OK", value: "ok", kind: "primary" }],
    );
    return null;
  }

  const rules = parseServiceRules(current);
  const byKey = new Map(rules.map((r) => [entryKey(r.text), r]));
  const order = new Map(catalogue.map((s) => [normalizeService(s.name), s.countries]));
  // Only touched rows go in, so an untouched list comes back byte-identical.
  const picks = new Map<string, Pick>();

  const list = el("div", { class: "picker-list" });
  const rows: { sighting: ProviderSighting; node: HTMLElement }[] = [];

  for (const sighting of catalogue) {
    const key = normalizeService(sighting.name);
    const existing = byKey.get(key);
    const state: PickState = existing ? (existing.blocked ? "blocked" : "mine") : "neutral";
    const pick: Pick = { name: sighting.name, state, countries: new Set(existing?.countries ?? []) };

    const countryBtns = new Map<string, HTMLButtonElement>();
    const stateBtns = new Map<PickState, HTMLButtonElement>();

    const touch = (): void => {
      picks.set(key, pick);
      paint();
    };

    function paint(): void {
      for (const [s, btn] of stateBtns) btn.setAttribute("aria-pressed", String(s === pick.state));
      const scopable = pick.state !== "neutral";
      for (const [cc, btn] of countryBtns) {
        btn.disabled = !scopable;
        btn.classList.toggle("on", scopable && pick.countries.has(cc));
        btn.title = scopable
          ? pick.countries.has(cc)
            ? `Counts in ${cc} — click to drop`
            : `Doesn't count in ${cc} — click to add`
          : `Seen in ${cc}`;
      }
      hint.textContent =
        pick.state === "neutral"
          ? coveredBy()
          : pick.countries.size === 0
            ? pick.state === "mine"
              ? "Counts in every country"
              : "Blocked in every country"
            : "";
    }

    /** Why a row can read "no opinion" and still be green in the app. */
    function coveredBy(): string {
      for (const cc of sighting.countries) {
        const rule = matchServiceRule(rules, sighting.name, cc);
        if (rule && entryKey(rule.text) !== key) {
          return `Already ${rule.blocked ? "blocked" : "covered"} by "${rule.text}"`;
        }
      }
      return "";
    }

    const countryRow = el("div", { class: "picker-countries" });
    for (const cc of sighting.countries) {
      const btn = el("button", { class: "picker-cc", type: "button" }, cc);
      btn.addEventListener("click", () => {
        if (pick.countries.has(cc)) pick.countries.delete(cc);
        else pick.countries.add(cc);
        touch();
      });
      countryBtns.set(cc, btn);
      countryRow.append(btn);
    }

    const stateRow = el("div", { class: "picker-states" });
    for (const [s, label, title] of [
      ["mine", "✓", "One of mine — highlight it"],
      ["blocked", "✗", "I can't use this — never highlight it"],
      ["neutral", "–", "No opinion — treat it as the data says"],
    ] as const) {
      const btn = el("button", { class: `picker-state ${s}`, type: "button", title, "aria-pressed": "false" }, label);
      btn.addEventListener("click", () => {
        pick.state = pick.state === s ? "neutral" : s;
        touch();
      });
      stateBtns.set(s, btn);
      stateRow.append(btn);
    }

    const hint = el("p", { class: "picker-hint" });
    const node = el(
      "div",
      { class: "picker-row" },
      el(
        "div",
        { class: "picker-head" },
        el("span", { class: "picker-name" }, sighting.name),
        sighting.free ? el("span", { class: "picker-tag free" }, "FREE") : null,
        el("span", { class: "picker-count" }, `${sighting.count}`),
      ),
      el("div", { class: "picker-controls" }, countryRow, stateRow),
      hint,
    );
    paint();
    rows.push({ sighting, node });
    list.append(node);
  }

  const search = el("input", { type: "search", class: "picker-search", placeholder: "Filter services…", autocomplete: "off" });
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const { sighting, node } of rows) {
      node.classList.toggle("hidden", q !== "" && !sighting.name.toLowerCase().includes(q));
    }
  });

  const body = el(
    "div",
    { class: "picker" },
    el(
      "p",
      {},
      "Every service your cached titles list, most common first. The number is how many of your " +
        "titles it turns up on. Block the ones you can't actually use — a library service you " +
        "have no card for, or an app that isn't on your box — and they stop counting as free.",
    ),
    search,
    list,
  );

  const choice = await dialog("Choose services", body, [
    { label: "Cancel", value: "cancel", kind: "plain" },
    { label: "Use these", value: "ok", kind: "primary" },
  ]);
  if (choice !== "ok") return null;
  return applyPicks(current, picks, order);
}
