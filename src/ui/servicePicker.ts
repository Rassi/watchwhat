/**
 * "Choose from my library" — turns the My services text field into a list you tick, built from
 * the providers your own cached titles actually list. Three states per service: one you have,
 * one you can't use, or no opinion.
 */

import { el, dialog } from "./components";
import { providerCatalogue } from "../data/providers";
import type { ProviderSighting } from "../data/providers";
import { normalizeService, parseServiceRules } from "./shared";

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

/**
 * `order` is the countries the provider was actually sighted in, and only those get
 * a button — but an entry may name others, and **those must survive being edited**.
 * A country is dropped from the buttons the moment no cached title lists that
 * provider there, which says nothing about whether the subscription covers it:
 * "Amazon Prime Video with Ads" simply hasn't turned up in DK yet. Filtering the
 * set down to `order` would have quietly deleted DK on the next unrelated edit, and
 * the entry would then stop counting the day the provider did appear there.
 */
function serialize(pick: Pick, order: string[]): string {
  const kept = [
    ...order.filter((c) => pick.countries.has(c)),
    ...[...pick.countries].filter((c) => !order.includes(c)).sort(),
  ];
  const scope = kept.length > 0 ? `@${kept.join("/")}` : "";
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
  interface Row {
    sighting: ProviderSighting;
    node: HTMLElement;
    pick: Pick;
    setState: (s: PickState) => void;
    setCountry: (cc: string, on: boolean) => void;
  }
  const rows: Row[] = [];

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
      // Countries the entry names but that have no button, because nothing cached
      // lists this provider there. They are kept on save, so say so rather than
      // letting the row imply the entry is narrower than it is.
      const unsighted = [...pick.countries].filter((c) => !sighting.countries.includes(c)).sort();
      hint.textContent =
        pick.state === "neutral"
          ? ""
          : pick.countries.size === 0
            ? pick.state === "mine"
              ? "Counts in every country"
              : "Blocked in every country"
            : unsighted.length > 0
              ? `Also kept for ${unsighted.join(", ")} — not seen in your titles there yet`
              : "";
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
    rows.push({
      sighting,
      node,
      pick,
      setState: (s) => {
        pick.state = s;
        touch();
      },
      setCountry: (cc, on) => {
        if (!sighting.countries.includes(cc) || pick.state === "neutral") return;
        if (on) pick.countries.add(cc);
        else pick.countries.delete(cc);
        touch();
      },
    });
    list.append(node);
  }

  const search = el("input", { type: "search", class: "picker-search", placeholder: "Filter services…", autocomplete: "off" });

  /**
   * Bulk actions over whatever the filter is currently showing.
   *
   * This is what replaced the hand-written shorthand. One entry called "Prime"
   * used to stand for all three Amazon variants; now that names are exact, three
   * entries are needed — so filtering to "prime" and pressing ✓ once has to be as
   * quick as typing it was. Deliberately tied to a non-empty filter: the same bar
   * over an unfiltered list is a one-click way to declare all 130 services yours.
   */
  const bulkCount = el("span", { class: "picker-bulk-count" });
  const bulkStates = el("div", { class: "picker-states" });
  const bulkCountries = el("div", { class: "picker-countries" });
  const bulkNote = el("p", { class: "picker-hint" });
  const bulk = el(
    "div",
    { class: "picker-bulk hidden" },
    bulkCount,
    el("div", { class: "picker-controls" }, bulkCountries, bulkStates),
    bulkNote,
  );

  const shownRows = (): Row[] => rows.filter((r) => !r.node.classList.contains("hidden"));

  for (const [s, label, title] of [
    ["mine", "✓", "Mark every service shown as one of mine"],
    ["blocked", "✗", "Mark every service shown as one I can't use"],
    ["neutral", "–", "Clear the opinion on every service shown"],
  ] as const) {
    const btn = el("button", { class: `picker-state ${s}`, type: "button", title }, label);
    btn.addEventListener("click", () => {
      for (const row of shownRows()) row.setState(s);
      paintBulk();
    });
    bulkStates.append(btn);
  }

  function paintBulk(): void {
    const shown = shownRows();
    const filtering = search.value.trim() !== "";
    bulk.classList.toggle("hidden", !filtering || shown.length === 0);
    if (!filtering || shown.length === 0) return;

    bulkCount.textContent = `Apply to all ${shown.length} shown`;
    // Only rows with an opinion can be scoped, so the country half is about them.
    const scopable = shown.filter((r) => r.pick.state !== "neutral");
    const countries = [...new Set(shown.flatMap((r) => r.sighting.countries))];

    bulkCountries.replaceChildren();
    for (const cc of countries) {
      const holders = scopable.filter((r) => r.sighting.countries.includes(cc));
      const all = holders.length > 0 && holders.every((r) => r.pick.countries.has(cc));
      const btn = el("button", { class: `picker-cc${all ? " on" : ""}`, type: "button" }, cc);
      btn.disabled = holders.length === 0;
      btn.title = holders.length === 0
        ? `Set ✓ or ✗ first — there is nothing to scope to ${cc}`
        : all
          ? `Counts in ${cc} for all ${holders.length} — click to drop`
          : `Click to add ${cc} to all ${holders.length}`;
      btn.addEventListener("click", () => {
        for (const row of holders) row.setCountry(cc, !all);
        paintBulk();
      });
      bulkCountries.append(btn);
    }

    bulkNote.textContent = scopable.length === 0 ? "Set ✓ or ✗ before choosing countries." : "";
  }

  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const { sighting, node } of rows) {
      node.classList.toggle("hidden", q !== "" && !sighting.name.toLowerCase().includes(q));
    }
    paintBulk();
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
    el(
      "p",
      {},
      "Tiers and resellers are separate services here, because that is how TMDB sends them. " +
        "Filter for one — \"prime\", \"paramount\" — and the bar that appears sets all of them at once.",
    ),
    search,
    bulk,
    list,
  );

  const choice = await dialog("Choose services", body, [
    { label: "Cancel", value: "cancel", kind: "plain" },
    { label: "Use these", value: "ok", kind: "primary" },
  ]);
  if (choice !== "ok") return null;
  return applyPicks(current, picks, order);
}
