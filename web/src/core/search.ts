// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { getTodayDay, isCardDue } from "./scheduler";
import { Card, Collection, Note } from "./types";

export interface SearchFilterResult {
    card: Card;
    note: Note;
    deckName: string;
    modelName: string;
}

function stripQuotes(val: string): string {
    return val
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .replace(/^'(.*)'$/, "$1")
        .trim();
}

export function searchCards(col: Collection, query: string): SearchFilterResult[] {
    const q = query.trim().toLowerCase();
    const today = getTodayDay();
    const nowSec = Math.floor(Date.now() / 1000);

    // Parse query tokens, preserving quoted filter values such as deck:"My Deck" (UX-07)
    const tokens = q.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

    return Object.values(col.cards).map(card => {
        const note = col.notes[card.nid];
        const deck = col.decks[card.did];
        const model = note ? col.models[note.mid] : null;

        return {
            card,
            note,
            deckName: deck ? deck.name : "Default",
            modelName: model ? model.name : "",
        };
    }).filter(({ card, note, deckName, modelName }) => {
        if (!note) { return false; }

        if (tokens.length === 0) { return true; }

        for (const rawToken of tokens) {
            const token = stripQuotes(rawToken);
            if (!token) { continue; }

            // 1. Deck filter: deck:name or deck:"My Deck" (UX-07)
            if (token.startsWith("deck:")) {
                const rawDeckArg = token.slice(5).trim();
                const isQuotedDeck = rawDeckArg.startsWith("\"") && rawDeckArg.endsWith("\"");
                const targetDeck = stripQuotes(rawDeckArg);
                if (!targetDeck) { continue; }
                const deckLower = deckName.toLowerCase();
                const matches = isQuotedDeck
                    ? deckLower === targetDeck || deckLower.startsWith(`${targetDeck}::`)
                    : deckLower.includes(targetDeck);
                if (!matches) {
                    return false;
                }
                continue;
            }

            // 2. Tag filter: tag:name or tag:"my tag"
            if (token.startsWith("tag:")) {
                const targetTag = stripQuotes(token.slice(4));
                if (targetTag === "none") {
                    if (note.tags.length > 0) { return false; }
                } else {
                    const hasTag = note.tags.some(t =>
                        t.toLowerCase() === targetTag || t.toLowerCase().startsWith(targetTag)
                    );
                    if (!hasTag) { return false; }
                }
                continue;
            }

            // 3. Card state filter: is:new, is:due, is:learn, is:review, is:suspended, is:buried (UX-08, SCHED-05)
            if (token.startsWith("is:")) {
                const state = stripQuotes(token.slice(3));
                if (state === "new" && card.queue !== 0) { return false; }
                if (state === "learn" && (card.queue !== 1 && card.queue !== 3)) { return false; }
                if (state === "review" && card.queue !== 2) { return false; }
                if (state === "suspended" && card.queue !== -1) { return false; }
                if (state === "buried" && (card.queue !== -2 && card.queue !== -3)) { return false; }
                if (state === "due") {
                    if (!isCardDue(card, nowSec, today, col.crt)) {
                        return false;
                    }
                }
                continue;
            }

            // 4. Note type filter: note:name or note:"Basic (and reversed)"
            if (token.startsWith("note:")) {
                const targetModel = stripQuotes(token.slice(5));
                if (!modelName.toLowerCase().includes(targetModel)) {
                    return false;
                }
                continue;
            }

            // 5. Flag filter: flag:1..7
            if (token.startsWith("flag:")) {
                const targetFlag = parseInt(stripQuotes(token.slice(5)), 10);
                if (card.flags !== targetFlag) { return false; }
                continue;
            }

            // 6. Text search across fields and tags
            const matchInFields = note.fields.some(f => f.toLowerCase().includes(token));
            const matchInTags = note.tags.some(t => t.toLowerCase().includes(token));
            if (!matchInFields && !matchInTags) {
                return false;
            }
        }

        return true;
    });
}
