import { Collection, Card, Note, Deck, DeckConfig, NoteType, RevlogEntry } from "../src/core/types";

export type ClientMessage =
  | { type: "init"; lastMod?: number }
  | { type: "answer_card"; cardId: number; nextState: Partial<Card>; revlogEntry: RevlogEntry }
  | { type: "upsert_deck"; deck: Deck }
  | { type: "delete_deck"; deckId: number }
  | { type: "upsert_deck_config"; dconf: DeckConfig }
  | { type: "upsert_note"; note: Note; cards: Card[] }
  | { type: "delete_note"; noteId: number; cardIds: number[] }
  | { type: "update_card"; card: Card }
  | { type: "import_collection"; collection: Collection }
  | { type: "ping" };

export type ServerMessage =
  | { type: "full_state"; collection: Collection }
  | { type: "answer_card"; cardId: number; nextState: Partial<Card>; revlogEntry: RevlogEntry }
  | { type: "upsert_deck"; deck: Deck }
  | { type: "delete_deck"; deckId: number }
  | { type: "upsert_deck_config"; dconf: DeckConfig }
  | { type: "upsert_note"; note: Note; cards: Card[] }
  | { type: "delete_note"; noteId: number; cardIds: number[] }
  | { type: "update_card"; card: Card }
  | { type: "import_collection"; collection: Collection }
  | { type: "pong" };
