import { Collection, Card, Note, Deck, DeckConfig, RevlogEntry } from "./types";
import { ClientMessage, ServerMessage } from "../../server/types";
import { createDefaultCollection } from "./default-data";

const LEGACY_STORAGE_KEY = "anki_web_collection_v1";
const USER_STORAGE_PREFIX = "anki_web_collection_v2_";

export type SyncStatus = "connected" | "connecting" | "offline";
export type TokenGetter = () => Promise<string | null>;

export class SyncClient {
  private ws: WebSocket | null = null;
  private userId: string;
  private getToken: TokenGetter;
  private onCollectionUpdated: (col: Collection) => void;
  private onStatusChanged: (status: SyncStatus) => void;
  private col: Collection;
  private reconnectTimer: any = null;
  private status: SyncStatus = "offline";
  private disposed: boolean = false;

  constructor(
    userId: string,
    getToken: TokenGetter,
    onCollectionUpdated: (col: Collection) => void,
    onStatusChanged: (status: SyncStatus) => void
  ) {
    this.userId = userId;
    this.getToken = getToken;
    this.onCollectionUpdated = onCollectionUpdated;
    this.onStatusChanged = onStatusChanged;

    // Remove legacy unauthenticated storage key so shared data never leaks across users
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // ignore
    }

    this.col = this.loadLocalCollection();
  }

  private getStorageKey(): string {
    return `${USER_STORAGE_PREFIX}${this.userId}`;
  }

  public getCollection(): Collection {
    return this.col;
  }

  private loadLocalCollection(): Collection {
    try {
      const saved = localStorage.getItem(this.getStorageKey());
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn("Failed to load user local storage collection:", e);
    }
    const def = createDefaultCollection();
    this.saveLocalCollection(def);
    return def;
  }

  public saveLocalCollection(col: Collection) {
    this.col = col;
    try {
      localStorage.setItem(this.getStorageKey(), JSON.stringify(col));
    } catch (e) {
      console.warn("Failed to save user local storage collection:", e);
    }
    if (!this.disposed) {
      this.onCollectionUpdated(this.col);
    }
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

      this.ws.onopen = () => {
        if (this.disposed) {
          this.ws?.close();
          return;
        }
        this.setStatus("connected");
        this.send({ type: "init", lastMod: this.col.mod });
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
    } catch (e) {
      if (this.disposed) return;
      this.setStatus("offline");
      this.scheduleReconnect();
    }
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

  private send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleServerMessage(msg: ServerMessage) {
    if (msg.type === "full_state") {
      const serverDeckCount = Object.keys(msg.collection.decks || {}).length;
      const serverCardCount = Object.keys(msg.collection.cards || {}).length;

      if (serverDeckCount > 0 && serverCardCount > 0) {
        this.saveLocalCollection(msg.collection);
      } else {
        // If this user's Durable Object is brand new and empty, seed it with their local collection
        this.send({ type: "import_collection", collection: this.col });
      }
      return;
    }

    if (msg.type === "answer_card") {
      const card = this.col.cards[msg.cardId];
      if (card) {
        Object.assign(card, msg.nextState, { mod: Math.floor(Date.now() / 1000) });
      }
      this.col.revlog.push(msg.revlogEntry);
      this.saveLocalCollection({ ...this.col });
      return;
    }

    if (msg.type === "upsert_deck") {
      this.col.decks[msg.deck.id] = msg.deck;
      this.saveLocalCollection({ ...this.col });
      return;
    }

    if (msg.type === "delete_deck") {
      delete this.col.decks[msg.deckId];
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
      for (const cid of msg.cardIds) {
        delete this.col.cards[cid];
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
      this.saveLocalCollection({ ...this.col });
      return;
    }

    if (msg.type === "import_collection") {
      this.saveLocalCollection(msg.collection);
      return;
    }
  }

  // Client mutation actions
  public answerCard(cardId: number, nextState: Partial<Card>, revlogEntry: RevlogEntry) {
    const card = this.col.cards[cardId];
    if (card) {
      Object.assign(card, nextState, { mod: Math.floor(Date.now() / 1000) });
    }
    this.col.revlog.push(revlogEntry);
    this.saveLocalCollection({ ...this.col });
    this.send({ type: "answer_card", cardId, nextState, revlogEntry });
  }

  public upsertDeck(deck: Deck) {
    this.col.decks[deck.id] = deck;
    this.saveLocalCollection({ ...this.col });
    this.send({ type: "upsert_deck", deck });
  }

  public deleteDeck(deckId: number) {
    delete this.col.decks[deckId];
    for (const card of Object.values(this.col.cards)) {
      if (card.did === deckId) {
        delete this.col.cards[card.id];
      }
    }
    this.saveLocalCollection({ ...this.col });
    this.send({ type: "delete_deck", deckId });
  }

  public upsertDeckConfig(dconf: DeckConfig) {
    this.col.dconf[dconf.id] = dconf;
    this.saveLocalCollection({ ...this.col });
    this.send({ type: "upsert_deck_config", dconf });
  }

  public upsertNote(note: Note, cards: Card[]) {
    this.col.notes[note.id] = note;
    for (const c of cards) {
      this.col.cards[c.id] = c;
    }
    this.saveLocalCollection({ ...this.col });
    this.send({ type: "upsert_note", note, cards });
  }

  public deleteNote(noteId: number) {
    const cardIds: number[] = [];
    for (const card of Object.values(this.col.cards)) {
      if (card.nid === noteId) {
        cardIds.push(card.id);
        delete this.col.cards[card.id];
      }
    }
    delete this.col.notes[noteId];
    this.saveLocalCollection({ ...this.col });
    this.send({ type: "delete_note", noteId, cardIds });
  }

  public updateCard(card: Card) {
    this.col.cards[card.id] = card;
    this.saveLocalCollection({ ...this.col });
    this.send({ type: "update_card", card });
  }

  public saveMedia(filename: string, dataUrl: string) {
    this.col.media[filename] = dataUrl;
    this.saveLocalCollection({ ...this.col });
    this.send({ type: "save_media", filename, dataUrl });
  }

  public importCollection(col: Collection) {
    this.saveLocalCollection(col);
    this.send({ type: "import_collection", collection: col });
  }
}
