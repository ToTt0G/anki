import { Collection, RevlogEntry } from "./types";
import { getTodayDay } from "./scheduler";

export interface TodayStats {
  totalStudied: number;
  totalTimeSec: number;
  againCount: number;
  hardCount: number;
  goodCount: number;
  easyCount: number;
  retentionRate: number; // percentage
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
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const todayEntries = col.revlog.filter(r => r.id >= startOfDay);

  let totalTimeMs = 0;
  let again = 0;
  let hard = 0;
  let good = 0;
  let easy = 0;
  let learn = 0;
  let review = 0;
  let relearn = 0;

  for (const entry of todayEntries) {
    totalTimeMs += entry.time || 0;
    if (entry.ease === 1) again++;
    else if (entry.ease === 2) hard++;
    else if (entry.ease === 3) good++;
    else if (entry.ease === 4) easy++;

    if (entry.type === 0) learn++;
    else if (entry.type === 1) review++;
    else if (entry.type === 2) relearn++;
  }

  const total = todayEntries.length;
  const passing = good + easy;
  const retention = total > 0 ? Math.round((passing / total) * 100) : 100;

  return {
    totalStudied: total,
    totalTimeSec: Math.round(totalTimeMs / 1000),
    againCount: again,
    hardCount: hard,
    goodCount: good,
    easyCount: easy,
    retentionRate: retention,
    learnCount: learn,
    reviewCount: review,
    relearnCount: relearn
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
    suspendedCount
  };
}

export function calculateDueForecast(col: Collection, days = 30): DueForecastItem[] {
  const today = getTodayDay();
  const countsByDay: Record<number, number> = {};

  for (let i = 0; i < days; i++) {
    countsByDay[today + i] = 0;
  }

  for (const card of Object.values(col.cards)) {
    if (card.queue === 2) {
      const targetDay = Math.max(today, card.due);
      if (targetDay in countsByDay) {
        countsByDay[targetDay]++;
      }
    }
  }

  let cumulative = 0;
  const result: DueForecastItem[] = [];

  for (let i = 0; i < days; i++) {
    const day = today + i;
    const due = countsByDay[day] || 0;
    cumulative += due;

    const d = new Date(Date.now() + i * 86400000);
    const dateStr = `${d.getMonth() + 1}/${d.getDate()}`;

    result.push({
      dayOffset: i,
      dateStr,
      dueCount: due,
      cumulativeCount: cumulative
    });
  }

  return result;
}

export function calculateReviewHistory(col: Collection, days = 30): ReviewHeatmapDay[] {
  const history: Record<string, { count: number; timeSec: number }> = {};
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    history[key] = { count: 0, timeSec: 0 };
  }

  for (const entry of col.revlog) {
    const key = new Date(entry.id).toISOString().slice(0, 10);
    if (key in history) {
      history[key].count++;
      history[key].timeSec += Math.round((entry.time || 0) / 1000);
    }
  }

  return Object.entries(history).map(([dateStr, val]) => ({
    dateStr,
    count: val.count,
    timeSec: val.timeSec
  }));
}
