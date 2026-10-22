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

export interface PushPreferences {
  dailyMode: "adaptive" | "fixed";
  dailyTime: string; // "HH:MM", e.g. "09:00"
  tzOffsetMinutes: number; // JS Date.getTimezoneOffset() (minutes behind UTC)
  learningAlerts: boolean;
}

const DEFAULT_PUSH_PREFS: PushPreferences = {
  dailyMode: "adaptive",
  dailyTime: "09:00",
  tzOffsetMinutes: 0,
  learningAlerts: true
};

export interface DueSummary {
  learnDueCount: number;
  reviewDueCount: number;
  newCount: number;
  earliestLearnDueSec: number | null;
  topDeckName: string;
  studiedToday: boolean;
  streakDays: number;
  adaptiveHour: number;
}

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
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ws_tickets (
        nonce TEXT PRIMARY KEY,
        exp INTEGER NOT NULL
      );
    `);
  }

  private getMeta(key: string): string | null {
    const rows = this.sql.exec("SELECT val FROM col_meta WHERE key = ?", key).toArray();
    return rows.length > 0 ? String(rows[0].val) : null;
  }

  private setMeta(key: string, val: string) {
    this.sql.exec("INSERT OR REPLACE INTO col_meta (key, val) VALUES (?, ?)", key, val);
  }

  private getPushPreferences(): PushPreferences {
    const raw = this.getMeta("push_preferences");
    if (!raw) return { ...DEFAULT_PUSH_PREFS };
    try {
      const parsed = JSON.parse(raw);
      return {
        dailyMode: parsed.dailyMode === "fixed" ? "fixed" : "adaptive",
        dailyTime: typeof parsed.dailyTime === "string" && /^\d{2}:\d{2}$/.test(parsed.dailyTime)
          ? parsed.dailyTime
          : "09:00",
        tzOffsetMinutes: typeof parsed.tzOffsetMinutes === "number" ? parsed.tzOffsetMinutes : 0,
        learningAlerts: parsed.learningAlerts !== false
      };
    } catch {
      return { ...DEFAULT_PUSH_PREFS };
    }
  }

  private savePushPreferences(prefs: PushPreferences) {
    this.setMeta("push_preferences", JSON.stringify(prefs));
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

    const crtMeta = Number(this.getMeta("col_crt")) || Math.floor(Date.now() / 1000);

    return {
      crt: crtMeta,
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
    this.ctx.storage.transactionSync(() => {
      if (col.crt) {
        this.setMeta("col_crt", String(col.crt));
      }
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

  /**
   * Analyze the collection, review history, and user timezone to compute:
   * - Due learning cards (exact Unix seconds)
   * - Due review cards (epoch day <= today)
   * - Available new cards
   * - Whether the user has already studied today
   * - Current consecutive-day study streak
   * - Adaptive habitual study hour (0..23) learned from revlog timestamps
   */
  private computeDueSummary(col: Collection, prefs: PushPreferences): DueSummary {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const todayEpochDay = Math.floor(nowMs / 86_400_000);
    const crtDay = Math.floor((col.crt || nowSec) / 86400);

    let learnDueCount = 0;
    let reviewDueCount = 0;
    let newCount = 0;
    let earliestLearnDueSec: number | null = null;
    const duePerDeck: Record<number, number> = {};

    for (const card of Object.values(col.cards)) {
      if (card.queue < 0) continue; // Suspended or buried

      if (card.queue === 1 || card.queue === 3) {
        if (earliestLearnDueSec === null || card.due < earliestLearnDueSec) {
          earliestLearnDueSec = card.due;
        }
        if (card.due <= nowSec + 60) {
          learnDueCount++;
          duePerDeck[card.did] = (duePerDeck[card.did] || 0) + 1;
        }
      } else if (card.queue === 2) {
        // Handle both epoch-day due numbers and imported relative-day due numbers
        const effectiveDueDay = card.due < 10000 ? crtDay + card.due : card.due;
        if (effectiveDueDay <= todayEpochDay) {
          reviewDueCount++;
          duePerDeck[card.did] = (duePerDeck[card.did] || 0) + 1;
        }
      } else if (card.queue === 0) {
        newCount++;
      }
    }

    // Find the deck with the most due cards
    let topDeckId = 1;
    let maxDeckDue = -1;
    for (const [didStr, count] of Object.entries(duePerDeck)) {
      if (count > maxDeckDue) {
        maxDeckDue = count;
        topDeckId = Number(didStr);
      }
    }
    const topDeckName =
      col.decks[topDeckId]?.name || Object.values(col.decks)[0]?.name || "Default";

    // Local time calculations using tzOffsetMinutes (minutes behind UTC)
    const offsetMs = (prefs.tzOffsetMinutes || 0) * 60_000;
    const localNow = new Date(nowMs - offsetMs);
    const localMidnightUtcMs =
      Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate(),
        0,
        0,
        0
      ) + offsetMs;

    const studiedDaySet = new Set<string>();
    const hourBuckets = new Array<number>(24).fill(0);
    let studiedToday = false;

    for (const entry of col.revlog || []) {
      const ts = entry.id;
      if (ts >= localMidnightUtcMs) {
        studiedToday = true;
      }
      const localDate = new Date(ts - offsetMs);
      const dayKey = localDate.toISOString().slice(0, 10);
      studiedDaySet.add(dayKey);
      const hr = localDate.getUTCHours();
      if (hr >= 0 && hr < 24) {
        hourBuckets[hr]++;
      }
    }

    // Compute streak (consecutive days up to today or yesterday)
    let streakDays = 0;
    for (let d = 0; d < 365; d++) {
      const checkDate = new Date(nowMs - offsetMs - d * 86_400_000);
      const key = checkDate.toISOString().slice(0, 10);
      if (studiedDaySet.has(key)) {
        streakDays++;
      } else if (d === 0) {
        // Haven't studied yet today; check if streak is alive from yesterday
        continue;
      } else {
        break;
      }
    }

    // Learn user's habitual study hour (defaults to 9 AM if < 5 reviews)
    let adaptiveHour = 9;
    if ((col.revlog || []).length >= 5) {
      let bestCount = -1;
      for (let h = 6; h <= 22; h++) {
        if (hourBuckets[h] > bestCount) {
          bestCount = hourBuckets[h];
          adaptiveHour = h;
        }
      }
    }

    return {
      learnDueCount,
      reviewDueCount,
      newCount,
      earliestLearnDueSec,
      topDeckName,
      studiedToday,
      streakDays,
      adaptiveHour
    };
  }

  /**
   * Compute and schedule the exact next Durable Object alarm timestamp (`setAlarm`)
   * combining:
   * 1. Intraday Learning / Relearning step completion alerts (when the user has unfinished learning steps)
   * 2. Daily Review / Study reminder at the user's adaptive or fixed daily study time
   */
  private async recomputeAndScheduleAlarm(): Promise<number | null> {
    const subRows = this.sql
      .exec("SELECT COUNT(*) as count FROM push_subscriptions")
      .toArray();
    const subCount = Number(subRows[0]?.count || 0);

    if (subCount === 0) {
      await this.ctx.storage.deleteAlarm();
      this.setMeta("next_alarm_ms", "");
      return null;
    }

    const prefs = this.getPushPreferences();
    const col = this.getFullCollection();
    const summary = this.computeDueSummary(col, prefs);

    const nowMs = Date.now();
    const offsetMs = (prefs.tzOffsetMinutes || 0) * 60_000;
    const localNow = new Date(nowMs - offsetMs);
    const localDateStr = localNow.toISOString().slice(0, 10);
    const localMidnightUtcMs =
      Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate(),
        0,
        0,
        0
      ) + offsetMs;

    // 1. Candidate A: Intraday learning step reminder
    let learnCandidateMs: number | null = null;
    const lastActivityMs = Number(this.getMeta("last_activity_ms") || 0);
    const lastLearnPushMs = Number(this.getMeta("last_learn_push_ms") || 0);

    // Only schedule a learning-step alert if the user has studied since the last learning alert
    if (
      prefs.learningAlerts &&
      summary.earliestLearnDueSec !== null &&
      lastLearnPushMs < lastActivityMs
    ) {
      const dueMs = summary.earliestLearnDueSec * 1000;
      const hasOpenSockets = this.ctx
        .getWebSockets()
        .some(ws => ws.readyState === WebSocket.OPEN);
      const activeBufferMs = hasOpenSockets ? 10 * 60_000 : 90_000;
      learnCandidateMs = Math.max(
        dueMs,
        lastActivityMs + activeBufferMs,
        lastLearnPushMs + 15 * 60_000,
        nowMs + 30_000
      );
    }

    // 2. Candidate B: Daily study reminder
    let targetHour = summary.adaptiveHour;
    let targetMinute = 0;
    if (prefs.dailyMode === "fixed") {
      const [hStr, mStr] = prefs.dailyTime.split(":");
      targetHour = Math.min(23, Math.max(0, Number(hStr) || 9));
      targetMinute = Math.min(59, Math.max(0, Number(mStr) || 0));
    }

    const todayTargetUtcMs =
      localMidnightUtcMs + (targetHour * 60 + targetMinute) * 60_000;
    const lastDailySentDate = this.getMeta("last_daily_push_date") || "";

    let dailyCandidateMs: number;
    if (
      !summary.studiedToday &&
      lastDailySentDate !== localDateStr &&
      todayTargetUtcMs > nowMs + 15_000
    ) {
      dailyCandidateMs = todayTargetUtcMs;
    } else {
      dailyCandidateMs = todayTargetUtcMs + 86_400_000;
    }

    const nextAlarmMs =
      learnCandidateMs !== null
        ? Math.min(learnCandidateMs, dailyCandidateMs)
        : dailyCandidateMs;

    await this.ctx.storage.setAlarm(nextAlarmMs);
    this.setMeta("next_alarm_ms", String(nextAlarmMs));
    return nextAlarmMs;
  }

  /**
   * Durable Object Alarm Handler:
   * Wakes up automatically at the scheduled millisecond even when all browsers/phones are closed,
   * evaluates due learning steps & daily study goals, dispatches Web Push notifications,
   * and schedules the next alarm.
   */
  async alarm(): Promise<void> {
    const subRows = this.sql
      .exec("SELECT COUNT(*) as count FROM push_subscriptions")
      .toArray();
    if (!Number(subRows[0]?.count || 0)) {
      return;
    }

    const prefs = this.getPushPreferences();
    const col = this.getFullCollection();
    const summary = this.computeDueSummary(col, prefs);
    const config = this.getVapidConfig();

    const nowMs = Date.now();
    const lastActivityMs = Number(this.getMeta("last_activity_ms") || 0);
    const lastLearnPushMs = Number(this.getMeta("last_learn_push_ms") || 0);

    // If user is actively reviewing cards right now (activity within last 90s and socket open), snooze alarm
    const hasOpenSockets = this.ctx
      .getWebSockets()
      .some(ws => ws.readyState === WebSocket.OPEN);
    if (hasOpenSockets && nowMs - lastActivityMs < 90_000) {
      await this.recomputeAndScheduleAlarm();
      return;
    }

    const offsetMs = (prefs.tzOffsetMinutes || 0) * 60_000;
    const localNow = new Date(nowMs - offsetMs);
    const localDateStr = localNow.toISOString().slice(0, 10);
    const localMidnightUtcMs =
      Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate(),
        0,
        0,
        0
      ) + offsetMs;

    let targetHour = summary.adaptiveHour;
    let targetMinute = 0;
    if (prefs.dailyMode === "fixed") {
      const [hStr, mStr] = prefs.dailyTime.split(":");
      targetHour = Math.min(23, Math.max(0, Number(hStr) || 9));
      targetMinute = Math.min(59, Math.max(0, Number(mStr) || 0));
    }
    const todayTargetUtcMs =
      localMidnightUtcMs + (targetHour * 60 + targetMinute) * 60_000;
    const lastDailySentDate = this.getMeta("last_daily_push_date") || "";

    // Check Tier 1: Intraday Learning Step Ready
    if (
      prefs.learningAlerts &&
      summary.learnDueCount > 0 &&
      lastLearnPushMs < lastActivityMs
    ) {
      const count = summary.learnDueCount;
      const payload: PushPayload = {
        title: `klanki · ${count} Learning ${count === 1 ? "Card" : "Cards"} Due`,
        body: `Your learning step in ${summary.topDeckName} is ready — review now to lock it into memory.`,
        url: "/",
        tag: "klanki-learn-due"
      };
      await this.broadcastPushNotification(payload, config);
      this.setMeta("last_learn_push_ms", String(nowMs));
    } else if (
      // Check Tier 2: Daily Study Reminder
      nowMs >= todayTargetUtcMs - 60_000 &&
      !summary.studiedToday &&
      lastDailySentDate !== localDateStr
    ) {
      const dueTotal = summary.learnDueCount + summary.reviewDueCount;
      const streakSuffix =
        summary.streakDays >= 2 ? ` (${summary.streakDays}-day streak)` : "";

      if (dueTotal > 0) {
        const payload: PushPayload = {
          title: `klanki · ${dueTotal} ${dueTotal === 1 ? "Card" : "Cards"} Due Today`,
          body: `Ready in ${summary.topDeckName}${
            summary.newCount > 0 ? ` + ${ Math.min(20, summary.newCount) } new` : ""
          }${streakSuffix}.`,
          url: "/",
          tag: "klanki-daily-due"
        };
        await this.broadcastPushNotification(payload, config);
        this.setMeta("last_daily_push_date", localDateStr);
      } else if (summary.newCount > 0) {
        const batch = Math.min(20, summary.newCount);
        const payload: PushPayload = {
          title: "klanki · Daily Study Reminder",
          body: `${batch} new ${batch === 1 ? "card" : "cards"} waiting in ${summary.topDeckName}${streakSuffix}.`,
          url: "/",
          tag: "klanki-daily-due"
        };
        await this.broadcastPushNotification(payload, config);
        this.setMeta("last_daily_push_date", localDateStr);
      }
    }

    await this.recomputeAndScheduleAlarm();
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
        this.setMeta("last_activity_ms", String(Date.now()));
        await this.recomputeAndScheduleAlarm();
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
        const sub: PushSubscriptionData & { tzOffsetMinutes?: number } = await request.json();
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
        if (typeof sub.tzOffsetMinutes === "number") {
          const prefs = this.getPushPreferences();
          prefs.tzOffsetMinutes = sub.tzOffsetMinutes;
          this.savePushPreferences(prefs);
        }
        const nextAlarmAt = await this.recomputeAndScheduleAlarm();
        return Response.json({ success: true, nextAlarmAt });
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
        await this.recomputeAndScheduleAlarm();
        return Response.json({ success: true });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/push/preferences" && request.method === "POST") {
      try {
        const incoming: Partial<PushPreferences> = await request.json();
        const current = this.getPushPreferences();
        const updated: PushPreferences = {
          dailyMode: incoming.dailyMode === "fixed" ? "fixed" : incoming.dailyMode === "adaptive" ? "adaptive" : current.dailyMode,
          dailyTime:
            typeof incoming.dailyTime === "string" && /^\d{2}:\d{2}$/.test(incoming.dailyTime)
              ? incoming.dailyTime
              : current.dailyTime,
          tzOffsetMinutes:
            typeof incoming.tzOffsetMinutes === "number"
              ? incoming.tzOffsetMinutes
              : current.tzOffsetMinutes,
          learningAlerts:
            typeof incoming.learningAlerts === "boolean"
              ? incoming.learningAlerts
              : current.learningAlerts
        };
        this.savePushPreferences(updated);
        const nextAlarmAt = await this.recomputeAndScheduleAlarm();
        const col = this.getFullCollection();
        const dueSummary = this.computeDueSummary(col, updated);
        return Response.json({
          success: true,
          preferences: updated,
          nextAlarmAt,
          dueSummary
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/push/status") {
      const rows = this.sql.exec("SELECT COUNT(*) as count FROM push_subscriptions").toArray();
      const prefs = this.getPushPreferences();
      const col = this.getFullCollection();
      const dueSummary = this.computeDueSummary(col, prefs);
      const nextAlarmAt = await this.recomputeAndScheduleAlarm();
      return Response.json({
        subscriptions: rows[0]?.count || 0,
        vapidConfigured: !!this.getVapidConfig().publicKey,
        preferences: prefs,
        nextAlarmAt,
        dueSummary
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
        const prefs = this.getPushPreferences();
        const summary = this.computeDueSummary(col, prefs);
        const dueTotal = summary.learnDueCount + summary.reviewDueCount;

        const payload: PushPayload = {
          title:
            body.title ||
            (dueTotal > 0
              ? `klanki · ${dueTotal} ${dueTotal === 1 ? "Card" : "Cards"} Due`
              : "klanki · Study Reminder"),
          body:
            body.body ||
            (dueTotal > 0
              ? `${dueTotal} due in ${summary.topDeckName}${
                  summary.newCount > 0 ? ` + ${Math.min(20, summary.newCount)} new` : ""
                }.`
              : `${Math.min(20, summary.newCount)} new cards ready in ${summary.topDeckName}.`),
          url: "/",
          tag: "klanki-due-review"
        };

        const config = this.getVapidConfig();
        const results = await this.broadcastPushNotification(payload, config);
        return Response.json({ dueCount: dueTotal + summary.newCount, summary, ...results });
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
    const args: any[] = [];
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

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
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
        this.sql.exec(
          "INSERT OR REPLACE INTO revlog (id, json) VALUES (?, ?)",
          msg.revlogEntry.id,
          JSON.stringify(msg.revlogEntry)
        );
        this.setMeta("last_activity_ms", String(Date.now()));
        await this.recomputeAndScheduleAlarm();
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
        await this.recomputeAndScheduleAlarm();
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
        this.setMeta("last_activity_ms", String(Date.now()));
        await this.recomputeAndScheduleAlarm();
        this.broadcast(msg, ws);
        return;
      }

      if (msg.type === "delete_note") {
        this.sql.exec("DELETE FROM notes WHERE id = ?", msg.noteId);
        for (const cid of msg.cardIds) {
          this.sql.exec("DELETE FROM cards WHERE id = ?", cid);
        }
        await this.recomputeAndScheduleAlarm();
        this.broadcast(msg, ws);
        return;
      }

      if (msg.type === "update_card") {
        this.sql.exec("INSERT OR REPLACE INTO cards (id, json) VALUES (?, ?)", msg.card.id, JSON.stringify(msg.card));
        this.setMeta("last_activity_ms", String(Date.now()));
        await this.recomputeAndScheduleAlarm();
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
        this.setMeta("last_activity_ms", String(Date.now()));
        await this.recomputeAndScheduleAlarm();
        this.broadcast(msg, ws);
        return;
      }
    } catch (e) {
      console.error("Error processing websocket message:", e);
    }
  }

  async webSocketClose(_ws: WebSocket) {
    // When a client closes the app, recompute the alarm without the active-session buffer
    await this.recomputeAndScheduleAlarm();
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
