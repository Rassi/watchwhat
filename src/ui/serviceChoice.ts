/**
 * Deciding whether a service is yours *from the title you happened to be looking at*.
 *
 * The picker in Settings is for going through the list deliberately; this is for the
 * other way round, which is how the question actually arrives — you open a film, see
 * a service you can't place, and want to answer right there. Both write the same
 * `myServices` entries, so neither is a special case of the other.
 */

import { el, dialog, toast } from "./components";
import { getSettings, saveSettings } from "../data/settings";
import { reconcileSettings } from "../data/cloudsettings";
import { normalizeService, parseServiceRules } from "./shared";

export type ServiceChoice = "mine" | "blocked" | "neutral";

/**
 * `myServices` with one provider's verdict changed, either in one country or everywhere.
 *
 * Choosing "I have this" clears an old block *for that country*, rather than leaving
 * the two to fight — a block wins wherever both apply, so the chip would otherwise
 * stay stubbornly grey.
 *
 * An entry that counted *everywhere* has to be expanded to a country list before one
 * country can be taken out of it — there is no "everywhere except AU" — which is the
 * same shape the shipped Plex entry has for the same reason.
 */
export function applyServiceChoice(
  current: string,
  providerName: string,
  country: string,
  choice: ServiceChoice,
  everywhere: boolean,
  watchCountries: string[],
): string {
  const key = normalizeService(providerName);
  const rules = parseServiceRules(current);
  const untouched = rules.filter((r) => r.name !== key).map((r) => r.text);
  const existing = rules.filter((r) => r.name === key);

  // Keep whatever spelling is already in the list; fall back to TMDB's.
  const label = existing[0]
    ? existing[0].text.replace(/^-/, "").split("@")[0].trim()
    : providerName;
  const order = (ccs: Iterable<string>): string[] => {
    const set = new Set(ccs);
    return [...watchCountries.filter((c) => set.has(c)), ...[...set].filter((c) => !watchCountries.includes(c)).sort()];
  };
  const join = (entries: string[]): string => entries.filter(Boolean).join(", ");

  if (choice === "neutral") {
    if (everywhere) return join(untouched);
    const kept = existing.flatMap((r) => {
      const left = (r.countries ?? watchCountries).filter((c) => c !== country);
      return left.length > 0 ? [`${r.blocked ? "-" : ""}${label}@${order(left).join("/")}`] : [];
    });
    return join([...untouched, ...kept]);
  }

  const blocked = choice === "blocked";
  const dash = blocked ? "-" : "";
  if (everywhere) return join([...untouched, `${dash}${label}`]);

  // Only this country changes hands. An entry of the opposite kind keeps every other
  // country it named, because "mine in DK, blocked in US" is a real state — a DK
  // account is no help against the US catalogue — and collapsing the two into one
  // entry would quietly drop the half you weren't looking at.
  const out = existing
    .filter((r) => r.blocked !== blocked)
    .flatMap((r) => {
      const left = (r.countries ?? watchCountries).filter((c) => c !== country);
      return left.length > 0 ? [`${r.blocked ? "-" : ""}${label}@${order(left).join("/")}`] : [];
    });

  const same = existing.find((r) => r.blocked === blocked);
  // Already unlimited and unchanged in kind: adding a country would only narrow it.
  if (same && same.countries === null) out.push(`${dash}${label}`);
  else out.push(`${dash}${label}@${order([...(same?.countries ?? []), country]).join("/")}`);
  return join([...untouched, ...out]);
}

/** Human-readable current state, for the dialog to open with. */
function describe(current: string, providerName: string, country: string): string {
  const key = normalizeService(providerName);
  const rules = parseServiceRules(current).filter((r) => r.name === key);
  const here = rules.filter((r) => r.countries === null || r.countries.includes(country));
  const rule = here.find((r) => r.blocked) ?? here[0];
  if (!rule) {
    return rules.length > 0
      ? `Not counted in ${country} — your entry covers ${rules.map((r) => (r.countries ?? []).join("/")).join(", ")}.`
      : `You have no opinion on this one, so it counts as whatever TMDB says it is.`;
  }
  const where = rule.countries === null ? "every country" : rule.countries.join("/");
  return rule.blocked
    ? `Currently blocked in ${where} — it never counts as yours or as free.`
    : `Currently one of yours in ${where}.`;
}

/**
 * Ask what to do about one provider in one country. Resolves true if anything changed,
 * so the caller can redraw the card it was tapped from.
 */
export async function openServiceChoice(
  providerName: string,
  country: string,
  link: string | null,
): Promise<boolean> {
  const settings = getSettings();
  const watchCountries = settings.watchCountries.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);

  const everywhere = el("input", { type: "checkbox", id: "svc-everywhere" }) as HTMLInputElement;
  const body = el(
    "div",
    {},
    el("p", {}, describe(settings.myServices, providerName, country)),
    el(
      "label",
      { class: "svc-everywhere", for: "svc-everywhere" },
      everywhere,
      el("span", {}, `Apply to every country, not just ${country}`),
    ),
    link
      ? el(
          "p",
          { class: "field-help" },
          el("a", { href: link, target: "_blank", rel: "noopener" }, `Open ${country} listings on JustWatch ↗`),
        )
      : null,
  );

  const choice = await dialog(`${providerName} in ${country}`, body, [
    { label: "One of mine", value: "mine", kind: "primary" },
    { label: "Can't use it", value: "blocked", kind: "danger" },
    { label: "No opinion", value: "neutral" },
    { label: "Cancel", value: "cancel", kind: "plain" },
  ]);
  if (choice === null || choice === "cancel") return false;

  const next = applyServiceChoice(
    settings.myServices,
    providerName,
    country,
    choice as ServiceChoice,
    everywhere.checked,
    watchCountries,
  );
  if (next === settings.myServices) return false;

  saveSettings({ myServices: next });
  const scope = everywhere.checked ? "everywhere" : `in ${country}`;
  toast(
    choice === "mine"
      ? `${providerName} is now one of yours ${scope}`
      : choice === "blocked"
        ? `${providerName} is now blocked ${scope}`
        : `Dropped your opinion on ${providerName} ${scope}`,
  );
  // Same push-now treatment the Settings screen gives an edit, so the other devices
  // don't wait for the next background sync to agree about what you pay for.
  void reconcileSettings();
  return true;
}
