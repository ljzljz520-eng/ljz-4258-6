export interface OutboxItem {
  id: string;
  kind: 'command' | 'reading' | 'anchor';
  payload: unknown;
  attempts: number;
  createdAt: string;
  lastError?: string;
  status: 'queued' | 'synced' | 'blocked' | 'conflict';
}

const DB_NAME = 'ferment-record';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
    t.onerror = () => reject(t.error);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> { return tx('kv', 'readonly', (s) => s.get(key) as IDBRequest<T>); }
export async function kvSet(key: string, value: unknown) {
  if (value === undefined) return tx('kv', 'readwrite', (s) => s.delete(key));
  await tx('kv', 'readwrite', (s) => s.put(value, key));
}
export async function kvDelete(key: string) { await tx('kv', 'readwrite', (s) => s.delete(key)); }
export async function enqueue(item: OutboxItem) { await tx('outbox', 'readwrite', (s) => s.put(item)); }
export async function allOutbox(): Promise<OutboxItem[]> { return (await tx('outbox', 'readonly', (s) => s.getAll() as IDBRequest<OutboxItem[]>)) ?? []; }
export async function updateOutbox(item: OutboxItem) { await tx('outbox', 'readwrite', (s) => s.put(item)); }
export async function deleteOutbox(id: string) { await tx('outbox', 'readwrite', (s) => s.delete(id)); }
export async function saveSnapshot<T extends { id: string }>(value: T) { await tx('snapshots', 'readwrite', (s) => s.put(value)); }
export async function getSnapshot<T>(id: string): Promise<T | undefined> { return tx('snapshots', 'readonly', (s) => s.get(id) as IDBRequest<T>); }
export const clientItemId = () => `${crypto.randomUUID()}`;
