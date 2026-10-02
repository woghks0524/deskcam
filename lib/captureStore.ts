// 캡처·녹화를 브라우저(IndexedDB)에 보관 — 새로고침하거나 창을 실수로 닫아도 남는다.
// 시크릿 창 등에서 저장이 막혀도 앱은 계속 동작해야 하므로 모든 실패는 조용히 넘긴다.

export type StoredCapture = { id: string; createdAt: number; blob: Blob };
export type StoredRecording = { id: string; createdAt: number; blob: Blob; ext: string; durationMs: number };

const DB_NAME = "doccam";
const CAPTURES = "captures";
const RECORDINGS = "recordings";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [CAPTURES, RECORDINGS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function loadAll<T extends { createdAt: number }>(store: string): Promise<T[]> {
  const all = (await run<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>)) ?? [];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export const loadCaptures = () => loadAll<StoredCapture>(CAPTURES);
export const saveCapture = (c: StoredCapture) => run(CAPTURES, "readwrite", (s) => s.put(c));
export const deleteCapture = (id: string) => run(CAPTURES, "readwrite", (s) => s.delete(id));
export const clearCaptures = () => run(CAPTURES, "readwrite", (s) => s.clear());

export const loadRecordings = () => loadAll<StoredRecording>(RECORDINGS);
export const saveRecording = (r: StoredRecording) => run(RECORDINGS, "readwrite", (s) => s.put(r));
export const deleteRecording = (id: string) => run(RECORDINGS, "readwrite", (s) => s.delete(id));
