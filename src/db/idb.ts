const DB_NAME = 'fermented-milk-records';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('outbox')) {
        const s = db.createObjectStore('outbox', { keyPath: 'client_event_id' });
        s.createIndex('status', 'status', { unique: false });
        s.createIndex('created_at', 'created_at', { unique: false });
      }
      if (!db.objectStoreNames.contains('source_seq')) db.createObjectStore('source_seq');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  return async (): Promise<T> => {
    const db = await openDb();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      t.oncomplete = () => db.close();
    });
  };
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  return (await tx('kv', 'readonly', s => s.get(key) as IDBRequest<T | undefined>))();
}

export async function idbSet<T>(key: string, value: T) {
  return (await tx('kv', 'readwrite', s => s.put(value, key) as IDBRequest<IDBValidKey>))();
}

export async function idbPutOutbox<T extends { client_event_id: string }>(item: T) {
  return (await tx('outbox', 'readwrite', s => s.put(item) as IDBRequest<IDBValidKey>))();
}

export async function idbAllOutbox() {
  return (await tx('outbox', 'readonly', s => s.getAll() as IDBRequest<any[]>))();
}

export async function idbDeleteOutbox(id: string) {
  return (await tx('outbox', 'readwrite', s => s.delete(id) as IDBRequest<undefined>))();
}

export async function idbMarkOutbox(id: string, status: string, error?: unknown) {
  const item = await idbGet<any>(`outbox:${id}`);
  void item;
  const all = await idbAllOutbox();
  const found = all.find(x => x.client_event_id === id);
  if (found) await idbPutOutbox({ ...found, status, error, updated_at: new Date().toISOString() });
}

export async function idbNextSourceSeq(sourceId: string) {
  const current = (await (await tx('source_seq', 'readonly', s => s.get(sourceId) as IDBRequest<number | undefined>))()) ?? 0;
  const next = current + 1;
  await (await tx('source_seq', 'readwrite', s => s.put(next, sourceId) as IDBRequest<IDBValidKey>))();
  return next;
}
