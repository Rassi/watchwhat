/** Minimal promise wrapper around IndexedDB with out-of-line keys. */

const DB_NAME = "watchwhat";
const DB_VERSION = 2;

export type StoreName = "shows" | "watched" | "progress" | "episodes" | "movies" | "meta";
const STORES: StoreName[] = ["shows", "watched", "progress", "episodes", "movies", "meta"];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      req.result.onclose = () => (dbPromise = null);
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
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
