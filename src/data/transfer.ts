/**
 * Whole-library export and import.
 *
 * With no server in the middle, a file is how one device's library reaches
 * another: export on the device that has the data, import on the one that
 * doesn't. Import replaces rather than merges — reconciling two libraries that
 * have both moved on is a sync problem, and guessing at it would quietly lose
 * watches. Replacing is at least predictable, and the caller says so out loud.
 */

import { STORES, dbBulkPut, dbClear, dbGetAllEntries, type StoreName } from "./db";

const FORMAT = "watchwhat-backup";
const VERSION = 1;

export interface BackupFile {
  format: string;
  version: number;
  exportedAt: string;
  stores: Record<string, [IDBValidKey, unknown][]>;
}

/** What a backup holds, in the terms the user thinks in. */
export interface BackupSummary {
  shows: number;
  movies: number;
  /** Episodes marked watched across every show. */
  episodes: number;
}

export function summarize(backup: BackupFile): BackupSummary {
  const progress = backup.stores.progress ?? [];
  let episodes = 0;
  for (const [, value] of progress) {
    const seasons = (value as { seasons?: { episodes?: { completed?: boolean }[] }[] }).seasons ?? [];
    for (const season of seasons) {
      for (const ep of season.episodes ?? []) if (ep.completed) episodes++;
    }
  }
  return { shows: (backup.stores.shows ?? []).length, movies: (backup.stores.movies ?? []).length, episodes };
}

export async function exportBackup(): Promise<BackupFile> {
  const stores: Record<string, [IDBValidKey, unknown][]> = {};
  for (const store of STORES) stores[store] = await dbGetAllEntries(store);
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), stores };
}

export function backupFilename(): string {
  return `watchwhat-${new Date().toISOString().slice(0, 10)}.json`;
}

/** Hand the export to the browser as a download. */
export function downloadBackup(backup: BackupFile): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = backupFilename();
  a.click();
  // Safari needs the element to survive the click before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Check a parsed file is one of ours before it gets anywhere near the database.
 * A half-recognised file that imports partially is worse than one that doesn't
 * import at all, so this is strict about shape and lets the caller show why.
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON.");
  }
  const file = raw as Partial<BackupFile>;
  if (file?.format !== FORMAT) throw new Error("That doesn't look like a WatchWhat export.");
  if (typeof file.version !== "number" || file.version > VERSION) {
    throw new Error("That export was made by a newer version of WatchWhat — update this device first.");
  }
  if (!file.stores || typeof file.stores !== "object") throw new Error("That export is missing its data.");
  for (const [name, entries] of Object.entries(file.stores)) {
    if (!STORES.includes(name as StoreName)) throw new Error(`That export contains an unknown section ("${name}").`);
    if (!Array.isArray(entries) || entries.some((e) => !Array.isArray(e) || e.length !== 2)) {
      throw new Error(`The "${name}" section of that export is malformed.`);
    }
  }
  return file as BackupFile;
}

/** Replace this device's library with the backup's. */
export async function importBackup(backup: BackupFile): Promise<void> {
  for (const store of STORES) {
    const entries = backup.stores[store];
    if (!entries) continue; // a section the exporting version didn't have
    await dbClear(store);
    await dbBulkPut(store, entries);
  }
}
