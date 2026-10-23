import { Collection, Card, Note, Deck, DeckConfig, RevlogEntry } from "./types";
import { ClientMessage, ServerMessage } from "../../server/types";
import { createDefaultCollection } from "./default-data";
import {
  clearUserOfflineData,
  enqueueOutboxOp,
  getOutboxOps,
  loadCollectionFromIdb,
  OutboxEntry,
  removeOutboxOp,
  saveCollectionToIdb,
  saveMediaItemToIdb
} from "./idb-storage";
import { generateUniqueId } from "./ids";

const LEGACY_STORAGE_KEY = "anki_web_collection_v1";

export type SyncStatus = "connected" | "connecting" | "offline";
export type TokenGetter = () => Promise<string | null>;

function makeOpId(): string {
  return `op_${generateUniqueId()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Apply a queued ClientMessage locally onto a Collection snapshot (for deterministic offline outbox replay D01, D08).
 */
export function applyClientMutationLocally(col: Collection, msg: ClientMessage): void {
  if (msg.type === "answer_card") {
    const card = col.cards[msg.cardId];
    if (card) {
      Object.assign(card, msg.nextState, { mod: Math.floor(Date.now() / 1000) });
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
        if (d.name.startsWith(prefix)) deckIdsToDelete.add(d.id);
      }
    }
    for (const did of deckIdsToDelete) {
      if (did !== 1) delete col.decks[did];
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
  private initialized: boolean = false;
  private hasBackup: boolean = false;
  private pendingOutboxCount: number = 0;
  private reconnectTimer: any = null;
  private status: SyncStatus = "offline";
  private disposed: boolean = false;

  constructor(
    userId: string,
    getToken: TokenGetter,
    onCollectionUpdated: (col: Collection) => void,
    onStatusChanged: (status: SyncStatus) => void,
    onError?: (err: string) => void
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
    this.hydrateFromStorage();
  }

  private async hydrateFromStorage() {
    const loaded = await loadCollectionFromIdb(this.userId);
    const outbox = await getOutboxOps(this.userId);
    this.pendingOutboxCount = outbox.length;

    if (loaded && !this.disposed) {
      this.col = loaded.collection;
      this.revision = loaded.revision;
      this.initialized = loaded.initialized;
      for (const op of outbox) {
        applyClientMutationLocally(this.col, op.msg);
      }
      this.onCollectionUpdated({ ...this.col });
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
      includeMedia
    ).then(res => {
      if (!res.ok && res.error) {
        this.onError?.(res.error);
      }
    });
  }

  public async connect() {
    if (this.disposed) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

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
          "Content-Type": "application/json"
        }
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
          lastRevision: this.revision
        });
      };

      this.ws.onmessage = event => {
        if (this.disposed) return;
        try {
          const msg: ServerMessage = JSON.parse(event.data);
          this.handleServerMessage(msg);
        } catch (e) {
          console.error("Failed to parse websocket message:", e);
        }
      };

      this.ws.onclose = () => {
        if (this.disposed) return;
        this.setStatus("offline");
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        if (this.disposed) return;
        this.setStatus("offline");
        this.ws?.close();
      };
    } catch {
      if (this.disposed) return;
      this.setStatus("offline");
      this.scheduleReconnect();
    }
  }

  /**
   * Force an immediate sync / reconciliation even when the WebSocket is already connected (U05).
   */
  public async syncNow(): Promise<void> {
    if (this.disposed) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
      return;
    }
    await this.drainOutbox();
    this.sendDirect({
      type: "init",
      lastMod: this.col.mod,
      lastRevision: this.revision,
      force: true
    });
  }

  /**
   * Restore the server's pre-import backup snapshot (D07, U14).
   */
  public async restoreServerBackup(): Promise<boolean> {
    try {
      const token = await this.getToken();
      if (!token) return false;
      const res = await fetch("/api/collection/restore-backup", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      });
      if (!res.ok) return false;
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
    if (this.disposed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 3000);
  }

  private sendDirect(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Persist mutation to IndexedDB outbox first, then transmit if WebSocket is open (D01).
   */
  private async queueAndSend(msg: ClientMessage & { opId: string }) {
    const entry: OutboxEntry = {
      opId: msg.opId,
      userId: this.userId,
      createdAt: Date.now(),
      msg
    };
    this.pendingOutboxCount++;
    await enqueueOutboxOp(entry);
    this.sendDirect(msg);
  }

  private async drainOutbox() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const ops = await getOutboxOps(this.userId);
    this.pendingOutboxCount = ops.length;
    for (const op of ops) {
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
      const remaining = await getOutboxOps(this.userId);
      this.pendingOutboxCount = remaining.length;
      return;
    }

    if (msg.type === "op_error") {
      if (msg.opId) {
        await removeOutboxOp(this.userId, msg.opId);
      }
      this.onError?.(msg.error);
      return;
    }

    if (msg.type === "full_state") {
      this.hasBackup = Boolean(msg.hasBackup);
      // Use explicit server `initialized` flag, never a card/deck count heuristic (D02)
      if (msg.initialized) {
        this.revision = msg.revision || 0;
        this.initialized = true;

        // Re-apply any unacknowledged offline outbox operations on top of the server base state (D01, D08)
        const pendingOps = await getOutboxOps(this.userId);
        const mergedCol: Collection = {
          ...msg.collection,
          decks: { ...(msg.collection.decks || {}) },
          dconf: { ...(msg.collection.dconf || {}) },
          models: { ...(msg.collection.models || {}) },
          notes: { ...(msg.collection.notes || {}) },
          cards: { ...(msg.collection.cards || {}) },
          revlog: [...(msg.collection.revlog || [])],
          media: { ...this.col.media, ...(msg.collection.media || {}) }
        };
        for (const op of pendingOps) {
          applyClientMutationLocally(mergedCol, op.msg);
        }
        this.saveLocalCollection(mergedCol, true);
        await this.drainOutbox();
      } else {
        // Server Durable Object is genuinely brand-new and uninitialized: seed it once
        this.initialized = true;
        const opId = makeOpId();
        await this.queueAndSend({
          type: "import_collection",
          opId,
          collection: this.col
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
        Object.assign(card, msg.nextState, { mod: Math.floor(Date.now() / 1000) });
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
        if (did !== 1) delete this.col.decks[did];
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

  // Client mutation actions (optimistic local update + persistent IndexedDB outbox)
  public answerCard(cardId: number, nextState: Partial<Card>, revlogEntry: RevlogEntry) {
    const opId = makeOpId();
    const msg: ClientMessage & { opId: string } = {
      type: "answer_card",
      opId,
      cardId,
      nextState,
      revlogEntry
    };
    applyClientMutationLocally(this.col, msg);
    this.saveLocalCollection({ ...this.col });
    this.queueAndSend(msg);
  }

  public upsertDeck(deck: Deck) {
    const opId = makeOpId();
    const msg: ClientMessage & { opId: string } = { type: "upsert_deck", opId, deck };
    applyClientMutationLocally(this.col, msg);
    this.saveLocalCollection({ ...this.col });
    this.queueAndSend(msg);
  }

  public deleteDeck(deckId: number) {
    const opId = makeOpId();
    const msg: ClientMessage & { opId: string } = { type: "delete_deck", opId, deckId };
    applyClientMutationLocally(this.col, msg);
    this.saveLocalCollection({ ...this.col });
    this.queueAndSend(msg);
  }

  public upsertDeckConfig(dconf: DeckConfig) {
    const opId = makeOpId();
    const msg: ClientMessage & { opId: string } = { type: "upsert_deck_config", opId, dconf };
    applyClientMutationLocally(this.col, msg);
    this.saveLocalCollection({ ...this.col });
    this.queueAndSend(msg);
  }

  public upsertNote(note: Note, cards: Card[]) {
    const opId = makeOpId();
    const msg: ClientMessage & { opId: string } = { type: "upsert_note", opId, note, cards };
    applyClientMutationLocally(this.col, msg);
    this.saveLocalCollection({ ...this.col });
    this.queueAndSend(msg);
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
    applyClientMutationLocally(this.col, msg);
    this.saveLocalCollection({ ...this.col });
    this.queueAndSend(msg);
  }

  public updateCard(card: Card) {
    const opId = makeOpId();
    const msg: ClientMessage & { opId: string } = { type: "update_card", opId, card };
    applyClientMutationLocally(this.col, msg);
    this.saveLocalCollection({ ...this.col });
    this.queueAndSend(msg);
  }

  public saveMedia(filename: string, dataUrl: string) {
    const opId = makeOpId();
    this.col.media[filename] = dataUrl;
    saveMediaItemToIdb(this.userId, filename, dataUrl);
    this.onCollectionUpdated({ ...this.col });
    this.queueAndSend({ type: "save_media", opId, filename, dataUrl });
  }

  public importCollection(col: Collection) {
    const opId = makeOpId();
    this.hasBackup = true;
    this.saveLocalCollection(col, true);
    // Separate large base64 media into individual save_media messages if total media > 512 KB
    const mediaEntries = Object.entries(col.media || {});
    const totalMediaChars = mediaEntries.reduce((sum, [, val]) => sum + val.length, 0);

    if (totalMediaChars > 512_000) {
      const colWithoutInlineMedia: Collection = { ...col, media: {} };
      this.queueAndSend({
        type: "import_collection",
        opId,
        collection: colWithoutInlineMedia
      });
      for (const [filename, dataUrl] of mediaEntries) {
        this.queueAndSend({
          type: "save_media",
          opId: makeOpId(),
          filename,
          dataUrl
        });
      }
    } else {
      this.queueAndSend({ type: "import_collection", opId, collection: col });
    }
  }
}
