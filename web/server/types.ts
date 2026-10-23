import { Collection, Card, Note, Deck, DeckConfig, RevlogEntry } from "../src/core/types";

export type ClientMessage =
  | { type: "init"; lastMod?: number; lastRevision?: number; force?: boolean }
  | {
      type: "answer_card";
      opId?: string;
      cardId: number;
      nextState: Partial<Card>;
      revlogEntry: RevlogEntry;
      baseReps?: number;
    }
  | { type: "upsert_deck"; opId?: string; deck: Deck }
  | { type: "delete_deck"; opId?: string; deckId: number }
  | { type: "upsert_deck_config"; opId?: string; dconf: DeckConfig }
  | { type: "upsert_note"; opId?: string; note: Note; cards: Card[] }
  | { type: "delete_note"; opId?: string; noteId: number; cardIds?: number[] }
  | { type: "update_card"; opId?: string; card: Card }
  | { type: "save_media"; opId?: string; filename: string; dataUrl: string }
  | {
      type: "import_collection";
      opId?: string;
      collection: Collection;
      expectedRevision?: number;
      forceOverwrite?: boolean;
    }
  | { type: "ping" };

export type ServerMessage =
  | {
      type: "full_state";
      collection: Collection;
      revision: number;
      initialized: boolean;
      hasBackup?: boolean;
    }
  | {
      type: "ack";
      opId: string;
      revision: number;
    }
  | {
      type: "op_error";
      opId?: string;
      error: string;
      revision?: number;
    }
  | {
      type: "answer_card";
      opId?: string;
      cardId: number;
      nextState: Partial<Card>;
      revlogEntry: RevlogEntry;
      revision?: number;
    }
  | { type: "upsert_deck"; opId?: string; deck: Deck; revision?: number }
  | {
      type: "delete_deck";
      opId?: string;
      deckId: number;
      deletedDeckIds?: number[];
      deletedCardIds?: number[];
      deletedNoteIds?: number[];
      revision?: number;
    }
  | { type: "upsert_deck_config"; opId?: string; dconf: DeckConfig; revision?: number }
  | { type: "upsert_note"; opId?: string; note: Note; cards: Card[]; revision?: number }
  | {
      type: "delete_note";
      opId?: string;
      noteId: number;
      cardIds: number[];
      revision?: number;
    }
  | { type: "update_card"; opId?: string; card: Card; revision?: number }
  | { type: "save_media"; opId?: string; filename: string; dataUrl: string; revision?: number }
  | {
      type: "import_collection";
      opId?: string;
      collection: Collection;
      revision?: number;
    }
  | { type: "pong" };
