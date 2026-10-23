// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// IndexedDB Persistent Collection, Media & Offline Outbox Storage (D01, D08, D09, S07, P03)

import { ClientMessage } from "../../server/types";
import { Collection } from "./types";

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
    /** Entries persisted before this field existed default to "pending" when absent. */
    status?: OutboxStatus;
    /** Last server-side error for conflicted entries (D13). */
    error?: string;
    attempts?: number;
}

export type OutboxStatus = "pending" | "conflict";

/**
 * Result of queueing an outbox operation. `durable: true` guarantees the entry survived the
 * IndexedDB transaction commit; a `durable: false` result means the operation only lives in
 * session memory (kept so it is not silently lost, but never claim durable offline saving).
 */
export interface OutboxQueueResult {
    ok: boolean;
    durable: boolean;
    store: "idb" | "memory";
    error?: string;
}

export interface StoredCollectionMeta {
    userId: string;
    collection: Omit<Collection, "media">;
    revision: number;
    initialized: boolean;
    generation?: string;
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
    if (dbPromise) { return dbPromise; }
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
    userId: string,
): Promise<{ collection: Collection; revision: number; initialized: boolean; generation?: string } | null> {
    if (!hasIndexedDB()) {
        const meta = memoryCollections.get(userId);
        if (!meta) { return null; }
        const media = memoryMedia.get(userId) || {};
        return {
            collection: { ...meta.collection, media },
            revision: meta.revision,
            initialized: meta.initialized,
            generation: meta.generation,
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

        if (!meta) { return null; }

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
            initialized: Boolean(meta.initialized),
            generation: meta.generation,
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
    includeMedia: boolean = false,
    generation: string = "0",
): Promise<{ ok: boolean; error?: string }> {
    const { media, ...coreCol } = col;
    const record: StoredCollectionMeta = {
        userId,
        collection: coreCol,
        revision,
        initialized,
        generation,
        updatedAt: Date.now(),
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

            if (includeMedia) {
                const mediaStore = tx.objectStore(STORE_MEDIA);
                const currentMedia = media || {};
                const validIds = new Set(Object.keys(currentMedia).map(fn => `${userId}:${fn}`));
                const mediaIdx = mediaStore.index("by_user");
                const cursorReq = mediaIdx.openKeyCursor(IDBKeyRange.only(userId));
                cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (cursor) {
                        const pk = String(cursor.primaryKey);
                        if (!validIds.has(pk)) {
                            mediaStore.delete(cursor.primaryKey);
                        }
                        cursor.continue();
                    }
                };
                for (const [filename, dataUrl] of Object.entries(currentMedia)) {
                    mediaStore.put({
                        id: `${userId}:${filename}`,
                        userId,
                        filename,
                        dataUrl,
                    });
                }
            }

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        });
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: err?.message || "Storage quota exceeded or unavailable" };
    }
}

export async function saveMediaItemToIdb(
    userId: string,
    filename: string,
    dataUrl: string,
): Promise<{ ok: boolean; error?: string }> {
    const safeName = filename;
    if (!hasIndexedDB()) {
        const cur = memoryMedia.get(userId) || {};
        cur[safeName] = dataUrl;
        memoryMedia.set(userId, cur);
        return { ok: true };
    }

    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_MEDIA, "readwrite");
            tx.objectStore(STORE_MEDIA).put({
                id: `${userId}:${safeName}`,
                userId,
                filename: safeName,
                dataUrl,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        });
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: err?.message || "Failed to persist media item" };
    }
}

export async function deleteMediaItemsFromIdb(
    userId: string,
    filenames: string[],
): Promise<{ ok: boolean; error?: string }> {
    const cur = memoryMedia.get(userId);
    if (cur) {
        for (const fn of filenames) {
            delete cur[fn];
        }
        memoryMedia.set(userId, cur);
    }

    if (!hasIndexedDB()) {
        return { ok: true };
    }

    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_MEDIA, "readwrite");
            const store = tx.objectStore(STORE_MEDIA);
            for (const fn of filenames) {
                store.delete(`${userId}:${fn}`);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        });
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: err?.message || "Failed to delete media items" };
    }
}

export async function enqueueOutboxOp(entry: OutboxEntry): Promise<OutboxQueueResult> {
    if (!hasIndexedDB()) {
        const list = memoryOutbox.get(entry.userId) || [];
        const filtered = list.filter(item => item.opId !== entry.opId);
        filtered.push(entry);
        memoryOutbox.set(entry.userId, filtered);
        // Memory is the designed fallback store in this environment (e.g. unit tests).
        return { ok: true, durable: false, store: "memory", error: "IndexedDB is unavailable" };
    }

    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_OUTBOX, "readwrite");
            tx.objectStore(STORE_OUTBOX).put(entry);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        });
        memoryOutbox.set(entry.userId, (memoryOutbox.get(entry.userId) || []).filter(item => item.opId !== entry.opId));
        return { ok: true, durable: true, store: "idb" };
    } catch (err: any) {
        // Persistence failed: fall back to session memory so the operation is not silently
        // lost, but report the durability failure explicitly to the caller (D01/D14).
        const list = memoryOutbox.get(entry.userId) || [];
        const filtered = list.filter(item => item.opId !== entry.opId);
        filtered.push(entry);
        memoryOutbox.set(entry.userId, filtered);
        return {
            ok: true,
            durable: false,
            store: "memory",
            error: err?.message || "Failed to persist offline operation",
        };
    }
}

/**
 * Patch an outbox entry's lifecycle status without removing it (D13 conflict handling).
 */
export async function updateOutboxOpStatus(
    userId: string,
    opId: string,
    status: OutboxStatus,
    error?: string,
): Promise<void> {
    const applyPatch = (item: OutboxEntry): OutboxEntry => ({
        ...item,
        status,
        error: status === "pending" ? undefined : error,
    });

    const entry = (await getOutboxOps(userId)).find(item => item.opId === opId);
    if (!entry) { return; }
    const result = await enqueueOutboxOp(applyPatch(entry));
    if (!result.durable && hasIndexedDB()) {
        throw new Error(result.error || "Could not persist conflict resolution. Reconnect before closing the app.");
    }
}

export function isPendingOutboxEntry(entry: OutboxEntry): boolean {
    return (entry.status ?? "pending") === "pending";
}

export async function removeOutboxOp(userId: string, opId: string): Promise<void> {
    // Always clean the in-memory fallback view too, even when IndexedDB is available,
    // so entries queued during a persistence failure do not linger in memory (D01).
    const memList = memoryOutbox.get(userId) || [];
    if (memList.some(item => item.opId === opId)) {
        memoryOutbox.set(
            userId,
            memList.filter(item => item.opId !== opId),
        );
    }

    if (!hasIndexedDB()) { return; }

    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_OUTBOX, "readwrite");
            tx.objectStore(STORE_OUTBOX).delete(opId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        });
    } catch (err) {
        throw new Error("Could not remove the saved change. Please try again.", { cause: err });
    }
}

export async function getOutboxOps(userId: string): Promise<OutboxEntry[]> {
    // Merge in-memory fallback entries (queued when IndexedDB persistence failed) into the
    // IDB-backed view so callers never see a missing operation (D01).
    const memoryEntries = memoryOutbox.get(userId) || [];

    if (!hasIndexedDB()) {
        return [...memoryEntries].sort((a, b) => a.createdAt - b.createdAt);
    }

    try {
        const db = await openDb();
        const list = await new Promise<OutboxEntry[]>((resolve, reject) => {
            const tx = db.transaction(STORE_OUTBOX, "readonly");
            const idx = tx.objectStore(STORE_OUTBOX).index("by_user");
            const req = idx.getAll(userId);
            req.onsuccess = () => {
                resolve((req.result || []) as OutboxEntry[]);
            };
            req.onerror = () => reject(req.error);
        });

        const byId = new Map(list.map(item => [item.opId, item]));
        for (const entry of memoryEntries) { byId.set(entry.opId, entry); }
        const merged = [...byId.values()];
        merged.sort((a, b) => a.createdAt - b.createdAt);
        return merged;
    } catch {
        return [...memoryEntries].sort((a, b) => a.createdAt - b.createdAt);
    }
}

const SIGN_OUT_CLEANUP_PREF_KEY = "klanki_clear_data_on_signout";
let memorySignOutCleanupPref = true;

/**
 * Shared-device privacy policy (SEC-04): defaults to `true` so signing out removes
 * downloaded study collections, media, and offline outbox records from browser storage.
 */
export function getClearDataOnSignOutPreference(): boolean {
    try {
        if (typeof localStorage === "undefined") { return memorySignOutCleanupPref; }
        const val = localStorage.getItem(SIGN_OUT_CLEANUP_PREF_KEY);
        if (val === null) { return memorySignOutCleanupPref; }
        return val !== "false";
    } catch {
        return memorySignOutCleanupPref;
    }
}

export function setClearDataOnSignOutPreference(enabled: boolean): void {
    memorySignOutCleanupPref = enabled;
    try {
        if (typeof localStorage !== "undefined") {
            localStorage.setItem(SIGN_OUT_CLEANUP_PREF_KEY, enabled ? "true" : "false");
        }
    } catch {
        // ignore
    }
}

export async function hasUnsyncedUserChanges(userId: string): Promise<number> {
    const ops = await getOutboxOps(userId);
    return ops.length;
}

export async function clearUserOutbox(userId: string): Promise<void> {
    memoryOutbox.delete(userId);
    if (!hasIndexedDB()) { return; }

    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_OUTBOX, "readwrite");
        const outboxIdx = tx.objectStore(STORE_OUTBOX).index("by_user");
        const outboxReq = outboxIdx.openKeyCursor(IDBKeyRange.only(userId));
        outboxReq.onsuccess = () => {
            const cursor = outboxReq.result;
            if (cursor) {
                tx.objectStore(STORE_OUTBOX).delete(cursor.primaryKey);
                cursor.continue();
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
}

/**
 * Clear all offline data (collection, media, and outbox) for a specific user or all users (S07, SEC-04).
 */
export async function clearUserOfflineData(userId?: string): Promise<void> {
    try {
        if (typeof localStorage !== "undefined") {
            const keysToRemove: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (
                    k
                    && (k.startsWith("anki_web_collection_")
                        || (userId && k.includes(userId)))
                ) {
                    keysToRemove.push(k);
                }
            }
            keysToRemove.forEach(k => localStorage.removeItem(k));
        }
    } catch {
        // ignore
    }

    if (userId) {
        memoryCollections.delete(userId);
        memoryMedia.delete(userId);
        memoryOutbox.delete(userId);
    } else {
        memoryCollections.clear();
        memoryMedia.clear();
        memoryOutbox.clear();
    }
    if (!hasIndexedDB()) { return; }

    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(
                [STORE_COLLECTIONS, STORE_MEDIA, STORE_OUTBOX],
                "readwrite",
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
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        });
    } catch (err) {
        throw new Error("Could not clear offline data. Please try again.", { cause: err });
    }
}
