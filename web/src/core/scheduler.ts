// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { Card, CardQueue, Collection, DeckConfig, DeckStudyCounts, Rating, SchedulingOption } from "./types";

export function isValidTimeZone(tz?: string): tz is string {
    if (!tz || typeof tz !== "string" || tz.length > 64) { return false; }
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * Validate a 24-hour `HH:MM` notification clock time (`00:00`..`23:59`) (L-04).
 */
export function isValidDailyTime(val: unknown): val is string {
    return typeof val === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(val);
}

/**
 * Pure calendar-day arithmetic on a `YYYY-MM-DD` date string (SCHED-02).
 * Uses UTC calendar date components so adding/subtracting days is never
 * skewed by 23-hour or 25-hour daylight-saving transitions.
 */
export function addCalendarDays(dateStr: string, deltaDays: number): string {
    const [yStr, mStr, dStr] = dateStr.split("-");
    const dt = new Date(Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr) + deltaDays));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function extractWallClockInTimeZone(
    epochMs: number,
    timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number; dateStr: string } {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
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
    const year = Number(map.year);
    const month = Number(map.month);
    const day = Number(map.day);
    // Some runtimes emit "24" at midnight with h23
    const rawHour = Number(map.hour) || 0;
    const hour = rawHour === 24 ? 0 : rawHour;
    const minute = Number(map.minute) || 0;
    const second = Number(map.second) || 0;
    const dateStr = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${
        String(day).padStart(2, "0")
    }`;
    return { year, month, day, hour, minute, second, dateStr };
}

/**
 * Convert a local wall-clock time (`YYYY-MM-DD` + `hour:minute:second`) in an IANA
 * `timeZone` (or fallback UTC offset) to the exact UTC epoch milliseconds (SCHED-02).
 * Handles DST spring-forward and fall-back transitions accurately via two-pass offset refinement.
 */
export function zonedTimeToUtcMs(
    dateStr: string,
    hour: number,
    minute: number = 0,
    second: number = 0,
    timeZone?: string,
    fallbackOffsetMinutes: number = 0,
): number {
    const [yStr, mStr, dStr] = dateStr.split("-");
    const year = Number(yStr);
    const month = Number(mStr);
    const day = Number(dStr);
    const targetWallUtc = Date.UTC(year, month - 1, day, hour, minute, second);

    if (isValidTimeZone(timeZone)) {
        try {
            // Pass 1: estimate offset at targetWallUtc
            const p1 = extractWallClockInTimeZone(targetWallUtc, timeZone);
            const obs1Utc = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, p1.second);
            const offset1 = obs1Utc - targetWallUtc;
            const candidate1 = targetWallUtc - offset1;

            // Pass 2: refine offset at candidate1 (handles crossing a DST transition boundary)
            const p2 = extractWallClockInTimeZone(candidate1, timeZone);
            const obs2Utc = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second);
            const offset2 = obs2Utc - candidate1;
            return targetWallUtc - offset2;
        } catch {
            // Fall through to fallbackOffsetMinutes
        }
    }

    return targetWallUtc + (fallbackOffsetMinutes || 0) * 60_000;
}

/**
 * Compute timezone-aware local calendar date parts, local midnight in UTC ms,
 * and canonical local-day epoch index (SCHED-01, SCHED-02).
 */
export function getZonedDayInfo(
    epochMs: number = Date.now(),
    opts?: { timeZone?: string; tzOffsetMinutes?: number },
): { dateStr: string; hour: number; minute: number; midnightUtcMs: number; todayEpochDay: number } {
    const tz = opts?.timeZone && isValidTimeZone(opts.timeZone) ? opts.timeZone : undefined;
    if (tz) {
        try {
            const wall = extractWallClockInTimeZone(epochMs, tz);
            const midnightUtcMs = zonedTimeToUtcMs(wall.dateStr, 0, 0, 0, tz, opts?.tzOffsetMinutes);
            const todayEpochDay = Math.floor(Date.UTC(wall.year, wall.month - 1, wall.day) / 86_400_000);
            return {
                dateStr: wall.dateStr,
                hour: wall.hour,
                minute: wall.minute,
                midnightUtcMs,
                todayEpochDay,
            };
        } catch {
            // Fall through
        }
    }

    if (opts && typeof opts.tzOffsetMinutes === "number") {
        const offsetMs = (opts.tzOffsetMinutes || 0) * 60_000;
        const localNow = new Date(epochMs - offsetMs);
        const y = localNow.getUTCFullYear();
        const m = localNow.getUTCMonth();
        const d = localNow.getUTCDate();
        const dateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const hour = localNow.getUTCHours();
        const minute = localNow.getUTCMinutes();
        const midnightUtcMs = Date.UTC(y, m, d, 0, 0, 0) + offsetMs;
        const todayEpochDay = Math.floor(Date.UTC(y, m, d) / 86_400_000);
        return { dateStr, hour, minute, midnightUtcMs, todayEpochDay };
    }

    const d = new Date(epochMs);
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    const dateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const midnightUtcMs = new Date(y, m, day, 0, 0, 0, 0).getTime();
    const todayEpochDay = Math.floor(Date.UTC(y, m, day) / 86_400_000);
    return {
        dateStr,
        hour: d.getHours(),
        minute: d.getMinutes(),
        midnightUtcMs,
        todayEpochDay,
    };
}

/**
 * Local calendar day index aligned with local midnight (SCHED-01, C11).
 */
export function getTodayDay(nowMs: number = Date.now(), timeZone?: string): number {
    if (timeZone) {
        return getZonedDayInfo(nowMs, { timeZone }).todayEpochDay;
    }
    const d = new Date(nowMs);
    const localMidnightUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.floor(localMidnightUtc / 86_400_000);
}

export function getLocalDayStartMs(nowMs: number = Date.now(), timeZone?: string): number {
    if (timeZone) {
        return getZonedDayInfo(nowMs, { timeZone }).midnightUtcMs;
    }
    const d = new Date(nowMs);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/**
 * Normalize a review or day-learning card's `due` field to canonical epoch days (C01, C02, C05).
 * Traditional desktop Anki stores review card `due` as days relative to `col.crt` (`due < 10000`),
 * whereas klanki schedules using epoch days (`>= 10000`).
 */
export function normalizeReviewDueDay(due: number, colCrtSec?: number): number {
    if (due < 10_000) {
        const crtSec = colCrtSec && colCrtSec > 0 ? colCrtSec : Math.floor(Date.now() / 1000);
        const crtDay = Math.floor(crtSec / 86_400);
        return crtDay + due;
    }
    return due;
}

/**
 * Convert a canonical epoch-day `due` back to Anki's collection-relative day for .apkg export (C02).
 */
export function toRelativeAnkiDueDay(due: number, colCrtSec: number): number {
    const crtDay = Math.floor(colCrtSec / 86_400);
    if (due >= 10_000) {
        return Math.max(0, due - crtDay);
    }
    return Math.max(0, due);
}

/**
 * Restore a suspended (`queue = -1`) or buried (`queue = -2 | -3`) card to its
 * authoritative active queue based on its `type` and `due` representation (UX-02).
 */
export function restoreCardQueue(card: Pick<Card, "type" | "due">): CardQueue {
    if (card.type === 0) {
        return 0;
    }
    if (card.type === 1 || card.type === 3) {
        // Intraday learning stores `due` as Unix epoch seconds (>= 1_000_000_000);
        // day-learning stores `due` in days (< 1_000_000_000).
        return card.due >= 1_000_000_000 ? 1 : 3;
    }
    return 2;
}

/**
 * Reset a card back to brand-new state, clearing both SM-2 scheduling fields
 * and FSRS memory state (`card.data`) (UX-03).
 */
export function resetCardProgress(
    card: Card,
    newDue: number = 0,
    nowSec: number = Math.floor(Date.now() / 1000),
): Card {
    return {
        ...card,
        type: 0,
        queue: 0,
        due: newDue,
        ivl: 0,
        factor: 2500,
        reps: 0,
        lapses: 0,
        left: 0,
        odue: 0,
        odid: 0,
        data: "{}",
        mod: nowSec,
    };
}

export function fuzzDelta(interval: number): number {
    if (interval < 2.5) { return 0; }
    const t1 = Math.max(0, Math.min(interval, 7) - 2.5) * 0.15;
    const t2 = Math.max(0, Math.min(interval, 20) - 7) * 0.1;
    const t3 = Math.max(0, interval - 20) * 0.05;
    return 1 + t1 + t2 + t3;
}

export function withReviewFuzz(
    interval: number,
    minIvl: number,
    maxIvl: number,
    seed: number,
): number {
    const cappedMin = Math.min(minIvl, maxIvl);
    const delta = fuzzDelta(interval);
    if (delta === 0) {
        return Math.min(maxIvl, Math.max(cappedMin, Math.round(interval)));
    }

    const lo = Math.round(Math.max(cappedMin, interval - delta));
    const hi = Math.round(Math.min(maxIvl, interval + delta));
    if (lo >= hi) { return Math.min(maxIvl, lo); }

    const r = Math.abs(Math.sin(seed) * 10000) % 1;
    return Math.min(maxIvl, Math.floor(lo + r * (1 + hi - lo)));
}

export function formatInterval(val: number, isDays: boolean): string {
    if (!isDays) {
        const mins = Math.round(val / 60);
        if (mins < 1) { return "<1m"; }
        if (mins < 60) { return `${mins}m`; }
        const hours = Math.round(mins / 60);
        return `${hours}h`;
    }

    const days = Math.round(val);
    if (days < 1) { return "<1d"; }
    if (days < 30) { return `${days}d`; }
    if (days < 365) {
        const months = (days / 30.4375).toFixed(1).replace(/\.0$/, "");
        return `${months}m`;
    }
    const years = (days / 365.25).toFixed(1).replace(/\.0$/, "");
    return `${years}y`;
}

// ============================================================================
// FSRS v4.5 / v5 Spaced Repetition Engine (C03, SCHED-03, SCHED-04)
// ============================================================================
export const FSRS_DEFAULT_W = [
    0.40255,
    1.18385,
    3.173,
    15.69105,
    7.1949,
    0.5345,
    1.4604,
    0.0046,
    1.54575,
    0.1192,
    1.01925,
    1.9395,
    0.11,
    0.29605,
    2.2698,
    0.2315,
    2.9898,
    0.51655,
    0.6621,
];

export interface FsrsMemoryState {
    s: number; // stability in days
    d: number; // difficulty in [1, 10]
    lastRevDay?: number;
}

export function parseFsrsState(card: Card, today: number): FsrsMemoryState {
    if (card.data) {
        try {
            const parsed = JSON.parse(card.data);
            if (typeof parsed.s === "number" && parsed.s > 0 && typeof parsed.d === "number") {
                return {
                    s: Math.max(0.1, parsed.s),
                    d: Math.min(10, Math.max(1, parsed.d)),
                    lastRevDay: typeof parsed.lastRevDay === "number"
                        ? parsed.lastRevDay
                        : today - Math.max(1, card.ivl),
                };
            }
        } catch {
            // fall through
        }
    }
    // Initialize from legacy card state if migrating an existing card to FSRS
    const initS = card.ivl > 0 ? card.ivl : FSRS_DEFAULT_W[2];
    const easeNorm = (card.factor || 2500) / 1000;
    const initD = Math.min(10, Math.max(1, 11 - (easeNorm - 1.3) * 4));
    return {
        s: initS,
        d: initD,
        lastRevDay: card.ivl > 0 ? today - card.ivl : today,
    };
}

export function fsrsInitialStability(rating: Rating, w: readonly number[] = FSRS_DEFAULT_W): number {
    return Math.max(0.1, w[rating - 1]);
}

export function fsrsInitialDifficulty(rating: Rating, w: readonly number[] = FSRS_DEFAULT_W): number {
    const w4 = w[4];
    const w5 = w[5];
    const d = w4 - Math.exp(w5 * (rating - 1)) + 1;
    return Math.min(10, Math.max(1, d));
}

export function fsrsNextDifficulty(d: number, rating: Rating, w: readonly number[] = FSRS_DEFAULT_W): number {
    const w6 = w[6];
    const w7 = w[7];
    const d0Easy = fsrsInitialDifficulty(4, w);
    const deltaD = -w6 * (rating - 3);
    const damped = d + deltaD * ((10 - d) / 9);
    const nextD = w7 * d0Easy + (1 - w7) * damped;
    return Math.min(10, Math.max(1, nextD));
}

export function fsrsRetrievability(elapsedDays: number, stability: number): number {
    if (elapsedDays <= 0) { return 1; }
    return Math.pow(1 + (19 / 81) * (elapsedDays / Math.max(0.1, stability)), -0.5);
}

export function fsrsSameDayStability(s: number, rating: Rating, w: readonly number[] = FSRS_DEFAULT_W): number {
    const w17 = w[17];
    const w18 = w[18];
    return Math.max(0.1, s * Math.exp(w17 * (rating - 3 + w18)));
}

export function fsrsNextRecallStability(
    d: number,
    s: number,
    r: number,
    rating: Rating,
    w: readonly number[] = FSRS_DEFAULT_W,
): number {
    const w8 = w[8];
    const w9 = w[9];
    const w10 = w[10];
    const hardPenalty = rating === 2 ? w[15] : 1;
    const easyBonus = rating === 4 ? w[16] : 1;
    const factor = Math.exp(w8)
        * (11 - d)
        * Math.pow(Math.max(0.1, s), -w9)
        * (Math.exp((1 - r) * w10) - 1)
        * hardPenalty
        * easyBonus;
    return Math.max(0.1, s * (1 + factor));
}

export function fsrsNextForgetStability(
    d: number,
    s: number,
    r: number,
    w: readonly number[] = FSRS_DEFAULT_W,
): number {
    const w11 = w[11];
    const w12 = w[12];
    const w13 = w[13];
    const w14 = w[14];
    const nextS = w11
        * Math.pow(Math.min(10, Math.max(1, d)), -w12)
        * (Math.pow(Math.max(0.1, s) + 1, w13) - 1)
        * Math.exp((1 - r) * w14);
    return Math.max(0.1, Math.min(s, nextS));
}

export function fsrsIntervalFromStability(
    stability: number,
    desiredRetention: number,
    maxIvl: number,
): number {
    const r = Math.min(0.97, Math.max(0.7, desiredRetention || 0.9));
    const raw = (stability / (19 / 81)) * (Math.pow(r, -2) - 1);
    return Math.min(maxIvl, Math.max(1, Math.round(raw)));
}

function calculateFsrsReviewScheduling(
    card: Card,
    config: DeckConfig,
    nowSec: number,
    today: number,
): SchedulingOption[] {
    const desiredRetention = config.desiredRetention || 0.9;
    const maxIvl = Math.max(1, config.rev.maxIvl || 36500);
    const state = parseFsrsState(card, today);
    const rawElapsedDays = state.lastRevDay !== undefined
        ? Math.max(0, today - state.lastRevDay)
        : Math.max(1, card.ivl);
    const isSameDay = rawElapsedDays === 0;
    const elapsedDays = Math.max(1, rawElapsedDays);
    const r = fsrsRetrievability(elapsedDays, state.s);

    // 1. Again (Lapse)
    const newLapses = card.lapses + 1;
    const isLeech = newLapses >= (config.lapse.leechFails || 8);
    const leechSuspended = isLeech && config.lapse.leechAction === 0;
    const lapseDelays = config.lapse.delays.length ? config.lapse.delays : [10];
    const againDelaySec = lapseDelays[0] * 60;
    const sAgain = isSameDay
        ? fsrsSameDayStability(state.s, 1)
        : fsrsNextForgetStability(state.d, state.s, r);
    const dAgain = fsrsNextDifficulty(state.d, 1);

    // 2. Hard, Good, Easy recall stabilities & intervals (clamped to maxIvl SCHED-03)
    const sHard = isSameDay
        ? fsrsSameDayStability(state.s, 2)
        : fsrsNextRecallStability(state.d, state.s, r, 2);
    const dHard = fsrsNextDifficulty(state.d, 2);
    const hardIvl = Math.min(
        maxIvl,
        Math.max(1, fsrsIntervalFromStability(sHard, desiredRetention, maxIvl)),
    );

    const sGood = isSameDay
        ? fsrsSameDayStability(state.s, 3)
        : fsrsNextRecallStability(state.d, state.s, r, 3);
    const dGood = fsrsNextDifficulty(state.d, 3);
    const goodIvl = Math.min(
        maxIvl,
        Math.max(
            hardIvl + 1,
            fsrsIntervalFromStability(sGood, desiredRetention, maxIvl),
        ),
    );

    const sEasy = isSameDay
        ? fsrsSameDayStability(state.s, 4)
        : fsrsNextRecallStability(state.d, state.s, r, 4);
    const dEasy = fsrsNextDifficulty(state.d, 4);
    const easyIvl = Math.min(
        maxIvl,
        Math.max(
            goodIvl + 1,
            fsrsIntervalFromStability(sEasy, desiredRetention, maxIvl),
        ),
    );

    return [
        {
            rating: 1,
            label: "Again",
            intervalText: formatInterval(againDelaySec, false),
            nextState: {
                type: 3,
                queue: leechSuspended ? -1 : 1,
                due: nowSec + againDelaySec,
                ivl: -againDelaySec,
                factor: card.factor || 2500,
                left: 1000 + lapseDelays.length,
                reps: card.reps + 1,
                lapses: newLapses,
                data: JSON.stringify({
                    s: Number(sAgain.toFixed(3)),
                    d: Number(dAgain.toFixed(3)),
                    lastRevDay: today,
                }),
            },
        },
        {
            rating: 2,
            label: "Hard",
            intervalText: formatInterval(hardIvl, true),
            nextState: {
                type: 2,
                queue: 2,
                due: today + hardIvl,
                ivl: hardIvl,
                factor: card.factor || 2500,
                left: 0,
                reps: card.reps + 1,
                lapses: card.lapses,
                data: JSON.stringify({
                    s: Number(sHard.toFixed(3)),
                    d: Number(dHard.toFixed(3)),
                    lastRevDay: today,
                }),
            },
        },
        {
            rating: 3,
            label: "Good",
            intervalText: formatInterval(goodIvl, true),
            nextState: {
                type: 2,
                queue: 2,
                due: today + goodIvl,
                ivl: goodIvl,
                factor: card.factor || 2500,
                left: 0,
                reps: card.reps + 1,
                lapses: card.lapses,
                data: JSON.stringify({
                    s: Number(sGood.toFixed(3)),
                    d: Number(dGood.toFixed(3)),
                    lastRevDay: today,
                }),
            },
        },
        {
            rating: 4,
            label: "Easy",
            intervalText: formatInterval(easyIvl, true),
            nextState: {
                type: 2,
                queue: 2,
                due: today + easyIvl,
                ivl: easyIvl,
                factor: card.factor || 2500,
                left: 0,
                reps: card.reps + 1,
                lapses: card.lapses,
                data: JSON.stringify({
                    s: Number(sEasy.toFixed(3)),
                    d: Number(dEasy.toFixed(3)),
                    lastRevDay: today,
                }),
            },
        },
    ];
}

export function calculateScheduling(card: Card, config: DeckConfig): SchedulingOption[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const today = getTodayDay();
    const useFsrs = Boolean(config.fsrsEnabled);
    const desiredRetention = config.desiredRetention || 0.9;
    const maxIvl = Math.max(1, config.rev.maxIvl || 36500);

    const delays = card.type === 3
        ? config.lapse.delays.length
            ? config.lapse.delays
            : [10]
        : config.new.delays.length
        ? config.new.delays
        : [1, 10];
    const initialFactor = config.new.initialFactor || 2500;
    const currentFactor = card.factor || initialFactor;

    const graduatingInt = Math.min(
        maxIvl,
        useFsrs
            ? fsrsIntervalFromStability(fsrsInitialStability(3), desiredRetention, maxIvl)
            : config.new.ints[0] || 1,
    );
    const easyInt = Math.min(
        maxIvl,
        useFsrs
            ? Math.max(
                graduatingInt + 1,
                fsrsIntervalFromStability(fsrsInitialStability(4), desiredRetention, maxIvl),
            )
            : config.new.ints[1] || 4,
    );

    const hardFactor = config.rev.hardFactor || 1.2;
    const ease4 = config.rev.ease4 || 1.3;
    const ivlFct = config.rev.ivlFct || 1.0;

    // 1. NEW CARDS
    if (card.type === 0) {
        const againSec = (delays[0] || 1) * 60;
        const hardSec = delays.length > 1
            ? Math.round(((delays[0] + delays[1]) / 2) * 60)
            : Math.round(againSec * 1.5);
        const goodSec = delays.length > 1 ? delays[1] * 60 : graduatingInt * 86400;
        const goodIsGraduate = delays.length <= 1;

        const makeFsrsData = (r: Rating) =>
            useFsrs
                ? JSON.stringify({
                    s: Number(fsrsInitialStability(r).toFixed(3)),
                    d: Number(fsrsInitialDifficulty(r).toFixed(3)),
                    lastRevDay: today,
                })
                : card.data;

        return [
            {
                rating: 1,
                label: "Again",
                intervalText: formatInterval(againSec, false),
                nextState: {
                    type: 1,
                    queue: 1,
                    due: nowSec + againSec,
                    ivl: -againSec,
                    factor: currentFactor,
                    left: 1000 + delays.length,
                    reps: card.reps + 1,
                    lapses: card.lapses,
                    data: makeFsrsData(1),
                },
            },
            {
                rating: 2,
                label: "Hard",
                intervalText: formatInterval(hardSec, false),
                nextState: {
                    type: 1,
                    queue: 1,
                    due: nowSec + hardSec,
                    ivl: -hardSec,
                    factor: currentFactor,
                    left: 1000 + delays.length,
                    reps: card.reps + 1,
                    lapses: card.lapses,
                    data: makeFsrsData(2),
                },
            },
            {
                rating: 3,
                label: "Good",
                intervalText: goodIsGraduate
                    ? formatInterval(graduatingInt, true)
                    : formatInterval(goodSec, false),
                nextState: goodIsGraduate
                    ? {
                        type: 2,
                        queue: 2,
                        due: today + graduatingInt,
                        ivl: graduatingInt,
                        factor: currentFactor,
                        left: 0,
                        reps: card.reps + 1,
                        lapses: card.lapses,
                        data: makeFsrsData(3),
                    }
                    : {
                        type: 1,
                        queue: 1,
                        due: nowSec + goodSec,
                        ivl: -goodSec,
                        factor: currentFactor,
                        left: 1000 + (delays.length - 1),
                        reps: card.reps + 1,
                        lapses: card.lapses,
                        data: makeFsrsData(3),
                    },
            },
            {
                rating: 4,
                label: "Easy",
                intervalText: formatInterval(easyInt, true),
                nextState: {
                    type: 2,
                    queue: 2,
                    due: today + easyInt,
                    ivl: easyInt,
                    factor: currentFactor,
                    left: 0,
                    reps: card.reps + 1,
                    lapses: card.lapses,
                    data: makeFsrsData(4),
                },
            },
        ];
    }

    // 2. LEARNING OR RELEARNING CARDS
    if (card.type === 1 || card.type === 3) {
        const stepIdx = Math.max(0, delays.length - (card.left % 1000));
        const againSec = (delays[0] || 1) * 60;
        const currentDelay = delays[stepIdx] || delays[0] || 1;
        const hardSec = Math.round(currentDelay * 60 * 1.5);
        const nextStepIdx = stepIdx + 1;
        const isGraduating = nextStepIdx >= delays.length;

        const fsrsState = useFsrs ? parseFsrsState(card, today) : null;
        const updateLearnFsrs = (r: Rating): string => {
            if (!useFsrs || !fsrsState) { return card.data; }
            const nextS = fsrsSameDayStability(fsrsState.s, r);
            const nextD = fsrsNextDifficulty(fsrsState.d, r);
            return JSON.stringify({
                s: Number(nextS.toFixed(3)),
                d: Number(nextD.toFixed(3)),
                lastRevDay: today,
            });
        };

        const graduatingDays = Math.min(
            maxIvl,
            useFsrs && fsrsState
                ? fsrsIntervalFromStability(fsrsSameDayStability(fsrsState.s, 3), desiredRetention, maxIvl)
                : card.type === 3
                ? Math.max(config.lapse.minInt || 1, Math.round(Math.abs(card.ivl) * (config.lapse.mult || 0))) || 1
                : graduatingInt,
        );

        const goodSec = isGraduating
            ? graduatingDays * 86400
            : (delays[nextStepIdx] || currentDelay) * 60;
        const easyDays = Math.min(
            maxIvl,
            useFsrs && fsrsState
                ? Math.max(
                    graduatingDays + 1,
                    fsrsIntervalFromStability(fsrsSameDayStability(fsrsState.s, 4), desiredRetention, maxIvl),
                )
                : card.type === 3
                ? graduatingDays + 1
                : easyInt,
        );

        return [
            {
                rating: 1,
                label: "Again",
                intervalText: formatInterval(againSec, false),
                nextState: {
                    type: card.type,
                    queue: 1,
                    due: nowSec + againSec,
                    ivl: -againSec,
                    factor: currentFactor,
                    left: 1000 + delays.length,
                    reps: card.reps + 1,
                    lapses: card.lapses,
                    data: updateLearnFsrs(1),
                },
            },
            {
                rating: 2,
                label: "Hard",
                intervalText: formatInterval(hardSec, false),
                nextState: {
                    type: card.type,
                    queue: 1,
                    due: nowSec + hardSec,
                    ivl: -hardSec,
                    factor: currentFactor,
                    left: card.left,
                    reps: card.reps + 1,
                    lapses: card.lapses,
                    data: updateLearnFsrs(2),
                },
            },
            {
                rating: 3,
                label: "Good",
                intervalText: isGraduating
                    ? formatInterval(graduatingDays, true)
                    : formatInterval(goodSec, false),
                nextState: isGraduating
                    ? {
                        type: 2,
                        queue: 2,
                        due: today + graduatingDays,
                        ivl: graduatingDays,
                        factor: currentFactor,
                        left: 0,
                        reps: card.reps + 1,
                        lapses: card.lapses,
                        data: updateLearnFsrs(3),
                    }
                    : {
                        type: card.type,
                        queue: 1,
                        due: nowSec + goodSec,
                        ivl: -goodSec,
                        factor: currentFactor,
                        left: 1000 + (delays.length - nextStepIdx),
                        reps: card.reps + 1,
                        lapses: card.lapses,
                        data: updateLearnFsrs(3),
                    },
            },
            {
                rating: 4,
                label: "Easy",
                intervalText: formatInterval(easyDays, true),
                nextState: {
                    type: 2,
                    queue: 2,
                    due: today + easyDays,
                    ivl: easyDays,
                    factor: currentFactor,
                    left: 0,
                    reps: card.reps + 1,
                    lapses: card.lapses,
                    data: updateLearnFsrs(4),
                },
            },
        ];
    }

    // 3. REVIEW CARDS — Use real FSRS if enabled on deck config (C03)
    if (useFsrs) {
        return calculateFsrsReviewScheduling(card, config, nowSec, today);
    }

    // Standard V3 / SM-2 Review Scheduling
    const currentIvl = Math.max(1, card.ivl);
    const factorFloat = currentFactor / 1000;
    const seed = card.id + card.reps;

    const newLapses = card.lapses + 1;
    const isLeech = newLapses >= (config.lapse.leechFails || 8);
    const leechSuspended = isLeech && config.lapse.leechAction === 0;
    const againFactor = Math.max(1300, currentFactor - 200);
    const lapseDelays = config.lapse.delays.length ? config.lapse.delays : [10];
    const againDelaySec = lapseDelays[0] * 60;

    const hardFactorCalc = Math.max(1300, currentFactor - 150);
    const rawHardIvl = Math.max(currentIvl + 1, Math.round(currentIvl * hardFactor * ivlFct));
    const hardIvl = Math.min(maxIvl, withReviewFuzz(rawHardIvl, currentIvl + 1, maxIvl, seed + 1));

    const rawGoodIvl = Math.max(hardIvl + 1, Math.round(currentIvl * factorFloat * ivlFct));
    const goodIvl = Math.min(maxIvl, withReviewFuzz(rawGoodIvl, hardIvl + 1, maxIvl, seed + 2));

    const easyFactor = currentFactor + 150;
    const rawEasyIvl = Math.max(goodIvl + 1, Math.round(currentIvl * factorFloat * ivlFct * ease4));
    const easyIvl = Math.min(maxIvl, withReviewFuzz(rawEasyIvl, goodIvl + 1, maxIvl, seed + 3));

    return [
        {
            rating: 1,
            label: "Again",
            intervalText: formatInterval(againDelaySec, false),
            nextState: {
                type: 3,
                queue: leechSuspended ? -1 : 1,
                due: nowSec + againDelaySec,
                ivl: -againDelaySec,
                factor: againFactor,
                left: 1000 + lapseDelays.length,
                reps: card.reps + 1,
                lapses: newLapses,
                data: card.data,
            },
        },
        {
            rating: 2,
            label: "Hard",
            intervalText: formatInterval(hardIvl, true),
            nextState: {
                type: 2,
                queue: 2,
                due: today + hardIvl,
                ivl: hardIvl,
                factor: hardFactorCalc,
                left: 0,
                reps: card.reps + 1,
                lapses: card.lapses,
                data: card.data,
            },
        },
        {
            rating: 3,
            label: "Good",
            intervalText: formatInterval(goodIvl, true),
            nextState: {
                type: 2,
                queue: 2,
                due: today + goodIvl,
                ivl: goodIvl,
                factor: currentFactor,
                left: 0,
                reps: card.reps + 1,
                lapses: card.lapses,
                data: card.data,
            },
        },
        {
            rating: 4,
            label: "Easy",
            intervalText: formatInterval(easyIvl, true),
            nextState: {
                type: 2,
                queue: 2,
                due: today + easyIvl,
                ivl: easyIvl,
                factor: easyFactor,
                left: 0,
                reps: card.reps + 1,
                lapses: card.lapses,
                data: card.data,
            },
        },
    ];
}

// ============================================================================
// Shared Card-State Predicates (SCHED-05, UX-08)
// ============================================================================

export function isCardDueInLearnQueue(
    card: Card,
    nowSec: number,
    today: number,
    colCrtSec?: number,
    aheadSec: number = 0,
): boolean {
    if (card.queue === 1) {
        return card.due <= nowSec + aheadSec;
    }
    if (card.queue === 3) {
        // Queue 3 is day-learning (or legacy timestamp if > 1_000_000_000) (C05)
        if (card.due > 1_000_000_000) {
            return card.due <= nowSec + aheadSec;
        }
        return normalizeReviewDueDay(card.due, colCrtSec) <= today;
    }
    return false;
}

export function isCardDueForReview(
    card: Card,
    today: number,
    colCrtSec?: number,
): boolean {
    if (card.queue !== 2) { return false; }
    return normalizeReviewDueDay(card.due, colCrtSec) <= today;
}

/**
 * Authoritative predicate for whether a card is currently due (`is:due`) (UX-08, SCHED-05).
 * Matches due learning cards (`queue === 1 | 3`) and due review cards (`queue === 2`).
 * Never treats New (`queue === 0`), Suspended (`queue === -1`), or Buried (`queue < -1`) cards as due.
 */
export function isCardDue(
    card: Card,
    nowSec: number,
    today: number,
    colCrtSec?: number,
    learnAheadSec: number = 0,
): boolean {
    if (card.queue === 1 || card.queue === 3) {
        return isCardDueInLearnQueue(card, nowSec, today, colCrtSec, learnAheadSec);
    }
    if (card.queue === 2) {
        return isCardDueForReview(card, today, colCrtSec);
    }
    return false;
}

function getEffectiveDailyLimits(
    col: Collection,
    did: number,
    today: number,
): { maxNew: number; maxRev: number; studiedNewToday: number; studiedRevToday: number; matchingDid: Set<number> } {
    const targetDeck = col.decks[did];
    const targetPrefix = targetDeck ? `${targetDeck.name}::` : "";

    const matchingDid = new Set<number>();
    matchingDid.add(did);
    for (const [idStr, d] of Object.entries(col.decks)) {
        const id = Number(idStr);
        if (targetPrefix && d.name.startsWith(targetPrefix)) {
            matchingDid.add(id);
        }
    }

    const conf = (targetDeck && col.dconf[targetDeck.conf])
        || col.dconf[1]
        || Object.values(col.dconf)[0];

    const baseNewLimit = conf?.new?.perDay !== undefined ? Math.max(0, conf.new.perDay) : 20;
    const baseRevLimit = conf?.rev?.perDay !== undefined ? Math.max(0, conf.rev.perDay) : 200;

    // Ephemeral Custom Study override valid only for `today` (C09)
    const custom = targetDeck?.customStudy;
    const extraNew = custom && custom.day === today ? Math.max(0, custom.extraNew || 0) : 0;
    const extraRev = custom && custom.day === today ? Math.max(0, custom.extraRev || 0) : 0;

    const startOfDayMs = getLocalDayStartMs();
    const seenNewCardsToday = new Set<number>();
    const seenRevCardsToday = new Set<number>();

    for (const entry of col.revlog || []) {
        if (entry.id < startOfDayMs) { continue; }
        const c = col.cards[entry.cid];
        if (!c || !matchingDid.has(c.did)) { continue; }
        if (entry.type === 0 && entry.lastIvl === 0) {
            seenNewCardsToday.add(entry.cid);
        } else if (entry.type === 1) {
            seenRevCardsToday.add(entry.cid);
        }
    }

    return {
        maxNew: baseNewLimit + extraNew,
        maxRev: baseRevLimit + extraRev,
        studiedNewToday: seenNewCardsToday.size,
        studiedRevToday: seenRevCardsToday.size,
        matchingDid,
    };
}

/**
 * Compute study counts for all decks in `col` in a single pass (`O(D + C + R)`) (PERF-01).
 * Parent decks aggregate the playable New, Learn, and Due counts of all their subdecks
 * bottom-up so a main deck always reflects the sum of its subdecks.
 */
export function getAllDeckCounts(col: Collection): Record<number, DeckStudyCounts> {
    const today = getTodayDay();
    const nowSec = Math.floor(Date.now() / 1000);
    const startOfDayMs = getLocalDayStartMs();

    const directNew: Record<number, number> = {};
    const directLearn: Record<number, number> = {};
    const directRev: Record<number, number> = {};

    for (const card of Object.values(col.cards)) {
        if (card.queue < 0) { continue; }
        const did = card.did;
        if (card.queue === 0) {
            directNew[did] = (directNew[did] || 0) + 1;
        } else if (card.queue === 1 || card.queue === 3) {
            if (isCardDueInLearnQueue(card, nowSec, today, col.crt, 300)) {
                directLearn[did] = (directLearn[did] || 0) + 1;
            }
        } else if (card.queue === 2) {
            if (isCardDueForReview(card, today, col.crt)) {
                directRev[did] = (directRev[did] || 0) + 1;
            }
        }
    }

    const studiedNewByDeck = new Map<number, Set<number>>();
    const studiedRevByDeck = new Map<number, Set<number>>();
    for (const entry of col.revlog || []) {
        if (entry.id < startOfDayMs) { continue; }
        const c = col.cards[entry.cid];
        if (!c) { continue; }
        if (entry.type === 0 && entry.lastIvl === 0) {
            let s = studiedNewByDeck.get(c.did);
            if (!s) {
                s = new Set<number>();
                studiedNewByDeck.set(c.did, s);
            }
            s.add(entry.cid);
        } else if (entry.type === 1) {
            let s = studiedRevByDeck.get(c.did);
            if (!s) {
                s = new Set<number>();
                studiedRevByDeck.set(c.did, s);
            }
            s.add(entry.cid);
        }
    }

    const deckByName = new Map<string, number>();
    const allDecks = Object.values(col.decks);
    for (const d of allDecks) {
        deckByName.set(d.name, d.id);
    }

    // Sort decks deepest-first so child subdecks are evaluated before their parent deck
    const decksByDepthDesc = [...allDecks].sort((a, b) => {
        const depthA = (a.name.match(/::/g) || []).length;
        const depthB = (b.name.match(/::/g) || []).length;
        return depthB - depthA;
    });

    const defaultDconf = col.dconf[1] || Object.values(col.dconf)[0];
    const childrenNew: Record<number, number> = {};
    const childrenLearn: Record<number, number> = {};
    const childrenRev: Record<number, number> = {};
    const result: Record<number, DeckStudyCounts> = {};

    for (const d of decksByDepthDesc) {
        const conf = col.dconf[d.conf] || defaultDconf;
        const baseNewLimit = conf?.new?.perDay !== undefined ? Math.max(0, conf.new.perDay) : 20;
        const baseRevLimit = conf?.rev?.perDay !== undefined ? Math.max(0, conf.rev.perDay) : 200;
        const custom = d.customStudy;
        const extraNew = custom && custom.day === today ? Math.max(0, custom.extraNew || 0) : 0;
        const extraRev = custom && custom.day === today ? Math.max(0, custom.extraRev || 0) : 0;

        const maxNew = baseNewLimit + extraNew;
        const maxRev = baseRevLimit + extraRev;
        const studiedNew = studiedNewByDeck.get(d.id)?.size || 0;
        const studiedRev = studiedRevByDeck.get(d.id)?.size || 0;

        const ownRemainingNew = Math.max(0, maxNew - studiedNew);
        const ownRemainingRev = Math.max(0, maxRev - studiedRev);
        const ownPlayableNew = Math.min(directNew[d.id] || 0, ownRemainingNew);
        const ownPlayableRev = Math.min(directRev[d.id] || 0, ownRemainingRev);
        const ownPlayableLearn = directLearn[d.id] || 0;

        const totalNew = maxNew === 0 ? 0 : ownPlayableNew + (childrenNew[d.id] || 0);
        const totalLearn = ownPlayableLearn + (childrenLearn[d.id] || 0);
        const totalRev = maxRev === 0 ? 0 : ownPlayableRev + (childrenRev[d.id] || 0);

        result[d.id] = {
            newCount: totalNew,
            learnCount: totalLearn,
            reviewCount: totalRev,
        };

        // Roll up into the closest existing ancestor deck (`A::B::C` -> `A::B` or `A`)
        const parts = d.name.split("::");
        for (let i = parts.length - 1; i >= 1; i--) {
            const ancestorName = parts.slice(0, i).join("::");
            const parentId = deckByName.get(ancestorName);
            if (parentId !== undefined) {
                childrenNew[parentId] = (childrenNew[parentId] || 0) + totalNew;
                childrenLearn[parentId] = (childrenLearn[parentId] || 0) + totalLearn;
                childrenRev[parentId] = (childrenRev[parentId] || 0) + totalRev;
                break;
            }
        }
    }

    return result;
}

export function getDeckCounts(col: Collection, did: number): DeckStudyCounts {
    const all = getAllDeckCounts(col);
    return all[did] || { newCount: 0, learnCount: 0, reviewCount: 0 };
}

export function getNextStudyCard(col: Collection, did: number): Card | null {
    const today = getTodayDay();
    const nowSec = Math.floor(Date.now() / 1000);
    const { matchingDid } = getEffectiveDailyLimits(col, did, today);

    const allowedByDeck = getAllDeckCounts(col);
    const targetCounts = allowedByDeck[did] || { newCount: 0, learnCount: 0, reviewCount: 0 };
    const canStudyNew = targetCounts.newCount > 0;
    const canStudyRev = targetCounts.reviewCount > 0;

    // Order decks alphabetically by name so studying a parent deck walks subdecks in display order
    const sortedDecks = Object.values(col.decks).sort((a, b) => a.name.localeCompare(b.name));
    const deckOrderRank = new Map<number, number>();
    sortedDecks.forEach((d, idx) => deckOrderRank.set(d.id, idx));

    const deckIdByName = new Map(sortedDecks.map(deck => [deck.name, deck.id]));

    // Also compute each individual deck's direct remaining allowance so a subdeck whose own
    // daily cap is exhausted is skipped in favor of the next subdeck with remaining allowance.
    const startOfDayMs = getLocalDayStartMs();
    const directStudiedNew: Record<number, Set<number>> = {};
    const directStudiedRev: Record<number, Set<number>> = {};
    for (const entry of col.revlog || []) {
        if (entry.id < startOfDayMs) { continue; }
        const c = col.cards[entry.cid];
        if (!c || !matchingDid.has(c.did)) { continue; }
        if (entry.type === 0 && entry.lastIvl === 0) {
            (directStudiedNew[c.did] ||= new Set()).add(entry.cid);
        } else if (entry.type === 1) {
            (directStudiedRev[c.did] ||= new Set()).add(entry.cid);
        }
    }
    const defaultDconf = col.dconf[1] || Object.values(col.dconf)[0];
    const hasDirectAllowance = (cardDeckId: number, kind: "newCount" | "reviewCount"): boolean => {
        const d = col.decks[cardDeckId];
        if (!d) { return false; }
        const conf = col.dconf[d.conf] || defaultDconf;
        const custom = d.customStudy;
        if (kind === "newCount") {
            const base = conf?.new?.perDay !== undefined ? Math.max(0, conf.new.perDay) : 20;
            const extra = custom && custom.day === today ? Math.max(0, custom.extraNew || 0) : 0;
            return (directStudiedNew[cardDeckId]?.size || 0) < base + extra;
        } else {
            const base = conf?.rev?.perDay !== undefined ? Math.max(0, conf.rev.perDay) : 200;
            const extra = custom && custom.day === today ? Math.max(0, custom.extraRev || 0) : 0;
            return (directStudiedRev[cardDeckId]?.size || 0) < base + extra;
        }
    };

    const withinAncestorLimits = (cardDeckId: number, kind: "newCount" | "reviewCount"): boolean => {
        if (!hasDirectAllowance(cardDeckId, kind)) { return false; }
        const deck = col.decks[cardDeckId];
        if (!deck) { return false; }
        const parts = deck.name.split("::");
        let path = "";
        for (const segment of parts) {
            path = path ? `${path}::${segment}` : segment;
            const ancestorId = deckIdByName.get(path);
            if (
                ancestorId !== undefined
                && matchingDid.has(ancestorId)
                && (allowedByDeck[ancestorId]?.[kind] ?? 0) <= 0
            ) {
                return false;
            }
        }
        return true;
    };

    // 1. Learning cards due right now (or within 5m lookahead if none due this second)
    let dueLearn: Card | null = null;
    let earliestLearnDue = Infinity;

    // 2. Review cards due today (ordered by subdeck order, then due day)
    let dueReview: Card | null = null;
    let earliestReviewRank = Infinity;
    let earliestReviewDue = Infinity;

    // 3. New cards (ordered by subdeck display order, then card due position)
    let nextNew: Card | null = null;
    let earliestNewDeckRank = Infinity;
    let earliestNewPos = Infinity;

    for (const card of Object.values(col.cards)) {
        if (!matchingDid.has(card.did)) { continue; }
        if (card.queue < 0) { continue; }
        const dRank = deckOrderRank.get(card.did) ?? 0;

        if (card.queue === 1 || card.queue === 3) {
            if (isCardDueInLearnQueue(card, nowSec, today, col.crt, 300)) {
                const sortMetric = card.queue === 3 && card.due < 1_000_000_000
                    ? normalizeReviewDueDay(card.due, col.crt) * 86400
                    : card.due;
                if (sortMetric < earliestLearnDue) {
                    dueLearn = card;
                    earliestLearnDue = sortMetric;
                }
            }
        } else if (card.queue === 2 && canStudyRev && withinAncestorLimits(card.did, "reviewCount")) {
            const dueDay = normalizeReviewDueDay(card.due, col.crt);
            if (
                dueDay <= today
                && (dRank < earliestReviewRank || (dRank === earliestReviewRank && dueDay < earliestReviewDue))
            ) {
                dueReview = card;
                earliestReviewRank = dRank;
                earliestReviewDue = dueDay;
            }
        } else if (card.queue === 0 && canStudyNew && withinAncestorLimits(card.did, "newCount")) {
            if (
                dRank < earliestNewDeckRank
                || (dRank === earliestNewDeckRank && card.due < earliestNewPos)
            ) {
                nextNew = card;
                earliestNewDeckRank = dRank;
                earliestNewPos = card.due;
            }
        }
    }

    return dueLearn || dueReview || nextNew;
}

/**
 * Temporary Custom Study "lapsed today" queue (C10, UX-11): returns the IDs of cards in `did`
 * (and its subdecks) that were forgotten today (`ease === 1` in today's `revlog`).
 * Selects strictly from today's authoritative review history rather than `card.queue === 1` alone
 * so previously lapsed learning cards from earlier days are not falsely included (UX-11).
 */
export function getCustomStudyCardIds(col: Collection, did: number): number[] {
    const startOfTodayMs = getLocalDayStartMs();
    const lapsedToday = new Set<number>();
    for (const r of col.revlog || []) {
        if (r.id >= startOfTodayMs && r.ease === 1) {
            lapsedToday.add(r.cid);
        }
    }

    const targetDeck = col.decks[did];
    const targetPrefix = targetDeck ? `${targetDeck.name}::` : "";
    const matchingDid = new Set<number>([did]);
    for (const [idStr, d] of Object.entries(col.decks)) {
        if (targetPrefix && d.name.startsWith(targetPrefix)) {
            matchingDid.add(Number(idStr));
        }
    }

    const ids: number[] = [];
    for (const card of Object.values(col.cards)) {
        if (!matchingDid.has(card.did) || card.queue < 0) { continue; }
        if (lapsedToday.has(card.id)) {
            ids.push(card.id);
        }
    }
    return ids.sort((a, b) => a - b);
}
