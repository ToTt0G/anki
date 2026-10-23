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

/**
 * Exponential backoff with random jitter (0–30%) for WebSocket reconnects (PERF-05).
 */
export function computeReconnectDelayMs(
    attempt: number,
    randomFn: () => number = Math.random,
): number {
    const safeAttempt = Math.max(0, Math.min(attempt, 5));
    const baseMs = Math.min(30_000, 1_000 * Math.pow(2, safeAttempt));
    const jitterMs = Math.floor(baseMs * 0.3 * Math.max(0, Math.min(1, randomFn())));
    return baseMs + jitterMs;
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

function cloneCollection(col: Collection): Collection {
    return {
        ...col,
        decks: { ...(col.decks || {}) },
        dconf: { ...(col.dconf || {}) },
        models: { ...(col.models || {}) },
        notes: { ...(col.notes || {}) },
        cards: { ...(col.cards || {}) },
        revlog: [...(col.revlog || [])],
        media: { ...(col.media || {}) },
    };
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
        // UX-01: When renaming a parent deck, also rename any `Parent::Child` subdecks
        const existing = col.decks[msg.deck.id];
        if (existing && existing.name && existing.name !== msg.deck.name) {
            const oldPrefix = `${existing.name}::`;
            const newPrefix = `${msg.deck.name}::`;
            const nowSec = Math.floor(Date.now() / 1000);
            for (const d of Object.values(col.decks)) {
                if (d.id !== msg.deck.id && d.name.startsWith(oldPrefix)) {
                    col.decks[d.id] = {
                        ...d,
                        name: `${newPrefix}${d.name.slice(oldPrefix.length)}`,
                        mod: nowSec,
                    };
                }
            }
        }
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
        // DATA-02: Only delete cards whose authoritative `nid` matches `msg.noteId`
        for (const card of Object.values(col.cards)) {
            if (card.nid === msg.noteId) {
                delete col.cards[card.id];
            }
        }
        delete col.notes[msg.noteId];
    } else if (msg.type === "update_card") {
        col.cards[msg.card.id] = msg.card;
    } else if (msg.type === "save_media") {
        col.media[msg.filename] = msg.dataUrl;
    } else if (msg.type === "import_collection") {
        col.id = msg.collection.id ?? col.id;
        col.crt = msg.collection.crt ?? col.crt;
        col.mod = msg.collection.mod ?? col.mod;
        col.decks = { ...(msg.collection.decks || {}) };
        col.dconf = { ...(msg.collection.dconf || {}) };
        col.models = { ...(msg.collection.models || {}) };
        col.notes = { ...(msg.collection.notes || {}) };
        col.cards = { ...(msg.collection.cards || {}) };
        col.revlog = [...(msg.collection.revlog || [])];
        col.media = { ...(msg.collection.media || {}) };
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
    /** Last authoritative server/hydrated base collection before unacknowledged optimistic ops (DATA-06). */
    private serverBaseCol: Collection;
    private revision: number = 0;
    private generation: string = "0";
    private messageQueue: Promise<void> = Promise.resolve();
    private importing = new Set<string>();
    private initialized: boolean = false;
    private hasBackup: boolean = false;
    private pendingOutboxCount: number = 0;
    private reconnectTimer: any = null;
    private reconnectAttempts: number = 0;
    private onlineHandler: (() => void) | null = null;
    private status: SyncStatus = "offline";
    private disposed: boolean = false;
    /** Resolves once offline state (collection + outbox) has been fully loaded (D01). */
    private hydration: Promise<void>;
    private hydrated: boolean = false;
    /** Set when a deletion tombstone was observed: automatic re-seeding is disabled (S10). */
    private autoSeedBlocked: boolean = false;
    /** Duplicate-submit guard for rapid card answers (UX-09). */
    private lastAnswerGuard: { key: string; at: number } | null = null;

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

        const initial = createDefaultCollection();
        this.col = initial;
        this.serverBaseCol = cloneCollection(initial);
        this.hydration = this.hydrateFromStorage();

        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            this.onlineHandler = () => {
                if (!this.disposed && this.status === "offline") {
                    this.reconnectAttempts = 0;
                    void this.connect();
                }
            };
            window.addEventListener("online", this.onlineHandler);
        }
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
            this.col = cloneCollection(loaded.collection);
            this.serverBaseCol = cloneCollection(loaded.collection);
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

    public async retryConflictedOp(opId: string, forceOverwrite: boolean = true): Promise<void> {
        const entry = (await getOutboxOps(this.userId)).find(op => op.opId === opId && op.status === "conflict");
        if (!entry) { return; }
        if (entry.msg.type === "import_collection") {
            entry.msg = {
                ...entry.msg,
                expectedRevision: this.revision,
                forceOverwrite,
            };
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
        await this.reconcileLocalFromBase();
        await this.refreshPendingOutboxCount();
        this.sendDirect({ type: "init", force: true });
    }

    /**
     * Rebuild `this.col` from `this.serverBaseCol` plus only pending (non-conflicted)
     * outbox operations so rejected optimistic mutations are immediately rolled back (DATA-06).
     */
    private async reconcileLocalFromBase(): Promise<void> {
        const pendingOps = (await getOutboxOps(this.userId)).filter(isPendingOutboxEntry);
        const rebuilt = cloneCollection(this.serverBaseCol);
        for (const op of pendingOps) {
            applyClientMutationLocally(rebuilt, op.msg);
        }
        this.saveLocalCollection(rebuilt, true);
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
                this.reconnectAttempts = 0;
                this.setStatus("connected");
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
     * Restore the server's pre-import backup snapshot (D07, U14, DATA-10).
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
                this.sendDirect({ type: "init", force: true });
                return false;
            }
            if (!res.ok) { return false; }
            const data = await res.json();
            if (data.collection) {
                this.revision = data.revision || this.revision + 1;
                this.initialized = true;
                this.serverBaseCol = cloneCollection(data.collection);
                this.saveLocalCollection(data.collection, true);
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Clear offline storage on this device. Refuses by default when unsynced outbox operations
     * are pending unless `forceDiscardPending: true` is explicitly passed (DATA-05).
     */
    public async clearOfflineStorage(options?: { forceDiscardPending?: boolean }): Promise<void> {
        if (!options?.forceDiscardPending) {
            const ops = await getOutboxOps(this.userId);
            const pendingCount = ops.filter(isPendingOutboxEntry).length;
            if (pendingCount > 0) {
                throw new Error(
                    `Cannot clear offline cache while ${pendingCount} unsynced ${
                        pendingCount === 1 ? "change is" : "changes are"
                    } pending without confirmation.`,
                );
            }
        }
        await clearUserOfflineData(this.userId);
        this.pendingOutboxCount = 0;
    }

    public disconnect() {
        this.disposed = true;
        this.hydrated = true;
        if (this.onlineHandler && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
            window.removeEventListener("online", this.onlineHandler);
            this.onlineHandler = null;
        }
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
        const delayMs = computeReconnectDelayMs(this.reconnectAttempts++);
        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delayMs);
    }

    private sendDirect(msg: ClientMessage) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const serialized = JSON.stringify(msg);
            if (msg.type === "import_collection" && new TextEncoder().encode(serialized).length > 512_000) {
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
                    forceOverwrite: msg.forceOverwrite,
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

    private snapshotCollectionForRollback(): Collection {
        return cloneCollection(this.col);
    }

    private rollbackToSnapshot(snapshot: Collection): void {
        this.saveLocalCollection(snapshot);
    }

    private applyAndQueue(msg: ClientMessage & { opId: string }) {
        if (!this.hydrated) {
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
            const allOps = await getOutboxOps(this.userId);
            const ackedOp = allOps.find(o => o.opId === msg.opId);
            if (ackedOp) {
                applyClientMutationLocally(this.serverBaseCol, ackedOp.msg);
            }
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
                await this.clearOfflineStorage({ forceDiscardPending: true });
                const fresh = createDefaultCollection();
                this.col = fresh;
                this.serverBaseCol = cloneCollection(fresh);
                this.generation = serverGeneration;
                this.autoSeedBlocked = Boolean(msg.deleted);
            }
            this.hasBackup = Boolean(msg.hasBackup);

            if (msg.deleted && !msg.initialized) {
                await this.handleDeletedCollection(msg.revision ?? 0);
                return;
            }

            if (msg.initialized) {
                this.revision = msg.revision || 0;
                this.initialized = true;
                this.serverBaseCol = cloneCollection(msg.collection);

                // Re-apply only unacknowledged PENDING offline outbox operations on top of the
                // authoritative server base state (DATA-06). Conflicted ops are excluded.
                const pendingOps = (await getOutboxOps(this.userId)).filter(isPendingOutboxEntry);
                const mergedCol = cloneCollection(msg.collection);
                for (const op of pendingOps) {
                    applyClientMutationLocally(mergedCol, op.msg);
                }
                this.saveLocalCollection(mergedCol, true);
                await this.drainOutbox();
            } else {
                if (msg.deleted || this.autoSeedBlocked) {
                    await this.handleDeletedCollection(msg.revision ?? 0);
                    return;
                }

                // DATA-06: Before auto-seeding an uninitialized server, rebuild from
                // `serverBaseCol` + pending (non-conflicted) ops so any rejected op is excluded.
                const allOps = await getOutboxOps(this.userId);
                const hasConflicts = allOps.some(op => (op.status ?? "pending") === "conflict");
                if (hasConflicts) {
                    await this.reconcileLocalFromBase();
                    return;
                }

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
            const applyAnswer = (target: Collection) => {
                const card = target.cards[msg.cardId];
                if (card) {
                    target.cards[msg.cardId] = {
                        ...card,
                        ...msg.nextState,
                        mod: Math.floor(Date.now() / 1000),
                    };
                }
                if (!target.revlog.some(r => r.id === msg.revlogEntry.id)) {
                    target.revlog.push(msg.revlogEntry);
                }
            };
            applyAnswer(this.serverBaseCol);
            applyAnswer(this.col);
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "upsert_deck") {
            this.serverBaseCol.decks[msg.deck.id] = msg.deck;
            this.col.decks[msg.deck.id] = msg.deck;
            if (msg.renamedSubdecks) {
                for (const sub of msg.renamedSubdecks) {
                    this.serverBaseCol.decks[sub.id] = sub;
                    this.col.decks[sub.id] = sub;
                }
            }
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "delete_deck") {
            const applyDeleteDeck = (target: Collection) => {
                const deckIds = msg.deletedDeckIds || [msg.deckId];
                for (const did of deckIds) {
                    if (did !== 1) { delete target.decks[did]; }
                }
                if (msg.deletedCardIds) {
                    for (const cid of msg.deletedCardIds) {
                        delete target.cards[cid];
                    }
                } else {
                    for (const card of Object.values(target.cards)) {
                        if (deckIds.includes(card.did)) {
                            delete target.cards[card.id];
                        }
                    }
                }
                if (msg.deletedNoteIds) {
                    for (const nid of msg.deletedNoteIds) {
                        delete target.notes[nid];
                    }
                }
            };
            applyDeleteDeck(this.serverBaseCol);
            applyDeleteDeck(this.col);
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "upsert_deck_config") {
            this.serverBaseCol.dconf[msg.dconf.id] = msg.dconf;
            this.col.dconf[msg.dconf.id] = msg.dconf;
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "upsert_note") {
            this.serverBaseCol.notes[msg.note.id] = msg.note;
            this.col.notes[msg.note.id] = msg.note;
            for (const card of msg.cards) {
                this.serverBaseCol.cards[card.id] = card;
                this.col.cards[card.id] = card;
            }
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "delete_note") {
            const applyDeleteNote = (target: Collection) => {
                delete target.notes[msg.noteId];
                for (const cid of msg.cardIds || []) {
                    delete target.cards[cid];
                }
                for (const c of Object.values(target.cards)) {
                    if (c.nid === msg.noteId) {
                        delete target.cards[c.id];
                    }
                }
            };
            applyDeleteNote(this.serverBaseCol);
            applyDeleteNote(this.col);
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "update_card") {
            this.serverBaseCol.cards[msg.card.id] = msg.card;
            this.col.cards[msg.card.id] = msg.card;
            this.saveLocalCollection({ ...this.col });
            return;
        }

        if (msg.type === "save_media") {
            this.serverBaseCol.media[msg.filename] = msg.dataUrl;
            this.col.media[msg.filename] = msg.dataUrl;
            saveMediaItemToIdb(this.userId, msg.filename, msg.dataUrl);
            this.onCollectionUpdated({ ...this.col });
            return;
        }

        if (msg.type === "import_collection") {
            this.hasBackup = true;
            this.serverBaseCol = cloneCollection(msg.collection);
            this.saveLocalCollection(msg.collection, true);
            return;
        }
    }

    private async handleDeletedCollection(revision: number): Promise<void> {
        await this.clearOfflineStorage({ forceDiscardPending: true });
        const fresh = createDefaultCollection();
        this.col = fresh;
        this.serverBaseCol = cloneCollection(fresh);
        this.revision = revision;
        this.initialized = false;
        this.autoSeedBlocked = true;
        this.saveLocalCollection(this.col, true);
        this.onError?.("This account's cloud data was deleted elsewhere. Your offline copy was cleared.");
    }

    /**
     * Server rejected a queued operation (DATA-06, D13). Park it in the persistent conflict queue,
     * immediately roll back optimistic state to `serverBaseCol` + remaining pending ops, and
     * request an authoritative `init` snapshot from the server.
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
                await this.reconcileLocalFromBase();
                await this.refreshPendingOutboxCount();
            }
            this.onError?.(userMessageForOpError(kind, rawError));
        } finally {
            this.sendDirect({ type: "init", force: true });
        }
    }

    // Client mutation actions (optimistic local update + persistent IndexedDB outbox)
    public answerCard(cardId: number, nextState: Partial<Card>, revlogEntry: RevlogEntry) {
        // UX-09: Guard against rapid duplicate answers for the exact same card turn
        const now = Date.now();
        const guardKey = `${cardId}:${revlogEntry.lastIvl}:${nextState.reps ?? ""}`;
        if (this.lastAnswerGuard && this.lastAnswerGuard.key === guardKey && now - this.lastAnswerGuard.at < 400) {
            return;
        }
        this.lastAnswerGuard = { key: guardKey, at: now };

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

    public importCollection(col: Collection, forceOverwrite?: boolean) {
        const imported = structuredClone(col);
        void this.hydration.then(() => {
            if (this.disposed) { return; }
            this.hasBackup = true;
            this.autoSeedBlocked = false;
            this.applyAndQueue({
                type: "import_collection",
                opId: makeOpId(),
                expectedRevision: this.revision,
                forceOverwrite,
                collection: imported,
            });
        });
    }
}
