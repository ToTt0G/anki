// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { Card, Collection, Deck, DeckConfig, Note, NoteType } from "./types";

export function createDefaultCollection(): Collection {
    const now = Math.floor(Date.now() / 1000);
    const nowMs = Date.now();

    const defaultDeck: Deck = {
        id: 1,
        name: "Default",
        desc: "",
        collapsed: false,
        conf: 1,
        dyn: 0,
        mod: now,
        usn: 0,
    };

    const defaultDeckConfig: DeckConfig = {
        id: 1,
        name: "Default",
        new: {
            delays: [1, 10],
            ints: [1, 4],
            initialFactor: 2500,
            perDay: 20,
            order: 1,
        },
        rev: {
            perDay: 200,
            ease4: 1.3,
            ivlFct: 1.0,
            maxIvl: 36500,
            hardFactor: 1.2,
        },
        lapse: {
            delays: [10],
            mult: 0.0,
            minInt: 1,
            leechFails: 8,
            leechAction: 0,
        },
        timer: 0,
        maxTaken: 60,
        fsrsEnabled: false,
        desiredRetention: 0.9,
    };

    const basicModel: NoteType = {
        id: 1600000000001,
        name: "Basic",
        type: 0,
        mod: now,
        usn: 0,
        flds: [
            { name: "Front", ord: 0, sticky: false, rtl: false, font: "Arial", size: 20 },
            { name: "Back", ord: 1, sticky: false, rtl: false, font: "Arial", size: 20 },
        ],
        tmpls: [
            {
                name: "Card 1",
                ord: 0,
                qfmt: "{{Front}}",
                afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
            },
        ],
        css: `.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 20px;
  text-align: center;
  color: #111;
  background-color: transparent;
  line-height: 1.5;
}
hr#answer {
  border: 0;
  border-top: 1px solid #ddd;
  margin: 1.5rem 0;
}`,
    };

    const reversedModel: NoteType = {
        id: 1600000000002,
        name: "Basic (and reversed card)",
        type: 0,
        mod: now,
        usn: 0,
        flds: [
            { name: "Front", ord: 0, sticky: false, rtl: false, font: "Arial", size: 20 },
            { name: "Back", ord: 1, sticky: false, rtl: false, font: "Arial", size: 20 },
        ],
        tmpls: [
            {
                name: "Card 1",
                ord: 0,
                qfmt: "{{Front}}",
                afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
            },
            {
                name: "Card 2",
                ord: 1,
                qfmt: "{{Back}}",
                afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}",
            },
        ],
        css: basicModel.css,
    };

    const clozeModel: NoteType = {
        id: 1600000000003,
        name: "Cloze",
        type: 1,
        mod: now,
        usn: 0,
        flds: [
            { name: "Text", ord: 0, sticky: false, rtl: false, font: "Arial", size: 20 },
            { name: "Back Extra", ord: 1, sticky: false, rtl: false, font: "Arial", size: 20 },
        ],
        tmpls: [
            {
                name: "Cloze",
                ord: 0,
                qfmt: "{{cloze:Text}}",
                afmt: "{{cloze:Text}}\n\n<hr id=answer>\n\n{{Back Extra}}",
            },
        ],
        css: `${basicModel.css}
.cloze {
  font-weight: bold;
  color: #0284c7;
}`,
    };

    // Sample notes & cards
    const n1: Note = {
        id: nowMs + 1,
        guid: "guid1",
        mid: basicModel.id,
        mod: now,
        usn: 0,
        tags: ["anki"],
        fields: [
            "What is spaced repetition?",
            "A learning technique that incorporates increasing intervals of time between subsequent review of previously learned material to exploit the psychological spacing effect.",
        ],
        sfld: "What is spaced repetition?",
        csum: 12345,
        flags: 0,
        data: "{}",
    };

    const c1: Card = {
        id: nowMs + 2,
        nid: n1.id,
        did: 1,
        ord: 0,
        mod: now,
        usn: 0,
        type: 0,
        queue: 0,
        due: 1,
        ivl: 0,
        factor: 2500,
        reps: 0,
        lapses: 0,
        left: 0,
        odue: 0,
        odid: 0,
        flags: 0,
        data: "{}",
    };

    const n2: Note = {
        id: nowMs + 3,
        guid: "guid2",
        mid: clozeModel.id,
        mod: now,
        usn: 0,
        tags: ["shortcuts"],
        fields: [
            "Press {{c1::Space}} or {{c1::Enter}} to show the answer, and keys {{c2::1, 2, 3, 4}} to rate the card.",
            "Keyboard shortcuts make reviewing much faster!",
        ],
        sfld: "Press Space or Enter to show the answer",
        csum: 67890,
        flags: 0,
        data: "{}",
    };

    const c2: Card = {
        id: nowMs + 4,
        nid: n2.id,
        did: 1,
        ord: 0,
        mod: now,
        usn: 0,
        type: 0,
        queue: 0,
        due: 2,
        ivl: 0,
        factor: 2500,
        reps: 0,
        lapses: 0,
        left: 0,
        odue: 0,
        odid: 0,
        flags: 0,
        data: "{}",
    };

    const c3: Card = {
        id: nowMs + 5,
        nid: n2.id,
        did: 1,
        ord: 1,
        mod: now,
        usn: 0,
        type: 0,
        queue: 0,
        due: 3,
        ivl: 0,
        factor: 2500,
        reps: 0,
        lapses: 0,
        left: 0,
        odue: 0,
        odid: 0,
        flags: 0,
        data: "{}",
    };

    return {
        id: 1,
        crt: now,
        mod: now,
        decks: { 1: defaultDeck },
        dconf: { 1: defaultDeckConfig },
        models: {
            [basicModel.id]: basicModel,
            [reversedModel.id]: reversedModel,
            [clozeModel.id]: clozeModel,
        },
        notes: {
            [n1.id]: n1,
            [n2.id]: n2,
        },
        cards: {
            [c1.id]: c1,
            [c2.id]: c2,
            [c3.id]: c3,
        },
        revlog: [],
        media: {},
    };
}
