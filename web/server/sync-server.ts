import { DurableObject } from "cloudflare:workers";
import { Collection, Card, Note, Deck, DeckConfig, NoteType, RevlogEntry } from "../src/core/types";
import { ClientMessage, ServerMessage } from "./types";

export class AnkiSyncServer extends DurableObject {
  private sql: any;

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.sql = (this.ctx.storage as any).sql;
    this.initDatabase();
  }

  private initDatabase() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS col_meta (
        key TEXT PRIMARY KEY,
        val TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decks (
        id INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dconf (
        id INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revlog (
        id INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media (
        name TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
    `);
  }

  private getFullCollection(): Collection {
    const decks: Record<number, Deck> = {};
    const dconf: Record<number, DeckConfig> = {};
    const models: Record<number, NoteType> = {};
    const notes: Record<number, Note> = {};
    const cards: Record<number, Card> = {};
    const revlog: RevlogEntry[] = [];
    const media: Record<string, string> = {};

    for (const row of this.sql.exec("SELECT json FROM decks").toArray()) {
      const d: Deck = JSON.parse(row.json);
      decks[d.id] = d;
    }
    for (const row of this.sql.exec("SELECT json FROM dconf").toArray()) {
      const dc: DeckConfig = JSON.parse(row.json);
      dconf[dc.id] = dc;
    }
    for (const row of this.sql.exec("SELECT json FROM models").toArray()) {
      const m: NoteType = JSON.parse(row.json);
      models[m.id] = m;
    }
    for (const row of this.sql.exec("SELECT json FROM notes").toArray()) {
      const n: Note = JSON.parse(row.json);
      notes[n.id] = n;
    }
    for (const row of this.sql.exec("SELECT json FROM cards").toArray()) {
      const c: Card = JSON.parse(row.json);
      cards[c.id] = c;
    }
    for (const row of this.sql.exec("SELECT json FROM revlog ORDER BY id ASC").toArray()) {
      revlog.push(JSON.parse(row.json));
    }
    for (const row of this.sql.exec("SELECT name, data FROM media").toArray()) {
      media[row.name] = row.data;
    }

    const modRow = this.sql.exec("SELECT val FROM col_meta WHERE key = 'mod'").toArray();
    const mod = modRow.length > 0 ? parseInt(modRow[0].val, 10) : Math.floor(Date.now() / 1000);

    return {
      id: 1,
      crt: 1600000000,
      mod,
      decks,
      dconf,
      models,
      notes,
      cards,
      revlog,
      media
    };
  }

  private saveFullCollection(col: Collection) {
    (this.ctx.storage as any).transactionSync(() => {
      this.sql.exec("INSERT OR REPLACE INTO col_meta (key, val) VALUES ('mod', ?)", String(Date.now()));

      for (const deck of Object.values(col.decks)) {
        this.sql.exec("INSERT OR REPLACE INTO decks (id, json) VALUES (?, ?)", deck.id, JSON.stringify(deck));
      }
      for (const dc of Object.values(col.dconf)) {
        this.sql.exec("INSERT OR REPLACE INTO dconf (id, json) VALUES (?, ?)", dc.id, JSON.stringify(dc));
      }
      for (const m of Object.values(col.models)) {
        this.sql.exec("INSERT OR REPLACE INTO models (id, json) VALUES (?, ?)", m.id, JSON.stringify(m));
      }
      for (const note of Object.values(col.notes)) {
        this.sql.exec("INSERT OR REPLACE INTO notes (id, json) VALUES (?, ?)", note.id, JSON.stringify(note));
      }
      for (const card of Object.values(col.cards)) {
        this.sql.exec("INSERT OR REPLACE INTO cards (id, json) VALUES (?, ?)", card.id, JSON.stringify(card));
      }
      for (const r of col.revlog) {
        this.sql.exec("INSERT OR REPLACE INTO revlog (id, json) VALUES (?, ?)", r.id, JSON.stringify(r));
      }
      for (const [name, data] of Object.entries(col.media || {})) {
        this.sql.exec("INSERT OR REPLACE INTO media (name, data) VALUES (?, ?)", name, data);
      }
    });
  }

  private broadcast(msg: ServerMessage, senderWs?: WebSocket) {
    const raw = JSON.stringify(msg);
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      if (ws !== senderWs) {
        try {
          ws.send(raw);
        } catch (e) {}
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. WebSocket Upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. HTTP Collection Endpoints
    if (url.pathname === "/collection") {
      if (request.method === "GET") {
        const col = this.getFullCollection();
        return Response.json(col);
      }
      if (request.method === "POST") {
        const col: Collection = await request.json();
        this.saveFullCollection(col);
        this.broadcast({ type: "full_state", collection: col });
        return Response.json({ success: true });
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    try {
      const msg: ClientMessage = JSON.parse(message);

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type === "init") {
        const col = this.getFullCollection();
        ws.send(JSON.stringify({ type: "full_state", collection: col }));
        return;
      }

      if (msg.type === "answer_card") {
        const row = this.sql.exec("SELECT json FROM cards WHERE id = ?", msg.cardId).toArray();
        if (row.length > 0) {
          const card: Card = JSON.parse(row[0].json);
          Object.assign(card, msg.nextState, { mod: Math.floor(Date.now() / 1000) });
          this.sql.exec("UPDATE cards SET json = ? WHERE id = ?", JSON.stringify(card), card.id);
        }
        this.sql.exec("INSERT OR REPLACE INTO revlog (id, json) VALUES (?, ?)", msg.revlogEntry.id, JSON.stringify(msg.revlogEntry));
        this.broadcast(msg, ws);
        return;
      }

      if (msg.type === "upsert_deck") {
        this.sql.exec("INSERT OR REPLACE INTO decks (id, json) VALUES (?, ?)", msg.deck.id, JSON.stringify(msg.deck));
        this.broadcast(msg, ws);
        return;
      }

      if (msg.type === "delete_deck") {
        this.sql.exec("DELETE FROM decks WHERE id = ?", msg.deckId);
        this.broadcast(msg, ws);
        return;
      }

      if (msg.type === "upsert_deck_config") {
        this.sql.exec("INSERT OR REPLACE INTO dconf (id, json) VALUES (?, ?)", msg.dconf.id, JSON.stringify(msg.dconf));
        this.broadcast(msg, ws);
        return;
      }

      if (msg.type === "upsert_note") {
        this.sql.exec("INSERT OR REPLACE INTO notes (id, json) VALUES (?, ?)", msg.note.id, JSON.stringify(msg.note));
        for (const card of msg.cards) {
          this.sql.exec("INSERT OR REPLACE INTO cards (id, json) VALUES (?, ?)", card.id, JSON.stringify(card));
        }
        this.broadcast(msg, ws);
        return;
      }

      if (msg.type === "delete_note") {
        this.sql.exec("DELETE FROM notes WHERE id = ?", msg.noteId);
        for (const cid of msg.cardIds) {
          this.sql.exec("DELETE FROM cards WHERE id = ?", cid);
        }
        this.broadcast(msg, ws);
        return;
      }

      if (msg.type === "update_card") {
        this.sql.exec("INSERT OR REPLACE INTO cards (id, json) VALUES (?, ?)", msg.card.id, JSON.stringify(msg.card));
        this.broadcast(msg, ws);
        return;
      }

      if (msg.type === "save_media") {
        this.sql.exec("INSERT OR REPLACE INTO media (name, val) VALUES (?, ?)", msg.filename, msg.dataUrl);
        this.broadcast(msg, ws);
        return;
      }

      if (msg.type === "import_collection") {
        this.saveFullCollection(msg.collection);
        this.broadcast(msg, ws);
        return;
      }
    } catch (e) {
      console.error("Error processing websocket message:", e);
    }
  }

  webSocketClose(ws: WebSocket) {
    // Client disconnected
  }
}
