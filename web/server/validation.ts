// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Runtime Schema, Foreign-Key & Boundary Validation for Server Inputs (SEC-02, SEC-09, SEC-13, DATA-11, DATA-12)

import { MAX_MEDIA_DATA_URL_LEN, validateMediaDataUrl } from "../src/core/media-validation";
import { ClientMessage } from "./types";

const MAX_STRING_LEN = 512_000; // 512 KB per note field
const MAX_CSS_LEN = 128_000; // 128 KB per model CSS
const MAX_TEMPLATE_LEN = 128_000; // 128 KB per card template
const MAX_CARD_DATA_LEN = 8_192; // 8 KB per card JSON data
const MAX_COLLECTION_ITEMS = 60_000;
const MAX_DECKS = 2_000;
const MAX_MODELS = 500;
const MAX_DCONF = 500;
const MAX_REVLOG_ITEMS = 250_000;
const MAX_MEDIA_ITEMS = 2_500;
const MAX_TOTAL_MEDIA_BYTES = 20 * 1024 * 1024; // 20 MB aggregate media per snapshot

export function isPositiveInt(val: unknown): val is number {
    return typeof val === "number" && Number.isFinite(val) && Number.isInteger(val) && val > 0;
}

export function isNonNegativeInt(val: unknown): val is number {
    return typeof val === "number" && Number.isFinite(val) && Number.isInteger(val) && val >= 0;
}

export function isFiniteNumber(val: unknown): val is number {
    return typeof val === "number" && Number.isFinite(val);
}

export function isValidCardQueue(val: unknown): boolean {
    return typeof val === "number" && Number.isInteger(val) && val >= -3 && val <= 4;
}

export function isValidCardType(val: unknown): boolean {
    return typeof val === "number" && Number.isInteger(val) && val >= 0 && val <= 3;
}

export function validateCardObject(card: any): string | null {
    if (!card || typeof card !== "object" || Array.isArray(card)) {
        return "Card must be an object";
    }
    if (!isPositiveInt(card.id)) { return "Card id must be a positive integer"; }
    if (!isPositiveInt(card.nid)) { return "Card nid must be a positive integer"; }
    if (!isPositiveInt(card.did)) { return "Card did must be a positive integer"; }
    if (typeof card.ord !== "number" || !Number.isInteger(card.ord) || card.ord < 0 || card.ord > 100) {
        return "Card ord out of range";
    }
    if (!isValidCardType(card.type)) { return "Invalid card type"; }
    if (!isValidCardQueue(card.queue)) { return "Invalid card queue"; }
    if (!isFiniteNumber(card.due)) { return "Invalid card due value"; }
    if (!isFiniteNumber(card.ivl)) { return "Invalid card interval"; }
    if (!isFiniteNumber(card.factor) || card.factor < 0 || card.factor > 100_000) {
        return "Invalid card ease factor";
    }
    if (!isFiniteNumber(card.reps) || card.reps < 0) { return "Invalid card reps"; }
    if (!isFiniteNumber(card.lapses) || card.lapses < 0) { return "Invalid card lapses"; }
    if (card.left !== undefined && (!isFiniteNumber(card.left) || card.left < 0 || card.left > 1_000_000)) {
        return "Invalid card left value";
    }
    if (card.flags !== undefined && (!isFiniteNumber(card.flags) || card.flags < 0 || card.flags > 255)) {
        return "Invalid card flags";
    }
    if (card.data !== undefined && (typeof card.data !== "string" || card.data.length > MAX_CARD_DATA_LEN)) {
        return "Invalid card data payload";
    }
    return null;
}

export function validateCardPartialState(nextState: any): string | null {
    if (!nextState || typeof nextState !== "object" || Array.isArray(nextState)) {
        return "answer_card requires nextState object";
    }
    if (nextState.queue !== undefined && !isValidCardQueue(nextState.queue)) {
        return "answer_card has invalid nextState.queue";
    }
    if (nextState.type !== undefined && !isValidCardType(nextState.type)) {
        return "answer_card has invalid nextState.type";
    }
    if (nextState.due !== undefined && !isFiniteNumber(nextState.due)) {
        return "answer_card has invalid nextState.due";
    }
    if (nextState.ivl !== undefined && !isFiniteNumber(nextState.ivl)) {
        return "answer_card has invalid nextState.ivl";
    }
    if (
        nextState.factor !== undefined
        && (!isFiniteNumber(nextState.factor) || nextState.factor < 0 || nextState.factor > 100_000)
    ) {
        return "answer_card has invalid nextState.factor";
    }
    if (nextState.reps !== undefined && (!isNonNegativeInt(nextState.reps) || nextState.reps > 1_000_000)) {
        return "answer_card has invalid nextState.reps";
    }
    if (nextState.lapses !== undefined && (!isNonNegativeInt(nextState.lapses) || nextState.lapses > 1_000_000)) {
        return "answer_card has invalid nextState.lapses";
    }
    if (nextState.left !== undefined && (!isNonNegativeInt(nextState.left) || nextState.left > 1_000_000)) {
        return "answer_card has invalid nextState.left";
    }
    if (
        nextState.data !== undefined
        && (typeof nextState.data !== "string" || nextState.data.length > MAX_CARD_DATA_LEN)
    ) {
        return "answer_card has invalid nextState.data";
    }
    return null;
}

export function validateRevlogObject(entry: any): string | null {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return "Revlog entry must be an object";
    }
    if (!isPositiveInt(entry.id)) {
        return "Revlog id must be a positive integer";
    }
    if (!isPositiveInt(entry.cid)) {
        return "Revlog cid must be a positive integer";
    }
    if (typeof entry.ease !== "number" || !Number.isInteger(entry.ease) || entry.ease < 1 || entry.ease > 4) {
        return "Revlog ease must be an integer between 1 and 4";
    }
    if (!isFiniteNumber(entry.ivl)) {
        return "Revlog ivl must be a finite number";
    }
    if (entry.lastIvl !== undefined && !isFiniteNumber(entry.lastIvl)) {
        return "Revlog lastIvl must be a finite number";
    }
    if (
        entry.factor !== undefined
        && (!isFiniteNumber(entry.factor) || entry.factor < 0 || entry.factor > 100_000)
    ) {
        return "Revlog factor out of range";
    }
    if (
        entry.time !== undefined
        && (!isFiniteNumber(entry.time) || entry.time < 0 || entry.time > 86_400_000)
    ) {
        return "Revlog time out of range";
    }
    if (
        entry.type !== undefined
        && (typeof entry.type !== "number" || !Number.isInteger(entry.type) || entry.type < 0 || entry.type > 4)
    ) {
        return "Revlog type must be an integer between 0 and 4";
    }
    return null;
}

export function validateNoteObject(note: any): string | null {
    if (!note || typeof note !== "object" || Array.isArray(note)) {
        return "Note must be an object";
    }
    if (!isPositiveInt(note.id)) { return "Note id must be a positive integer"; }
    if (!isPositiveInt(note.mid)) { return "Note mid must be a positive integer"; }
    if (note.guid !== undefined && (typeof note.guid !== "string" || note.guid.length > 256)) {
        return "Invalid note guid";
    }
    if (!Array.isArray(note.fields) || note.fields.length === 0 || note.fields.length > 64) {
        return "Note fields must be a non-empty array (max 64)";
    }
    for (const fld of note.fields) {
        if (typeof fld !== "string" || fld.length > MAX_STRING_LEN) {
            return "Note field exceeds maximum length";
        }
    }
    if (note.sfld !== undefined && (typeof note.sfld !== "string" || note.sfld.length > MAX_STRING_LEN)) {
        return "Note sfld exceeds maximum length";
    }
    if (!Array.isArray(note.tags) || note.tags.length > 200) {
        return "Note tags must be an array (max 200)";
    }
    for (const tag of note.tags) {
        if (typeof tag !== "string" || tag.length > 256) {
            return "Invalid note tag";
        }
    }
    if (note.data !== undefined && (typeof note.data !== "string" || note.data.length > MAX_CARD_DATA_LEN)) {
        return "Note data exceeds maximum length";
    }
    return null;
}

export function validateDeckObject(deck: any): string | null {
    if (!deck || typeof deck !== "object" || Array.isArray(deck)) {
        return "Deck must be an object";
    }
    if (!isPositiveInt(deck.id)) { return "Deck id must be a positive integer"; }
    if (typeof deck.name !== "string" || !deck.name.trim() || deck.name.length > 512) {
        return "Deck name must be a non-empty string (max 512 chars)";
    }
    if (deck.desc !== undefined && (typeof deck.desc !== "string" || deck.desc.length > 16_384)) {
        return "Deck description exceeds maximum length";
    }
    if (deck.conf !== undefined && !isPositiveInt(deck.conf)) {
        return "Deck conf must be a positive integer";
    }
    if (deck.customStudy !== undefined && deck.customStudy !== null) {
        const cs = deck.customStudy;
        if (
            typeof cs !== "object"
            || Array.isArray(cs)
            || !isNonNegativeInt(cs.day)
            || !isNonNegativeInt(cs.extraNew)
            || !isNonNegativeInt(cs.extraRev)
            || cs.extraNew > 10_000
            || cs.extraRev > 10_000
        ) {
            return "Invalid deck customStudy override";
        }
    }
    return null;
}

export function validateDeckConfigObject(dconf: any): string | null {
    if (!dconf || typeof dconf !== "object" || Array.isArray(dconf)) {
        return "DeckConfig must be an object";
    }
    if (!isPositiveInt(dconf.id)) {
        return "DeckConfig id must be a positive integer";
    }
    if (typeof dconf.name !== "string" || !dconf.name.trim() || dconf.name.length > 256) {
        return "DeckConfig name must be a non-empty string (max 256 chars)";
    }
    if (!dconf.new || typeof dconf.new !== "object" || Array.isArray(dconf.new)) {
        return "DeckConfig.new must be an object";
    }
    if (
        !Array.isArray(dconf.new.delays)
        || dconf.new.delays.length === 0
        || dconf.new.delays.length > 32
        || !dconf.new.delays.every((n: any) => isFiniteNumber(n) && n > 0 && n <= 525_600)
    ) {
        return "DeckConfig.new.delays must be 1..32 positive numbers";
    }
    if (
        !Array.isArray(dconf.new.ints)
        || dconf.new.ints.length < 2
        || dconf.new.ints.length > 8
        || !dconf.new.ints.every((n: any) => isFiniteNumber(n) && n >= 1 && n <= 365_000)
    ) {
        return "DeckConfig.new.ints must contain valid graduating/easy intervals";
    }
    if (!isFiniteNumber(dconf.new.perDay) || dconf.new.perDay < 0 || dconf.new.perDay > 100_000) {
        return "DeckConfig.new.perDay out of range";
    }
    if (
        !isFiniteNumber(dconf.new.initialFactor) || dconf.new.initialFactor < 1000 || dconf.new.initialFactor > 100_000
    ) {
        return "DeckConfig.new.initialFactor out of range";
    }

    if (!dconf.rev || typeof dconf.rev !== "object" || Array.isArray(dconf.rev)) {
        return "DeckConfig.rev must be an object";
    }
    if (!isFiniteNumber(dconf.rev.perDay) || dconf.rev.perDay < 0 || dconf.rev.perDay > 100_000) {
        return "DeckConfig.rev.perDay out of range";
    }
    if (!isFiniteNumber(dconf.rev.maxIvl) || dconf.rev.maxIvl < 1 || dconf.rev.maxIvl > 365_000) {
        return "DeckConfig.rev.maxIvl out of range";
    }
    if (
        dconf.rev.ease4 !== undefined
        && (!isFiniteNumber(dconf.rev.ease4) || dconf.rev.ease4 <= 0 || dconf.rev.ease4 > 100)
    ) {
        return "DeckConfig.rev.ease4 out of range";
    }
    if (
        dconf.rev.ivlFct !== undefined
        && (!isFiniteNumber(dconf.rev.ivlFct) || dconf.rev.ivlFct <= 0 || dconf.rev.ivlFct > 100)
    ) {
        return "DeckConfig.rev.ivlFct out of range";
    }
    if (
        dconf.rev.hardFactor !== undefined
        && (!isFiniteNumber(dconf.rev.hardFactor) || dconf.rev.hardFactor <= 0 || dconf.rev.hardFactor > 100)
    ) {
        return "DeckConfig.rev.hardFactor out of range";
    }

    if (!dconf.lapse || typeof dconf.lapse !== "object" || Array.isArray(dconf.lapse)) {
        return "DeckConfig.lapse must be an object";
    }
    if (
        !Array.isArray(dconf.lapse.delays)
        || dconf.lapse.delays.length === 0
        || dconf.lapse.delays.length > 32
        || !dconf.lapse.delays.every((n: any) => isFiniteNumber(n) && n > 0 && n <= 525_600)
    ) {
        return "DeckConfig.lapse.delays must be 1..32 positive numbers";
    }
    if (!isFiniteNumber(dconf.lapse.minInt) || dconf.lapse.minInt < 1 || dconf.lapse.minInt > 365_000) {
        return "DeckConfig.lapse.minInt out of range";
    }
    if (!isFiniteNumber(dconf.lapse.leechFails) || dconf.lapse.leechFails < 1 || dconf.lapse.leechFails > 1000) {
        return "DeckConfig.lapse.leechFails out of range";
    }
    if (dconf.fsrsEnabled !== undefined && typeof dconf.fsrsEnabled !== "boolean") {
        return "DeckConfig.fsrsEnabled must be a boolean";
    }
    if (
        dconf.desiredRetention !== undefined
        && (!isFiniteNumber(dconf.desiredRetention) || dconf.desiredRetention < 0.7 || dconf.desiredRetention > 0.99)
    ) {
        return "DeckConfig.desiredRetention must be between 0.70 and 0.99";
    }
    return null;
}

export function validateNoteTypeObject(model: any): string | null {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
        return "NoteType must be an object";
    }
    if (!isPositiveInt(model.id)) {
        return "NoteType id must be a positive integer";
    }
    if (typeof model.name !== "string" || !model.name.trim() || model.name.length > 256) {
        return "NoteType name must be a non-empty string (max 256 chars)";
    }
    if (model.type !== 0 && model.type !== 1) {
        return "NoteType type must be 0 (standard) or 1 (cloze)";
    }
    if (!Array.isArray(model.flds) || model.flds.length === 0 || model.flds.length > 64) {
        return "NoteType flds must be a non-empty array (1..64)";
    }
    for (let i = 0; i < model.flds.length; i++) {
        const f = model.flds[i];
        if (!f || typeof f !== "object" || typeof f.name !== "string" || !f.name.trim() || f.name.length > 256) {
            return `NoteType field ${i} has invalid name`;
        }
        if (f.ord !== undefined && (!isNonNegativeInt(f.ord) || f.ord > 64)) {
            return `NoteType field ${i} has invalid ord`;
        }
    }
    if (!Array.isArray(model.tmpls) || model.tmpls.length === 0 || model.tmpls.length > 64) {
        return "NoteType tmpls must be a non-empty array (1..64)";
    }
    for (let i = 0; i < model.tmpls.length; i++) {
        const t = model.tmpls[i];
        if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name.trim() || t.name.length > 256) {
            return `NoteType template ${i} has invalid name`;
        }
        if (typeof t.qfmt !== "string" || t.qfmt.length > MAX_TEMPLATE_LEN) {
            return `NoteType template ${i} has invalid qfmt`;
        }
        if (typeof t.afmt !== "string" || t.afmt.length > MAX_TEMPLATE_LEN) {
            return `NoteType template ${i} has invalid afmt`;
        }
    }
    if (model.css !== undefined && (typeof model.css !== "string" || model.css.length > MAX_CSS_LEN)) {
        return "NoteType css exceeds maximum length";
    }
    return null;
}

/**
 * Validate an entire Collection payload including nested schemas (`models`, `dconf`,
 * `decks`, `notes`, `cards`, `revlog`, `media`), item count caps, map-key invariants,
 * and foreign-key relationship consistency (SEC-02, DATA-11, SEC-13).
 */
export function validateCollectionPayload(col: any): string | null {
    if (!col || typeof col !== "object" || Array.isArray(col)) {
        return "Collection must be an object";
    }
    if (!col.decks || typeof col.decks !== "object" || Array.isArray(col.decks)) {
        return "Collection decks must be an object map";
    }
    if (!col.notes || typeof col.notes !== "object" || Array.isArray(col.notes)) {
        return "Collection notes must be an object map";
    }
    if (!col.cards || typeof col.cards !== "object" || Array.isArray(col.cards)) {
        return "Collection cards must be an object map";
    }
    if (col.models !== undefined && (!col.models || typeof col.models !== "object" || Array.isArray(col.models))) {
        return "Collection models must be an object map";
    }
    if (col.dconf !== undefined && (!col.dconf || typeof col.dconf !== "object" || Array.isArray(col.dconf))) {
        return "Collection dconf must be an object map";
    }
    if (col.revlog !== undefined && !Array.isArray(col.revlog)) {
        return "Collection revlog must be an array";
    }
    if (col.media !== undefined && (!col.media || typeof col.media !== "object" || Array.isArray(col.media))) {
        return "Collection media must be an object map";
    }

    const deckEntries = Object.entries(col.decks);
    const noteEntries = Object.entries(col.notes);
    const cardEntries = Object.entries(col.cards);
    const modelEntries = Object.entries(col.models || {});
    const dconfEntries = Object.entries(col.dconf || {});
    const revlogList: any[] = col.revlog || [];
    const mediaEntries = Object.entries(col.media || {});

    if (
        deckEntries.length === 0
        || deckEntries.length > MAX_DECKS
        || noteEntries.length > MAX_COLLECTION_ITEMS
        || cardEntries.length > MAX_COLLECTION_ITEMS
        || modelEntries.length > MAX_MODELS
        || dconfEntries.length > MAX_DCONF
        || revlogList.length > MAX_REVLOG_ITEMS
        || mediaEntries.length > MAX_MEDIA_ITEMS
    ) {
        return "Collection exceeds item count limits";
    }

    const validDeckIds = new Set<number>();
    for (const [key, d] of deckEntries) {
        const err = validateDeckObject(d);
        if (err) { return err; }
        if (Number(key) !== (d as any).id) {
            return "Deck map key does not match deck.id";
        }
        validDeckIds.add((d as any).id);
    }

    const validDconfIds = new Set<number>();
    for (const [key, dc] of dconfEntries) {
        const err = validateDeckConfigObject(dc);
        if (err) { return err; }
        if (Number(key) !== (dc as any).id) {
            return "DeckConfig map key does not match dconf.id";
        }
        validDconfIds.add((dc as any).id);
    }

    if (validDconfIds.size > 0) {
        for (const [, d] of deckEntries) {
            const confId = (d as any).conf;
            if (confId !== undefined && !validDconfIds.has(confId)) {
                return `Deck ${(d as any).id} references nonexistent dconf ${confId}`;
            }
        }
    }

    const validModelIds = new Set<number>();
    for (const [key, m] of modelEntries) {
        const err = validateNoteTypeObject(m);
        if (err) { return err; }
        if (Number(key) !== (m as any).id) {
            return "NoteType map key does not match model.id";
        }
        validModelIds.add((m as any).id);
    }

    const validNoteIds = new Set<number>();
    for (const [key, n] of noteEntries) {
        const err = validateNoteObject(n);
        if (err) { return err; }
        if (Number(key) !== (n as any).id) {
            return "Note map key does not match note.id";
        }
        if (validModelIds.size > 0 && !validModelIds.has((n as any).mid)) {
            return `Note ${(n as any).id} references nonexistent model ${(n as any).mid}`;
        }
        validNoteIds.add((n as any).id);
    }

    for (const [key, c] of cardEntries) {
        const err = validateCardObject(c);
        if (err) { return err; }
        if (Number(key) !== (c as any).id) {
            return "Card map key does not match card.id";
        }
        if (!validDeckIds.has((c as any).did)) {
            return `Card ${(c as any).id} references nonexistent deck ${(c as any).did}`;
        }
        if (!validNoteIds.has((c as any).nid)) {
            return `Card ${(c as any).id} references nonexistent note ${(c as any).nid}`;
        }
    }

    for (const r of revlogList) {
        const err = validateRevlogObject(r);
        if (err) { return err; }
    }

    let totalMediaBytes = 0;
    const normalizedMedia: Record<string, string> = {};
    for (const [filename, dataUrl] of mediaEntries) {
        if (typeof dataUrl !== "string") {
            return "Media value must be a string";
        }
        const mediaValidation = validateMediaDataUrl(filename, dataUrl);
        if (!mediaValidation.ok) {
            return mediaValidation.error;
        }
        totalMediaBytes += mediaValidation.decodedBytes;
        if (totalMediaBytes > MAX_TOTAL_MEDIA_BYTES) {
            return "Collection media exceeds aggregate size budget";
        }
        normalizedMedia[mediaValidation.safeFilename] = mediaValidation.canonicalDataUrl;
    }
    if (col.media) {
        col.media = normalizedMedia;
    }

    return null;
}

export function validateClientMessage(raw: any): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.type !== "string") {
        return { ok: false, error: "Message must be a JSON object with a string type" };
    }
    if (raw.generation !== undefined && (typeof raw.generation !== "string" || raw.generation.length > 64)) {
        return { ok: false, error: "Invalid collection generation" };
    }
    if (raw.opId !== undefined && (typeof raw.opId !== "string" || !raw.opId || raw.opId.length > 191)) {
        return { ok: false, error: "Invalid operation ID" };
    }

    switch (raw.type) {
        case "ping":
            return { ok: true, msg: raw as ClientMessage };

        case "init": {
            if (raw.knownGeneration !== undefined && (typeof raw.knownGeneration !== "string" || raw.knownGeneration.length > 64)) {
                return { ok: false, error: "Invalid knownGeneration" };
            }
            if (raw.hasLocalCollection !== undefined && typeof raw.hasLocalCollection !== "boolean") {
                return { ok: false, error: "Invalid hasLocalCollection" };
            }
            if (raw.knownMedia !== undefined) {
                if (
                    !Array.isArray(raw.knownMedia)
                    || raw.knownMedia.length > MAX_MEDIA_ITEMS
                    || !raw.knownMedia.every((m: any) => typeof m === "string" && m.length <= 255)
                ) {
                    return { ok: false, error: "Invalid knownMedia manifest" };
                }
            }
            return { ok: true, msg: raw as ClientMessage };
        }

        case "answer_card": {
            if (!isPositiveInt(raw.cardId)) {
                return { ok: false, error: "answer_card requires a positive integer cardId" };
            }
            const stateErr = validateCardPartialState(raw.nextState);
            if (stateErr) {
                return { ok: false, error: stateErr };
            }
            const revErr = validateRevlogObject(raw.revlogEntry);
            if (revErr) {
                return { ok: false, error: revErr };
            }
            // DATA-12: Require revlogEntry.cid to match the answered cardId
            if (raw.revlogEntry.cid !== raw.cardId) {
                return {
                    ok: false,
                    error: "answer_card revlogEntry.cid must match cardId",
                };
            }
            if (!isNonNegativeInt(raw.baseReps)) {
                return { ok: false, error: "answer_card baseReps must be a non-negative integer" };
            }
            if (raw.forceOverwrite !== undefined && typeof raw.forceOverwrite !== "boolean") {
                return { ok: false, error: "answer_card forceOverwrite must be a boolean" };
            }
            return { ok: true, msg: raw as ClientMessage };
        }

        case "upsert_deck": {
            const err = validateDeckObject(raw.deck);
            if (err) { return { ok: false, error: err }; }
            if (raw.isNew !== undefined && typeof raw.isNew !== "boolean") {
                return { ok: false, error: "upsert_deck isNew must be a boolean" };
            }
            if (raw.expectedMod !== undefined && !isNonNegativeInt(raw.expectedMod)) {
                return { ok: false, error: "upsert_deck expectedMod must be a non-negative integer" };
            }
            if (raw.forceOverwrite !== undefined && typeof raw.forceOverwrite !== "boolean") {
                return { ok: false, error: "upsert_deck forceOverwrite must be a boolean" };
            }
            return { ok: true, msg: raw as ClientMessage };
        }

        case "delete_deck": {
            if (!isPositiveInt(raw.deckId)) {
                return { ok: false, error: "delete_deck requires a positive integer deckId" };
            }
            if (raw.deckId === 1) {
                return { ok: false, error: "Default deck (id=1) cannot be deleted" };
            }
            if (raw.expectedRevision !== undefined && !isNonNegativeInt(raw.expectedRevision)) {
                return { ok: false, error: "Invalid delete_deck expectedRevision" };
            }
            return { ok: true, msg: raw as ClientMessage };
        }

        case "upsert_deck_config": {
            const err = validateDeckConfigObject(raw.dconf);
            if (err) {
                return { ok: false, error: err };
            }
            if (raw.expectedRevision !== undefined && !isNonNegativeInt(raw.expectedRevision)) {
                return { ok: false, error: "Invalid deck-config expectedRevision" };
            }
            return { ok: true, msg: raw as ClientMessage };
        }

        case "upsert_note": {
            const noteErr = validateNoteObject(raw.note);
            if (noteErr) { return { ok: false, error: noteErr }; }
            if (!Array.isArray(raw.cards) || (raw.isNew && raw.cards.length === 0) || raw.cards.length > 64) {
                return { ok: false, error: "upsert_note requires 0..64 cards (at least 1 when isNew)" };
            }
            for (const c of raw.cards) {
                const cardErr = validateCardObject(c);
                if (cardErr) { return { ok: false, error: cardErr }; }
                // DATA-11: Every card in upsert_note must belong to raw.note.id
                if (c.nid !== raw.note.id) {
                    return { ok: false, error: "upsert_note card.nid must match note.id" };
                }
            }
            if (raw.removedCardIds !== undefined
                && (!Array.isArray(raw.removedCardIds)
                    || raw.removedCardIds.length > 64
                    || !raw.removedCardIds.every(isPositiveInt))) {
                return { ok: false, error: "upsert_note removedCardIds must contain valid card IDs" };
            }
            if (raw.isNew !== undefined && typeof raw.isNew !== "boolean") {
                return { ok: false, error: "upsert_note isNew must be a boolean" };
            }
            if (raw.expectedMod !== undefined && !isNonNegativeInt(raw.expectedMod)) {
                return { ok: false, error: "upsert_note expectedMod must be a non-negative integer" };
            }
            if (raw.forceOverwrite !== undefined && typeof raw.forceOverwrite !== "boolean") {
                return { ok: false, error: "upsert_note forceOverwrite must be a boolean" };
            }
            return { ok: true, msg: raw as ClientMessage };
        }

        case "delete_note": {
            if (!isPositiveInt(raw.noteId)) {
                return { ok: false, error: "delete_note requires a positive integer noteId" };
            }
            if (raw.expectedRevision !== undefined && !isNonNegativeInt(raw.expectedRevision)) {
                return { ok: false, error: "Invalid delete_note expectedRevision" };
            }
            return { ok: true, msg: raw as ClientMessage };
        }

        case "update_card": {
            const err = validateCardObject(raw.card);
            if (err) { return { ok: false, error: err }; }
            if (raw.expectedMod !== undefined && !isNonNegativeInt(raw.expectedMod)) {
                return { ok: false, error: "update_card expectedMod must be a non-negative integer" };
            }
            if (raw.forceOverwrite !== undefined && typeof raw.forceOverwrite !== "boolean") {
                return { ok: false, error: "update_card forceOverwrite must be a boolean" };
            }
            return { ok: true, msg: raw as ClientMessage };
        }

        case "save_media": {
            if (typeof raw.filename !== "string" || !raw.filename.trim() || raw.filename.length > 255) {
                return { ok: false, error: "Invalid media filename" };
            }
            if (typeof raw.dataUrl !== "string" || raw.dataUrl.length > MAX_MEDIA_DATA_URL_LEN) {
                return { ok: false, error: "Media dataUrl exceeds maximum size" };
            }
            const mediaValidation = validateMediaDataUrl(raw.filename, raw.dataUrl);
            if (!mediaValidation.ok) {
                return { ok: false, error: mediaValidation.error };
            }
            // L-02 & L-03: Canonicalize filename and dataUrl in the validated message
            raw.filename = mediaValidation.safeFilename;
            raw.dataUrl = mediaValidation.canonicalDataUrl;
            return { ok: true, msg: raw as ClientMessage };
        }

        case "delete_media": {
            if (
                !Array.isArray(raw.filenames)
                || raw.filenames.length === 0
                || raw.filenames.length > MAX_MEDIA_ITEMS
                || !raw.filenames.every((fn: any) => typeof fn === "string" && fn.trim().length > 0 && fn.length <= 255)
            ) {
                return { ok: false, error: "delete_media requires 1..2500 valid filenames" };
            }
            return { ok: true, msg: raw as ClientMessage };
        }

        case "import_collection": {
            const err = validateCollectionPayload(raw.collection);
            if (err) { return { ok: false, error: err }; }
            if (
                raw.expectedRevision !== undefined
                && (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0)
            ) {
                return { ok: false, error: "import_collection expectedRevision must be an integer" };
            }
            if (raw.forceOverwrite !== undefined && typeof raw.forceOverwrite !== "boolean") {
                return { ok: false, error: "import_collection forceOverwrite must be a boolean" };
            }
            if (raw.seedOnUninitialized !== undefined && typeof raw.seedOnUninitialized !== "boolean") {
                return { ok: false, error: "import_collection seedOnUninitialized must be a boolean" };
            }
            if (raw.allowNoBackup !== undefined && typeof raw.allowNoBackup !== "boolean") {
                return { ok: false, error: "import_collection allowNoBackup must be a boolean" };
            }
            if (
                raw.keepMediaNames !== undefined
                && (!Array.isArray(raw.keepMediaNames)
                    || raw.keepMediaNames.length > MAX_MEDIA_ITEMS
                    || !raw.keepMediaNames.every((m: any) => typeof m === "string" && m.length <= 255))
            ) {
                return { ok: false, error: "import_collection keepMediaNames must be an array of filenames" };
            }
            return { ok: true, msg: raw as ClientMessage };
        }

        default:
            return { ok: false, error: `Unsupported message type: ${String(raw.type)}` };
    }
}

const ALLOWED_PUSH_HOST_SUFFIXES = [
    ".push.apple.com",
    "fcm.googleapis.com",
    ".fcm.googleapis.com",
    ".google.com",
    ".googleapis.com",
    ".notify.windows.com",
    ".push.services.mozilla.com",
    ".mozaws.net",
];

/**
 * Validate Web Push subscription endpoint & encryption keys against SSRF and malformed inputs (S04).
 */
export function validatePushSubscriptionInput(sub: any): { ok: true } | { ok: false; error: string } {
    if (!sub || typeof sub !== "object") {
        return { ok: false, error: "Subscription must be an object" };
    }
    if (typeof sub.endpoint !== "string" || sub.endpoint.length > 2048) {
        return { ok: false, error: "Invalid push endpoint length" };
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(sub.endpoint);
    } catch {
        return { ok: false, error: "Push endpoint is not a valid URL" };
    }

    if (parsedUrl.protocol !== "https:") {
        return { ok: false, error: "Push endpoint must use HTTPS" };
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.port) {
        return { ok: false, error: "Push endpoint must not contain credentials or custom ports" };
    }

    const host = parsedUrl.hostname.toLowerCase();
    const isAllowedHost = ALLOWED_PUSH_HOST_SUFFIXES.some(suffix =>
        suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix
    );
    if (!isAllowedHost) {
        return {
            ok: false,
            error: "Push endpoint hostname is not a recognized Web Push service provider",
        };
    }

    const p256dh = sub.keys?.p256dh;
    const auth = sub.keys?.auth;
    if (
        typeof p256dh !== "string"
        || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh)
        || typeof auth !== "string"
        || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)
    ) {
        return { ok: false, error: "Invalid push encryption keys (p256dh / auth)" };
    }

    return { ok: true };
}
