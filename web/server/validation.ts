// Runtime Schema & Boundary Validation for Server Inputs (S04, S05, S12)

import { ClientMessage } from "./types";

const MAX_STRING_LEN = 512_000; // 512 KB per note field
const MAX_MEDIA_DATA_URL_LEN = 15 * 1024 * 1024; // 15 MB per media item
const MAX_COLLECTION_ITEMS = 60_000;

export function isPositiveInt(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && Number.isInteger(val) && val > 0;
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
  if (!isPositiveInt(card.id)) return "Card id must be a positive integer";
  if (!isPositiveInt(card.nid)) return "Card nid must be a positive integer";
  if (!isPositiveInt(card.did)) return "Card did must be a positive integer";
  if (typeof card.ord !== "number" || !Number.isInteger(card.ord) || card.ord < 0 || card.ord > 100) {
    return "Card ord out of range";
  }
  if (!isValidCardType(card.type)) return "Invalid card type";
  if (!isValidCardQueue(card.queue)) return "Invalid card queue";
  if (!isFiniteNumber(card.due)) return "Invalid card due value";
  if (!isFiniteNumber(card.ivl)) return "Invalid card interval";
  if (!isFiniteNumber(card.factor) || card.factor < 0 || card.factor > 100_000) {
    return "Invalid card ease factor";
  }
  if (!isFiniteNumber(card.reps) || card.reps < 0) return "Invalid card reps";
  if (!isFiniteNumber(card.lapses) || card.lapses < 0) return "Invalid card lapses";
  return null;
}

export function validateNoteObject(note: any): string | null {
  if (!note || typeof note !== "object" || Array.isArray(note)) {
    return "Note must be an object";
  }
  if (!isPositiveInt(note.id)) return "Note id must be a positive integer";
  if (!isPositiveInt(note.mid)) return "Note mid must be a positive integer";
  if (!Array.isArray(note.fields) || note.fields.length === 0 || note.fields.length > 64) {
    return "Note fields must be a non-empty array (max 64)";
  }
  for (const fld of note.fields) {
    if (typeof fld !== "string" || fld.length > MAX_STRING_LEN) {
      return "Note field exceeds maximum length";
    }
  }
  if (!Array.isArray(note.tags) || note.tags.length > 200) {
    return "Note tags must be an array (max 200)";
  }
  for (const tag of note.tags) {
    if (typeof tag !== "string" || tag.length > 256) {
      return "Invalid note tag";
    }
  }
  return null;
}

export function validateDeckObject(deck: any): string | null {
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) {
    return "Deck must be an object";
  }
  if (!isPositiveInt(deck.id)) return "Deck id must be a positive integer";
  if (typeof deck.name !== "string" || !deck.name.trim() || deck.name.length > 512) {
    return "Deck name must be a non-empty string (max 512 chars)";
  }
  return null;
}

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
  const deckList = Object.values(col.decks);
  const noteList = Object.values(col.notes);
  const cardList = Object.values(col.cards);

  if (
    deckList.length > 2_000 ||
    noteList.length > MAX_COLLECTION_ITEMS ||
    cardList.length > MAX_COLLECTION_ITEMS
  ) {
    return "Collection exceeds maximum item count limits";
  }

  for (const d of deckList) {
    const err = validateDeckObject(d);
    if (err) return err;
  }
  for (const n of noteList) {
    const err = validateNoteObject(n);
    if (err) return err;
  }
  for (const c of cardList) {
    const err = validateCardObject(c);
    if (err) return err;
  }
  return null;
}

export function validateClientMessage(raw: any): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.type !== "string") {
    return { ok: false, error: "Message must be a JSON object with a string type" };
  }

  switch (raw.type) {
    case "ping":
    case "init":
      return { ok: true, msg: raw as ClientMessage };

    case "answer_card": {
      if (!isPositiveInt(raw.cardId)) {
        return { ok: false, error: "answer_card requires a positive integer cardId" };
      }
      if (!raw.nextState || typeof raw.nextState !== "object" || Array.isArray(raw.nextState)) {
        return { ok: false, error: "answer_card requires nextState object" };
      }
      if (raw.nextState.queue !== undefined && !isValidCardQueue(raw.nextState.queue)) {
        return { ok: false, error: "answer_card has invalid nextState.queue" };
      }
      if (raw.nextState.type !== undefined && !isValidCardType(raw.nextState.type)) {
        return { ok: false, error: "answer_card has invalid nextState.type" };
      }
      if (!raw.revlogEntry || !isPositiveInt(raw.revlogEntry.id) || !isPositiveInt(raw.revlogEntry.cid)) {
        return { ok: false, error: "answer_card requires valid revlogEntry" };
      }
      return { ok: true, msg: raw as ClientMessage };
    }

    case "upsert_deck": {
      const err = validateDeckObject(raw.deck);
      if (err) return { ok: false, error: err };
      return { ok: true, msg: raw as ClientMessage };
    }

    case "delete_deck": {
      if (!isPositiveInt(raw.deckId)) {
        return { ok: false, error: "delete_deck requires a positive integer deckId" };
      }
      if (raw.deckId === 1) {
        return { ok: false, error: "Default deck (id=1) cannot be deleted" };
      }
      return { ok: true, msg: raw as ClientMessage };
    }

    case "upsert_deck_config": {
      if (!raw.dconf || typeof raw.dconf !== "object" || !isPositiveInt(raw.dconf.id)) {
        return { ok: false, error: "upsert_deck_config requires valid dconf" };
      }
      return { ok: true, msg: raw as ClientMessage };
    }

    case "upsert_note": {
      const noteErr = validateNoteObject(raw.note);
      if (noteErr) return { ok: false, error: noteErr };
      if (!Array.isArray(raw.cards) || raw.cards.length === 0 || raw.cards.length > 64) {
        return { ok: false, error: "upsert_note requires 1..64 cards" };
      }
      for (const c of raw.cards) {
        const cardErr = validateCardObject(c);
        if (cardErr) return { ok: false, error: cardErr };
      }
      return { ok: true, msg: raw as ClientMessage };
    }

    case "delete_note": {
      if (!isPositiveInt(raw.noteId)) {
        return { ok: false, error: "delete_note requires a positive integer noteId" };
      }
      return { ok: true, msg: raw as ClientMessage };
    }

    case "update_card": {
      const err = validateCardObject(raw.card);
      if (err) return { ok: false, error: err };
      return { ok: true, msg: raw as ClientMessage };
    }

    case "save_media": {
      if (typeof raw.filename !== "string" || !raw.filename.trim() || raw.filename.length > 255) {
        return { ok: false, error: "Invalid media filename" };
      }
      if (typeof raw.dataUrl !== "string" || raw.dataUrl.length > MAX_MEDIA_DATA_URL_LEN) {
        return { ok: false, error: "Media dataUrl exceeds maximum size" };
      }
      return { ok: true, msg: raw as ClientMessage };
    }

    case "import_collection": {
      const err = validateCollectionPayload(raw.collection);
      if (err) return { ok: false, error: err };
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
  ".mozaws.net"
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
      error: "Push endpoint hostname is not a recognized Web Push service provider"
    };
  }

  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;
  if (
    typeof p256dh !== "string" ||
    !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) ||
    typeof auth !== "string" ||
    !/^[A-Za-z0-9_-]{16,32}$/.test(auth)
  ) {
    return { ok: false, error: "Invalid push encryption keys (p256dh / auth)" };
  }

  return { ok: true };
}
