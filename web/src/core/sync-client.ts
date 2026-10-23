// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { ClientMessage, OpErrorKind, ServerMessage } from "../../server/types";
import { createDefaultCollection } from "./default-data";
import {
    clearUserOfflineData,
    enqueueOutboxOp,
    getOutboxOps,
    isPendingOutboxEntry,
    loadCollectionFromIdb,
    OutboxEntry,
    removeOutboxOp,
    saveCollectionToIdb,
    saveMediaItemToIdb,
    updateOutboxOpStatus,
} from "./idb-storage";
import { generateUniqueId } from "./ids";
import { Card, Collection, Deck, DeckConfig, Note, RevlogEntry } from "./types";

const LEGACY_STORAGE_KEY = "anki_web_collection_v1";

export type SyncStatus = "connected" | "connecting" | "offline";
export type TokenGetter = () => Promise<string | null>;

function makeOpId(): string {
    return `op_${generateUniqueId()}_${Math.random().toString(36).slice(2, 8)}`;
}

function userMessageForOpError(kind: OpErrorKind | undefined, rawError: string): string {
    switch (kind) {
        case "id_collision":
            return `This change collided with data created on another device (${rawError}). Server state is loading — the conflicted change can be retried or discarded in Settings.`;
        case "conflict_revision":
            return `Sync conflict: this collection changed on another device (${rawError}). Server state is loading; retry the seen-not-applied change afterwards if it is still missing.`;
        case "deleted":
            return "This account's cloud data was deleted. Your offline copy was cleared.";
        default:
            return rawError;
    }
}

/**
 * Apply a queued ClientMessage locally onto a Collection snapshot (for deterministic offline outbox replay D01, D08).
 * All branches must be *replace-only* (never Object.assign into existing entries in place) so
 * that a shallow per-map snapshot of the collection still reproduces the pre-mutation state
 * for optimistic-update rollback when the offline outbox cannot persist (D01/D14).
 */
export function applyClientMutationLocally(col: Collection, msg: ClientMessage): void {
    if (msg.type === "answer_card") {
        const card = col.cards[msg.cardId];
        if (card) {
            col.cards[msg.cardId] = {
                ...card,
                ...msg.nextState,
                mod: Math.floor(Date.now() / 1000),
            };
        }
        if (!col.revlog.some(r => r.id === msg.revlogEntry.id)) {
            col.revlog.push(msg.revlogEntry);
        }
    } else if (msg.type === "upsert_deck") {
        col.decks[msg.deck.id] = msg.deck;
    } else if (msg.type === "delete_deck") {
        const target = col.decks[msg.deckId];
        const prefix = target ? `${target.name}::` : null;
        const deckIdsToDelete = new Set<number>([msg.deckId]);
        if (prefix) {
            for (const d of Object.values(col.decks)) {
                if (d.name.startsWith(prefix)) { deckIdsToDelete.add(d.id); }
            }
        }
        for (const did of deckIdsToDelete) {
            if (did !== 1) { delete col.decks[did]; }
        }
        const remainingNids = new Set<number>();
        const affectedNids = new Set<number>();
        for (const card of Object.values(col.cards)) {
            if (deckIdsToDelete.has(card.did)) {
                delete col.cards[card.id];
                affectedNids.add(card.nid);
            } else {
                remainingNids.add(card.nid);
            }
        }
        for (const nid of affectedNids) {
            if (!remainingNids.has(nid)) {
                delete col.notes[nid];
            }
        }
    } else if (msg.type === "upsert_deck_config") {
        col.dconf[msg.dconf.id] = msg.dconf;
    } else if (msg.type === "upsert_note") {
        col.notes[msg.note.id] = msg.note;
        for (const c of msg.cards) {
            col.cards[c.id] = c;
        }
    } else if (msg.type === "delete_note") {
        for (const card of Object.values(col.cards)) {
            if (card.nid === msg.noteId || msg.cardIds?.includes(card.id)) {
                delete col.cards[card.id];
            }
        }
        delete col.notes[msg.noteId];
    } else if (msg.type === "update_card") {
        col.cards[msg.card.id] = msg.card;
    } else if (msg.type === "save_media") {
        col.media[msg.filename] = msg.dataUrl;
    } else if (msg.type === "import_collection") {
        Object.assign(col, msg.collection);
    }
}

export class SyncClient {
    private ws: WebSocket | null = null;
    private userId: string;
    private getToken: TokenGetter;
    private onCollectionUpdated: (col: Collection) => void;
    private onStatusChanged: (status: SyncStatus) => void;
    private onError?: (err: string) => void;
    private col: Collection;
    private revision: number = 0;
    private generation: string = "0";
    private messageQueue: Promise<void> = Promise.resolve();
    private importing = new Set<string>();
    private initialized: boolean = false;
    private hasBackup: boolean = false;
    private pendingOutboxCount: number = 0;
    private reconnectTimer: any = null;
    private status: SyncStatus = "offline";
    private disposed: boolean = false;
    /** Resolves once offline state (collection + outbox) has been fully loaded (D01). */
    private hydration: Promise<void>;
    private hydrated: boolean = false;
    /** Set when a deletion tombstone was observed: automatic re-seeding is disabled (S10). */
    private autoSeedBlocked: boolean = false;

    constructor(
        userId: string,
        getToken: TokenGetter,
        onCollectionUpdated: (col: Collection) => void,
        onStatusChanged: (status: SyncStatus) => void,
        onError?: (err: string) => void,
    ) {
        this.userId = userId;
        this.getToken = getToken;
        this.onCollectionUpdated = onCollectionUpdated;
        this.onStatusChanged = onStatusChanged;
        this.onError = onError;

        try {
            if (typeof localStorage !== "undefined") {
                localStorage.removeItem(LEGACY_STORAGE_KEY);
            }
        } catch {
            // ignore
        }

        this.col = createDefaultCollection();
        this.hydration = this.hydrateFromStorage();
    }

    private async hydrateFromStorage() {
        const loaded = await loadCollectionFromIdb(this.userId);
        const outbox = await getOutboxOps(this.userId);
        this.pendingOutboxCount = outbox.filter(isPendingOutboxEntry).length;

        if (this.disposed) {
            this.hydrated = true;
            return;
        }

        if (loaded) {
            this.col = loaded.collection;
            this.revision = loaded.revision;
            this.generation = loaded.generation ?? "0";
            this.initialized = loaded.initialized;
        }

        // Replay only pending (non-conflicted) offline ops on top of the last known state.
        for (const op of outbox) {
            if (!isPendingOutboxEntry(op)) { continue; }
            applyClientMutationLocally(this.col, op.msg);
        }
        if (loaded || outbox.length > 0) {
            this.onCollectionUpdated({ ...this.col });
        }
        this.hydrated = true;
    }

    private async ensureHydrated(): Promise<void> {
        if (!this.hydrated) {
            await this.hydration;
        }
    }

    public getCollection(): Collection {
        return this.col;
    }

    public getPendingOutboxCount(): number {
        return this.pendingOutboxCount;
    }

    public getHasServerBackup(): boolean {
        return this.hasBackup;
    }

    private async refreshPendingOutboxCount(): Promise<void> {
        const ops = await getOutboxOps(this.userId);
        this.pendingOutboxCount = ops.filter(isPendingOutboxEntry).length;
        if (!this.disposed) { this.onCollectionUpdated({ ...this.col }); }
    }

    /**
     * Conflicted operations rejected by the server (D13). These are kept persistently so the
     * user can retry or discard them instead of silently losing edits.
     */
    public async getConflictedOps(): Promise<OutboxEntry[]> {
        const ops = await getOutboxOps(this.userId);
        return ops.filter(op => (op.status ?? "pending") === "conflict");
    }

    public async retryConflictedOp(opId: string): Promise<void> {
        const entry = (await getOutboxOps(this.userId)).find(op => op.opId === opId && op.status === "conflict");
        if (!entry) { return; }
        if (entry.msg.type === "import_collection") {
            entry.msg = { ...entry.msg, expectedRevision: this.revision };
        }
        const result = await enqueueOutboxOp({ ...entry, status: "pending", error: undefined });
        if (!result.durable) {
            this.onError?.(
                "Retry is saved for this session only; keep the app open until synced.",
            );
        }
        await this.refreshPendingOutboxCount();
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            await this.drainOutbox();
        } else {
            await this.connect();
        }
    }

    public async discardConflictedOp(opId: string): Promise<void> {
        await removeOutboxOp(this.userId, opId);
        await this.refreshPendingOutboxCount();
        // Reconcile with authoritative state so any partial optimistic effect is replaced.
        this.sendDirect({ type: "init", force: true });
    }

    public saveLocalCollection(col: Collection, includeMedia: boolean = false) {
        this.col = col;
        if (!this.disposed) {
            this.onCollectionUpdated(this.col);
        }
        saveCollectionToIdb(
            this.userId,
            this.col,
            this.revision,
            this.initialized,
            includeMedia,
            this.generation,
        ).then(res => {
            if (!res.ok && res.error) {
                this.onError?.(res.error);
            }
        });
    }

    public async connect() {
        if (this.disposed) { return; }
        // Offline initialization must fully finish BEFORE connecting or processing remote
        // state, otherwise a fast server response could be applied over state that is still
        // mid-load, and hydration could then clobber it with older local data (D01 race).
        await this.ensureHydrated();
        if (this.disposed) { return; }
        if (
            this.ws
            && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
        ) {
            return;
        }
        if (this.status === "connecting") { return; }

        this.setStatus("connecting");

        try {
            const token = await this.getToken();
            if (!token || this.disposed) {
                this.setStatus("offline");
                return;
            }

            const ticketRes = await fetch("/api/ws-ticket", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
            });

            if (!ticketRes.ok) {
                throw new Error(`Ticket request failed with status ${ticketRes.status}`);
            }

            const { ticket } = (await ticketRes.json()) as { ticket?: string };
            if (!ticket || this.disposed) {
                this.setStatus("offline");
                return;
            }

            const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            const host = window.location.host;
            const wsUrl = `${protocol}//${host}/api/ws?ticket=${encodeURIComponent(ticket)}`;

            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = async () => {
                if (this.disposed) {
                    this.ws?.close();
                    return;
                }
                this.setStatus("connected");
                // Request authoritative server state and then flush any queued offline ops (D01, D08)
                this.sendDirect({
                    type: "init",
                    lastMod: this.col.mod,
                    lastRevision: this.revision,
                });
            };

            this.ws.onmessage = event => {
                if (this.disposed) { return; }
                try {
                    const msg: ServerMessage = JSON.parse(event.data);
                    this.messageQueue = this.messageQueue
                        .then(() => this.disposed ? undefined : this.handleServerMessage(msg))
                        .catch(err => this.onError?.(err instanceof Error ? err.message : "Sync failed"));
                } catch (e) {
                    console.error("Failed to parse websocket message:", e);
                }
            };

            this.ws.onclose = () => {
                if (this.disposed) { return; }
                this.setStatus("offline");
                this.scheduleReconnect();
            };

            this.ws.onerror = () => {
                if (this.disposed) { return; }
                this.setStatus("offline");
                this.ws?.close();
            };
        } catch {
            if (this.disposed) { return; }
            this.setStatus("offline");
            this.scheduleReconnect();
        }
    }

    /**
     * Force an immediate sync / reconciliation even when the WebSocket is already connected (U05).
     */
    public async syncNow(): Promise<void> {
        if (this.disposed) { return; }
        await this.ensureHydrated();
        if (this.disposed) { return; }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            await this.connect();
            return;
        }
        await this.drainOutbox();
        this.sendDirect({
            type: "init",
            lastMod: this.col.mod,
            lastRevision: this.revision,
            force: true,
        });
    }

    /**
     * Restore the server's pre-import backup snapshot (D07, U14).
     */
    public async restoreServerBackup(): Promise<boolean> {
        try {
            const token = await this.getToken();
            if (!token) { return false; }
            const res = await fetch("/api/collection/restore-backup", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ expectedRevision: this.revision }),
            });
            if (res.status === 409) {
                // Another device restored concurrently: reconcile with authoritative state.
                this.sendDirect({ type: "init", force: true });
                return false;
            }
            if (!res.ok) { return false; }
            const data = await res.json();
            if (data.collection) {
                this.revision = data.revision || this.revision + 1;
                this.initialized = true;
                this.saveLocalCollection(data.collection, true);
            }
            return true;
        } catch {
            return false;
        }
    }

    public async clearOfflineStorage(): Promise<void> {
        await clearUserOfflineData(this.userId);
        this.pendingOutboxCount = 0;
    }

    public disconnect() {
        this.disposed = true;
        // Let anyone still awaiting hydration observe disposal instead of hanging.
        this.hydrated = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.onopen = null;
                this.ws.onmessage = null;
                this.ws.onclose = null;
                this.ws.onerror = null;
                this.ws.close();
            } catch {
                // ignore
            }
            this.ws = null;
        }
    }

    private setStatus(status: SyncStatus) {
        this.status = status;
        if (!this.disposed) {
            this.onStatusChanged(status);
        }
    }

    private scheduleReconnect() {
        if (this.disposed) { return; }
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); }
        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, 3000);
    }

    private sendDirect(msg: ClientMessage) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const serialized = JSON.stringify(msg);
            if (msg.type === "import_collection" && new TextEncoder().encode(serialized).length > 512_000) {
                // Durable Object WebSocket messages have a size limit. Keep a large import
                // atomic (including its media) by using the same CAS/idempotency contract over HTTP.
                void this.sendLargeImport(msg);
            } else {
                this.ws.send(serialized);
            }
        }
    }

    private async sendLargeImport(msg: Extract<ClientMessage, { type: "import_collection" }>) {
        if (!msg.opId || this.importing.has(msg.opId)) { return; }
        this.importing.add(msg.opId);
        try {
            const token = await this.getToken();
            if (!token || this.disposed) { return; }
            const response = await fetch("/api/collection", {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...msg.collection,
                    expectedRevision: msg.expectedRevision,
                    opId: msg.opId,
                    generation: msg.generation,
                    seedOnUninitialized: msg.seedOnUninitialized,
                }),
            });
            const result = await response.json();
            if (this.disposed) { return; }
            const reply: ServerMessage = response.ok
                ? { type: "ack", opId: msg.opId, revision: result.revision }
                : {
                    type: "op_error",
                    opId: msg.opId,
                    error: result.error || "Import failed",
                    kind: response.status === 410 ? "deleted" : "conflict_revision",
                    revision: result.currentRevision,
                };
            this.messageQueue = this.messageQueue.then(() => this.handleServerMessage(reply))
                .catch(err => this.onError?.(String(err)));
            await this.messageQueue;
            if (response.ok) { this.sendDirect({ type: "init", force: true }); }
        } catch {
            this.onError?.("Import is still queued. Reconnect to finish syncing it.");
        } finally {
            this.importing.delete(msg.opId);
        }
    }

    /**
     * Shallow per-map copy of the collection for optimistic-update rollback (D01/D14).
     * Works because applyClientMutationLocally is replace-only: entity objects are swapped
     * wholesale, and `mod`-stamp maps now hold pre-mutation references.
     */
    private snapshotCollectionForRollback(): Collection {
        return {
            ...this.col,
            decks: { ...this.col.decks },
            dconf: { ...this.col.dconf },
            models: { ...this.col.models },
            notes: { ...this.col.notes },
            cards: { ...this.col.cards },
            revlog: [...(this.col.revlog || [])],
            media: { ...this.col.media },
        };
    }

    private rollbackToSnapshot(snapshot: Collection): void {
        this.saveLocalCollection(snapshot);
    }

    /**
     * Apply a mutation locally (optimistic) and enqueue it durably. If even the in-memory
     * fallback queue cannot hold the operation, the optimistic edit is rolled back so it is
     * never silently lost (D01/D14).
     */
    private applyAndQueue(msg: ClientMessage & { opId: string }) {
        if (!this.hydrated) {
            // Order matters: never mutate a collection whose offline state is still loading.
            void this.hydration.then(() => {
                if (!this.disposed) { this.applyAndQueue(msg); }
            });
            return;
        }
        const snapshot = this.snapshotCollectionForRollback();
        applyClientMutationLocally(this.col, msg);
        this.saveLocalCollection({ ...this.col });
        void this.queueAndSend(msg, snapshot);
    }

    /**
     * Persist mutation to the IndexedDB outbox first, then transmit if the WebSocket is open (D01).
     * Persistence failure is surfaced explicitly; the pending count is only incremented once the
     * write committed, so we never claim durable offline saving prematurely (D14).
     */
    private async queueAndSend(msg: ClientMessage & { opId: string }, snapshot?: Collection) {
        msg = structuredClone(msg);
        await this.ensureHydrated();
        if (this.disposed) { return; }

        msg = { ...msg, generation: this.generation };
        const entry: OutboxEntry = {
            opId: msg.opId,
            userId: this.userId,
            createdAt: Date.now(),
            msg: structuredClone(msg),
        };
        const res = await enqueueOutboxOp(entry);

        if (this.disposed) {
            if (!res.ok && snapshot) {
                // Nothing could persist locally and the socket is gone: roll the optimistic edit back.
                this.rollbackToSnapshot(snapshot);
            }
            return;
        }

        if (!res.ok) {
            if (snapshot) {
                this.rollbackToSnapshot(snapshot);
            }
            this.onError?.(
                "Your last change could not be saved offline (storage failure) and was rolled back.",
            );
            return;
        }

        if (!res.durable) {
            // The op is alive in session memory but NOT durably persisted. Make that explicit
            // instead of claiming durable offline saving (D01/D14).
            this.onError?.(
                `Offline persistence unavailable (${res.error}). The change is queued for this session only and may be lost if the app closes; reconnect and sync to flush it.`,
            );
        }

        await this.refreshPendingOutboxCount();
        this.sendDirect(entry.msg);
    }

    private async drainOutbox() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
        const ops = await getOutboxOps(this.userId);
        this.pendingOutboxCount = ops.filter(isPendingOutboxEntry).length;
        for (const op of ops) {
            if (!isPendingOutboxEntry(op)) { continue; }
            if (this.ws.readyState === WebSocket.OPEN) {
                this.sendDirect(op.msg);
            }
        }
    }

    private async handleServerMessage(msg: ServerMessage) {
        if (msg.type === "ack") {
            this.revision = Math.max(this.revision, msg.revision);
            this.initialized = true;
            await removeOutboxOp(this.userId, msg.opId);
            await this.refreshPendingOutboxCount();
            return;
        }

        if (msg.type === "op_error") {
            await this.handleOpError(msg);
            return;
        }

        if (msg.type === "full_state") {
            const serverGeneration = msg.generation ?? "0";
            if (serverGeneration !== this.generation) {
                await this.clearOfflineStorage();
                this.col = createDefaultCollection();
                this.generation = serverGeneration;
                this.autoSeedBlocked = Boolean(msg.deleted);
            }
            this.hasBackup = Boolean(msg.hasBackup);

            // S10: the account's data was deleted on some device and a tombstone is active.
            // Drop the offline copy and block automatic re-seeding so deleted data cannot be
            // resurrected by this device.
            if (msg.deleted && !msg.initialized) {
                await this.handleDeletedCollection(msg.revision ?? 0);
                return;
            }

            // Use explicit server `initialized` flag, never a card/deck count heuristic (D02)
            if (msg.initialized) {
                this.revision = msg.revision || 0;
                this.initialized = true;

                // Re-apply any unacknowledged PENDING offline outbox operations on top of the
                // server base state (D01, D08). Conflicted ops are excluded until resolved.
                const pendingOps = (await getOutboxOps(this.userId)).filter(isPendingOutboxEntry);
                const mergedCol: Collection = {
                    ...msg.collection,
                    decks: { ...(msg.collection.decks || {}) },
                    dconf: { ...(msg.collection.dconf || {}) },
                    models: { ...(msg.collection.models || {}) },
                    notes: { ...(msg.collection.notes || {}) },
                    cards: { ...(msg.collection.cards || {}) },
                    revlog: [...(msg.collection.revlog || [])],
                    media: { ...this.col.media, ...(msg.collection.media || {}) },
                };
                for (const op of pendingOps) {
                    applyClientMutationLocally(mergedCol, op.msg);
                }
                this.saveLocalCollection(mergedCol, true);
                await this.drainOutbox();
            } else {
                if (msg.deleted || this.autoSeedBlocked) {
                    // Tombstone active: refuse to seed the freed server from local data (S10).
                    await this.handleDeletedCollection(msg.revision ?? 0);
                    return;
                }

                // Server Durable Object is genuinely brand-new and uninitialized: seed it once,
                // version-anchored to an empty server revision (D02) and flagged as an automatic
                // seed so the server can refuse it if the collection was deleted meanwhile (S10).
                this.initialized = true;
                await this.queueAndSend({
                    type: "import_collection",
                    opId: makeOpId(),
                    seedOnUninitialized: true,
                    expectedRevision: 0,
                    collection: this.col,
                });
            }
            return;
        }

        if ("revision" in msg && typeof msg.revision === "number") {
            this.revision = Math.max(this.revision, msg.revision);
        }

        if (msg.type === "answer_card") {
            const card = this.col.cards[msg.cardId];
            if (card) {
                this.col.cards[msg.cardId] = {
                    ...card,
                    ...msg.nextState,
                    mod: Math.floor(Date.now() / 1000),
                };
            }
            if (!this.col.revlog.some(r => r.id === msg.revlogEntry.id)) {
                this.col.revlog.push(msg.revlogEntry);
            }
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "upsert_deck") {
            this.col.decks[msg.deck.id] = msg.deck;
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "delete_deck") {
            const deckIds = msg.deletedDeckIds || [msg.deckId];
            for (const did of deckIds) {
                if (did !== 1) { delete this.col.decks[did]; }
            }
            if (msg.deletedCardIds) {
                for (const cid of msg.deletedCardIds) {
                    delete this.col.cards[cid];
                }
            } else {
                for (const card of Object.values(this.col.cards)) {
                    if (deckIds.includes(card.did)) {
                        delete this.col.cards[card.id];
                    }
                }
            }
            if (msg.deletedNoteIds) {
                for (const nid of msg.deletedNoteIds) {
                    delete this.col.notes[nid];
                }
            }
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "upsert_deck_config") {
            this.col.dconf[msg.dconf.id] = msg.dconf;
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "upsert_note") {
            this.col.notes[msg.note.id] = msg.note;
            for (const card of msg.cards) {
                this.col.cards[card.id] = card;
            }
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "delete_note") {
            delete this.col.notes[msg.noteId];
            for (const cid of msg.cardIds || []) {
                delete this.col.cards[cid];
            }
            for (const c of Object.values(this.col.cards)) {
                if (c.nid === msg.noteId) {
                    delete this.col.cards[c.id];
                }
            }
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "update_card") {
            this.col.cards[msg.card.id] = msg.card;
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "save_media") {
            this.col.media[msg.filename] = msg.dataUrl;
            saveMediaItemToIdb(this.userId, msg.filename, msg.dataUrl);
            this.onCollectionUpdated({ ...this.col });
            return;
        }

        if (msg.type === "import_collection") {
            this.hasBackup = true;
            this.saveLocalCollection(msg.collection, true);
            return;
        }
    }

    private async handleDeletedCollection(revision: number): Promise<void> {
        await this.clearOfflineStorage();
        this.col = createDefaultCollection();
        this.revision = revision;
        this.initialized = false;
        this.autoSeedBlocked = true;
        this.saveLocalCollection(this.col, true);
        this.onError?.("This account's cloud data was deleted elsewhere. Your offline copy was cleared.");
    }

    /**
     * Server rejected a queued operation (D13). Park it in the persistent conflict queue
     * (retry/discard from Settings) and reconcile local state with the authoritative server.
     */
    private async handleOpError(msg: Extract<ServerMessage, { type: "op_error" }>) {
        const kind = msg.kind || "internal";
        const rawError = msg.error || "The server rejected this change.";

        if (kind === "deleted") {
            await this.handleDeletedCollection(msg.revision ?? 0);
            this.sendDirect({ type: "init", force: true });
            return;
        }

        try {
            if (msg.opId) {
                await updateOutboxOpStatus(this.userId, msg.opId, "conflict", rawError);
                await this.refreshPendingOutboxCount();
            }
            this.onError?.(userMessageForOpError(kind, rawError));
        } finally {
            this.sendDirect({ type: "init", force: true });
        }
    }

    // Client mutation actions (optimistic local update + persistent IndexedDB outbox)
    public answerCard(cardId: number, nextState: Partial<Card>, revlogEntry: RevlogEntry) {
        const opId = makeOpId();
        const msg: ClientMessage & { opId: string } = {
            type: "answer_card",
            opId,
            cardId,
            nextState,
            revlogEntry,
        };
        this.applyAndQueue(msg);
    }

    public upsertDeck(deck: Deck, isNew: boolean = false) {
        const opId = makeOpId();
        const msg: ClientMessage & { opId: string } = { type: "upsert_deck", opId, deck, isNew };
        this.applyAndQueue(msg);
    }

    public deleteDeck(deckId: number) {
        const opId = makeOpId();
        const msg: ClientMessage & { opId: string } = { type: "delete_deck", opId, deckId };
        this.applyAndQueue(msg);
    }

    public upsertDeckConfig(dconf: DeckConfig) {
        const opId = makeOpId();
        const msg: ClientMessage & { opId: string } = { type: "upsert_deck_config", opId, dconf };
        this.applyAndQueue(msg);
    }

    public upsertNote(note: Note, cards: Card[], isNew: boolean = false) {
        const opId = makeOpId();
        const msg: ClientMessage & { opId: string } = { type: "upsert_note", opId, note, cards, isNew };
        this.applyAndQueue(msg);
    }

    public deleteNote(noteId: number) {
        const cardIds: number[] = [];
        for (const card of Object.values(this.col.cards)) {
            if (card.nid === noteId) {
                cardIds.push(card.id);
            }
        }
        const opId = makeOpId();
        const msg: ClientMessage & { opId: string } = { type: "delete_note", opId, noteId, cardIds };
        this.applyAndQueue(msg);
    }

    public updateCard(card: Card) {
        const opId = makeOpId();
        const msg: ClientMessage & { opId: string } = { type: "update_card", opId, card };
        this.applyAndQueue(msg);
    }

    public saveMedia(filename: string, dataUrl: string) {
        this.applyAndQueue({ type: "save_media", opId: makeOpId(), filename, dataUrl });
    }

    public importCollection(col: Collection) {
        const imported = structuredClone(col);
        void this.hydration.then(() => {
            if (this.disposed) { return; }
            this.hasBackup = true;
            this.autoSeedBlocked = false;
            this.applyAndQueue({
                type: "import_collection",
                opId: makeOpId(),
                expectedRevision: this.revision,
                collection: imported,
            });
        });
    }
}
