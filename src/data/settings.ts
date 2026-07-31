/** localStorage-backed settings, Trakt tokens, and per-show preferences. */

export interface AppSettings {
  traktClientId: string;
  traktClientSecret: string;
  tmdbApiKey: string;
  /** OMDb key for IMDb/Rotten Tomatoes ratings (optional). */
  omdbApiKey: string;
  /** Days without watching before a show moves to "Haven't watched for a while". */
  staleDays: number;
  theme: "auto" | "dark" | "light";
  /** Comma-separated streaming services the user subscribes to (highlighted in Where to watch). */
  myServices: string;
  /** Comma-separated ISO country codes for Where to watch. */
  watchCountries: string;
}

const SETTINGS_KEY = "watchwhat.settings";
const TOKENS_KEY = "watchwhat.tokens";
const NEVER_MARK_PREVIOUS_KEY = "watchwhat.neverMarkPrevious";

const defaults: AppSettings = {
  traktClientId: "",
  traktClientSecret: "",
  tmdbApiKey: "",
  omdbApiKey: "",
  staleDays: 30,
  theme: "auto",
  // Free-to-air services are left out on purpose: TMDB reports them as free/ads, so they are
  // marked from the data. Listing them here would only claim you pay for them.
  // "@US/DK" limits an account to the countries it can actually play in; see parseServiceRules.
  // The "-" entries are the other way round: TMDB calls them free, but they are free to someone
  // else. Kanopy and Hoopla want a US library card, Cineasterna a Swedish one and Filmoteket a
  // Norwegian one and Beamafilm an Australian one; FXNow and Adult Swim want a US pay-TV login,
  // which is not free at all; YouTube's free tier and The Roku Channel have no Apple TV app.
  // Filmstriben is deliberately absent — that one a Danish library card does cover.
  // Plex is listed the long way round: it plays on the Apple TV in DK but nowhere else, and a
  // block is the only half that takes countries, so every country except DK is named. Adding a
  // seventh watch country means adding it here too, or Plex will claim to be free there.
  // Tubi is absent on purpose: genuinely free where it plays, so it stays yellow and you judge
  // the country row.
  myServices:
    "Disney+@US/DK, Netflix@US/DK, Prime@US/DK, Hulu@US, Paramount+@US, HBO Max@US/DK, Apple TV+@DK, " +
    "-Kanopy, -Hoopla, -YouTube Free, -Cineasterna, -Filmoteket, -Beamafilm, -FXNow, -Adult Swim, " +
    "-The Roku Channel, -Plex@SE/NO/US/GB/AU",
  // The order here is the order the rows appear in on a title page, so it runs from where you
  // can actually watch things to where you mostly can't: DK and US are the real ones, GB is a
  // maybe, and SE/NO/AU are kept only for the handful of free-to-air catalogues they add (SVT,
  // NRK, SBS and ABC iview carry things the others don't). Grouping the Nordics together reads
  // more tidily but buries US halfway down the card.
  watchCountries: "DK, US, GB, SE, NO, AU",
};

function readJson<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Only fields that differ from the default are stored, so a key's absence *is* the marker for
 * "use the default" — and keeps following it as defaults change. Reset simply drops keys again.
 * Saving a value equal to the current default drops the key too, so editing a field and putting
 * it back leaves no trace. Only the current default is ever compared against; nothing here
 * remembers what the defaults used to be.
 */
function readStored(): Partial<AppSettings> {
  const stored: Record<string, unknown> = readJson<Record<string, unknown>>(SETTINGS_KEY) ?? {};
  // A pin that has caught up with the default is not a pin. Dropping it has to reach storage,
  // not just this read: a key left behind would look unpinned only while the two happened to
  // agree, then silently take over again the next time the default moved. Reset and Save are
  // both greyed out in that state, so nothing else would ever clear it.
  let pruned = false;
  for (const key of Object.keys(stored) as (keyof AppSettings)[]) {
    if (stored[key] === defaults[key]) {
      delete stored[key];
      pruned = true;
    }
  }
  if (pruned) writeStored(stored as Partial<AppSettings>);
  return stored as Partial<AppSettings>;
}

function writeStored(stored: Partial<AppSettings>): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
}

export function getSettings(): AppSettings {
  return { ...defaults, ...readStored() };
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const stored: Record<string, unknown> = { ...readStored() };
  for (const key of Object.keys(patch) as (keyof AppSettings)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === defaults[key]) delete stored[key];
    else stored[key] = value;
  }
  writeStored(stored as Partial<AppSettings>);
  return { ...defaults, ...(stored as Partial<AppSettings>) };
}

/** What each per-field Reset in Settings restores, and what saveSettings unpins against. */
export const defaultSettings: Readonly<AppSettings> = defaults;

export function isConfigured(): boolean {
  const s = getSettings();
  return s.traktClientId !== "" && s.traktClientSecret !== "";
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
}

export function getTokens(): Tokens | null {
  return readJson<Tokens>(TOKENS_KEY);
}

export function saveTokens(tokens: Tokens): void {
  localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
}

export function clearTokens(): void {
  localStorage.removeItem(TOKENS_KEY);
}

export function isAuthenticated(): boolean {
  return getTokens() !== null;
}

const TRAKT_UNAVAILABLE_KEY = "watchwhat.traktUnavailable";

export interface TraktUnavailable {
  at: number;
  reason: string;
}

/**
 * Trakt saying it doesn't recognise this app is not a transient failure — it is
 * the answer to every call from now on. Latching it stops the app retrying a
 * dead endpoint on every screen and every mutation. Saving credentials clears
 * the latch, which is the only repair that could ever work anyway.
 */
export function markTraktUnavailable(reason: string): void {
  if (localStorage.getItem(TRAKT_UNAVAILABLE_KEY)) return; // keep the first reason
  localStorage.setItem(TRAKT_UNAVAILABLE_KEY, JSON.stringify({ at: Date.now(), reason }));
}

export function traktUnavailable(): TraktUnavailable | null {
  return readJson<TraktUnavailable>(TRAKT_UNAVAILABLE_KEY);
}

export function clearTraktUnavailable(): void {
  localStorage.removeItem(TRAKT_UNAVAILABLE_KEY);
}

/**
 * Whether Trakt can be called at all. Trakt deleted the API app in July 2026, so
 * this is false on every device that isn't set up with working credentials —
 * and the app then runs entirely off its IndexedDB mirror: it still renders,
 * still records what you watch, and just doesn't sync anywhere. Every Trakt call
 * site is gated on this rather than on being offline, because a device with no
 * tokens is not a device that failed a request.
 */
export function isTraktLive(): boolean {
  return isConfigured() && isAuthenticated() && traktUnavailable() === null;
}

/** Shows for which "mark previous episodes?" should never be asked. */
export function getNeverMarkPrevious(): Set<number> {
  return new Set(readJson<number[]>(NEVER_MARK_PREVIOUS_KEY) ?? []);
}

export function addNeverMarkPrevious(showTraktId: number): void {
  const set = getNeverMarkPrevious();
  set.add(showTraktId);
  localStorage.setItem(NEVER_MARK_PREVIOUS_KEY, JSON.stringify([...set]));
}
