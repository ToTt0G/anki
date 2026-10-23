// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { getTodayDay } from "./scheduler";
import { Card, Collection, Note } from "./types";

export interface SearchFilterResult {
    card: Card;
    note: Note;
    deckName: string;
    modelName: string;
}

export function searchCards(col: Collection, query: string): SearchFilterResult[] {
    const q = query.trim().toLowerCase();
    const today = getTodayDay();
    const nowSec = Math.floor(Date.now() / 1000);

    // Parse query tokens
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
            const token = rawToken.replace(/^"|"$/g, "");

            // 1. Deck filter: deck:name
            if (token.startsWith("deck:")) {
                const targetDeck = token.slice(5).trim();
                if (!deckName.toLowerCase().includes(targetDeck)) {
                    return false;
                }
                continue;
            }

            // 2. Tag filter: tag:name
            if (token.startsWith("tag:")) {
                const targetTag = token.slice(4).trim();
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

            // 3. Card state filter: is:new, is:due, is:learn, is:review, is:suspended, is:buried
            if (token.startsWith("is:")) {
                const state = token.slice(3).trim();
                if (state === "new" && card.queue !== 0) { return false; }
                if (state === "learn" && (card.queue !== 1 && card.queue !== 3)) { return false; }
                if (state === "review" && card.queue !== 2) { return false; }
                if (state === "suspended" && card.queue !== -1) { return false; }
                if (state === "buried" && (card.queue !== -2 && card.queue !== -3)) { return false; }
                if (state === "due") {
                    const isDue = (card.queue === 1 || card.queue === 3)
                        ? card.due <= nowSec
                        : card.queue === 2
                        ? card.due <= today
                        : card.queue === 0;
                    if (!isDue) { return false; }
                }
                continue;
            }

            // 4. Note type filter: note:name
            if (token.startsWith("note:")) {
                const targetModel = token.slice(5).trim();
                if (!modelName.toLowerCase().includes(targetModel)) {
                    return false;
                }
                continue;
            }

            // 5. Flag filter: flag:1..7
            if (token.startsWith("flag:")) {
                const targetFlag = parseInt(token.slice(5).trim(), 10);
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
