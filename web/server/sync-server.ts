// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { DurableObject } from "cloudflare:workers";
import { normalizeMediaFilename } from "../src/core/media-validation";
import {
    addCalendarDays,
    getZonedDayInfo,
    isCardDueForReview,
    isCardDueInLearnQueue,
    isValidDailyTime,
    isValidTimeZone,
    zonedTimeToUtcMs,
} from "../src/core/scheduler";
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
import { validateClientMessage, validatePushSubscriptionInput } from "./validation";

const MAX_WS_MESSAGE_BYTES = 16 * 1024 * 1024; // 16 MB max WebSocket message (SEC-09)
const MAX_WS_STANDARD_BYTES = 1 * 1024 * 1024; // 1 MB max for non-import/non-media messages (SEC-09)
const MAX_CONCURRENT_SOCKETS = 10; // Max concurrent WebSockets per user DO (SEC-09)
const MAX_INIT_PER_MINUTE = 30;

// M-01: Per-account aggregate storage & item quotas
export const MAX_ACCOUNT_MEDIA_ITEMS = 2_500;
export const MAX_ACCOUNT_MEDIA_DATA_CHARS = 70 * 1024 * 1024; // ~50 MB decoded media per account
export const MAX_ACCOUNT_DECKS = 2_000;
export const MAX_ACCOUNT_NOTES = 60_000;
export const MAX_ACCOUNT_CARDS = 60_000;

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
    dailyTime: string; // "HH:MM", 00:00..23:59 (L-04)
    tzOffsetMinutes: number;
    timeZone?: string; // IANA timezone, e.g. "Europe/Stockholm" (N05, N06)
    learningAlerts: boolean;
    /** Privacy setting (SEC-10): only include deck names in push notifications when explicitly enabled. */
    includeDeckName?: boolean;
}

const DEFAULT_PUSH_PREFS: PushPreferences = {
    dailyMode: "adaptive",
    dailyTime: "09:00",
    tzOffsetMinutes: 0,
    timeZone: "UTC",
    learningAlerts: true,
    includeDeckName: false,
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
    private dueSummaryCache: { key: string; summary: DueSummary } | null = null;
    private initRateWindowStartMs: number = 0;
    private initRateCount: number = 0;

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
      CREATE TABLE IF NOT EXISTS backup_media (
        name TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backup_snapshot_parts (
        part INTEGER PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staged_import_media (
        import_op_id TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (import_op_id, name)
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
        applied_at INTEGER NOT NULL,
        ack_extra TEXT NOT NULL DEFAULT ''
      );
    `);

        try {
            this.sql.exec(
                "ALTER TABLE push_subscriptions ADD COLUMN unsub_secret TEXT NOT NULL DEFAULT ''",
            );
        } catch {
            // Column already exists.
        }
        try {
            this.sql.exec(
                "ALTER TABLE applied_ops ADD COLUMN ack_extra TEXT NOT NULL DEFAULT ''",
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

    /** Split serialized backups into SQLite-safe UTF-8 text rows. */
    private setBackupSnapshot(col: Collection): void {
        const payload = new TextEncoder().encode(JSON.stringify(col));
        const fragmentSize = 1024 * 1024;
        const decoder = new TextDecoder();
        this.sql.exec("DELETE FROM backup_snapshot_parts");
        for (let part = 0, start = 0; start < payload.length; part++) {
            let end = Math.min(start + fragmentSize, payload.length);
            while (end < payload.length && (payload[end] & 0xc0) === 0x80) { end--; }
            this.sql.exec(
                "INSERT INTO backup_snapshot_parts (part, data) VALUES (?, ?)",
                part,
                decoder.decode(payload.subarray(start, end)),
            );
            start = end;
        }
        this.setMeta("backup_snapshot", "chunked:v1");
    }

    private readBackupSnapshot(): Collection | null {
        const raw = this.getMeta("backup_snapshot");
        if (!raw) { return null; }
        if (raw !== "chunked:v1") { return JSON.parse(raw) as Collection; }
        const parts = this.sql.exec("SELECT part, data FROM backup_snapshot_parts ORDER BY part ASC").toArray();
        if (!parts.length) { throw new Error("Backup manifest exists but its data is missing"); }
        for (let i = 0; i < parts.length; i++) {
            if (Number(parts[i].part) !== i) { throw new Error("Backup snapshot has missing chunks"); }
        }
        return JSON.parse(parts.map((row: any) => String(row.data)).join("")) as Collection;
    }

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

    private checkExpectedRevision(
        expectedRevision: unknown,
        forceOverwrite?: boolean,
    ): { ok: boolean; error?: string } {
        if (forceOverwrite === true) {
            return { ok: true };
        }
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

    private bumpRevision(
        opId?: string,
        ackExtra?: {
            cardId?: number;
            cardState?: Card;
            revlogEntry?: RevlogEntry;
            originalRevlogId?: number;
        },
    ): number {
        const next = this.getRevision() + 1;
        this.setMeta("col_revision", String(next));
        this.setMeta("col_initialized", "1");
        this.dueSummaryCache = null;
        // A-09: Bound idempotency-key growth while preserving a one-year replay window
        // for clients that have been offline for extended periods.
        if (next % 1024 === 0) {
            this.sql.exec("DELETE FROM applied_ops WHERE applied_at < ?", Date.now() - 365 * 86_400_000);
        }
        if (opId) {
            const now = Date.now();
            this.sql.exec(
                "INSERT OR REPLACE INTO applied_ops (op_id, revision, applied_at, ack_extra) VALUES (?, ?, ?, ?)",
                opId,
                next,
                now,
                ackExtra ? JSON.stringify(ackExtra) : "",
            );
        }
        return next;
    }

    private getAlreadyAppliedOp(opId?: string): { revision: number; extra?: Record<string, any> } | null {
        if (!opId) { return null; }
        const rows = this.sql
            .exec("SELECT revision, ack_extra FROM applied_ops WHERE op_id = ?", opId)
            .toArray();
        if (rows.length === 0) { return null; }
        let extra: Record<string, any> | undefined;
        if (rows[0].ack_extra) {
            try {
                extra = JSON.parse(String(rows[0].ack_extra));
            } catch {
                extra = undefined;
            }
        }
        return { revision: Number(rows[0].revision), extra };
    }

    private getAlreadyAppliedRevision(opId?: string): number | null {
        return this.getAlreadyAppliedOp(opId)?.revision ?? null;
    }

    /**
     * Enforce per-account media count and byte-size quotas on incremental uploads (M-01).
     */
    private checkAccountMediaQuota(filename: string, dataUrl: string): void {
        const stats = this.sql
            .exec(
                "SELECT COUNT(*) as cnt, COALESCE(SUM(LENGTH(data)), 0) as total_chars FROM media WHERE name != ?",
                filename,
            )
            .toArray()[0];
        const existingCount = Number(stats?.cnt || 0);
        const existingChars = Number(stats?.total_chars || 0);

        if (existingCount + 1 > MAX_ACCOUNT_MEDIA_ITEMS) {
            throw new OpError(
                `Account media item limit exceeded (max ${MAX_ACCOUNT_MEDIA_ITEMS} files). Clean up unused media in Settings.`,
                "validation",
                false,
            );
        }
        if (existingChars + dataUrl.length > MAX_ACCOUNT_MEDIA_DATA_CHARS) {
            throw new OpError(
                "Account media storage quota exceeded (max 50 MB). Clean up unused media in Settings.",
                "validation",
                false,
            );
        }
    }

    private getMediaManifest(): string[] {
        return this.sql
            .exec("SELECT name FROM media ORDER BY name ASC")
            .toArray()
            .map((r: any) => String(r.name));
    }

    private getPushPreferences(): PushPreferences {
        const raw = this.getMeta("push_preferences");
        if (!raw) { return { ...DEFAULT_PUSH_PREFS }; }
        try {
            const parsed = JSON.parse(raw);
            return {
                dailyMode: parsed.dailyMode === "fixed" ? "fixed" : "adaptive",
                dailyTime: isValidDailyTime(parsed.dailyTime) ? parsed.dailyTime : "09:00",
                tzOffsetMinutes: typeof parsed.tzOffsetMinutes === "number" ? parsed.tzOffsetMinutes : 0,
                timeZone: isValidTimeZone(parsed.timeZone) ? parsed.timeZone : undefined,
                learningAlerts: parsed.learningAlerts !== false,
                includeDeckName: parsed.includeDeckName === true,
            };
        } catch {
            return { ...DEFAULT_PUSH_PREFS };
        }
    }

    private savePushPreferences(prefs: PushPreferences) {
        this.setMeta("push_preferences", JSON.stringify(prefs));
        this.dueSummaryCache = null;
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

    private getFullCollection(
        includeMedia: boolean = true,
        excludeMediaNames?: Set<string>,
    ): Collection {
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
                if (excludeMediaNames && excludeMediaNames.has(row.name)) {
                    continue;
                }
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
     * Save a recoverable backup snapshot of core tables AND media before a full collection
     * overwrite (DATA-08, DATA-09, DATA-10, H-03, NEW-05, L-02).
     * Aborts the transaction if backup creation fails unless `allowNoBackup` is true (H-03).
     */
    private saveFullCollection(
        col: Collection,
        opId?: string,
        saveBackup: boolean = true,
        allowNoBackup: boolean = false,
        keepMediaNames?: string[],
    ): number {
        let nextRev = 0;
        this.ctx.storage.transactionSync(() => {
            if (saveBackup && this.isInitialized()) {
                try {
                    const current = this.getFullCollection(false);
                    if (Object.keys(current.cards).length > 0 || Object.keys(current.notes).length > 0) {
                        if (this.getMeta("test_fail_backup") === "1") {
                            throw new Error("Simulated backup storage failure");
                        }
                        this.setBackupSnapshot(current);
                        this.sql.exec("DELETE FROM backup_media");
                        this.sql.exec("INSERT INTO backup_media (name, data) SELECT name, data FROM media");
                    }
                } catch (e: any) {
                    if (!allowNoBackup) {
                        throw new OpError(
                            `Pre-import backup snapshot failed (${
                                e?.message || "storage error"
                            }); collection replacement aborted to protect existing data.`,
                            "internal",
                            true,
                        );
                    }
                }
            }

            if (col.crt) {
                this.setMeta("col_crt", String(col.crt));
            }
            this.sql.exec("DELETE FROM decks");
            this.sql.exec("DELETE FROM dconf");
            this.sql.exec("DELETE FROM models");
            this.sql.exec("DELETE FROM notes");
            this.sql.exec("DELETE FROM cards");
            this.sql.exec("DELETE FROM revlog");

            // Staged media is invisible until promoted in the CAS-protected collection transaction.
            const stagedNames = new Set((keepMediaNames || []).map(fn => normalizeMediaFilename(fn) || fn));
            if (stagedNames.size > 0 && !opId) {
                throw new OpError("Staged import requires an operation ID", "validation");
            }
            let combinedCount = Object.keys(col.media || {}).length;
            let combinedBytes = Object.values(col.media || {}).reduce((n, data) => n + data.length, 0);
            for (const filename of stagedNames) {
                const row = this.sql.exec(
                    "SELECT LENGTH(data) AS size FROM staged_import_media WHERE import_op_id = ? AND name = ?",
                    opId,
                    filename,
                ).toArray()[0];
                if (!row) {
                    throw new OpError(
                        `Import staging is missing ${filename}; retry the media upload`,
                        "validation",
                        true,
                    );
                }
                if (!(filename in (col.media || {}))) {
                    combinedCount++;
                    combinedBytes += Number(row.size);
                }
            }
            if (combinedCount > MAX_ACCOUNT_MEDIA_ITEMS || combinedBytes > MAX_ACCOUNT_MEDIA_DATA_CHARS) {
                throw new OpError("Combined import media exceeds account quota", "validation");
            }
            this.sql.exec("DELETE FROM media");

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
            if (col.media) {
                for (const [rawName, data] of Object.entries(col.media)) {
                    const safeName = normalizeMediaFilename(rawName) || rawName;
                    this.sql.exec("INSERT OR REPLACE INTO media (name, data) VALUES (?, ?)", safeName, data);
                }
            }
            for (const filename of stagedNames) {
                this.sql.exec(
                    "INSERT OR REPLACE INTO media (name, data) SELECT name, data FROM staged_import_media WHERE import_op_id = ? AND name = ?",
                    opId,
                    filename,
                );
            }
            if (stagedNames.size > 0) {
                this.sql.exec("DELETE FROM staged_import_media WHERE import_op_id = ?", opId);
            }
            nextRev = this.bumpRevision(opId);
        });
        return nextRev;
    }

    private computeDueSummary(prefs: PushPreferences, nowOverrideMs?: number): DueSummary {
        const nowMs = typeof nowOverrideMs === "number" ? nowOverrideMs : Date.now();
        const nowSec = Math.floor(nowMs / 1000);
        const localNowParts = getZonedDayInfo(nowMs, prefs);
        const todayEpochDay = localNowParts.todayEpochDay;
        const crtSec = Number(this.getMeta("col_crt")) || nowSec;

        const cacheKey = `${this.getRevision()}:${
            prefs.timeZone || ""
        }:${prefs.tzOffsetMinutes}:${localNowParts.dateStr}:${localNowParts.hour}:${Math.floor(nowSec / 60)}`;
        if (nowOverrideMs === undefined && this.dueSummaryCache && this.dueSummaryCache.key === cacheKey) {
            return this.dueSummaryCache.summary;
        }

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
                if (earliestLearnDueSec === null || card.due < earliestLearnDueSec) {
                    earliestLearnDueSec = card.due;
                }
                if (isCardDueInLearnQueue(card, nowSec, todayEpochDay, crtSec, 60)) {
                    learnDueCount++;
                    duePerDeck[card.did] = (duePerDeck[card.did] || 0) + 1;
                }
            } else if (card.queue === 3) {
                if (isCardDueInLearnQueue(card, nowSec, todayEpochDay, crtSec, 60)) {
                    learnDueCount++;
                    duePerDeck[card.did] = (duePerDeck[card.did] || 0) + 1;
                }
            } else if (card.queue === 2) {
                if (isCardDueForReview(card, todayEpochDay, crtSec)) {
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
            const entryParts = getZonedDayInfo(ts, prefs);
            studiedDaySet.add(entryParts.dateStr);
            if (entryParts.hour >= 0 && entryParts.hour < 24) {
                hourBuckets[entryParts.hour]++;
            }
        }

        let streakDays = 0;
        for (let d = 0; d < 365; d++) {
            const checkDateStr = addCalendarDays(localNowParts.dateStr, -d);
            if (studiedDaySet.has(checkDateStr)) {
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

        const summary: DueSummary = {
            learnDueCount,
            reviewDueCount,
            newCount,
            earliestLearnDueSec,
            topDeckName,
            studiedToday,
            streakDays,
            adaptiveHour,
        };

        if (nowOverrideMs === undefined) {
            this.dueSummaryCache = { key: cacheKey, summary };
        }
        return summary;
    }

    public computeNextDailyTargetUtcMs(nowMs: number, prefs: PushPreferences, summary: DueSummary): number {
        const localParts = getZonedDayInfo(nowMs, prefs);
        let targetHour = summary.adaptiveHour;
        let targetMinute = 0;
        if (prefs.dailyMode === "fixed" && isValidDailyTime(prefs.dailyTime)) {
            const [hStr, mStr] = prefs.dailyTime.split(":");
            targetHour = Number(hStr);
            targetMinute = Number(mStr);
        }

        const todayTargetUtcMs = zonedTimeToUtcMs(
            localParts.dateStr,
            targetHour,
            targetMinute,
            0,
            prefs.timeZone,
            prefs.tzOffsetMinutes,
        );
        const lastDailySentDate = this.getMeta("last_daily_push_date") || "";

        if (
            !summary.studiedToday
            && lastDailySentDate !== localParts.dateStr
            && todayTargetUtcMs > nowMs + 15_000
        ) {
            return todayTargetUtcMs;
        }

        const tomorrowDateStr = addCalendarDays(localParts.dateStr, 1);
        return zonedTimeToUtcMs(
            tomorrowDateStr,
            targetHour,
            targetMinute,
            0,
            prefs.timeZone,
            prefs.tzOffsetMinutes,
        );
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

        const dailyCandidateMs = this.computeNextDailyTargetUtcMs(nowMs, prefs, summary);
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

        const localParts = getZonedDayInfo(nowMs, prefs);
        let targetHour = summary.adaptiveHour;
        let targetMinute = 0;
        if (prefs.dailyMode === "fixed" && isValidDailyTime(prefs.dailyTime)) {
            const [hStr, mStr] = prefs.dailyTime.split(":");
            targetHour = Number(hStr);
            targetMinute = Number(mStr);
        }
        const todayTargetUtcMs = zonedTimeToUtcMs(
            localParts.dateStr,
            targetHour,
            targetMinute,
            0,
            prefs.timeZone,
            prefs.tzOffsetMinutes,
        );
        const lastDailySentDate = this.getMeta("last_daily_push_date") || "";

        let transientFailure = false;
        const deckLocationText = prefs.includeDeckName ? ` in ${summary.topDeckName}` : "";

        if (
            prefs.learningAlerts
            && summary.learnDueCount > 0
            && lastLearnPushMs < lastActivityMs
        ) {
            const count = summary.learnDueCount;
            const payload: PushPayload = {
                title: `klanki: ${count} Learning ${count === 1 ? "Card" : "Cards"} Due`,
                body: `Your learning step${deckLocationText} is ready to review.`,
                url: "/",
                tag: "klanki-learn-due",
            };
            const results = await this.broadcastPushNotification(payload, config);
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
                        body: `Ready for review${deckLocationText}${
                            summary.newCount > 0 ? ` + ${Math.min(20, summary.newCount)} new` : ""
                        }${streakSuffix}.`,
                        url: "/",
                        tag: "klanki-daily-due",
                    }
                    : {
                        title: "klanki: Daily Study Reminder",
                        body: `${Math.min(20, summary.newCount)} new cards waiting${deckLocationText}${streakSuffix}.`,
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
            const retryAt = Date.now() + 15 * 60_000;
            await this.ctx.storage.setAlarm(retryAt);
            this.setMeta("next_alarm_ms", String(retryAt));
            return;
        }

        await this.recomputeAndScheduleAlarm();
    }

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

    private checkInitRateLimit(): boolean {
        const now = Date.now();
        if (now - this.initRateWindowStartMs > 60_000) {
            this.initRateWindowStartMs = now;
            this.initRateCount = 0;
        }
        this.initRateCount++;
        return this.initRateCount <= MAX_INIT_PER_MINUTE;
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // 0. Internal endpoint to register a single-use WebSocket ticket nonce
        if (url.pathname === "/internal/issue-ticket" && request.method === "POST") {
            const body: { nonce: string; exp: number } = await request.json();
            const now = Date.now();
            this.sql.exec("DELETE FROM ws_tickets WHERE exp < ?", now);
            const pendingTickets = this.sql.exec("SELECT COUNT(*) as c FROM ws_tickets").toArray();
            if (Number(pendingTickets[0]?.c || 0) >= 30) {
                return Response.json({ error: "Too many pending tickets" }, { status: 429 });
            }
            this.sql.exec(
                "INSERT OR REPLACE INTO ws_tickets (nonce, exp) VALUES (?, ?)",
                body.nonce,
                body.exp,
            );
            return Response.json({ ok: true });
        }

        // 1. WebSocket Upgrade (requires valid single-use ticket nonce & concurrent socket cap SEC-09)
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

            const activeSockets = this.ctx
                .getWebSockets()
                .filter(ws => ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
            if (activeSockets.length >= MAX_CONCURRENT_SOCKETS) {
                return Response.json(
                    { error: "Maximum concurrent connections exceeded" },
                    { status: 429 },
                );
            }

            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            this.ctx.acceptWebSocket(server);
            return new Response(null, { status: 101, webSocket: client });
        }

        // 2. Complete Account Data Deletion Lifecycle (S10, DATA-03)
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
                this.sql.exec("DELETE FROM backup_media");
                this.sql.exec("DELETE FROM backup_snapshot_parts");
                this.sql.exec("DELETE FROM staged_import_media");
                this.sql.exec("DELETE FROM push_subscriptions");
                this.sql.exec("DELETE FROM ws_tickets");
                this.sql.exec("DELETE FROM applied_ops");
                this.setMeta("col_revision", String(deletedRevision));
                this.setMeta("col_generation", crypto.randomUUID());
                this.setDeletionTombstone();
                this.dueSummaryCache = null;
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

        // 3. HTTP Media & Collection Endpoints (NEW-05, M-01, L-02, L-03, L-10, H-03)
        if (url.pathname === "/media") {
            if (request.method === "GET") {
                const rawName = url.searchParams.get("name") || "";
                const safeName = normalizeMediaFilename(rawName) || rawName;
                if (!safeName) {
                    return Response.json({ error: "Missing media name" }, { status: 400 });
                }
                const rows = this.sql.exec("SELECT data FROM media WHERE name = ?", safeName).toArray();
                if (!rows.length) {
                    return Response.json({ error: "Media not found" }, { status: 404 });
                }
                return Response.json({ filename: safeName, dataUrl: rows[0].data });
            }
            if (request.method === "POST") {
                try {
                    const body = (await request.json()) as {
                        filename?: string;
                        dataUrl?: string;
                        opId?: string;
                        importOpId?: string;
                        generation?: string;
                    };
                    const validation = validateClientMessage({
                        type: "save_media",
                        filename: body?.filename,
                        dataUrl: body?.dataUrl,
                        opId: body?.opId,
                        generation: body?.generation,
                    });
                    if (!validation.ok) {
                        return Response.json({ error: validation.error }, { status: 400 });
                    }
                    const msg = validation.msg as Extract<ClientMessage, { type: "save_media" }>;
                    const currentGeneration = this.getMeta("col_generation") ?? "0";
                    if ((msg.generation ?? "0") !== currentGeneration || this.getDeletionTombstone()) {
                        return Response.json({ error: "Collection was deleted; reload before uploading media." }, {
                            status: 410,
                        });
                    }
                    const importOpId = body.importOpId;
                    if (importOpId !== undefined) {
                        if (typeof importOpId !== "string" || !/^[a-zA-Z0-9_-]{1,191}$/.test(importOpId)) {
                            return Response.json({ error: "Invalid import operation ID" }, { status: 400 });
                        }
                        this.ctx.storage.transactionSync(() => {
                            this.sql.exec(
                                "DELETE FROM staged_import_media WHERE created_at < ?",
                                Date.now() - 86400000,
                            );
                            const prior = this.sql.exec(
                                "SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM staged_import_media WHERE NOT (import_op_id = ? AND name = ?)",
                                importOpId,
                                msg.filename,
                            ).toArray();
                            if (Number(prior[0]?.n || 0) + msg.dataUrl.length > MAX_ACCOUNT_MEDIA_DATA_CHARS) {
                                throw new OpError("Staged import media exceeds account quota", "validation");
                            }
                            this.sql.exec(
                                "INSERT OR REPLACE INTO staged_import_media (import_op_id, name, data, created_at) VALUES (?, ?, ?, ?)",
                                importOpId,
                                msg.filename,
                                msg.dataUrl,
                                Date.now(),
                            );
                        });
                        return Response.json({ success: true, staged: true, filename: msg.filename });
                    }
                    const already = this.getAlreadyAppliedRevision(msg.opId);
                    if (already !== null) {
                        return Response.json({ success: true, filename: msg.filename, revision: already });
                    }
                    let rev = 0;
                    this.ctx.storage.transactionSync(() => {
                        this.checkAccountMediaQuota(msg.filename, msg.dataUrl);
                        this.sql.exec(
                            "INSERT OR REPLACE INTO media (name, data) VALUES (?, ?)",
                            msg.filename,
                            msg.dataUrl,
                        );
                        rev = this.bumpRevision(msg.opId);
                    });
                    this.broadcast({
                        type: "save_media",
                        opId: msg.opId,
                        filename: msg.filename,
                        dataUrl: msg.dataUrl,
                        revision: rev,
                    });
                    return Response.json({ success: true, filename: msg.filename, revision: rev });
                } catch (err: any) {
                    const status = err instanceof OpError && err.kind === "validation" ? 413 : 400;
                    return Response.json({ error: err?.message || "Media upload failed" }, { status });
                }
            }
        }

        if (url.pathname === "/collection") {
            if (request.method === "GET") {
                const col = this.getFullCollection();
                return Response.json({
                    ...col,
                    revision: this.getRevision(),
                    generation: this.getMeta("col_generation") ?? "0",
                    initialized: this.isInitialized(),
                    hasBackup: Boolean(this.getMeta("backup_snapshot")),
                    mediaManifest: this.getMediaManifest(),
                });
            }
            if (request.method === "POST") {
                const body: Collection & {
                    expectedRevision?: unknown;
                    forceOverwrite?: boolean;
                    allowNoBackup?: boolean;
                    keepMediaNames?: string[];
                    opId?: string;
                    generation?: string;
                    seedOnUninitialized?: boolean;
                } = await request.json();
                if (!body || typeof body !== "object" || Array.isArray(body)) {
                    return Response.json({ error: "Collection must be an object" }, { status: 400 });
                }
                const {
                    expectedRevision,
                    forceOverwrite,
                    allowNoBackup,
                    keepMediaNames,
                    opId,
                    generation,
                    seedOnUninitialized,
                    ...collection
                } = body;
                const validation = validateClientMessage({
                    type: "import_collection",
                    collection,
                    expectedRevision,
                    forceOverwrite,
                    allowNoBackup,
                    keepMediaNames,
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

                const cas = this.checkExpectedRevision(body.expectedRevision, body.forceOverwrite);
                if (!cas.ok) {
                    return Response.json(
                        { error: cas.error, currentRevision: this.getRevision() },
                        { status: 409 },
                    );
                }
                try {
                    const revision = this.saveFullCollection(
                        collection,
                        body.opId,
                        true,
                        Boolean(body.allowNoBackup),
                        body.keepMediaNames,
                    );
                    this.clearDeletionTombstone();
                    this.setMeta("last_activity_ms", String(Date.now()));
                    await this.recomputeAndScheduleAlarm();
                    const fullCol = this.getFullCollection();
                    this.broadcast({
                        type: "full_state",
                        generation: this.getMeta("col_generation") ?? "0",
                        collection: fullCol,
                        revision,
                        initialized: true,
                        hasBackup: Boolean(this.getMeta("backup_snapshot")),
                        mediaManifest: this.getMediaManifest(),
                    });
                    return Response.json({ success: true, revision });
                } catch (err: any) {
                    return Response.json(
                        { error: err?.message || "Failed to save collection", currentRevision: this.getRevision() },
                        { status: 500 },
                    );
                }
            }
        }

        if (url.pathname === "/collection/restore-backup" && request.method === "POST") {
            const body = (await request.json().catch(() => null)) as
                | { expectedRevision?: unknown; forceOverwrite?: boolean }
                | null;
            const cas = this.checkExpectedRevision(body?.expectedRevision, body?.forceOverwrite);
            if (!cas.ok) {
                return Response.json({ error: cas.error, currentRevision: this.getRevision() }, { status: 409 });
            }
            let backupCol: Collection | null;
            try {
                backupCol = this.readBackupSnapshot();
            } catch {
                return Response.json({ error: "Backup snapshot is incomplete or corrupted" }, { status: 500 });
            }
            if (!backupCol) {
                return Response.json({ error: "No backup snapshot available" }, { status: 404 });
            }
            const backupMedia: Record<string, string> = {};
            for (const row of this.sql.exec("SELECT name, data FROM backup_media").toArray()) {
                backupMedia[row.name] = row.data;
            }
            backupCol.media = { ...(backupCol.media || {}), ...backupMedia };
            const revision = this.saveFullCollection(backupCol, undefined, false, true);
            this.clearDeletionTombstone();
            await this.recomputeAndScheduleAlarm();
            this.broadcast({
                type: "full_state",
                generation: this.getMeta("col_generation") ?? "0",
                collection: backupCol,
                revision,
                initialized: true,
                hasBackup: true,
                mediaManifest: this.getMediaManifest(),
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

                this.sql.exec(`
          DELETE FROM push_subscriptions
          WHERE endpoint NOT IN (
            SELECT endpoint FROM push_subscriptions ORDER BY updated_at DESC LIMIT 10
          )
        `);

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

        if (url.pathname === "/push/detach" && request.method === "POST") {
            try {
                const body: { endpoint?: string; unsubSecret?: string } = await request.json();
                const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
                const unsubSecret = typeof body?.unsubSecret === "string" ? body.unsubSecret.trim() : "";

                if (!endpoint || !unsubSecret) {
                    return Response.json({ error: "Unauthorized push detachment" }, { status: 403 });
                }

                const matched = this.sql
                    .exec(
                        "SELECT endpoint FROM push_subscriptions WHERE endpoint = ? AND unsub_secret = ? AND unsub_secret != ''",
                        endpoint,
                        unsubSecret,
                    )
                    .toArray();
                if (!matched.length) {
                    return Response.json({ error: "Unauthorized push detachment" }, { status: 403 });
                }

                this.sql.exec(
                    "DELETE FROM push_subscriptions WHERE endpoint = ? AND unsub_secret = ?",
                    endpoint,
                    unsubSecret,
                );
                await this.recomputeAndScheduleAlarm();
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
                // L-04: Reject invalid 24-hour notification time values explicitly
                if (incoming.dailyTime !== undefined && !isValidDailyTime(incoming.dailyTime)) {
                    return Response.json(
                        { error: "Invalid dailyTime (must be HH:MM in 24-hour range 00:00..23:59)" },
                        { status: 400 },
                    );
                }
                const current = this.getPushPreferences();
                const updated: PushPreferences = {
                    dailyMode: incoming.dailyMode === "fixed"
                        ? "fixed"
                        : incoming.dailyMode === "adaptive"
                        ? "adaptive"
                        : current.dailyMode,
                    dailyTime: isValidDailyTime(incoming.dailyTime)
                        ? incoming.dailyTime
                        : current.dailyTime,
                    tzOffsetMinutes: typeof incoming.tzOffsetMinutes === "number"
                        ? incoming.tzOffsetMinutes
                        : current.tzOffsetMinutes,
                    timeZone: isValidTimeZone(incoming.timeZone) ? incoming.timeZone : current.timeZone,
                    learningAlerts: typeof incoming.learningAlerts === "boolean"
                        ? incoming.learningAlerts
                        : current.learningAlerts,
                    includeDeckName: typeof incoming.includeDeckName === "boolean"
                        ? incoming.includeDeckName
                        : Boolean(current.includeDeckName),
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
                const deckLocationText = prefs.includeDeckName ? ` in ${summary.topDeckName}` : "";

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
                                ? `${dueTotal} due for review${deckLocationText}${
                                    summary.newCount > 0 ? ` + ${Math.min(20, summary.newCount)} new` : ""
                                }.`
                                : `${Math.min(20, summary.newCount)} new cards ready${deckLocationText}.`),
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

    private sendAck(
        ws: WebSocket,
        opId: string | undefined,
        revision: number,
        extra?: {
            cardId?: number;
            cardState?: Card;
            revlogEntry?: RevlogEntry;
            originalRevlogId?: number;
            updatedMod?: number;
        },
    ) {
        if (!opId) { return; }
        try {
            ws.send(
                JSON.stringify(
                    {
                        type: "ack",
                        opId,
                        revision,
                        ...extra,
                    } satisfies ServerMessage,
                ),
            );
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
        if (typeof message !== "string") {
            this.sendOpError(ws, undefined, "Binary WebSocket frames are not supported", "validation", false);
            return;
        }

        const byteLength = new TextEncoder().encode(message).byteLength;
        if (byteLength > MAX_WS_MESSAGE_BYTES) {
            this.sendOpError(
                ws,
                undefined,
                `WebSocket message exceeds maximum size (${MAX_WS_MESSAGE_BYTES} bytes)`,
                "validation",
                false,
            );
            return;
        }

        let raw: any;
        try {
            raw = JSON.parse(message);
        } catch {
            this.sendOpError(ws, undefined, "Invalid JSON payload", "validation", false);
            return;
        }

        if (
            raw?.type !== "import_collection"
            && raw?.type !== "save_media"
            && byteLength > MAX_WS_STANDARD_BYTES
        ) {
            this.sendOpError(
                ws,
                typeof raw?.opId === "string" ? raw.opId.slice(0, 191) : undefined,
                `Message of type '${String(raw?.type)}' exceeds maximum size`,
                "validation",
                false,
            );
            return;
        }

        const validation = validateClientMessage(raw);
        if (!validation.ok) {
            this.sendOpError(
                ws,
                typeof raw?.opId === "string" ? raw.opId.slice(0, 191) : undefined,
                validation.error,
                "validation",
                false,
            );
            return;
        }

        const msg = validation.msg;

        try {
            if (msg.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
                return;
            }

            if (msg.type === "init") {
                if (!this.checkInitRateLimit()) {
                    this.sendOpError(ws, undefined, "Rate limit exceeded for init requests", "validation", true);
                    return;
                }
                const excludeMedia = msg.knownMedia && msg.knownMedia.length > 0
                    ? new Set<string>(msg.knownMedia)
                    : undefined;
                const col = this.getFullCollection(true, excludeMedia);
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
                            mediaManifest: this.getMediaManifest(),
                        } satisfies ServerMessage,
                    ),
                );
                return;
            }

            const opId = "opId" in msg ? msg.opId : undefined;
            const currentGeneration = this.getMeta("col_generation") ?? "0";
            const msgGeneration = msg.generation ?? "0";

            if (
                msgGeneration !== currentGeneration
                || (msg.type === "import_collection" && msg.seedOnUninitialized && this.getDeletionTombstone())
                || (this.getDeletionTombstone() && msgGeneration === "0" && msg.type !== "import_collection")
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
            const alreadyApplied = this.getAlreadyAppliedOp(opId);
            if (alreadyApplied !== null) {
                this.sendAck(ws, opId, alreadyApplied.revision, alreadyApplied.extra);
                return;
            }

            if (msg.type === "answer_card") {
                let rev = 0;
                let finalState: Card | undefined;
                const originalRevlogId = msg.revlogEntry.id;
                const revlogEntry: RevlogEntry = { ...msg.revlogEntry };

                this.ctx.storage.transactionSync(() => {
                    const row = this.sql.exec("SELECT json FROM cards WHERE id = ?", msg.cardId).toArray();
                    if (row.length === 0) {
                        throw new OpError(
                            `Card ${msg.cardId} does not exist on the server.`,
                            "validation",
                            false,
                        );
                    }
                    const card: Card = JSON.parse(row[0].json);

                    // NEW-04 / H-01: Reject concurrent reviews answered from a stale card version
                    if (
                        !msg.forceOverwrite
                        && (msg.baseReps === undefined || (card.reps || 0) !== msg.baseReps)
                    ) {
                        throw new OpError(
                            `Concurrent review conflict on card ${msg.cardId}: expected ${msg.baseReps ?? "a supplied base review count"} reviews, server has ${
                                card.reps || 0
                            }.`,
                            "conflict_revision",
                            true,
                        );
                    }

                    const nextReps = Math.max((card.reps || 0) + 1, msg.nextState.reps || 0);
                    Object.assign(card, msg.nextState, {
                        reps: nextReps,
                        mod: Math.max(Math.floor(Date.now() / 1000), (card.mod || 0) + 1),
                    });
                    finalState = card;
                    this.sql.exec("UPDATE cards SET json = ? WHERE id = ?", JSON.stringify(card), card.id);

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
                    rev = this.bumpRevision(opId, {
                        cardId: msg.cardId,
                        cardState: finalState,
                        revlogEntry,
                        originalRevlogId,
                    });
                });

                // M-04: Return authoritative cardState and revlogEntry (including repaired revlog ID) in ack
                this.sendAck(ws, opId, rev, {
                    cardId: msg.cardId,
                    cardState: finalState,
                    revlogEntry,
                    originalRevlogId,
                });
                await this.recomputeAndScheduleAlarm();
                this.broadcast(
                    {
                        type: "answer_card",
                        opId,
                        cardId: msg.cardId,
                        nextState: finalState || msg.nextState,
                        revlogEntry,
                        revision: rev,
                    },
                    ws,
                );
                return;
            }

            if (msg.type === "upsert_deck") {
                let rev = 0;
                const renamedSubdecks: Deck[] = [];

                this.ctx.storage.transactionSync(() => {
                    const existingRows = this.sql
                        .exec("SELECT json FROM decks WHERE id = ?", msg.deck.id)
                        .toArray();
                    if (msg.isNew && existingRows.length > 0) {
                        throw new OpError(
                            `ID collision: deck ${msg.deck.id} already exists on the server.`,
                            "id_collision",
                            true,
                        );
                    }
                    if (existingRows.length === 0) {
                        const deckCount = Number(
                            this.sql.exec("SELECT COUNT(*) as c FROM decks").toArray()[0]?.c || 0,
                        );
                        if (deckCount >= MAX_ACCOUNT_DECKS) {
                            throw new OpError(
                                `Account deck limit exceeded (max ${MAX_ACCOUNT_DECKS}).`,
                                "validation",
                                false,
                            );
                        }
                    }

                    if (existingRows.length > 0) {
                        const prevDeck: Deck = JSON.parse(existingRows[0].json);
                        // H-04: Optimistic concurrency check on deck edits
                        if (
                            !msg.forceOverwrite
                            && (msg.expectedMod === undefined || (prevDeck.mod || 0) !== msg.expectedMod)
                        ) {
                            throw new OpError(
                                `Conflict: deck '${prevDeck.name}' was modified more recently on another device.`,
                                "conflict_revision",
                                true,
                            );
                        }

                        if (prevDeck.name && prevDeck.name !== msg.deck.name) {
                            const oldPrefix = `${prevDeck.name}::`;
                            const newPrefix = `${msg.deck.name}::`;
                            const allDeckRows = this.sql.exec("SELECT id, json FROM decks").toArray();
                            const nowSec = Math.floor(Date.now() / 1000);
                            for (const r of allDeckRows) {
                                const sub: Deck = JSON.parse(r.json);
                                if (sub.id !== msg.deck.id && sub.name.startsWith(oldPrefix)) {
                                    const updatedSub: Deck = {
                                        ...sub,
                                        name: `${newPrefix}${sub.name.slice(oldPrefix.length)}`,
                                        mod: nowSec,
                                    };
                                    this.sql.exec(
                                        "UPDATE decks SET json = ? WHERE id = ?",
                                        JSON.stringify(updatedSub),
                                        updatedSub.id,
                                    );
                                    renamedSubdecks.push(updatedSub);
                                }
                            }
                        }
                    }

                    if (existingRows.length) {
                        const previous: Deck = JSON.parse(existingRows[0].json);
                        msg.deck.mod = Math.max(Math.floor(Date.now() / 1000), (previous.mod || 0) + 1);
                    }
                    this.sql.exec(
                        "INSERT OR REPLACE INTO decks (id, json) VALUES (?, ?)",
                        msg.deck.id,
                        JSON.stringify(msg.deck),
                    );
                    if (this.getDeletionTombstone()) {
                        this.clearDeletionTombstone();
                    }
                    rev = this.bumpRevision(opId);
                });
                this.sendAck(ws, opId, rev, { updatedMod: msg.deck.mod });
                this.broadcast(
                    {
                        type: "upsert_deck",
                        opId,
                        deck: msg.deck,
                        renamedSubdecks: renamedSubdecks.length > 0 ? renamedSubdecks : undefined,
                        revision: rev,
                    },
                    ws,
                );
                return;
            }

            if (msg.type === "delete_deck") {
                const cas = this.checkExpectedRevision(msg.expectedRevision);
                if (!cas.ok) {
                    throw new OpError(cas.error || "Collection revision changed", "conflict_revision", true);
                }
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
                const cas = this.checkExpectedRevision(msg.expectedRevision);
                if (!cas.ok) {
                    throw new OpError(cas.error || "Collection revision changed", "conflict_revision", true);
                }
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
                const authoritativeCards: Card[] = [];

                this.ctx.storage.transactionSync(() => {
                    const existingNoteRows = this.sql
                        .exec("SELECT json FROM notes WHERE id = ?", msg.note.id)
                        .toArray();
                    if (msg.isNew) {
                        if (existingNoteRows.length > 0) {
                            throw new OpError(
                                `ID collision: note ${msg.note.id} already exists on the server.`,
                                "id_collision",
                                true,
                            );
                        }
                        const noteCount = Number(
                            this.sql.exec("SELECT COUNT(*) as c FROM notes").toArray()[0]?.c || 0,
                        );
                        if (noteCount + 1 > MAX_ACCOUNT_NOTES) {
                            throw new OpError(
                                `Account note limit exceeded (max ${MAX_ACCOUNT_NOTES}).`,
                                "validation",
                                false,
                            );
                        }
                        const cardCount = Number(
                            this.sql.exec("SELECT COUNT(*) as c FROM cards").toArray()[0]?.c || 0,
                        );
                        if (cardCount + msg.cards.length > MAX_ACCOUNT_CARDS) {
                            throw new OpError(
                                `Account card limit exceeded (max ${MAX_ACCOUNT_CARDS}).`,
                                "validation",
                                false,
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
                    } else if (existingNoteRows.length > 0) {
                        // H-04: Optimistic concurrency check on existing note edits
                        const prevNote: Note = JSON.parse(existingNoteRows[0].json);
                        if (
                            !msg.forceOverwrite
                            && (msg.expectedMod === undefined || (prevNote.mod || 0) !== msg.expectedMod)
                        ) {
                            throw new OpError(
                                `Conflict: note ${msg.note.id} was modified more recently on another device.`,
                                "conflict_revision",
                                true,
                            );
                        }
                    }

                    // DATA-11: Enforce foreign-key relationship consistency against server decks & models
                    const modelCount = Number(
                        this.sql.exec("SELECT COUNT(*) as c FROM models").toArray()[0]?.c || 0,
                    );
                    if (modelCount > 0) {
                        const modelRow = this.sql
                            .exec("SELECT id FROM models WHERE id = ?", msg.note.mid)
                            .toArray();
                        if (modelRow.length === 0) {
                            throw new OpError(
                                `Referenced note type ${msg.note.mid} does not exist on the server.`,
                                "validation",
                                false,
                            );
                        }
                    }

                    const deckCount = Number(
                        this.sql.exec("SELECT COUNT(*) as c FROM decks").toArray()[0]?.c || 0,
                    );
                    if (deckCount > 0) {
                        for (const card of msg.cards) {
                            const deckRow = this.sql
                                .exec("SELECT id FROM decks WHERE id = ?", card.did)
                                .toArray();
                            if (deckRow.length === 0) {
                                throw new OpError(
                                    `Card ${card.id} references nonexistent deck ${card.did}.`,
                                    "validation",
                                    false,
                                );
                            }
                        }
                    }

                    if (existingNoteRows.length) {
                        const previous: Note = JSON.parse(existingNoteRows[0].json);
                        msg.note.mod = Math.max(Math.floor(Date.now() / 1000), (previous.mod || 0) + 1);
                    }
                    this.sql.exec(
                        "INSERT OR REPLACE INTO notes (id, json) VALUES (?, ?)",
                        msg.note.id,
                        JSON.stringify(msg.note),
                    );

                    // NEW-01: When editing an existing note (`!msg.isNew`), NEVER overwrite existing
                    // card scheduling state (`ivl`, `due`, `reps`, `lapses`, `queue`, `type`, `data`).
                    // Only insert cards that do not yet exist (e.g. newly added cloze ordinals).
                    for (const card of msg.cards) {
                        const existingCardRows = this.sql
                            .exec("SELECT json FROM cards WHERE id = ?", card.id)
                            .toArray();
                        if (!msg.isNew && existingCardRows.length > 0) {
                            const serverCard: Card = JSON.parse(existingCardRows[0].json);
                            authoritativeCards.push(serverCard);
                        } else {
                            this.sql.exec(
                                "INSERT OR REPLACE INTO cards (id, json) VALUES (?, ?)",
                                card.id,
                                JSON.stringify(card),
                            );
                            authoritativeCards.push(card);
                        }
                    }
                    if (this.getDeletionTombstone()) {
                        this.clearDeletionTombstone();
                    }
                    this.setMeta("last_activity_ms", String(Date.now()));
                    rev = this.bumpRevision(opId);
                });
                this.sendAck(ws, opId, rev, { updatedMod: msg.note.mod });
                await this.recomputeAndScheduleAlarm();
                this.broadcast(
                    {
                        type: "upsert_note",
                        opId,
                        note: msg.note,
                        cards: authoritativeCards,
                        isNew: msg.isNew,
                        revision: rev,
                    },
                    ws,
                );
                return;
            }

            if (msg.type === "delete_note") {
                const cas = this.checkExpectedRevision(msg.expectedRevision);
                if (!cas.ok) {
                    throw new OpError(cas.error || "Collection revision changed", "conflict_revision", true);
                }
                let rev = 0;
                const removedCardIds = new Set<number>();

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
                    const noteRow = this.sql
                        .exec("SELECT id FROM notes WHERE id = ?", msg.card.nid)
                        .toArray();
                    if (noteRow.length === 0) {
                        throw new OpError(
                            `Card ${msg.card.id} references nonexistent note ${msg.card.nid}.`,
                            "validation",
                            false,
                        );
                    }
                    const deckRow = this.sql
                        .exec("SELECT id FROM decks WHERE id = ?", msg.card.did)
                        .toArray();
                    if (deckRow.length === 0) {
                        throw new OpError(
                            `Card ${msg.card.id} references nonexistent deck ${msg.card.did}.`,
                            "validation",
                            false,
                        );
                    }

                    // NEW-01 & H-04: Reject stale card updates if the server card has newer mod or reps
                    const existingCardRows = this.sql
                        .exec("SELECT json FROM cards WHERE id = ?", msg.card.id)
                        .toArray();
                    if (existingCardRows.length > 0 && !msg.forceOverwrite) {
                        const prevCard: Card = JSON.parse(existingCardRows[0].json);
                        if (msg.expectedMod === undefined || (prevCard.mod || 0) !== msg.expectedMod) {
                            throw new OpError(
                                `Conflict: card ${msg.card.id} was modified more recently on another device.`,
                                "conflict_revision",
                                true,
                            );
                        }
                    }

                    if (existingCardRows.length) {
                        const previous: Card = JSON.parse(existingCardRows[0].json);
                        msg.card.mod = Math.max(Math.floor(Date.now() / 1000), (previous.mod || 0) + 1);
                    }
                    this.sql.exec(
                        "INSERT OR REPLACE INTO cards (id, json) VALUES (?, ?)",
                        msg.card.id,
                        JSON.stringify(msg.card),
                    );
                    this.setMeta("last_activity_ms", String(Date.now()));
                    rev = this.bumpRevision(opId);
                });
                this.sendAck(ws, opId, rev, { updatedMod: msg.card.mod });
                await this.recomputeAndScheduleAlarm();
                this.broadcast({ type: "update_card", opId, card: msg.card, revision: rev }, ws);
                return;
            }

            if (msg.type === "save_media") {
                let rev = 0;
                const safeName = normalizeMediaFilename(msg.filename) || msg.filename;
                this.ctx.storage.transactionSync(() => {
                    this.checkAccountMediaQuota(safeName, msg.dataUrl);
                    this.sql.exec(
                        "INSERT OR REPLACE INTO media (name, data) VALUES (?, ?)",
                        safeName,
                        msg.dataUrl,
                    );
                    rev = this.bumpRevision(opId);
                });
                this.sendAck(ws, opId, rev);
                this.broadcast(
                    { type: "save_media", opId, filename: safeName, dataUrl: msg.dataUrl, revision: rev },
                    ws,
                );
                return;
            }

            if (msg.type === "delete_media") {
                let rev = 0;
                const normalizedNames = msg.filenames
                    .map(fn => normalizeMediaFilename(fn) || fn)
                    .filter(Boolean);
                this.ctx.storage.transactionSync(() => {
                    for (const fn of normalizedNames) {
                        this.sql.exec("DELETE FROM media WHERE name = ?", fn);
                    }
                    rev = this.bumpRevision(opId);
                });
                this.sendAck(ws, opId, rev);
                this.broadcast(
                    { type: "delete_media", opId, filenames: normalizedNames, revision: rev },
                    ws,
                );
                return;
            }

            if (msg.type === "import_collection") {
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

                const cas = this.checkExpectedRevision(msg.expectedRevision, msg.forceOverwrite);
                if (!cas.ok) {
                    this.sendOpError(ws, opId, cas.error || "Revision conflict", "conflict_revision", true);
                    this.broadcast(
                        {
                            type: "full_state",
                            generation: this.getMeta("col_generation") ?? "0",
                            collection: this.getFullCollection(),
                            revision: this.getRevision(),
                            initialized: this.isInitialized(),
                            hasBackup: Boolean(this.getMeta("backup_snapshot")),
                            mediaManifest: this.getMediaManifest(),
                        },
                        ws,
                    );
                    return;
                }

                const rev = this.saveFullCollection(
                    msg.collection,
                    opId,
                    true,
                    Boolean(msg.allowNoBackup),
                    msg.keepMediaNames,
                );
                this.clearDeletionTombstone();
                this.setMeta("last_activity_ms", String(Date.now()));
                this.sendAck(ws, opId, rev);
                await this.recomputeAndScheduleAlarm();
                this.broadcast(
                    { type: "import_collection", opId, collection: this.getFullCollection(), revision: rev },
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
