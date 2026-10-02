// 캡처를 브라우저(IndexedDB)에 보관 — 새로고침하거나 창을 실수로 닫아도 남는다.
// 시크릿 창 등에서 저장이 막혀도 앱은 계속 동작해야 하므로 모든 실패는 조용히 넘긴다.

export type StoredCapture = { id: string; createdAt: number; blob: Blob };

const DB_NAME = "doccam";
const STORE = "captures";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function loadCaptures(): Promise<StoredCapture[]> {
  const all = (await run<StoredCapture[]>("readonly", (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export const saveCapture = (c: StoredCapture) => run("readwrite", (s) => s.put(c));
export const deleteCapture = (id: string) => run("readwrite", (s) => s.delete(id));
export const clearCaptures = () => run("readwrite", (s) => s.clear());
