import { Card, DeckConfig, Rating, SchedulingOption, Collection, DeckStudyCounts } from "./types";

export function getTodayDay(): number {
  const now = new Date();
  return Math.floor(now.getTime() / (1000 * 60 * 60 * 24));
}

export function fuzzDelta(interval: number): number {
  if (interval < 2.5) return 0;
  const t1 = Math.max(0, Math.min(interval, 7) - 2.5) * 0.15;
  const t2 = Math.max(0, Math.min(interval, 20) - 7) * 0.1;
  const t3 = Math.max(0, interval - 20) * 0.05;
  return 1 + t1 + t2 + t3;
}

export function withReviewFuzz(interval: number, minIvl: number, maxIvl: number, seed: number): number {
  const delta = fuzzDelta(interval);
  if (delta === 0) return Math.min(maxIvl, Math.max(minIvl, Math.round(interval)));

  const lo = Math.round(Math.max(minIvl, interval - delta));
  const hi = Math.round(Math.min(maxIvl, interval + delta));
  if (lo >= hi) return lo;

  // Deterministic pseudo-random based on seed
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

export function calculateScheduling(card: Card, config: DeckConfig): SchedulingOption[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const today = getTodayDay();

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
  const graduatingInt = config.new.ints[0] || 1;
  const easyInt = config.new.ints[1] || 4;
  const hardFactor = config.rev.hardFactor || 1.2;
  const ease4 = config.rev.ease4 || 1.3;
  const ivlFct = config.rev.ivlFct || 1.0;
  const maxIvl = config.rev.maxIvl || 36500;

  // 1. NEW CARDS
  if (card.type === 0) {
    const againSec = (delays[0] || 1) * 60;
    const hardSec =
      delays.length > 1
        ? Math.round(((delays[0] + delays[1]) / 2) * 60)
        : Math.round(againSec * 1.5);
    const goodSec = delays.length > 1 ? delays[1] * 60 : graduatingInt * 86400;
    const goodIsGraduate = delays.length <= 1;

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
          data: card.data
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
          data: card.data
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
              data: card.data
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
              data: card.data
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
          data: card.data
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
    const graduatingDays =
      card.type === 3
        ? Math.max(config.lapse.minInt || 1, Math.round(card.ivl * (config.lapse.mult || 0))) || 1
        : graduatingInt;
    const goodSec = isGraduating ? graduatingDays * 86400 : (delays[nextStepIdx] || currentDelay) * 60;
    const easyDays = card.type === 3 ? graduatingDays + 1 : easyInt;

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
        intervalText: isGraduating ? formatInterval(graduatingDays, true) : formatInterval(goodSec, false),
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

  // 3. REVIEW CARDS
  const currentIvl = Math.max(1, card.ivl);
  const factorFloat = currentFactor / 1000;
  const seed = card.id + card.reps;

  // Again: lapses + 1, ease - 20%, enters relearn
  const newLapses = card.lapses + 1;
  const isLeech = newLapses >= (config.lapse.leechFails || 8);
  const leechSuspended = isLeech && config.lapse.leechAction === 0;
  const againFactor = Math.max(1300, currentFactor - 200);
  const lapseDelays = config.lapse.delays.length ? config.lapse.delays : [10];
  const againDelaySec = lapseDelays[0] * 60;

  // Hard: interval = currentIvl * hardFactor
  const hardFactorCalc = Math.max(1300, currentFactor - 150);
  const rawHardIvl = Math.max(currentIvl + 1, Math.round(currentIvl * hardFactor * ivlFct));
  const hardIvl = Math.min(maxIvl, withReviewFuzz(rawHardIvl, currentIvl + 1, maxIvl, seed + 1));

  // Good: interval = currentIvl * factor * ivlFct
  const rawGoodIvl = Math.max(hardIvl + 1, Math.round(currentIvl * factorFloat * ivlFct));
  const goodIvl = Math.min(maxIvl, withReviewFuzz(rawGoodIvl, hardIvl + 1, maxIvl, seed + 2));

  // Easy: ease + 15%, interval = currentIvl * factor * ivlFct * ease4
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

export function getDeckCounts(col: Collection, did: number): DeckStudyCounts {
  const today = getTodayDay();
  const nowSec = Math.floor(Date.now() / 1000);

  const targetDeck = col.decks[did];
  const targetPrefix = targetDeck ? `${targetDeck.name}::` : "";

  const matchingDid = new Set<number>();
  matchingDid.add(did);
  for (const [idStr, d] of Object.entries(col.decks)) {
    const id = Number(idStr);
    if (d.name.startsWith(targetPrefix)) {
      matchingDid.add(id);
    }
  }

  let newCount = 0;
  let learnCount = 0;
  let reviewCount = 0;

  for (const card of Object.values(col.cards)) {
    if (!matchingDid.has(card.did)) continue;
    if (card.queue < 0) continue; // suspended or buried

    if (card.queue === 0) {
      newCount++;
    } else if (card.queue === 1 || card.queue === 3) {
      if (card.due <= nowSec + 300) {
        learnCount++;
      }
    } else if (card.queue === 2) {
      if (card.due <= today) {
        reviewCount++;
      }
    }
  }

  return { newCount, learnCount, reviewCount };
}

export function getNextStudyCard(col: Collection, did: number): Card | null {
  const today = getTodayDay();
  const nowSec = Math.floor(Date.now() / 1000);

  const targetDeck = col.decks[did];
  const targetPrefix = targetDeck ? `${targetDeck.name}::` : "";

  const matchingDid = new Set<number>();
  matchingDid.add(did);
  for (const [idStr, d] of Object.entries(col.decks)) {
    const id = Number(idStr);
    if (d.name.startsWith(targetPrefix)) {
      matchingDid.add(id);
    }
  }

  // 1. Learning cards due right now take highest priority
  let dueLearn: Card | null = null;
  let earliestLearnDue = Infinity;

  // 2. Review cards due today
  let dueReview: Card | null = null;
  let earliestReviewDue = Infinity;

  // 3. New cards
  let nextNew: Card | null = null;
  let earliestNewPos = Infinity;

  for (const card of Object.values(col.cards)) {
    if (!matchingDid.has(card.did)) continue;
    if (card.queue < 0) continue; // suspended or buried

    if (card.queue === 1 || card.queue === 3) {
      if (card.due <= nowSec && card.due < earliestLearnDue) {
        dueLearn = card;
        earliestLearnDue = card.due;
      }
    } else if (card.queue === 2) {
      if (card.due <= today && card.due < earliestReviewDue) {
        dueReview = card;
        earliestReviewDue = card.due;
      }
    } else if (card.queue === 0) {
      if (card.due < earliestNewPos) {
        nextNew = card;
        earliestNewPos = card.due;
      }
    }
  }

  return dueLearn || dueReview || nextNew;
}
