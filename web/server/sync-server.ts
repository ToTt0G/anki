// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { DurableObject } from "cloudflare:workers";
import { Card, Collection, Deck, DeckConfig, Note, NoteType, RevlogEntry } from "../src/core/types";
import {
    DEFAULT_VAPID_PUBLIC_KEY,
    DEFAULT_VAPID_SUBJECT,
    PushPayload,
    PushSubscriptionData,
    sendWebPush,
    VapidConfig,
} from "./push-service";
import { ClientMessage, OpErrorKind, ServerMessage } from "./types";
import { validateClientMessage, validateCollectionPayload, validatePushSubscriptionInput } from "./validation";

/**
 * Typed error carrying a machine-readable kind so clients can offer retry/conflict UX (D13).
 */
class OpError extends Error {
    kind: OpErrorKind;
    retryable: boolean;

    constructor(message: string, kind: OpErrorKind, retryable: boolean = false) {
        super(message);
        this.kind = kind;
        this.retryable = retryable;
    }
}

export interface PushPreferences {
    dailyMode: "adaptive" | "fixed";
    dailyTime: string; // "HH:MM", e.g. "09:00"
    tzOffsetMinutes: number;
    timeZone?: string; // IANA timezone, e.g. "Europe/Stockholm" (N05, N06)
    learningAlerts: boolean;
}

const DEFAULT_PUSH_PREFS: PushPreferences = {
    dailyMode: "adaptive",
    dailyTime: "09:00",
    tzOffsetMinutes: 0,
    timeZone: "UTC",
    learningAlerts: true,
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

function isValidTimeZone(tz?: string): tz is string {
    if (!tz || typeof tz !== "string" || tz.length > 64) { return false; }
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * Get YYYY-MM-DD and hour (0..23) and minute (0..59) in the user's IANA timeZone (N05).
 */
function getLocalTimeParts(
    epochMs: number,
    prefs: PushPreferences,
): { dateStr: string; hour: number; minute: number; midnightUtcMs: number } {
    const tz = isValidTimeZone(prefs.timeZone) ? prefs.timeZone : null;
    if (tz) {
        try {
            const parts = new Intl.DateTimeFormat("en-CA", {
                timeZone: tz,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hourCycle: "h23",
            }).formatToParts(new Date(epochMs));

            const map: Record<string, string> = {};
            for (const p of parts) {
                map[p.type] = p.value;
            }
            const dateStr = `${map.year}-${map.month}-${map.day}`;
            const hour = Number(map.hour) || 0;
            const minute = Number(map.minute) || 0;
            const sec = Number(map.second) || 0;
            const elapsedTodayMs = ((hour * 60 + minute) * 60 + sec) * 1000;
            return {
                dateStr,
                hour,
                minute,
                midnightUtcMs: epochMs - elapsedTodayMs,
            };
        } catch {
            // Fall through to tzOffsetMinutes
        }
    }

    const offsetMs = (prefs.tzOffsetMinutes || 0) * 60_000;
    const localNow = new Date(epochMs - offsetMs);
    const dateStr = localNow.toISOString().slice(0, 10);
    const hour = localNow.getUTCHours();
    const minute = localNow.getUTCMinutes();
    const midnightUtcMs = Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate(),
        0,
        0,
        0,
    ) + offsetMs;

    return { dateStr, hour, minute, midnightUtcMs };
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
        updated_at INTEGER NOT NULL,
        unsub_secret TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS ws_tickets (
        nonce TEXT PRIMARY KEY,
        exp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS applied_ops (
        op_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

        // Migration for databases created before per-subscription unsubscribe secrets (S03).
        try {
            this.sql.exec(
                "ALTER TABLE push_subscriptions ADD COLUMN unsub_secret TEXT NOT NULL DEFAULT ''",
            );
        } catch {
            // Column already exists.
        }
    }

    private getMeta(key: string): string | null {
        const rows = this.sql.exec("SELECT val FROM col_meta WHERE key = ?", key).toArray();
        return rows.length > 0 ? String(rows[0].val) : null;
    }

    private setMeta(key: string, val: string) {
        this.sql.exec("INSERT OR REPLACE INTO col_meta (key, val) VALUES (?, ?)", key, val);
    }

    private getRevision(): number {
        return Number(this.getMeta("col_revision") || 0);
    }

    /**
     * Account-deletion tombstone (S10): written when the user deletes their cloud data. A stale
     * device that later comes online must not be able to silently re-seed the deleted collection
     * from its local copy; automatic seeding is refused until a deliberate full import clears it.
     */
    private getDeletionTombstone(): { deletedAt: number } | null {
        const raw = this.getMeta("deletion_tombstone");
        if (!raw) { return null; }
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.deletedAt === "number") { return parsed; }
        } catch {
            // ignore malformed tombstone
        }
        return null;
    }

    private setDeletionTombstone(): void {
        this.setMeta(
            "deletion_tombstone",
            JSON.stringify({ deletedAt: Date.now(), deletionId: crypto.randomUUID() }),
        );
    }

    private clearDeletionTombstone(): void {
        this.setMeta("deletion_tombstone", "");
    }

    /**
     * Compare-and-swap check for whole-collection overwrites (D02, S13). A stale client must not
     * be able to blindly replace newer data. Callers that omit `expectedRevision` are only
     * allowed on a still-uninitialized (revision 0) server.
     */
    private checkExpectedRevision(expectedRevision: unknown): { ok: boolean; error?: string } {
        const current = this.getRevision();
        if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) {
            return { ok: false, error: "Full collection replacement requires an explicit expectedRevision." };
        }
        if (expectedRevision !== current) {
            return {
                ok: false,
                error: `Revision conflict: expected ${expectedRevision}, server is at ${current}. Reload and retry.`,
            };
        }
        return { ok: true };
    }

    private isInitialized(): boolean {
        if (this.getMeta("col_initialized") === "1") { return true; }
        const deckRows = this.sql.exec("SELECT COUNT(*) as c FROM decks").toArray();
        if (Number(deckRows[0]?.c || 0) > 0) {
            this.setMeta("col_initialized", "1");
            return true;
        }
        return false;
    }

    private bumpRevision(opId?: string): number {
        const next = this.getRevision() + 1;
        this.setMeta("col_revision", String(next));
        this.setMeta("col_initialized", "1");
        if (opId) {
            const now = Date.now();
            // Clients may retry indefinitely after losing an acknowledgement. Retain every
            // operation ID for the lifetime of this collection generation.
            this.sql.exec(
                "INSERT OR REPLACE INTO applied_ops (op_id, revision, applied_at) VALUES (?, ?, ?)",
                opId,
                next,
                now,
            );
        }
        return next;
    }

    private getAlreadyAppliedRevision(opId?: string): number | null {
        if (!opId) { return null; }
        const rows = this.sql
            .exec("SELECT revision FROM applied_ops WHERE op_id = ?", opId)
            .toArray();
        return rows.length > 0 ? Number(rows[0].revision) : null;
    }

    private getPushPreferences(): PushPreferences {
        const raw = this.getMeta("push_preferences");
        if (!raw) { return { ...DEFAULT_PUSH_PREFS }; }
        try {
            const parsed = JSON.parse(raw);
            return {
                dailyMode: parsed.dailyMode === "fixed" ? "fixed" : "adaptive",
                dailyTime: typeof parsed.dailyTime === "string" && /^\d{2}:\d{2}$/.test(parsed.dailyTime)
                    ? parsed.dailyTime
                    : "09:00",
                tzOffsetMinutes: typeof parsed.tzOffsetMinutes === "number" ? parsed.tzOffsetMinutes : 0,
                timeZone: isValidTimeZone(parsed.timeZone) ? parsed.timeZone : undefined,
                learningAlerts: parsed.learningAlerts !== false,
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
            subject: (this.env as any)?.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
        };
    }

    private isVapidReady(): boolean {
        const cfg = this.getVapidConfig();
        return Boolean(cfg.publicKey && cfg.privateKey && cfg.subject);
    }

    private getFullCollection(includeMedia: boolean = true): Collection {
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
        if (includeMedia) {
            for (const row of this.sql.exec("SELECT name, data FROM media").toArray()) {
                media[row.name] = row.data;
            }
        }

        const crtMeta = Number(this.getMeta("col_crt")) || Math.floor(Date.now() / 1000);

        return {
            id: 1,
            crt: crtMeta,
            mod: Math.floor(Date.now() / 1000),
            dconf,
            models,
            decks,
            cards,
            notes,
            revlog,
            media,
        };
    }

    /**
     * Save a recoverable backup snapshot of core tables before a full collection overwrite (D07).
     */
    private saveBackupSnapshot() {
        if (!this.isInitialized()) { return; }
        try {
            const current = this.getFullCollection(false);
            if (Object.keys(current.cards).length > 0 || Object.keys(current.notes).length > 0) {
                this.setMeta("backup_snapshot", JSON.stringify(current));
            }
        } catch (e) {
            console.warn("Could not save pre-import backup snapshot:", e);
        }
    }

    private saveFullCollection(col: Collection, opId?: string): number {
        this.saveBackupSnapshot();
        let nextRev = 0;
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

            for (const d of Object.values(col.decks || {})) {
                this.sql.exec("INSERT INTO decks (id, json) VALUES (?, ?)", d.id, JSON.stringify(d));
            }
            for (const dc of Object.values(col.dconf || {})) {
                this.sql.exec("INSERT INTO dconf (id, json) VALUES (?, ?)", dc.id, JSON.stringify(dc));
            }
            for (const m of Object.values(col.models || {})) {
                this.sql.exec("INSERT INTO models (id, json) VALUES (?, ?)", m.id, JSON.stringify(m));
            }
            for (const n of Object.values(col.notes || {})) {
                this.sql.exec("INSERT INTO notes (id, json) VALUES (?, ?)", n.id, JSON.stringify(n));
            }
            for (const c of Object.values(col.cards || {})) {
                this.sql.exec("INSERT INTO cards (id, json) VALUES (?, ?)", c.id, JSON.stringify(c));
            }
            for (const r of col.revlog || []) {
                this.sql.exec("INSERT OR REPLACE INTO revlog (id, json) VALUES (?, ?)", r.id, JSON.stringify(r));
            }
            if (col.media && Object.keys(col.media).length > 0) {
                for (const [name, data] of Object.entries(col.media)) {
                    this.sql.exec("INSERT OR REPLACE INTO media (name, data) VALUES (?, ?)", name, data);
                }
            }
            nextRev = this.bumpRevision(opId);
        });
        return nextRev;
    }

    /**
     * Lightweight due summary calculation that reads only decks, cards, and revlog (never media) (P01, C05, N05).
     */
    private computeDueSummary(prefs: PushPreferences): DueSummary {
        const nowMs = Date.now();
        const nowSec = Math.floor(nowMs / 1000);
        // Day boundary must match the client's local calendar day, not raw UTC days (C11/N05).
        // Clients scheduleReview due dates as local-midnight epoch days (scheduler.getTodayDay);
        // deriving todayEpochDay from the same local midnight keeps due counts consistent
        // across devices around midnight in non-UTC timezones.
        const localNowParts = getLocalTimeParts(nowMs, prefs);
        const todayEpochDay = Math.floor(Date.parse(`${localNowParts.dateStr}T00:00:00Z`) / 86_400_000);
        const crtSec = Number(this.getMeta("col_crt")) || nowSec;
        const crtDay = Math.floor(crtSec / 86400);

        const decks: Record<number, Deck> = {};
        for (const row of this.sql.exec("SELECT json FROM decks").toArray()) {
            const d: Deck = JSON.parse(row.json);
            decks[d.id] = d;
        }

        let learnDueCount = 0;
        let reviewDueCount = 0;
        let newCount = 0;
        let earliestLearnDueSec: number | null = null;
        const duePerDeck: Record<number, number> = {};

        for (const row of this.sql.exec("SELECT json FROM cards").toArray()) {
            const card: Card = JSON.parse(row.json);
            if (card.queue < 0) { continue; }

            if (card.queue === 1) {
                // Intraday learning (Unix seconds)
                if (earliestLearnDueSec === null || card.due < earliestLearnDueSec) {
                    earliestLearnDueSec = card.due;
                }
                if (card.due <= nowSec + 60) {
                    learnDueCount++;
                    duePerDeck[card.did] = (duePerDeck[card.did] || 0) + 1;
                }
            } else if (card.queue === 3) {
                // Day-learning queue (C05): due is in days (or Unix sec if legacy klanki card)
                const isDayDue = card.due > 1_000_000_000
                    ? card.due <= nowSec + 60
                    : (card.due < 10000 ? crtDay + card.due : card.due) <= todayEpochDay;
                if (isDayDue) {
                    learnDueCount++;
                    duePerDeck[card.did] = (duePerDeck[card.did] || 0) + 1;
                }
            } else if (card.queue === 2) {
                const effectiveDueDay = card.due < 10000 ? crtDay + card.due : card.due;
                if (effectiveDueDay <= todayEpochDay) {
                    reviewDueCount++;
                    duePerDeck[card.did] = (duePerDeck[card.did] || 0) + 1;
                }
            } else if (card.queue === 0) {
                newCount++;
            }
        }

        let topDeckId = 1;
        let maxDeckDue = -1;
        for (const [didStr, count] of Object.entries(duePerDeck)) {
            if (count > maxDeckDue) {
                maxDeckDue = count;
                topDeckId = Number(didStr);
            }
        }
        const topDeckName = decks[topDeckId]?.name || Object.values(decks)[0]?.name || "Default";

        const studiedDaySet = new Set<string>();
        const hourBuckets = new Array<number>(24).fill(0);
        let studiedToday = false;
        let totalRevlogs = 0;

        for (const row of this.sql.exec("SELECT json FROM revlog").toArray()) {
            totalRevlogs++;
            const entry: RevlogEntry = JSON.parse(row.json);
            const ts = entry.id;
            if (ts >= localNowParts.midnightUtcMs) {
                studiedToday = true;
            }
            const entryParts = getLocalTimeParts(ts, prefs);
            studiedDaySet.add(entryParts.dateStr);
            if (entryParts.hour >= 0 && entryParts.hour < 24) {
                hourBuckets[entryParts.hour]++;
            }
        }

        let streakDays = 0;
        for (let d = 0; d < 365; d++) {
            const checkParts = getLocalTimeParts(nowMs - d * 86_400_000, prefs);
            if (studiedDaySet.has(checkParts.dateStr)) {
                streakDays++;
            } else if (d === 0) {
                continue;
            } else {
                break;
            }
        }

        let adaptiveHour = 9;
        if (totalRevlogs >= 5) {
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
            adaptiveHour,
        };
    }

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
        const summary = this.computeDueSummary(prefs);

        const nowMs = Date.now();
        const localParts = getLocalTimeParts(nowMs, prefs);

        let learnCandidateMs: number | null = null;
        const lastActivityMs = Number(this.getMeta("last_activity_ms") || 0);
        const lastLearnPushMs = Number(this.getMeta("last_learn_push_ms") || 0);

        if (
            prefs.learningAlerts
            && summary.earliestLearnDueSec !== null
            && lastLearnPushMs < lastActivityMs
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
                nowMs + 30_000,
            );
        }

        let targetHour = summary.adaptiveHour;
        let targetMinute = 0;
        if (prefs.dailyMode === "fixed") {
            const [hStr, mStr] = prefs.dailyTime.split(":");
            targetHour = Math.min(23, Math.max(0, Number(hStr) || 9));
            targetMinute = Math.min(59, Math.max(0, Number(mStr) || 0));
        }

        const todayTargetUtcMs = localParts.midnightUtcMs + (targetHour * 60 + targetMinute) * 60_000;
        const lastDailySentDate = this.getMeta("last_daily_push_date") || "";

        let dailyCandidateMs: number;
        if (
            !summary.studiedToday
            && lastDailySentDate !== localParts.dateStr
            && todayTargetUtcMs > nowMs + 15_000
        ) {
            dailyCandidateMs = todayTargetUtcMs;
        } else {
            dailyCandidateMs = todayTargetUtcMs + 86_400_000;
        }

        const nextAlarmMs = learnCandidateMs !== null
            ? Math.min(learnCandidateMs, dailyCandidateMs)
            : dailyCandidateMs;

        await this.ctx.storage.setAlarm(nextAlarmMs);
        this.setMeta("next_alarm_ms", String(nextAlarmMs));
        return nextAlarmMs;
    }

    async alarm(): Promise<void> {
        const subRows = this.sql
            .exec("SELECT COUNT(*) as count FROM push_subscriptions")
            .toArray();
        if (!Number(subRows[0]?.count || 0) || !this.isVapidReady()) {
            return;
        }

        const prefs = this.getPushPreferences();
        const summary = this.computeDueSummary(prefs);
        const config = this.getVapidConfig();

        const nowMs = Date.now();
        const lastActivityMs = Number(this.getMeta("last_activity_ms") || 0);
        const lastLearnPushMs = Number(this.getMeta("last_learn_push_ms") || 0);

        const hasOpenSockets = this.ctx
            .getWebSockets()
            .some(ws => ws.readyState === WebSocket.OPEN);
        if (hasOpenSockets && nowMs - lastActivityMs < 90_000) {
            await this.recomputeAndScheduleAlarm();
            return;
        }

        const localParts = getLocalTimeParts(nowMs, prefs);
        let targetHour = summary.adaptiveHour;
        let targetMinute = 0;
        if (prefs.dailyMode === "fixed") {
            const [hStr, mStr] = prefs.dailyTime.split(":");
            targetHour = Math.min(23, Math.max(0, Number(hStr) || 9));
            targetMinute = Math.min(59, Math.max(0, Number(mStr) || 0));
        }
        const todayTargetUtcMs = localParts.midnightUtcMs + (targetHour * 60 + targetMinute) * 60_000;
        const lastDailySentDate = this.getMeta("last_daily_push_date") || "";

        let transientFailure = false;

        if (
            prefs.learningAlerts
            && summary.learnDueCount > 0
            && lastLearnPushMs < lastActivityMs
        ) {
            const count = summary.learnDueCount;
            const payload: PushPayload = {
                title: `klanki: ${count} Learning ${count === 1 ? "Card" : "Cards"} Due`,
                body: `Your learning step in ${summary.topDeckName} is ready to review.`,
                url: "/",
                tag: "klanki-learn-due",
            };
            const results = await this.broadcastPushNotification(payload, config);
            // Only mark delivered if at least one subscription succeeded (N08)
            if (results.sent > 0) {
                this.setMeta("last_learn_push_ms", String(nowMs));
            } else if (results.failed > 0) {
                transientFailure = true;
            }
        } else if (
            nowMs >= todayTargetUtcMs - 60_000
            && !summary.studiedToday
            && lastDailySentDate !== localParts.dateStr
        ) {
            const dueTotal = summary.learnDueCount + summary.reviewDueCount;
            const streakSuffix = summary.streakDays >= 2 ? ` (${summary.streakDays}-day streak)` : "";

            if (dueTotal > 0 || summary.newCount > 0) {
                const payload: PushPayload = dueTotal > 0
                    ? {
                        title: `klanki: ${dueTotal} ${dueTotal === 1 ? "Card" : "Cards"} Due Today`,
                        body: `Ready in ${summary.topDeckName}${
                            summary.newCount > 0 ? ` + ${Math.min(20, summary.newCount)} new` : ""
                        }${streakSuffix}.`,
                        url: "/",
                        tag: "klanki-daily-due",
                    }
                    : {
                        title: "klanki: Daily Study Reminder",
                        body: `${
                            Math.min(20, summary.newCount)
                        } new cards waiting in ${summary.topDeckName}${streakSuffix}.`,
                        url: "/",
                        tag: "klanki-daily-due",
                    };

                const results = await this.broadcastPushNotification(payload, config);
                if (results.sent > 0) {
                    this.setMeta("last_daily_push_date", localParts.dateStr);
                } else if (results.failed > 0) {
                    transientFailure = true;
                }
            }
        }

        if (transientFailure) {
            // Retry in 15 minutes on transient push delivery failure (N08)
            const retryAt = Date.now() + 15 * 60_000;
            await this.ctx.storage.setAlarm(retryAt);
            this.setMeta("next_alarm_ms", String(retryAt));
            return;
        }

        await this.recomputeAndScheduleAlarm();
    }

    /**
     * Enforce rate limit on manual push trigger endpoints (S05).
     */
    private checkPushTriggerRateLimit(): { allowed: boolean; error?: string } {
        const now = Date.now();
        const lastTrigger = Number(this.getMeta("last_push_trigger_ms") || 0);
        if (now - lastTrigger < 5_000) {
            return {
                allowed: false,
                error: "Please wait a few seconds before sending another notification.",
            };
        }
        this.setMeta("last_push_trigger_ms", String(now));
        return { allowed: true };
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
                body.exp,
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

        // 2. Complete Account Data Deletion Lifecycle (S10)
        if (url.pathname === "/account-data" && request.method === "DELETE") {
            await this.ctx.storage.deleteAlarm();
            const deletedRevision = this.getRevision() + 1;
            this.ctx.storage.transactionSync(() => {
                this.sql.exec("DELETE FROM col_meta");
                this.sql.exec("DELETE FROM decks");
                this.sql.exec("DELETE FROM dconf");
                this.sql.exec("DELETE FROM models");
                this.sql.exec("DELETE FROM notes");
                this.sql.exec("DELETE FROM cards");
                this.sql.exec("DELETE FROM revlog");
                this.sql.exec("DELETE FROM media");
                this.sql.exec("DELETE FROM push_subscriptions");
                this.sql.exec("DELETE FROM ws_tickets");
                this.sql.exec("DELETE FROM applied_ops");
                this.setMeta("col_revision", String(deletedRevision));
                this.setMeta("col_generation", crypto.randomUUID());
                this.setDeletionTombstone();
            });
            for (const ws of this.ctx.getWebSockets()) {
                try {
                    ws.close(1000, "Account data deleted");
                } catch {
                    // ignore
                }
            }
            return Response.json({ success: true });
        }

        // 3. HTTP Collection & Backup Restore Endpoints (D07)
        if (url.pathname === "/collection") {
            if (request.method === "GET") {
                const col = this.getFullCollection();
                return Response.json({
                    ...col,
                    revision: this.getRevision(),
                    generation: this.getMeta("col_generation") ?? "0",
                    initialized: this.isInitialized(),
                    hasBackup: Boolean(this.getMeta("backup_snapshot")),
                });
            }
            if (request.method === "POST") {
                const body: Collection & {
                    expectedRevision?: unknown;
                    opId?: string;
                    generation?: string;
                    seedOnUninitialized?: boolean;
                } = await request.json();
                if (!body || typeof body !== "object" || Array.isArray(body)) {
                    return Response.json({ error: "Collection must be an object" }, { status: 400 });
                }
                const { expectedRevision, opId, generation, seedOnUninitialized, ...collection } = body;
                const validation = validateClientMessage({
                    type: "import_collection",
                    collection,
                    expectedRevision,
                    opId,
                    generation,
                    seedOnUninitialized,
                });
                if (!validation.ok) {
                    return Response.json({ error: validation.error }, { status: 400 });
                }
                if (
                    (body.generation ?? "0") !== (this.getMeta("col_generation") ?? "0")
                    || (body.seedOnUninitialized && this.getDeletionTombstone())
                ) {
                    return Response.json({
                        error: "Collection was deleted; reload before importing.",
                        currentRevision: this.getRevision(),
                    }, { status: 410 });
                }
                const applied = this.getAlreadyAppliedRevision(body.opId);
                if (applied !== null) { return Response.json({ success: true, revision: applied }); }
                // Compare-and-swap guard: never let a stale client blindly replace newer data (D02).
                const cas = this.checkExpectedRevision(body.expectedRevision);
                if (!cas.ok) {
                    return Response.json(
                        { error: cas.error, currentRevision: this.getRevision() },
                        { status: 409 },
                    );
                }
                const revision = this.saveFullCollection(collection, body.opId);
                // A deliberate full replacement through this endpoint clears the deletion tombstone.
                this.clearDeletionTombstone();
                this.setMeta("last_activity_ms", String(Date.now()));
                await this.recomputeAndScheduleAlarm();
                this.broadcast({
                    type: "full_state",
                    generation: this.getMeta("col_generation") ?? "0",
                    collection,
                    revision,
                    initialized: true,
                    hasBackup: Boolean(this.getMeta("backup_snapshot")),
                });
                return Response.json({ success: true, revision });
            }
        }

        if (url.pathname === "/collection/restore-backup" && request.method === "POST") {
            const body = (await request.json().catch(() => null)) as
                | { expectedRevision?: unknown }
                | null;
            const cas = this.checkExpectedRevision(body?.expectedRevision);
            if (!cas.ok) {
                return Response.json({ error: cas.error, currentRevision: this.getRevision() }, { status: 409 });
            }
            const backupRaw = this.getMeta("backup_snapshot");
            if (!backupRaw) {
                return Response.json({ error: "No backup snapshot available" }, { status: 404 });
            }
            const backupCol: Collection = JSON.parse(backupRaw);
            const currentMedia = this.getFullCollection(true).media;
            backupCol.media = { ...currentMedia, ...(backupCol.media || {}) };
            const revision = this.saveFullCollection(backupCol);
            this.clearDeletionTombstone();
            await this.recomputeAndScheduleAlarm();
            this.broadcast({
                type: "full_state",
                generation: this.getMeta("col_generation") ?? "0",
                collection: backupCol,
                revision,
                initialized: true,
                hasBackup: true,
            });
            return Response.json({ success: true, revision, collection: backupCol });
        }

        // 4. Web Push API Endpoints
        if (url.pathname === "/push/vapid-public-key") {
            const config = this.getVapidConfig();
            return Response.json({
                publicKey: config.publicKey,
                vapidConfigured: this.isVapidReady(),
            });
        }

        if (url.pathname === "/push/subscribe" && request.method === "POST") {
            try {
                const sub: PushSubscriptionData & { tzOffsetMinutes?: number; timeZone?: string } = await request
                    .json();
                const validation = validatePushSubscriptionInput(sub);
                if (!validation.ok) {
                    return Response.json({ error: validation.error }, { status: 400 });
                }

                const now = Date.now();
                // Per-subscription secret: issued to the subscribing device and required later to
                // detach this endpoint from a *different* user's DO (S03). Caller-supplied user IDs
                // alone are never sufficient authorization for cross-account mutations.
                const secretBytes = new Uint8Array(32);
                crypto.getRandomValues(secretBytes);
                const unsubSecret = Array.from(secretBytes)
                    .map(b => b.toString(16).padStart(2, "0"))
                    .join("");

                this.sql.exec(
                    "INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created_at, updated_at, unsub_secret) VALUES (?, ?, ?, ?, ?, ?)",
                    sub.endpoint,
                    sub.keys.p256dh,
                    sub.keys.auth,
                    now,
                    now,
                    unsubSecret,
                );

                // Enforce maximum 10 subscriptions per user, pruning oldest (S04)
                this.sql.exec(`
          DELETE FROM push_subscriptions
          WHERE endpoint NOT IN (
            SELECT endpoint FROM push_subscriptions ORDER BY updated_at DESC LIMIT 10
          )
        `);

                // Only initialize timezone if not already explicitly configured (N05, N06)
                const prefs = this.getPushPreferences();
                let prefsChanged = false;
                if (!prefs.timeZone || prefs.timeZone === "UTC") {
                    if (isValidTimeZone(sub.timeZone)) {
                        prefs.timeZone = sub.timeZone;
                        prefsChanged = true;
                    }
                    if (typeof sub.tzOffsetMinutes === "number") {
                        prefs.tzOffsetMinutes = sub.tzOffsetMinutes;
                        prefsChanged = true;
                    }
                }
                if (prefsChanged) {
                    this.savePushPreferences(prefs);
                }

                const nextAlarmAt = await this.recomputeAndScheduleAlarm();
                return Response.json({ success: true, nextAlarmAt, unsubSecret });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500 });
            }
        }

        // Internal route used during account switching (S03): an authenticated caller may forward
        // a detach for the PREVIOUS user's subscription, but the previous user's DO only honours
        // it when the caller proves possession of the per-subscription unsubscribe secret.
        if (url.pathname === "/push/detach" && request.method === "POST") {
            try {
                const body: { endpoint?: string; unsubSecret?: string } = await request.json();
                if (
                    body?.endpoint
                    && typeof body.endpoint === "string"
                    && body?.unsubSecret
                    && typeof body.unsubSecret === "string"
                ) {
                    this.sql.exec(
                        "DELETE FROM push_subscriptions WHERE endpoint = ? AND unsub_secret = ?",
                        body.endpoint,
                        body.unsubSecret,
                    );
                }
                await this.recomputeAndScheduleAlarm();
                // Intentionally identical response whether or not the record existed (no oracle).
                return Response.json({ success: true });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500 });
            }
        }

        if (url.pathname === "/push/unsubscribe" && request.method === "POST") {
            try {
                const body: { endpoint: string } = await request.json();
                if (body?.endpoint && typeof body.endpoint === "string") {
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
                    dailyMode: incoming.dailyMode === "fixed"
                        ? "fixed"
                        : incoming.dailyMode === "adaptive"
                        ? "adaptive"
                        : current.dailyMode,
                    dailyTime: typeof incoming.dailyTime === "string" && /^\d{2}:\d{2}$/.test(incoming.dailyTime)
                        ? incoming.dailyTime
                        : current.dailyTime,
                    tzOffsetMinutes: typeof incoming.tzOffsetMinutes === "number"
                        ? incoming.tzOffsetMinutes
                        : current.tzOffsetMinutes,
                    timeZone: isValidTimeZone(incoming.timeZone) ? incoming.timeZone : current.timeZone,
                    learningAlerts: typeof incoming.learningAlerts === "boolean"
                        ? incoming.learningAlerts
                        : current.learningAlerts,
                };
                this.savePushPreferences(updated);
                const nextAlarmAt = await this.recomputeAndScheduleAlarm();
                const dueSummary = this.computeDueSummary(updated);
                return Response.json({
                    success: true,
                    preferences: updated,
                    nextAlarmAt,
                    dueSummary,
                });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500 });
            }
        }

        if (url.pathname === "/push/status") {
            const rows = this.sql.exec("SELECT COUNT(*) as count FROM push_subscriptions").toArray();
            const prefs = this.getPushPreferences();
            const dueSummary = this.computeDueSummary(prefs);
            const nextAlarmAt = await this.recomputeAndScheduleAlarm();
            return Response.json({
                subscriptions: rows[0]?.count || 0,
                vapidConfigured: this.isVapidReady(),
                preferences: prefs,
                nextAlarmAt,
                dueSummary,
            });
        }

        if (url.pathname === "/push/send-test" && request.method === "POST") {
            const rateLimit = this.checkPushTriggerRateLimit();
            if (!rateLimit.allowed) {
                return Response.json({ error: rateLimit.error }, { status: 429 });
            }
            try {
                const body = (await request.json().catch(() => ({}))) as {
                    endpoint?: string;
                    title?: string;
                    body?: string;
                };
                const payload: PushPayload = {
                    title: String(body.title || "klanki Test Notification").slice(0, 120),
                    body: String(body.body || "Web Push is working on this device.").slice(0, 300),
                    url: "/",
                    tag: "klanki-test",
                };

                const config = this.getVapidConfig();
                const results = await this.broadcastPushNotification(payload, config, body.endpoint);
                return Response.json(results);
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500 });
            }
        }

        if (url.pathname === "/push/notify-due" && request.method === "POST") {
            const rateLimit = this.checkPushTriggerRateLimit();
            if (!rateLimit.allowed) {
                return Response.json({ error: rateLimit.error }, { status: 429 });
            }
            try {
                const body = (await request.json().catch(() => ({}))) as {
                    title?: string;
                    body?: string;
                };
                const prefs = this.getPushPreferences();
                const summary = this.computeDueSummary(prefs);
                const dueTotal = summary.learnDueCount + summary.reviewDueCount;

                const payload: PushPayload = {
                    title: String(
                        body.title
                            || (dueTotal > 0
                                ? `klanki: ${dueTotal} ${dueTotal === 1 ? "Card" : "Cards"} Due`
                                : "klanki: Study Reminder"),
                    ).slice(0, 120),
                    body: String(
                        body.body
                            || (dueTotal > 0
                                ? `${dueTotal} due in ${summary.topDeckName}${
                                    summary.newCount > 0 ? ` + ${Math.min(20, summary.newCount)} new` : ""
                                }.`
                                : `${Math.min(20, summary.newCount)} new cards ready in ${summary.topDeckName}.`),
                    ).slice(0, 300),
                    url: "/",
                    tag: "klanki-due-review",
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
        targetEndpoint?: string,
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
                    auth: row.auth,
                },
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

    private sendAck(ws: WebSocket, opId: string | undefined, revision: number) {
        if (!opId) { return; }
        try {
            ws.send(JSON.stringify({ type: "ack", opId, revision } satisfies ServerMessage));
        } catch {
            // ignore
        }
    }

    private sendOpError(
        ws: WebSocket,
        opId: string | undefined,
        error: string,
        kind?: OpErrorKind,
        retryable?: boolean,
    ) {
        try {
            ws.send(
                JSON.stringify(
                    {
                        type: "op_error",
                        opId,
                        error,
                        kind,
                        retryable,
                        revision: this.getRevision(),
                    } satisfies ServerMessage,
                ),
            );
        } catch {
            // ignore
        }
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        if (typeof message !== "string") { return; }

        let raw: any;
        try {
            raw = JSON.parse(message);
        } catch {
            this.sendOpError(ws, undefined, "Invalid JSON payload");
            return;
        }

        const validation = validateClientMessage(raw);
        if (!validation.ok) {
            this.sendOpError(ws, raw?.opId, validation.error);
            return;
        }

        const msg = validation.msg;

        try {
            if (msg.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
                return;
            }

            if (msg.type === "init") {
                const col = this.getFullCollection();
                ws.send(
                    JSON.stringify(
                        {
                            type: "full_state",
                            generation: this.getMeta("col_generation") ?? "0",
                            collection: col,
                            revision: this.getRevision(),
                            initialized: this.isInitialized(),
                            hasBackup: Boolean(this.getMeta("backup_snapshot")),
                            deleted: Boolean(this.getDeletionTombstone()),
                        } satisfies ServerMessage,
                    ),
                );
                return;
            }

            // Deduplicate replayed operations by opId (D01, D05, D12)
            const opId = "opId" in msg ? msg.opId : undefined;
            if (
                (msg.generation ?? "0") !== (this.getMeta("col_generation") ?? "0")
                || (this.getDeletionTombstone() && msg.type !== "import_collection")
            ) {
                this.sendOpError(
                    ws,
                    opId,
                    "Collection generation was deleted; reload before making changes.",
                    "deleted",
                    false,
                );
                return;
            }
            const alreadyRev = this.getAlreadyAppliedRevision(opId);
            if (alreadyRev !== null) {
                this.sendAck(ws, opId, alreadyRev);
                return;
            }

            if (msg.type === "answer_card") {
                let rev = 0;
                let finalState: Partial<Card> = msg.nextState;
                const revlogEntry: RevlogEntry = { ...msg.revlogEntry };

                this.ctx.storage.transactionSync(() => {
                    const row = this.sql.exec("SELECT json FROM cards WHERE id = ?", msg.cardId).toArray();
                    if (row.length > 0) {
                        const card: Card = JSON.parse(row[0].json);
                        // Reconcile concurrent reviews (D05): ensure reps never regresses
                        const nextReps = Math.max((card.reps || 0) + 1, msg.nextState.reps || 0);
                        Object.assign(card, msg.nextState, {
                            reps: nextReps,
                            mod: Math.floor(Date.now() / 1000),
                        });
                        finalState = card;
                        this.sql.exec("UPDATE cards SET json = ? WHERE id = ?", JSON.stringify(card), card.id);
                    }

                    // Prevent revlog ID collision from overwriting prior history (D11)
                    while (
                        this.sql
                            .exec("SELECT id FROM revlog WHERE id = ?", revlogEntry.id)
                            .toArray().length > 0
                    ) {
                        revlogEntry.id++;
                    }

                    this.sql.exec(
                        "INSERT INTO revlog (id, json) VALUES (?, ?)",
                        revlogEntry.id,
                        JSON.stringify(revlogEntry),
                    );
                    this.setMeta("last_activity_ms", String(Date.now()));
                    rev = this.bumpRevision(opId);
                });

                this.sendAck(ws, opId, rev);
                await this.recomputeAndScheduleAlarm();
                this.broadcast(
                    {
                        type: "answer_card",
                        opId,
                        cardId: msg.cardId,
                        nextState: finalState,
                        revlogEntry,
                        revision: rev,
                    },
                    ws,
                );
                return;
            }

            if (msg.type === "upsert_deck") {
                let rev = 0;
                this.ctx.storage.transactionSync(() => {
                    // Reject conflicting inserts for brand-new decks instead of replacing unrelated
                    // records that a different device created with the same ID (D06).
                    if (msg.isNew) {
                        const existing = this.sql
                            .exec("SELECT id FROM decks WHERE id = ?", msg.deck.id)
                            .toArray();
                        if (existing.length > 0) {
                            throw new OpError(
                                `ID collision: deck ${msg.deck.id} already exists on the server.`,
                                "id_collision",
                                true,
                            );
                        }
                    }
                    this.sql.exec(
                        "INSERT OR REPLACE INTO decks (id, json) VALUES (?, ?)",
                        msg.deck.id,
                        JSON.stringify(msg.deck),
                    );
                    rev = this.bumpRevision(opId);
                });
                this.sendAck(ws, opId, rev);
                this.broadcast({ type: "upsert_deck", opId, deck: msg.deck, revision: rev }, ws);
                return;
            }

            if (msg.type === "delete_deck") {
                // Transactional cascading deletion of deck, subdecks, associated cards, and orphaned notes (D03)
                let rev = 0;
                const deletedDeckIds: number[] = [];
                const deletedCardIds: number[] = [];
                const deletedNoteIds: number[] = [];

                this.ctx.storage.transactionSync(() => {
                    const allDecks: Deck[] = this.sql
                        .exec("SELECT json FROM decks")
                        .toArray()
                        .map((r: any) => JSON.parse(r.json));
                    const target = allDecks.find(d => d.id === msg.deckId);
                    const prefix = target ? `${target.name}::` : null;

                    const deckSet = new Set<number>([msg.deckId]);
                    if (prefix) {
                        for (const d of allDecks) {
                            if (d.name.startsWith(prefix)) {
                                deckSet.add(d.id);
                            }
                        }
                    }

                    for (const did of deckSet) {
                        if (did === 1) { continue; }
                        this.sql.exec("DELETE FROM decks WHERE id = ?", did);
                        deletedDeckIds.push(did);
                    }

                    const remainingNoteIds = new Set<number>();
                    const affectedNoteIds = new Set<number>();

                    for (const row of this.sql.exec("SELECT id, json FROM cards").toArray()) {
                        const c: Card = JSON.parse(row.json);
                        if (deckSet.has(c.did)) {
                            this.sql.exec("DELETE FROM cards WHERE id = ?", c.id);
                            deletedCardIds.push(c.id);
                            affectedNoteIds.add(c.nid);
                        } else {
                            remainingNoteIds.add(c.nid);
                        }
                    }

                    for (const nid of affectedNoteIds) {
                        if (!remainingNoteIds.has(nid)) {
                            this.sql.exec("DELETE FROM notes WHERE id = ?", nid);
                            deletedNoteIds.push(nid);
                        }
                    }

                    rev = this.bumpRevision(opId);
                });

                this.sendAck(ws, opId, rev);
                await this.recomputeAndScheduleAlarm();
                // Broadcast authoritative cascading delete to all clients (including sender so state matches)
                this.broadcast({
                    type: "delete_deck",
                    opId,
                    deckId: msg.deckId,
                    deletedDeckIds,
                    deletedCardIds,
                    deletedNoteIds,
                    revision: rev,
                });
                return;
            }

            if (msg.type === "upsert_deck_config") {
                let rev = 0;
                this.ctx.storage.transactionSync(() => {
                    this.sql.exec(
                        "INSERT OR REPLACE INTO dconf (id, json) VALUES (?, ?)",
                        msg.dconf.id,
                        JSON.stringify(msg.dconf),
                    );
                    rev = this.bumpRevision(opId);
                });
                this.sendAck(ws, opId, rev);
                this.broadcast({ type: "upsert_deck_config", opId, dconf: msg.dconf, revision: rev }, ws);
                return;
            }

            if (msg.type === "upsert_note") {
                let rev = 0;
                this.ctx.storage.transactionSync(() => {
                    // Reject conflicting inserts for brand-new notes/cards instead of replacing
                    // unrelated records that another device created with the same ID (D06).
                    if (msg.isNew) {
                        const existingNote = this.sql
                            .exec("SELECT id FROM notes WHERE id = ?", msg.note.id)
                            .toArray();
                        if (existingNote.length > 0) {
                            throw new OpError(
                                `ID collision: note ${msg.note.id} already exists on the server.`,
                                "id_collision",
                                true,
                            );
                        }
                        for (const card of msg.cards) {
                            const existingCard = this.sql
                                .exec("SELECT id FROM cards WHERE id = ?", card.id)
                                .toArray();
                            if (existingCard.length > 0) {
                                throw new OpError(
                                    `ID collision: card ${card.id} already exists on the server.`,
                                    "id_collision",
                                    true,
                                );
                            }
                        }
                    }
                    this.sql.exec(
                        "INSERT OR REPLACE INTO notes (id, json) VALUES (?, ?)",
                        msg.note.id,
                        JSON.stringify(msg.note),
                    );
                    for (const card of msg.cards) {
                        this.sql.exec(
                            "INSERT OR REPLACE INTO cards (id, json) VALUES (?, ?)",
                            card.id,
                            JSON.stringify(card),
                        );
                    }
                    this.setMeta("last_activity_ms", String(Date.now()));
                    rev = this.bumpRevision(opId);
                });
                this.sendAck(ws, opId, rev);
                await this.recomputeAndScheduleAlarm();
                this.broadcast(
                    { type: "upsert_note", opId, note: msg.note, cards: msg.cards, revision: rev },
                    ws,
                );
                return;
            }

            if (msg.type === "delete_note") {
                // Derive all associated card IDs directly from server storage by nid (D04)
                let rev = 0;
                const removedCardIds = new Set<number>(msg.cardIds || []);

                this.ctx.storage.transactionSync(() => {
                    for (const row of this.sql.exec("SELECT id, json FROM cards").toArray()) {
                        const c: Card = JSON.parse(row.json);
                        if (c.nid === msg.noteId) {
                            removedCardIds.add(c.id);
                        }
                    }
                    for (const cid of removedCardIds) {
                        this.sql.exec("DELETE FROM cards WHERE id = ?", cid);
                    }
                    this.sql.exec("DELETE FROM notes WHERE id = ?", msg.noteId);
                    rev = this.bumpRevision(opId);
                });

                const authoritativeCardIds = Array.from(removedCardIds);
                this.sendAck(ws, opId, rev);
                await this.recomputeAndScheduleAlarm();
                this.broadcast({
                    type: "delete_note",
                    opId,
                    noteId: msg.noteId,
                    cardIds: authoritativeCardIds,
                    revision: rev,
                });
                return;
            }

            if (msg.type === "update_card") {
                let rev = 0;
                this.ctx.storage.transactionSync(() => {
                    this.sql.exec(
                        "INSERT OR REPLACE INTO cards (id, json) VALUES (?, ?)",
                        msg.card.id,
                        JSON.stringify(msg.card),
                    );
                    this.setMeta("last_activity_ms", String(Date.now()));
                    rev = this.bumpRevision(opId);
                });
                this.sendAck(ws, opId, rev);
                await this.recomputeAndScheduleAlarm();
                this.broadcast({ type: "update_card", opId, card: msg.card, revision: rev }, ws);
                return;
            }

            if (msg.type === "save_media") {
                let rev = 0;
                this.ctx.storage.transactionSync(() => {
                    this.sql.exec(
                        "INSERT OR REPLACE INTO media (name, data) VALUES (?, ?)",
                        msg.filename,
                        msg.dataUrl,
                    );
                    rev = this.bumpRevision(opId);
                });
                this.sendAck(ws, opId, rev);
                this.broadcast(
                    { type: "save_media", opId, filename: msg.filename, dataUrl: msg.dataUrl, revision: rev },
                    ws,
                );
                return;
            }

            if (msg.type === "import_collection") {
                // S10: a stale device must never be able to silently re-seed a deleted collection.
                if (msg.seedOnUninitialized && this.getDeletionTombstone() && !this.isInitialized()) {
                    this.sendOpError(
                        ws,
                        opId,
                        "This collection was deleted on another device; automatic restore is disabled.",
                        "deleted",
                        false,
                    );
                    this.broadcast(
                        {
                            type: "full_state",
                            generation: this.getMeta("col_generation") ?? "0",
                            collection: this.getFullCollection(),
                            revision: this.getRevision(),
                            initialized: false,
                            deleted: true,
                        },
                        ws,
                    );
                    return;
                }

                // Compare-and-swap: whole-collection overwrites must be anchored to the server
                // revision the client last saw; stale clients cannot replace newer data (D02).
                const cas = this.checkExpectedRevision(msg.expectedRevision);
                if (!cas.ok) {
                    this.sendOpError(ws, opId, cas.error || "Revision conflict", "conflict_revision", true);
                    // Give the client a fresh authoritative snapshot so it can reconcile.
                    this.broadcast(
                        {
                            type: "full_state",
                            generation: this.getMeta("col_generation") ?? "0",
                            collection: this.getFullCollection(),
                            revision: this.getRevision(),
                            initialized: this.isInitialized(),
                            hasBackup: Boolean(this.getMeta("backup_snapshot")),
                        },
                        ws,
                    );
                    return;
                }

                const rev = this.saveFullCollection(msg.collection, opId);
                // A deliberate, version-checked full import clears the deletion tombstone.
                this.clearDeletionTombstone();
                this.setMeta("last_activity_ms", String(Date.now()));
                this.sendAck(ws, opId, rev);
                await this.recomputeAndScheduleAlarm();
                this.broadcast(
                    { type: "import_collection", opId, collection: msg.collection, revision: rev },
                    ws,
                );
                return;
            }
        } catch (e: any) {
            console.error("Error processing websocket message:", e);
            this.sendOpError(
                ws,
                "opId" in msg ? msg.opId : undefined,
                e?.message || "Server error",
                e?.kind,
                e?.retryable,
            );
        }
    }

    async webSocketClose(_ws: WebSocket) {
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
