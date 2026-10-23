// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { getLocalDayStartMs, getTodayDay, normalizeReviewDueDay } from "./scheduler";
import { Collection } from "./types";

export interface TodayStats {
    totalStudied: number;
    totalTimeSec: number;
    againCount: number;
    hardCount: number;
    goodCount: number;
    easyCount: number;
    retentionRate: number | null; // null when totalStudied === 0 (U12)
    trueReviewRetentionRate: number | null;
    learnCount: number;
    reviewCount: number;
    relearnCount: number;
}

export interface CardStateStats {
    total: number;
    newCount: number;
    learnCount: number;
    youngCount: number; // ivl < 21 days
    matureCount: number; // ivl >= 21 days
    suspendedCount: number;
}

export interface DueForecastItem {
    dayOffset: number;
    dateStr: string;
    dueCount: number;
    cumulativeCount: number;
}

export interface ReviewHeatmapDay {
    dateStr: string;
    count: number;
    timeSec: number;
}

export function calculateTodayStats(col: Collection): TodayStats {
    const startOfDay = getLocalDayStartMs();
    const todayEntries = (col.revlog || []).filter(r => r.id >= startOfDay);

    let totalTimeMs = 0;
    let again = 0;
    let hard = 0;
    let good = 0;
    let easy = 0;
    let learn = 0;
    let review = 0;
    let relearn = 0;
    let reviewPassed = 0;

    for (const entry of todayEntries) {
        totalTimeMs += entry.time || 0;
        if (entry.ease === 1) { again++; }
        else if (entry.ease === 2) { hard++; }
        else if (entry.ease === 3) { good++; }
        else if (entry.ease === 4) { easy++; }

        if (entry.type === 0) { learn++; }
        else if (entry.type === 1) {
            review++;
            if (entry.ease >= 2) { reviewPassed++; }
        } else if (entry.type === 2) { relearn++; }
    }

    const total = todayEntries.length;
    // In Anki, Hard (2), Good (3), and Easy (4) are passing recall ratings; Again (1) is a lapse (U12)
    const passing = hard + good + easy;
    const retention = total > 0 ? Math.round((passing / total) * 100) : null;
    const trueReviewRetention = review > 0 ? Math.round((reviewPassed / review) * 100) : retention;

    return {
        totalStudied: total,
        totalTimeSec: Math.round(totalTimeMs / 1000),
        againCount: again,
        hardCount: hard,
        goodCount: good,
        easyCount: easy,
        retentionRate: retention,
        trueReviewRetentionRate: trueReviewRetention,
        learnCount: learn,
        reviewCount: review,
        relearnCount: relearn,
    };
}

export function calculateCardStateStats(col: Collection): CardStateStats {
    let total = 0;
    let newCount = 0;
    let learnCount = 0;
    let youngCount = 0;
    let matureCount = 0;
    let suspendedCount = 0;

    for (const card of Object.values(col.cards)) {
        total++;
        if (card.queue === -1) {
            suspendedCount++;
        } else if (card.queue === 0) {
            newCount++;
        } else if (card.queue === 1 || card.queue === 3) {
            learnCount++;
        } else if (card.queue === 2) {
            if (card.ivl >= 21) {
                matureCount++;
            } else {
                youngCount++;
            }
        }
    }

    return {
        total,
        newCount,
        learnCount,
        youngCount,
        matureCount,
        suspendedCount,
    };
}

export function calculateDueForecast(col: Collection, days = 30): DueForecastItem[] {
    const today = getTodayDay();
    const countsByDay: Record<number, number> = {};

    for (let i = 0; i < days; i++) {
        countsByDay[today + i] = 0;
    }

    for (const card of Object.values(col.cards)) {
        if (card.queue === 2 || (card.queue === 3 && card.due < 1_000_000_000)) {
            const dueDay = normalizeReviewDueDay(card.due, col.crt);
            const targetDay = Math.max(today, dueDay);
            if (targetDay in countsByDay) {
                countsByDay[targetDay]++;
            }
        }
    }

    let cumulative = 0;
    const result: DueForecastItem[] = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
        const day = today + i;
        const due = countsByDay[day] || 0;
        cumulative += due;

        // Use true calendar-day addition rather than fixed 86,400,000 ms offsets so
        // DST spring-forward/fall-back transitions never duplicate or skip dates (SCHED-02).
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const dateStr = `${d.getMonth() + 1}/${d.getDate()}`;

        result.push({
            dayOffset: i,
            dateStr,
            dueCount: due,
            cumulativeCount: cumulative,
        });
    }

    return result;
}

function toLocalDateString(epochMs: number): string {
    const d = new Date(epochMs);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

export function calculateReviewHistory(col: Collection, days = 30): ReviewHeatmapDay[] {
    const history: Record<string, { count: number; timeSec: number }> = {};
    const now = new Date();

    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = toLocalDateString(d.getTime());
        history[key] = { count: 0, timeSec: 0 };
    }

    for (const entry of col.revlog || []) {
        const key = toLocalDateString(entry.id);
        if (key in history) {
            history[key].count++;
            history[key].timeSec += Math.round((entry.time || 0) / 1000);
        }
    }

    return Object.entries(history).map(([dateStr, val]) => ({
        dateStr,
        count: val.count,
        timeSec: val.timeSec,
    }));
}
