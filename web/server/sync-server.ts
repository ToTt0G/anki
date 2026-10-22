import { DurableObject } from "cloudflare:workers";
import { Collection, Card, Note, Deck, DeckConfig, NoteType, RevlogEntry } from "../src/core/types";
import { ClientMessage, ServerMessage } from "./types";
import {
  DEFAULT_VAPID_PUBLIC_KEY,
  DEFAULT_VAPID_SUBJECT,
  PushSubscriptionData,
  PushPayload,
  sendWebPush,
  VapidConfig
} from "./push-service";

export class AnkiSyncServer extends DurableObject {
  private sql: any;

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.sql = (this.ctx.storage as any).sql;
    this.initDatabase();
  }

  private initDatabase() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS col_meta (\n        key TEXT PRIMARY KEY,\n        val TEXT NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS decks (\n        id INTEGER PRIMARY KEY,\n        json TEXT NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS dconf (\n        id INTEGER PRIMARY KEY,\n        json TEXT NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS models (\n        id INTEGER PRIMARY KEY,\n        json TEXT NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS notes (\n        id INTEGER PRIMARY KEY,\n        json TEXT NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS cards (\n        id INTEGER PRIMARY KEY,\n        json TEXT NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS revlog (\n        id INTEGER PRIMARY KEY,\n        json TEXT NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS media (\n        name TEXT PRIMARY KEY,\n        data TEXT NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS push_subscriptions (\n        endpoint TEXT PRIMARY KEY,\n        p256dh TEXT NOT NULL,\n        auth TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS ws_tickets (\n        nonce TEXT PRIMARY KEY,\n        exp INTEGER NOT NULL\n      );\n    `);
  }

  private getVapidConfig(): VapidConfig {
    return {
      publicKey: (this.env as any)?.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY,
      privateKey: (this.env as any)?.VAPID_PRIVATE_KEY || "",
      subject: (this.env as any)?.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT
    };
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
      const r: RevlogEntry = JSON.parse(row.json);
      revlog.push(r);
    }
    for (const row of this.sql.exec("SELECT name, data FROM media").toArray()) {
      media[row.name] = row.data;
    }

    return {
      crt: Math.floor(Date.now() / 1000),
      mod: Math.floor(Date.now() / 1000),
      scm: Math.floor(Date.now() / 1000),
      dconf,
      models,
      decks,
      cards,
      notes,
      revlog,
      media
    };
  }

  private saveFullCollection(col: Collection) {
    // Durable Objects requires storage.transactionSync for batch operations
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM decks");
      this.sql.exec("DELETE FROM dconf");
      this.sql.exec("DELETE FROM models");
      this.sql.exec("DELETE FROM notes");
      this.sql.exec("DELETE FROM cards");
      this.sql.exec("DELETE FROM revlog");
      this.sql.exec("DELETE FROM media");

      for (const d of Object.values(col.decks)) {
        this.sql.exec("INSERT INTO decks (id, json) VALUES (?, ?)", d.id, JSON.stringify(d));
      }
      for (const dc of Object.values(col.dconf)) {
        this.sql.exec("INSERT INTO dconf (id, json) VALUES (?, ?)", dc.id, JSON.stringify(dc));
      }
      for (const m of Object.values(col.models)) {
        this.sql.exec("INSERT INTO models (id, json) VALUES (?, ?)", m.id, JSON.stringify(m));
      }
      for (const n of Object.values(col.notes)) {
        this.sql.exec("INSERT INTO notes (id, json) VALUES (?, ?)", n.id, JSON.stringify(n));
      }
      for (const c of Object.values(col.cards)) {
        this.sql.exec("INSERT INTO cards (id, json) VALUES (?, ?)", c.id, JSON.stringify(c));
      }
      for (const r of col.revlog || []) {
        this.sql.exec("INSERT INTO revlog (id, json) VALUES (?, ?)", r.id, JSON.stringify(r));
      }
      for (const [name, data] of Object.entries(col.media || {})) {
        this.sql.exec("INSERT INTO media (name, data) VALUES (?, ?)", name, data);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 0. Internal endpoint to register a single-use WebSocket ticket nonce
    if (url.pathname === "/internal/issue-ticket" && request.method === "POST") {
      const body: { nonce: string; exp: number } = await request.json();
      const now = Date.now();
      this.sql.exec("DELETE FROM ws_tickets WHERE exp < ?", now);
      this.sql.exec(
        "INSERT OR REPLACE INTO ws_tickets (nonce, exp) VALUES (?, ?)",
        body.nonce,
        body.exp
      );
      return Response.json({ ok: true });
    }

    // 1. WebSocket Upgrade (requires valid single-use ticket nonce)
    if (request.headers.get("Upgrade") === "websocket") {
      const nonce = request.headers.get("X-Ticket-Nonce");
      if (!nonce) {
        return Response.json({ error: "Missing WebSocket ticket" }, { status: 401 });
      }
      const now = Date.now();
      this.sql.exec("DELETE FROM ws_tickets WHERE exp < ?", now);
      const rows = this.sql
        .exec("SELECT nonce, exp FROM ws_tickets WHERE nonce = ?", nonce)
        .toArray();
      if (!rows.length || rows[0].exp < now) {
        return Response.json({ error: "Invalid or expired WebSocket ticket" }, { status: 401 });
      }
      // Consume ticket so it is strictly single-use
      this.sql.exec("DELETE FROM ws_tickets WHERE nonce = ?", nonce);

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

    // 3. Web Push API Endpoints
    if (url.pathname === "/push/vapid-public-key") {
      const config = this.getVapidConfig();
      return Response.json({ publicKey: config.publicKey });
    }

    if (url.pathname === "/push/subscribe" && request.method === "POST") {
      try {
        const sub: PushSubscriptionData = await request.json();
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          return Response.json({ error: "Invalid subscription format" }, { status: 400 });
        }
        const now = Date.now();
        this.sql.exec(
          "INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          sub.endpoint,
          sub.keys.p256dh,
          sub.keys.auth,
          now,
          now
        );
        return Response.json({ success: true });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/push/unsubscribe" && request.method === "POST") {
      try {
        const body: { endpoint: string } = await request.json();
        if (body?.endpoint) {
          this.sql.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", body.endpoint);
        }
        return Response.json({ success: true });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/push/status") {
      const rows = this.sql.exec("SELECT COUNT(*) as count FROM push_subscriptions").toArray();
      return Response.json({
        subscriptions: rows[0]?.count || 0,
        vapidConfigured: !!this.getVapidConfig().publicKey
      });
    }

    if (url.pathname === "/push/send-test" && request.method === "POST") {
      try {
        const body: { endpoint?: string; title?: string; body?: string } = await request.json().catch(() => ({}));
        const payload: PushPayload = {
          title: body.title || "klanki Test Notification",
          body: body.body || "Web Push is fully working on this device!",
          url: "/",
          tag: "klanki-test"
        };

        const config = this.getVapidConfig();
        const results = await this.broadcastPushNotification(payload, config, body.endpoint);
        return Response.json(results);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/push/notify-due" && request.method === "POST") {
      try {
        const body: { title?: string; body?: string } = await request.json().catch(() => ({}));
        const col = this.getFullCollection();

        // Calculate due count
        const nowSec = Math.floor(Date.now() / 1000);
        let dueCount = 0;
        for (const card of Object.values(col.cards)) {
          if (card.queue === 1 && card.due <= nowSec) {
            dueCount++; // Reviewing/Learning due
          } else if (card.queue === 2) {
            dueCount++; // Review due
          } else if (card.queue === 0) {
            dueCount++; // New card available
          }
        }

        const payload: PushPayload = {
          title: body.title || "klanki Review Reminder",
          body: body.body || `${dueCount} cards are ready for review today!`,
          url: "/",
          tag: "klanki-due-review"
        };

        const config = this.getVapidConfig();
        const results = await this.broadcastPushNotification(payload, config);
        return Response.json({ dueCount, ...results });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  private async broadcastPushNotification(
    payload: PushPayload,
    config: VapidConfig,
    targetEndpoint?: string
  ) {
    let query = "SELECT endpoint, p256dh, auth FROM push_subscriptions";
    let args: any[] = [];
    if (targetEndpoint) {
      query += " WHERE endpoint = ?";
      args.push(targetEndpoint);
    }

    const rows = this.sql.exec(query, ...args).toArray();
    let sent = 0;
    let failed = 0;
    let pruned = 0;

    for (const row of rows) {
      const sub: PushSubscriptionData = {
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth
        }
      };

      const result = await sendWebPush(sub, payload, config);
      if (result.success) {
        sent++;
      } else {
        failed++;
        if (result.expired) {
          this.sql.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", row.endpoint);
          pruned++;
        }
      }
    }

    return { sent, failed, pruned, total: rows.length };
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
        this.sql.exec("INSERT OR REPLACE INTO media (name, data) VALUES (?, ?)", msg.filename, msg.dataUrl);
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

  private broadcast(msg: ServerMessage, senderWs?: WebSocket) {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== senderWs && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch (e) {
          console.warn("Failed to broadcast message:", e);
        }
      }
    }
  }
}
