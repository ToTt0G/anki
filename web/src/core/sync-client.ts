import { Collection, Card, Note, Deck, DeckConfig, RevlogEntry } from "./types";
import { ClientMessage, ServerMessage } from "../../server/types";
import { createDefaultCollection } from "./default-data";

const STORAGE_KEY = "anki_web_collection_v1";

export type SyncStatus = "connected" | "connecting" | "offline";

export class SyncClient {
  private ws: WebSocket | null = null;
  private room: string = "default";
  private onCollectionUpdated: (col: Collection) => void;
  private onStatusChanged: (status: SyncStatus) => void;
  private col: Collection;
  private reconnectTimer: any = null;
  private status: SyncStatus = "offline";

  constructor(
    onCollectionUpdated: (col: Collection) => void,
    onStatusChanged: (status: SyncStatus) => void
  ) {
    this.onCollectionUpdated = onCollectionUpdated;
    this.onStatusChanged = onStatusChanged;
    this.col = this.loadLocalCollection();
  }

  public getCollection(): Collection {
    return this.col;
  }

  private loadLocalCollection(): Collection {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn("Failed to load local storage collection:", e);
    }
    const def = createDefaultCollection();
    this.saveLocalCollection(def);
    return def;
  }

  public saveLocalCollection(col: Collection) {
    this.col = col;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(col));
    } catch (e) {
      console.warn("Failed to save local storage collection:", e);
    }
    this.onCollectionUpdated(this.col);
  }

  public connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/ws?room=${encodeURIComponent(this.room)}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.setStatus("connected");
        // Request initial sync
        this.send({ type: "init", lastMod: this.col.mod });
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: ServerMessage = JSON.parse(event.data);
          this.handleServerMessage(msg);
        } catch (e) {
          console.error("Failed to parse websocket message:", e);
        }
      };

      this.ws.onclose = () => {
        this.setStatus("offline");
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.setStatus("offline");
        this.ws?.close();
      };
    } catch (e) {
      this.setStatus("offline");
      this.scheduleReconnect();
    }
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    this.onStatusChanged(status);
  }

  private scheduleReconnect() {
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
      // If server has decks/cards, update local
      const serverDeckCount = Object.keys(msg.collection.decks || {}).length;
      const serverCardCount = Object.keys(msg.collection.cards || {}).length;

      if (serverDeckCount > 0 && serverCardCount > 0) {
        this.saveLocalCollection(msg.collection);
      } else {
        // If server is brand new and empty, upload our default collection
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
    // Also remove cards belonging to this deck
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

  public importCollection(col: Collection) {
    this.saveLocalCollection(col);
    this.send({ type: "import_collection", collection: col });
  }
}
