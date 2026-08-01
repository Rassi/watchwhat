/** Minimal promise wrapper around IndexedDB with out-of-line keys. */

const DB_NAME = "watchwhat";
const DB_VERSION = 3;

export type StoreName =
  | "shows"
  | "watched"
  | "progress"
  | "episodes"
  | "movies"
  | "meta"
  | "outbox"
  | "sync";

/** The library itself — what a backup contains and what an import replaces. */
export const STORES: StoreName[] = ["shows", "watched", "progress", "episodes", "movies", "meta"];

/**
 * Sync bookkeeping, deliberately outside `STORES`: an export carries a library,
 * not one device's unsent queue or its position in the log. Were these exported,
 * importing a backup would clear the outbox — discarding watches that had never
 * reached the server — and adopt the exporting device's cursor, so everything
 * between the two positions would never be pulled.
 */
export const DEVICE_STORES: StoreName[] = ["outbox", "sync"];

const ALL_STORES: StoreName[] = [...STORES, ...DEVICE_STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      for (const name of ALL_STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      req.result.onclose = () => (dbPromise = null);
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Open the database, creating any store that is missing.
 *
 * The second pass is what makes this safe rather than merely tidy. Stores are
 * only ever created in `onupgradeneeded`, so a database that reached the current
 * version *without* one — an upgrade that raced a second tab, or a build where
 * the version had been bumped before the store was added to the list — can never
 * gain it, and every read of that store throws NotFoundError forever. Reopening
 * one version higher runs the upgrade again and repairs it, which also means
 * adding a store later needs no version bump at all.
 */
async function openDb(): Promise<IDBDatabase> {
  dbPromise ??= (async () => {
    // Open at whatever version exists first. Asking for DB_VERSION outright
    // throws VersionError on a database the repair below has already pushed
    // past it, which would take the whole app down rather than just one store.
    const db = await open();
    if (db.version >= DB_VERSION && ALL_STORES.every((name) => db.objectStoreNames.contains(name))) {
      return db;
    }
    // One version past the current one when repairing, so the upgrade fires
    // whether this device is behind DB_VERSION or level with it.
    const next = Math.max(DB_VERSION, db.version + 1);
    db.close();
    return open(next);
  })();
  return dbPromise;
}

function toPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return toPromise(db.transaction(store).objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return toPromise(db.transaction(store).objectStore(store).getAll() as IDBRequest<T[]>);
}

/** Every key/value pair in a store — what export needs, since keys are out-of-line. */
export async function dbGetAllEntries(store: StoreName): Promise<[IDBValidKey, unknown][]> {
  const db = await openDb();
  const tx = db.transaction(store);
  const os = tx.objectStore(store);
  const [keys, values] = await Promise.all([toPromise(os.getAllKeys()), toPromise(os.getAll())]);
  return keys.map((key, i) => [key, values[i]]);
}

export async function dbPut(store: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openDb();
  await toPromise(db.transaction(store, "readwrite").objectStore(store).put(value, key));
}

export async function dbBulkPut(store: StoreName, entries: [IDBValidKey, unknown][]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  for (const [key, value] of entries) os.put(value, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  await toPromise(db.transaction(store, "readwrite").objectStore(store).delete(key));
}

export async function dbClear(store: StoreName): Promise<void> {
  const db = await openDb();
  await toPromise(db.transaction(store, "readwrite").objectStore(store).clear());
}
