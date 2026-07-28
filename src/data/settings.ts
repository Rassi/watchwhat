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
  myServices: "Disney+, Netflix, Prime, Hulu, Paramount+, Channel 4, BBC, ITVX, HBO Max, Filmstriben, Apple TV+",
  watchCountries: "DK, US, GB",
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
 * Values that shipped as defaults in earlier versions. A stored value matching one of
 * these was persisted incidentally rather than chosen, so it follows the current default.
 * Add the old value here whenever a default above changes.
 */
const supersededDefaults: Partial<Record<keyof AppSettings, readonly unknown[]>> = {
  myServices: ["Disney+, Netflix, Prime, Hulu, Paramount+, Channel 4, BBC, HBO Max, Filmstriben, Apple TV+"],
};

/** Never deliberately set: equal to the current default, or to a default we used to ship. */
function isUntouched(key: keyof AppSettings, value: unknown): boolean {
  return value === defaults[key] || (supersededDefaults[key]?.includes(value) ?? false);
}

export function getSettings(): AppSettings {
  const stored = readJson<Partial<AppSettings>>(SETTINGS_KEY) ?? {};
  const settings: AppSettings = { ...defaults };
  for (const key of Object.keys(stored) as (keyof AppSettings)[]) {
    if (key in defaults && !isUntouched(key, stored[key])) {
      (settings as unknown as Record<string, unknown>)[key] = stored[key];
    }
  }
  return settings;
}

/** Persists only the fields that differ from the defaults, so untouched ones stay current. */
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  const stored: Record<string, unknown> = {};
  for (const key of Object.keys(defaults) as (keyof AppSettings)[]) {
    if (!isUntouched(key, next[key])) stored[key] = next[key];
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
  return next;
}

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

/** Shows for which "mark previous episodes?" should never be asked. */
export function getNeverMarkPrevious(): Set<number> {
  return new Set(readJson<number[]>(NEVER_MARK_PREVIOUS_KEY) ?? []);
}

export function addNeverMarkPrevious(showTraktId: number): void {
  const set = getNeverMarkPrevious();
  set.add(showTraktId);
  localStorage.setItem(NEVER_MARK_PREVIOUS_KEY, JSON.stringify([...set]));
}
