// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

export type CardType = 0 | 1 | 2 | 3;
// 0 = New, 1 = Learning, 2 = Review, 3 = Relearning

export type CardQueue = -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4;
// -3 = User Buried, -2 = Sched Buried, -1 = Suspended, 0 = New, 1 = Learning, 2 = Review, 3 = Day Learn, 4 = Preview

export type Rating = 1 | 2 | 3 | 4;
// 1 = Again, 2 = Hard, 3 = Good, 4 = Easy

export interface Card {
    id: number;
    nid: number;
    did: number;
    ord: number;
    mod: number;
    usn: number;
    type: CardType;
    queue: CardQueue;
    due: number; // new: position; learn(q=1): unix sec; review(q=2)/day-learn(q=3): epoch day (or crt-relative day if <10000)
    ivl: number; // positive = days, negative = seconds
    factor: number; // permille, e.g. 2500
    reps: number;
    lapses: number;
    left: number; // remaining steps (e.g. 1001)
    odue: number;
    odid: number;
    flags: number;
    data: string; // JSON FSRS memory state { s, d, lastRevDay }
}

export interface Note {
    id: number;
    guid: string;
    mid: number;
    mod: number;
    usn: number;
    tags: string[];
    fields: string[];
    sfld: string;
    csum: number;
    flags: number;
    data: string;
}

export interface CustomStudyOverride {
    day: number;
    extraNew: number;
    extraRev: number;
}

export interface Deck {
    id: number;
    name: string;
    desc: string;
    collapsed: boolean;
    conf: number;
    dyn: number; // 0 = standard, 1 = filtered/cram
    mod: number;
    usn: number;
    customStudy?: CustomStudyOverride;
}

export interface DeckConfig {
    id: number;
    name: string;
    new: {
        delays: number[]; // learning steps in minutes [1, 10]
        ints: number[]; // [graduating: 1, easy: 4] days
        initialFactor: number; // 2500
        perDay: number;
        order: number; // 0 = random, 1 = order added
    };
    rev: {
        perDay: number;
        ease4: number; // 1.3
        ivlFct: number; // 1.0
        maxIvl: number; // 36500
        hardFactor: number; // 1.2
    };
    lapse: {
        delays: number[]; // [10]
        mult: number; // 0.0
        minInt: number; // 1
        leechFails: number; // 8
        leechAction: number; // 0 = suspend, 1 = tag only
    };
    timer: number;
    maxTaken: number;
    fsrsEnabled?: boolean;
    desiredRetention?: number;
}

export interface NoteTypeField {
    name: string;
    ord: number;
    sticky: boolean;
    rtl: boolean;
    font: string;
    size: number;
}

export interface NoteTypeTemplate {
    name: string;
    ord: number;
    qfmt: string;
    afmt: string;
    bafmt?: string;
    bqfmt?: string;
}

export interface NoteType {
    id: number;
    name: string;
    type: 0 | 1; // 0 = Standard, 1 = Cloze
    mod: number;
    usn: number;
    flds: NoteTypeField[];
    tmpls: NoteTypeTemplate[];
    css: string;
}

export interface RevlogEntry {
    id: number;
    cid: number;
    usn: number;
    ease: Rating;
    ivl: number;
    lastIvl: number;
    factor: number;
    time: number; // ms taken
    type: number; // 0 = learn, 1 = review, 2 = relearn, 3 = filtered, 4 = manual
}

export interface Collection {
    id?: number;
    crt: number; // creation timestamp in seconds
    mod: number;
    scm?: number;
    decks: Record<number, Deck>;
    dconf: Record<number, DeckConfig>;
    models: Record<number, NoteType>;
    notes: Record<number, Note>;
    cards: Record<number, Card>;
    revlog: RevlogEntry[];
    media: Record<string, string>; // filename -> dataURL/blobURL
}

export interface SchedulingOption {
    rating: Rating;
    label: string;
    intervalText: string;
    nextState: {
        type: CardType;
        queue: CardQueue;
        due: number;
        ivl: number;
        factor: number;
        left: number;
        reps: number;
        lapses: number;
        data: string;
    };
}

export interface DeckStudyCounts {
    newCount: number;
    learnCount: number;
    reviewCount: number;
}
