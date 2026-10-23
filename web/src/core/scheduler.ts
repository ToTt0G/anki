import {
  Card,
  DeckConfig,
  Rating,
  SchedulingOption,
  Collection,
  DeckStudyCounts
} from "./types";

/**
 * Local calendar day index aligned with local midnight (C11).
 */
export function getTodayDay(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  const localMidnightUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor(localMidnightUtc / 86_400_000);
}

export function getLocalDayStartMs(nowMs: number = Date.now()): number {
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

export function fuzzDelta(interval: number): number {
  if (interval < 2.5) return 0;
  const t1 = Math.max(0, Math.min(interval, 7) - 2.5) * 0.15;
  const t2 = Math.max(0, Math.min(interval, 20) - 7) * 0.1;
  const t3 = Math.max(0, interval - 20) * 0.05;
  return 1 + t1 + t2 + t3;
}

export function withReviewFuzz(
  interval: number,
  minIvl: number,
  maxIvl: number,
  seed: number
): number {
  const delta = fuzzDelta(interval);
  if (delta === 0) return Math.min(maxIvl, Math.max(minIvl, Math.round(interval)));

  const lo = Math.round(Math.max(minIvl, interval - delta));
  const hi = Math.round(Math.min(maxIvl, interval + delta));
  if (lo >= hi) return lo;

  const r = Math.abs(Math.sin(seed) * 10000) % 1;
  return Math.floor(lo + r * (1 + hi - lo));
}

export function formatInterval(val: number, isDays: boolean): string {
  if (!isDays) {
    const mins = Math.round(val / 60);
    if (mins < 1) return "<1m";
    if (mins < 60) return `${mins}m`;
    const hours = Math.round(mins / 60);
    return `${hours}h`;
  }

  const days = Math.round(val);
  if (days < 1) return "<1d";
  if (days < 30) return `${days}d`;
  if (days < 365) {
    const months = (days / 30.4375).toFixed(1).replace(/\.0$/, "");
    return `${months}m`;
  }
  const years = (days / 365.25).toFixed(1).replace(/\.0$/, "");
  return `${years}y`;
}

// ============================================================================
// FSRS v4.5 / v5 Spaced Repetition Engine (C03)
// ============================================================================
const FSRS_DEFAULT_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621
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
          lastRevDay: typeof parsed.lastRevDay === "number" ? parsed.lastRevDay : today - Math.max(1, card.ivl)
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
    lastRevDay: card.ivl > 0 ? today - card.ivl : today
  };
}

function fsrsInitialStability(rating: Rating): number {
  return Math.max(0.1, FSRS_DEFAULT_W[rating - 1]);
}

function fsrsInitialDifficulty(rating: Rating): number {
  const w4 = FSRS_DEFAULT_W[4];
  const w5 = FSRS_DEFAULT_W[5];
  const d = w4 - Math.exp(w5 * (rating - 1)) + 1;
  return Math.min(10, Math.max(1, d));
}

function fsrsNextDifficulty(d: number, rating: Rating): number {
  const w6 = FSRS_DEFAULT_W[6];
  const w7 = FSRS_DEFAULT_W[7];
  const d0Easy = fsrsInitialDifficulty(4);
  const deltaD = -w6 * (rating - 3);
  const damped = d + deltaD * ((10 - d) / 9);
  const nextD = w7 * d0Easy + (1 - w7) * damped;
  return Math.min(10, Math.max(1, nextD));
}

function fsrsRetrievability(elapsedDays: number, stability: number): number {
  if (elapsedDays <= 0) return 1;
  return Math.pow(1 + (19 / 81) * (elapsedDays / Math.max(0.1, stability)), -0.5);
}

function fsrsNextRecallStability(d: number, s: number, r: number, rating: Rating): number {
  const w8 = FSRS_DEFAULT_W[8];
  const w9 = FSRS_DEFAULT_W[9];
  const w10 = FSRS_DEFAULT_W[10];
  const hardPenalty = rating === 2 ? FSRS_DEFAULT_W[15] : 1;
  const easyBonus = rating === 4 ? FSRS_DEFAULT_W[16] : 1;
  const factor =
    Math.exp(w8) *
    (11 - d) *
    Math.pow(s, -w9) *
    (Math.exp((1 - r) * w10) - 1) *
    hardPenalty *
    easyBonus;
  return Math.max(0.1, s * (1 + factor));
}

function fsrsNextForgetStability(d: number, s: number, r: number): number {
  const w11 = FSRS_DEFAULT_W[11];
  const w12 = FSRS_DEFAULT_W[12];
  const w13 = FSRS_DEFAULT_W[13];
  const w14 = FSRS_DEFAULT_W[14];
  const nextS =
    w11 *
    Math.pow(d, -w12) *
    (Math.pow(s + 1, w13) - 1) *
    Math.exp((1 - r) * w14);
  return Math.max(0.1, Math.min(s, nextS));
}

export function fsrsIntervalFromStability(
  stability: number,
  desiredRetention: number,
  maxIvl: number
): number {
  const r = Math.min(0.97, Math.max(0.7, desiredRetention || 0.9));
  const raw = (stability / (19 / 81)) * (Math.pow(r, -2) - 1);
  return Math.min(maxIvl, Math.max(1, Math.round(raw)));
}

function calculateFsrsReviewScheduling(
  card: Card,
  config: DeckConfig,
  nowSec: number,
  today: number
): SchedulingOption[] {
  const desiredRetention = config.desiredRetention || 0.9;
  const maxIvl = config.rev.maxIvl || 36500;
  const state = parseFsrsState(card, today);
  const elapsedDays = Math.max(
    1,
    state.lastRevDay !== undefined ? today - state.lastRevDay : Math.max(1, card.ivl)
  );
  const r = fsrsRetrievability(elapsedDays, state.s);

  // 1. Again (Lapse)
  const newLapses = card.lapses + 1;
  const isLeech = newLapses >= (config.lapse.leechFails || 8);
  const leechSuspended = isLeech && config.lapse.leechAction === 0;
  const lapseDelays = config.lapse.delays.length ? config.lapse.delays : [10];
  const againDelaySec = lapseDelays[0] * 60;
  const sAgain = fsrsNextForgetStability(state.d, state.s, r);
  const dAgain = fsrsNextDifficulty(state.d, 1);

  // 2. Hard, Good, Easy recall stabilities & intervals
  const sHard = fsrsNextRecallStability(state.d, state.s, r, 2);
  const dHard = fsrsNextDifficulty(state.d, 2);
  const hardIvl = Math.max(
    1,
    fsrsIntervalFromStability(sHard, desiredRetention, maxIvl)
  );

  const sGood = fsrsNextRecallStability(state.d, state.s, r, 3);
  const dGood = fsrsNextDifficulty(state.d, 3);
  const goodIvl = Math.max(
    hardIvl + 1,
    fsrsIntervalFromStability(sGood, desiredRetention, maxIvl)
  );

  const sEasy = fsrsNextRecallStability(state.d, state.s, r, 4);
  const dEasy = fsrsNextDifficulty(state.d, 4);
  const easyIvl = Math.max(
    goodIvl + 1,
    fsrsIntervalFromStability(sEasy, desiredRetention, maxIvl)
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
          lastRevDay: today
        })
      }
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
          lastRevDay: today
        })
      }
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
          lastRevDay: today
        })
      }
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
          lastRevDay: today
        })
      }
    }
  ];
}

export function calculateScheduling(card: Card, config: DeckConfig): SchedulingOption[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const today = getTodayDay();
  const useFsrs = Boolean(config.fsrsEnabled);
  const desiredRetention = config.desiredRetention || 0.9;
  const maxIvl = config.rev.maxIvl || 36500;

  const delays =
    card.type === 3
      ? config.lapse.delays.length
        ? config.lapse.delays
        : [10]
      : config.new.delays.length
      ? config.new.delays
      : [1, 10];
  const initialFactor = config.new.initialFactor || 2500;
  const currentFactor = card.factor || initialFactor;

  const graduatingInt = useFsrs
    ? fsrsIntervalFromStability(fsrsInitialStability(3), desiredRetention, maxIvl)
    : config.new.ints[0] || 1;
  const easyInt = useFsrs
    ? Math.max(
        graduatingInt + 1,
        fsrsIntervalFromStability(fsrsInitialStability(4), desiredRetention, maxIvl)
      )
    : config.new.ints[1] || 4;

  const hardFactor = config.rev.hardFactor || 1.2;
  const ease4 = config.rev.ease4 || 1.3;
  const ivlFct = config.rev.ivlFct || 1.0;

  // 1. NEW CARDS
  if (card.type === 0) {
    const againSec = (delays[0] || 1) * 60;
    const hardSec =
      delays.length > 1
        ? Math.round(((delays[0] + delays[1]) / 2) * 60)
        : Math.round(againSec * 1.5);
    const goodSec = delays.length > 1 ? delays[1] * 60 : graduatingInt * 86400;
    const goodIsGraduate = delays.length <= 1;

    const makeFsrsData = (r: Rating) =>
      useFsrs
        ? JSON.stringify({
            s: Number(fsrsInitialStability(r).toFixed(3)),
            d: Number(fsrsInitialDifficulty(r).toFixed(3)),
            lastRevDay: today
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
          data: makeFsrsData(1)
        }
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
          data: makeFsrsData(2)
        }
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
              data: makeFsrsData(3)
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
              data: makeFsrsData(3)
            }
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
          data: makeFsrsData(4)
        }
      }
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
    const graduatingDays =
      useFsrs && fsrsState
        ? fsrsIntervalFromStability(fsrsState.s, desiredRetention, maxIvl)
        : card.type === 3
        ? Math.max(config.lapse.minInt || 1, Math.round(Math.abs(card.ivl) * (config.lapse.mult || 0))) || 1
        : graduatingInt;

    const goodSec = isGraduating
      ? graduatingDays * 86400
      : (delays[nextStepIdx] || currentDelay) * 60;
    const easyDays =
      useFsrs && fsrsState
        ? Math.max(
            graduatingDays + 1,
            fsrsIntervalFromStability(fsrsState.s * 1.3, desiredRetention, maxIvl)
          )
        : card.type === 3
        ? graduatingDays + 1
        : easyInt;

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
          data: card.data
        }
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
          data: card.data
        }
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
              data: card.data
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
              data: card.data
            }
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
          data: card.data
        }
      }
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
        data: card.data
      }
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
        data: card.data
      }
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
        data: card.data
      }
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
        data: card.data
      }
    }
  ];
}

function getEffectiveDailyLimits(
  col: Collection,
  did: number,
  today: number
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

  const conf =
    (targetDeck && col.dconf[targetDeck.conf]) ||
    col.dconf[1] ||
    Object.values(col.dconf)[0];

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
    if (entry.id < startOfDayMs) continue;
    const c = col.cards[entry.cid];
    if (!c || !matchingDid.has(c.did)) continue;
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
    matchingDid
  };
}

export function isCardDueInLearnQueue(
  card: Card,
  nowSec: number,
  today: number,
  colCrtSec?: number,
  aheadSec: number = 0
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

export function getDeckCounts(col: Collection, did: number): DeckStudyCounts {
  const today = getTodayDay();
  const nowSec = Math.floor(Date.now() / 1000);
  const { maxNew, maxRev, studiedNewToday, studiedRevToday, matchingDid } =
    getEffectiveDailyLimits(col, did, today);

  let rawNewCount = 0;
  let learnCount = 0;
  let rawReviewCount = 0;

  for (const card of Object.values(col.cards)) {
    if (!matchingDid.has(card.did)) continue;
    if (card.queue < 0) continue;

    if (card.queue === 0) {
      rawNewCount++;
    } else if (card.queue === 1 || card.queue === 3) {
      if (isCardDueInLearnQueue(card, nowSec, today, col.crt, 300)) {
        learnCount++;
      }
    } else if (card.queue === 2) {
      if (normalizeReviewDueDay(card.due, col.crt) <= today) {
        rawReviewCount++;
      }
    }
  }

  const remainingNewAllowance = Math.max(0, maxNew - studiedNewToday);
  const remainingRevAllowance = Math.max(0, maxRev - studiedRevToday);

  return {
    newCount: Math.min(rawNewCount, remainingNewAllowance),
    learnCount,
    reviewCount: Math.min(rawReviewCount, remainingRevAllowance)
  };
}

export function getNextStudyCard(col: Collection, did: number): Card | null {
  const today = getTodayDay();
  const nowSec = Math.floor(Date.now() / 1000);
  const { maxNew, maxRev, studiedNewToday, studiedRevToday, matchingDid } =
    getEffectiveDailyLimits(col, did, today);

  const canStudyNew = studiedNewToday < maxNew;
  const canStudyRev = studiedRevToday < maxRev;

  // 1. Learning cards due right now (or within 5m lookahead if none due this second)
  let dueLearn: Card | null = null;
  let earliestLearnDue = Infinity;

  // 2. Review cards due today (respecting daily review limit C04)
  let dueReview: Card | null = null;
  let earliestReviewDue = Infinity;

  // 3. New cards (respecting daily new limit C04)
  let nextNew: Card | null = null;
  let earliestNewPos = Infinity;

  for (const card of Object.values(col.cards)) {
    if (!matchingDid.has(card.did)) continue;
    if (card.queue < 0) continue;

    if (card.queue === 1 || card.queue === 3) {
      if (isCardDueInLearnQueue(card, nowSec, today, col.crt, 300)) {
        const sortMetric =
          card.queue === 3 && card.due < 1_000_000_000
            ? normalizeReviewDueDay(card.due, col.crt) * 86400
            : card.due;
        if (sortMetric < earliestLearnDue) {
          dueLearn = card;
          earliestLearnDue = sortMetric;
        }
      }
    } else if (card.queue === 2 && canStudyRev) {
      const dueDay = normalizeReviewDueDay(card.due, col.crt);
      if (dueDay <= today && dueDay < earliestReviewDue) {
        dueReview = card;
        earliestReviewDue = dueDay;
      }
    } else if (card.queue === 0 && canStudyNew) {
      if (card.due < earliestNewPos) {
        nextNew = card;
        earliestNewPos = card.due;
      }
    }
  }

  return dueLearn || dueReview || nextNew;
}
