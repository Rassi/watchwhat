/** localStorage-backed settings and per-show preferences. */

export interface AppSettings {
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
  /**
   * The custom movie lists, as JSON: `[{ traktId, name, slug }]`.
   *
   * Synced because **the event log carries list ids and nothing else.** `list.add` says
   * "movie 1314481 is on list 36041308", so a device set up from sync alone replayed every
   * membership and had no idea any list was called "Family" — and `movies.ts` hides the picker
   * entirely when the catalogue is empty, so the lists were not merely unnamed but unreachable.
   *
   * A JSON string rather than an array because everything in this file compares values with
   * `===`: `saveSettings` uses it to tell a real edit from a no-op, and `readStored` uses it to
   * drop a value that has caught up with its default. Two equal arrays are never `===`, so an
   * array field would stamp itself as changed on every save and push over other devices' edits.
   */
  movieLists: string;
  /** Base URL of the sync Worker. Empty disables sync entirely. */
  syncUrl: string;
  /**
   * Bearer token for the sync Worker. Per-device, like the API keys — the repo is
   * public, so this can only ever live in localStorage, never in the build.
   */
  syncToken: string;
}

const SETTINGS_KEY = "watchwhat.settings";
const SETTINGS_STAMPS_KEY = "watchwhat.settingsUpdated";
const SETTINGS_SEEDED_KEY = "watchwhat.settingsSeeded";
const NEVER_MARK_PREVIOUS_KEY = "watchwhat.neverMarkPrevious";

/**
 * Settings kept on the sync server rather than only in this browser, so a new
 * device needs nothing typed into it but the sync URL and token.
 *
 * The rest are deliberately excluded. `syncUrl` and `syncToken` are how you
 * reach the server, so they cannot come from it; `theme` is left per-device
 * because a phone in dark and a desktop in light is a reasonable thing to want.
 */
export const CLOUD_KEYS = ["tmdbApiKey", "omdbApiKey", "staleDays", "myServices", "watchCountries", "movieLists"] as const;

export type CloudKey = (typeof CLOUD_KEYS)[number];

/** One field as it travels. `value: null` means "explicitly back on the default". */
export interface CloudEntry {
  value: unknown;
  updated: string;
}

const defaults: AppSettings = {
  tmdbApiKey: "",
  omdbApiKey: "",
  staleDays: 30,
  theme: "auto",
  // Every name here is TMDB's own spelling, because matching is exact — see matchServiceRule.
  // This list is meant to be edited with "Choose from my library…", not by hand; that picker
  // only ever offers names TMDB actually sent, so it cannot produce one that matches nothing.
  //
  // Tiers and resellers are separate providers to TMDB, so a subscription needs one entry per
  // variant: Prime is three, Paramount+ is seven. Tedious to type and trivial to pick, which is
  // the whole reason the picker exists. Cutting one is a real decision, not tidying — dropping
  // "HBO Max Amazon Channel" means titles listed only under it stop counting as yours.
  //
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
    "Disney Plus@US/DK, " +
    "Netflix@US/DK, Netflix Standard with Ads@US/DK, Netflix Kids@US/DK, " +
    "Amazon Prime Video@US/DK, Amazon Prime Video with Ads@US/DK, Amazon Prime Video Free with Ads@US/DK, " +
    "Hulu@US, " +
    "Paramount Plus@US, Paramount Plus Premium@US, Paramount Plus Essential@US, " +
    "Paramount Plus Basic with Ads@US, Paramount+ Amazon Channel@US, " +
    "Paramount+ Roku Premium Channel@US, Paramount Plus Apple TV Channel@US, " +
    "HBO Max@US/DK, HBO Max Amazon Channel@US/DK, " +
    "Apple TV@DK, " +
    "-Kanopy, -Hoopla, -YouTube Free, -Cineasterna, -Filmoteket, -Beamafilm, -FXNow, -Adult Swim, " +
    "-The Roku Channel, -Plex@SE/NO/US/GB/AU",
  // The order here is the order the rows appear in on a title page, and **the first entry is
  // read as the primary region** — Discover asks it for "on my services". So it runs from where
  // you can actually watch things to where you mostly can't: US and DK are the real ones, GB is
  // a maybe, and SE/NO/AU are kept only for the handful of free-to-air catalogues they add (SVT,
  // NRK, SBS and ABC iview carry things the others don't). Grouping the Nordics together reads
  // more tidily but buries US halfway down the card.
  //
  // US leads deliberately. Films reach home there first, the US catalogue is the one with the
  // most of his services in it, and every release date in the app is already read against US —
  // see RELEASE_DATE_REGION in ui/discover.ts. With DK first, a US-dated feed was being filtered
  // by Danish availability, which is the worst of both.
  watchCountries: "US, DK, GB, SE, NO, AU",
  movieLists: "",
  // The URL is not a secret, so it ships as a default and only the token has to be
  // typed on each device.
  syncUrl: "https://watchwhat-sync.rassi.workers.dev",
  syncToken: "",
};

const DEVICE_ID_KEY = "watchwhat.deviceId";

/**
 * A stable name for this browser, stamped on every event it appends.
 * Nothing reconciles on it — the log merges by event id — but it is what makes
 * a divergence legible after the fact ("which device marked this?").
 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

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
  //
  // Stamps are deliberately left alone here. Dropping a pin that has caught up
  // with the default does not change the effective value, so there is nothing to
  // tell the other device about — and stamping it would mean a background read
  // could race a real edit made elsewhere.
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

/**
 * When each cloud-backed field was last changed *on this device*, ISO 8601.
 *
 * This doubles as the queue: a field whose stamp is newer than the server's is
 * one the server has not accepted yet, so an edit made offline is pushed by the
 * next reconcile rather than being lost. That is why there is no outbox for
 * settings — the stamp is the record that something is owed.
 */
function readStamps(): Record<string, string> {
  return readJson<Record<string, string>>(SETTINGS_STAMPS_KEY) ?? {};
}

function writeStamps(stamps: Record<string, string>): void {
  localStorage.setItem(SETTINGS_STAMPS_KEY, JSON.stringify(stamps));
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const before = getSettings();
  const stored: Record<string, unknown> = { ...readStored() };
  const stamps = readStamps();
  const now = new Date().toISOString();
  let stamped = false;

  for (const key of Object.keys(patch) as (keyof AppSettings)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === defaults[key]) delete stored[key];
    else stored[key] = value;
    // Only a real change is stamped. Settings' "Save preferences" writes all four
    // fields whether or not they were touched, and stamping those would push
    // unchanged values that could then win against a genuine edit elsewhere.
    if (value !== before[key] && (CLOUD_KEYS as readonly string[]).includes(key)) {
      stamps[key] = now;
      stamped = true;
    }
  }

  writeStored(stored as Partial<AppSettings>);
  if (stamped) writeStamps(stamps);
  return { ...defaults, ...(stored as Partial<AppSettings>) };
}

/**
 * Give the settings this device already had a stamp, so they reach a server that
 * has never held any.
 *
 * Without this nothing would ever seed it: stamps are new, so no existing device
 * has one, and a field with neither a local stamp nor a remote row is read as
 * "no opinion anywhere" and left alone — leaving a TMDB key sitting in a browser
 * that the new device was supposed to inherit it from.
 *
 * Only pinned fields are stamped. A field still on its default is not an
 * opinion, and asserting it would pin the default everywhere, which is the
 * opposite of what "left alone follows future defaults" is for.
 *
 * Runs once per device. If two devices seed different values for the same field,
 * the one that opened later wins — same rule as any other edit.
 */
export function seedCloudStamps(): void {
  if (localStorage.getItem(SETTINGS_SEEDED_KEY)) return;
  localStorage.setItem(SETTINGS_SEEDED_KEY, new Date().toISOString());

  const stored = readStored() as Record<string, unknown>;
  const stamps = readStamps();
  const now = new Date().toISOString();
  let seeded = false;
  for (const key of CLOUD_KEYS) {
    if (!(key in stored) || stamps[key]) continue;
    stamps[key] = now;
    seeded = true;
  }
  if (seeded) writeStamps(stamps);
}

/**
 * A remote value is only adopted if it is the same shape as the default. The
 * server stores opaque JSON by design, so this is the one place that can stop a
 * wrong type — `staleDays` arriving as a string, say — from reaching code that
 * assumes otherwise. A mismatch is dropped rather than coerced.
 */
function acceptable(key: CloudKey, value: unknown): boolean {
  if (value === null) return true; // an unpin, back to the default
  return typeof value === typeof defaults[key];
}

/**
 * Fold the server's settings into this device's, newest write per field wins.
 *
 * Returns the fields that need pushing — ones this device changed since the
 * server last heard, and ones the server has never seen at all.
 */
export function mergeCloudSettings(remote: Record<string, CloudEntry>): {
  changed: CloudKey[];
  push: Record<string, CloudEntry>;
} {
  const stored: Record<string, unknown> = { ...readStored() };
  const stamps = readStamps();
  const changed: CloudKey[] = [];
  const push: Record<string, CloudEntry> = {};

  for (const key of CLOUD_KEYS) {
    const mine = stamps[key];
    const theirs = remote[key];

    if (theirs && (!mine || theirs.updated > mine)) {
      if (!acceptable(key, theirs.value)) continue;
      if (theirs.value === null || theirs.value === defaults[key]) delete stored[key];
      else stored[key] = theirs.value;
      stamps[key] = theirs.updated;
      changed.push(key);
    } else if (mine && (!theirs || mine > theirs.updated)) {
      push[key] = { value: key in stored ? stored[key] : null, updated: mine };
    }
    // Equal stamps are the same write coming back; nothing to do either way.
  }

  if (changed.length) {
    writeStored(stored as Partial<AppSettings>);
    writeStamps(stamps);
  }
  return { changed, push };
}

/** What each per-field Reset in Settings restores, and what saveSettings unpins against. */
export const defaultSettings: Readonly<AppSettings> = defaults;

/**
 * Clear out what the Trakt integration left in localStorage: an OAuth access
 * and refresh token, the client id and secret they were issued against, and the
 * flag that latched the day Trakt started refusing the app. None of it can be
 * used again — the tokens are dead and the API app was deleted — and a stored
 * client secret is worth being rid of on principle. Runs once per device; a
 * no-op on every open after that.
 */
export function purgeTraktRemnants(): void {
  localStorage.removeItem("watchwhat.tokens");
  localStorage.removeItem("watchwhat.traktUnavailable");
  const stored = readJson<Record<string, unknown>>(SETTINGS_KEY);
  if (!stored || !("traktClientId" in stored || "traktClientSecret" in stored)) return;
  delete stored.traktClientId;
  delete stored.traktClientSecret;
  writeStored(stored as Partial<AppSettings>);
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
