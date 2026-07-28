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
/** Bumped when the meaning of the stored blob changes; see migrateStored. */
const SETTINGS_SCHEMA_KEY = "watchwhat.settingsSchema";
const SETTINGS_SCHEMA = 2;
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
 * Only fields the user has explicitly set are stored, so presence records intent: anything
 * absent follows the default and picks up future changes to it. Every saveSettings call
 * comes from a deliberate action in Settings, so the patch keys are exactly what was touched.
 */
function readStored(): Partial<AppSettings> {
  const stored = readJson<Partial<AppSettings>>(SETTINGS_KEY);
  if (!stored) return {};
  if (Number(localStorage.getItem(SETTINGS_SCHEMA_KEY)) >= SETTINGS_SCHEMA) return stored;
  return migrateStored(stored);
}

function writeStored(stored: Partial<AppSettings>): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
  localStorage.setItem(SETTINGS_SCHEMA_KEY, String(SETTINGS_SCHEMA));
}

/**
 * Schema 1 wrote every field on every save, default or not, so presence meant nothing there.
 * Drop the ones still sitting at a value we shipped as a default; what remains was chosen.
 * This list is closed — intent tracking replaced it, so a new default never needs an entry.
 */
function migrateStored(stored: Partial<AppSettings>): Partial<AppSettings> {
  const shippedDefaults: Partial<Record<keyof AppSettings, readonly unknown[]>> = {
    staleDays: [30],
    theme: ["auto"],
    myServices: [
      "Disney+, Netflix, Prime, Hulu, Paramount+, Channel 4, BBC, HBO Max, Filmstriben, Apple TV+",
      defaults.myServices,
    ],
    watchCountries: ["DK, US, GB"],
  };
  const migrated: Record<string, unknown> = {};
  for (const key of Object.keys(stored) as (keyof AppSettings)[]) {
    if (!(key in defaults)) continue;
    const value = stored[key];
    if (value === defaults[key] || (shippedDefaults[key]?.includes(value) ?? false)) continue;
    migrated[key] = value;
  }
  writeStored(migrated as Partial<AppSettings>);
  return migrated as Partial<AppSettings>;
}

export function getSettings(): AppSettings {
  return { ...defaults, ...readStored() };
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const stored: Record<string, unknown> = { ...readStored() };
  for (const key of Object.keys(patch) as (keyof AppSettings)[]) {
    if (patch[key] !== undefined) stored[key] = patch[key];
  }
  writeStored(stored as Partial<AppSettings>);
  return { ...defaults, ...(stored as Partial<AppSettings>) };
}

/** Settings the Reset button covers — preferences only, never credentials. */
export const PREFERENCE_FIELDS: readonly { key: keyof AppSettings; label: string }[] = [
  { key: "staleDays", label: '"Not watched for a while" cutoff (days)' },
  { key: "theme", label: "Theme" },
  { key: "myServices", label: "My streaming services" },
  { key: "watchCountries", label: "Where-to-watch countries" },
];

export interface SettingChange {
  label: string;
  /** What you have now. */
  current: string;
  /** What it would fall back to. */
  fallback: string;
}

/** Preferences explicitly set on this device, with the default each would revert to. */
export function changedPreferences(): SettingChange[] {
  const stored = readStored();
  const settings = getSettings();
  return PREFERENCE_FIELDS.filter((f) => f.key in stored).map((f) => ({
    label: f.label,
    current: String(settings[f.key]),
    fallback: String(defaults[f.key]),
  }));
}

/** Forgets explicit preference values so they follow the defaults again. Credentials untouched. */
export function resetPreferences(): void {
  const stored: Record<string, unknown> = { ...readStored() };
  for (const f of PREFERENCE_FIELDS) delete stored[f.key];
  writeStored(stored as Partial<AppSettings>);
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
