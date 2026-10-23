// IndexedDB Persistent Collection, Media & Offline Outbox Storage (D01, D08, D09, S07, P03)

import { Collection } from "./types";
import { ClientMessage } from "../../server/types";

const DB_NAME = "klanki_db_v2";
const DB_VERSION = 1;
const STORE_COLLECTIONS = "collections";
const STORE_MEDIA = "media";
const STORE_OUTBOX = "outbox";

export interface OutboxEntry {
  opId: string;
  userId: string;
  createdAt: number;
  msg: ClientMessage;
}

export interface StoredCollectionMeta {
  userId: string;
  collection: Omit<Collection, "media">;
  revision: number;
  initialized: boolean;
  updatedAt: number;
}

// In-memory fallback for non-IndexedDB environments (e.g. Node unit tests)
const memoryCollections = new Map<string, StoredCollectionMeta>();
const memoryMedia = new Map<string, Record<string, string>>();
const memoryOutbox = new Map<string, OutboxEntry[]>();

function hasIndexedDB(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) {
        db.createObjectStore(STORE_COLLECTIONS, { keyPath: "userId" });
      }
      if (!db.objectStoreNames.contains(STORE_MEDIA)) {
        const mediaStore = db.createObjectStore(STORE_MEDIA, { keyPath: "id" });
        mediaStore.createIndex("by_user", "userId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const outboxStore = db.createObjectStore(STORE_OUTBOX, { keyPath: "opId" });
        outboxStore.createIndex("by_user", "userId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function loadCollectionFromIdb(
  userId: string
): Promise<{ collection: Collection; revision: number; initialized: boolean } | null> {
  if (!hasIndexedDB()) {
    const meta = memoryCollections.get(userId);
    if (!meta) return null;
    const media = memoryMedia.get(userId) || {};
    return {
      collection: { ...meta.collection, media },
      revision: meta.revision,
      initialized: meta.initialized
    };
  }

  try {
    const db = await openDb();
    const meta = await new Promise<StoredCollectionMeta | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_COLLECTIONS, "readonly");
      const req = tx.objectStore(STORE_COLLECTIONS).get(userId);
      req.onsuccess = () => resolve(req.result as StoredCollectionMeta | undefined);
      req.onerror = () => reject(req.error);
    });

    if (!meta) return null;

    const media = await new Promise<Record<string, string>>((resolve, reject) => {
      const tx = db.transaction(STORE_MEDIA, "readonly");
      const idx = tx.objectStore(STORE_MEDIA).index("by_user");
      const req = idx.getAll(userId);
      req.onsuccess = () => {
        const map: Record<string, string> = {};
        for (const item of req.result || []) {
          map[item.filename] = item.dataUrl;
        }
        resolve(map);
      };
      req.onerror = () => reject(req.error);
    });

    return {
      collection: { ...meta.collection, media },
      revision: meta.revision || 0,
      initialized: Boolean(meta.initialized)
    };
  } catch (err) {
    console.warn("IndexedDB load error:", err);
    return null;
  }
}

export async function saveCollectionToIdb(
  userId: string,
  col: Collection,
  revision: number,
  initialized: boolean,
  includeMedia: boolean = false
): Promise<{ ok: boolean; error?: string }> {
  const { media, ...coreCol } = col;
  const record: StoredCollectionMeta = {
    userId,
    collection: coreCol,
    revision,
    initialized,
    updatedAt: Date.now()
  };

  if (!hasIndexedDB()) {
    memoryCollections.set(userId, record);
    if (includeMedia && media) {
      memoryMedia.set(userId, { ...media });
    }
    return { ok: true };
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const stores = includeMedia ? [STORE_COLLECTIONS, STORE_MEDIA] : [STORE_COLLECTIONS];
      const tx = db.transaction(stores, "readwrite");
      tx.objectStore(STORE_COLLECTIONS).put(record);

      if (includeMedia && media) {
        const mediaStore = tx.objectStore(STORE_MEDIA);
        for (const [filename, dataUrl] of Object.entries(media)) {
          mediaStore.put({
            id: `${userId}:${filename}`,
            userId,
            filename,
            dataUrl
          });
        }
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Storage quota exceeded or unavailable" };
  }
}

export async function saveMediaItemToIdb(
  userId: string,
  filename: string,
  dataUrl: string
): Promise<{ ok: boolean; error?: string }> {
  if (!hasIndexedDB()) {
    const cur = memoryMedia.get(userId) || {};
    cur[filename] = dataUrl;
    memoryMedia.set(userId, cur);
    return { ok: true };
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MEDIA, "readwrite");
      tx.objectStore(STORE_MEDIA).put({
        id: `${userId}:${filename}`,
        userId,
        filename,
        dataUrl
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Failed to persist media item" };
  }
}

export async function enqueueOutboxOp(entry: OutboxEntry): Promise<void> {
  if (!hasIndexedDB()) {
    const list = memoryOutbox.get(entry.userId) || [];
    const filtered = list.filter(item => item.opId !== entry.opId);
    filtered.push(entry);
    memoryOutbox.set(entry.userId, filtered);
    return;
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_OUTBOX, "readwrite");
      tx.objectStore(STORE_OUTBOX).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("Failed to enqueue outbox op:", err);
  }
}

export async function removeOutboxOp(userId: string, opId: string): Promise<void> {
  if (!hasIndexedDB()) {
    const list = memoryOutbox.get(userId) || [];
    memoryOutbox.set(
      userId,
      list.filter(item => item.opId !== opId)
    );
    return;
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_OUTBOX, "readwrite");
      tx.objectStore(STORE_OUTBOX).delete(opId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("Failed to remove outbox op:", err);
  }
}

export async function getOutboxOps(userId: string): Promise<OutboxEntry[]> {
  if (!hasIndexedDB()) {
    const list = memoryOutbox.get(userId) || [];
    return [...list].sort((a, b) => a.createdAt - b.createdAt);
  }

  try {
    const db = await openDb();
    return await new Promise<OutboxEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE_OUTBOX, "readonly");
      const idx = tx.objectStore(STORE_OUTBOX).index("by_user");
      const req = idx.getAll(userId);
      req.onsuccess = () => {
        const list = (req.result || []) as OutboxEntry[];
        list.sort((a, b) => a.createdAt - b.createdAt);
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/**
 * Clear all offline data (collection, media, and outbox) for a specific user or all users (S07).
 */
export async function clearUserOfflineData(userId?: string): Promise<void> {
  try {
    if (typeof localStorage !== "undefined") {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (
          k &&
          (k.startsWith("anki_web_collection_") ||
            (userId && k.includes(userId)))
        ) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    }
  } catch {
    // ignore
  }

  if (!hasIndexedDB()) {
    if (userId) {
      memoryCollections.delete(userId);
      memoryMedia.delete(userId);
      memoryOutbox.delete(userId);
    } else {
      memoryCollections.clear();
      memoryMedia.clear();
      memoryOutbox.clear();
    }
    return;
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [STORE_COLLECTIONS, STORE_MEDIA, STORE_OUTBOX],
        "readwrite"
      );

      if (!userId) {
        tx.objectStore(STORE_COLLECTIONS).clear();
        tx.objectStore(STORE_MEDIA).clear();
        tx.objectStore(STORE_OUTBOX).clear();
      } else {
        tx.objectStore(STORE_COLLECTIONS).delete(userId);

        const mediaIdx = tx.objectStore(STORE_MEDIA).index("by_user");
        const mediaReq = mediaIdx.openKeyCursor(IDBKeyRange.only(userId));
        mediaReq.onsuccess = () => {
          const cursor = mediaReq.result;
          if (cursor) {
            tx.objectStore(STORE_MEDIA).delete(cursor.primaryKey);
            cursor.continue();
          }
        };

        const outboxIdx = tx.objectStore(STORE_OUTBOX).index("by_user");
        const outboxReq = outboxIdx.openKeyCursor(IDBKeyRange.only(userId));
        outboxReq.onsuccess = () => {
          const cursor = outboxReq.result;
          if (cursor) {
            tx.objectStore(STORE_OUTBOX).delete(cursor.primaryKey);
            cursor.continue();
          }
        };
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("Failed to clear offline data:", err);
  }
}
