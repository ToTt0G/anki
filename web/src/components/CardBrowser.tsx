import React, { useState } from "react";
import { Collection, Card, Note } from "../core/types";
import { searchCards, SearchFilterResult } from "../core/search";
import { Search, EyeOff, Trash2, RotateCcw, Archive } from "lucide-react";

interface Props {
  collection: Collection;
  onUpdateNote: (note: Note) => void;
  onUpdateCard: (card: Card) => void;
  onDeleteNote: (noteId: number) => void;
}

export const CardBrowser: React.FC<Props> = ({
  collection,
  onUpdateNote,
  onUpdateCard,
  onDeleteNote
}) => {
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);

  const searchResults = searchCards(collection, searchQuery);

  const selectedCardItem = selectedCardId
    ? searchResults.find(r => r.card.id === selectedCardId) || null
    : searchResults[0] || null;

  const handleFieldChange = (fieldIdx: number, val: string) => {
    if (!selectedCardItem) return;
    const updatedNote = { ...selectedCardItem.note };
    const fields = [...updatedNote.fields];
    fields[fieldIdx] = val;
    if (fieldIdx === 0) {
      updatedNote.sfld = val;
    }
    updatedNote.fields = fields;
    updatedNote.mod = Math.floor(Date.now() / 1000);
    onUpdateNote(updatedNote);
  };

  const handleTagsChange = (val: string) => {
    if (!selectedCardItem) return;
    const tags = val.trim().split(/\s+/).filter(Boolean);
    const updatedNote = { ...selectedCardItem.note, tags, mod: Math.floor(Date.now() / 1000) };
    onUpdateNote(updatedNote);
  };

  const handleToggleSuspend = () => {
    if (!selectedCardItem) return;
    const card = { ...selectedCardItem.card };
    if (card.queue === -1) {
      card.queue = card.type === 0 ? 0 : card.type === 2 ? 2 : 1;
    } else {
      card.queue = -1;
    }
    card.mod = Math.floor(Date.now() / 1000);
    onUpdateCard(card);
  };

  const handleToggleBury = () => {
    if (!selectedCardItem) return;
    const card = { ...selectedCardItem.card };
    if (card.queue === -2 || card.queue === -3) {
      card.queue = card.type === 0 ? 0 : card.type === 2 ? 2 : 1;
    } else {
      card.queue = -3;
    }
    card.mod = Math.floor(Date.now() / 1000);
    onUpdateCard(card);
  };

  const handleResetCard = () => {
    if (!selectedCardItem) return;
    const card = { ...selectedCardItem.card };
    card.type = 0;
    card.queue = 0;
    card.reps = 0;
    card.lapses = 0;
    card.ivl = 0;
    card.factor = 2500;
    card.mod = Math.floor(Date.now() / 1000);
    onUpdateCard(card);
  };

  const handleDelete = () => {
    if (!selectedCardItem) return;
    if (window.confirm("Delete this note and all its cards?")) {
      onDeleteNote(selectedCardItem.note.id);
      setSelectedCardId(null);
    }
  };

  const model = selectedCardItem ? collection.models[selectedCardItem.note.mid] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "calc(100vh - 120px)" }}>
      {/* Search Header */}
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ position: "relative", flex: 1 }}>
          <Search
            size={16}
            style={{
              position: "absolute",
              left: 10,
              top: 10,
              color: "var(--text-secondary)"
            }}
          />
          <input
            type="text"
            placeholder="deck:Default tag:anki is:due..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{ width: "100%", paddingLeft: 34 }}
          />
        </div>
      </div>

      {/* Main split view: Sidebar + List + Detail */}
      <div className="browser-layout">
        {/* Quick Filter Sidebar */}
        <div className="browser-sidebar">
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 8 }}>
            STATES
          </div>
          <div
            style={{ cursor: "pointer", padding: "4px 0", fontSize: 13 }}
            onClick={() => setSearchQuery("")}
          >
            All Cards
          </div>
          <div
            style={{ cursor: "pointer", padding: "4px 0", fontSize: 13, color: "var(--color-due)" }}
            onClick={() => setSearchQuery("is:due")}
          >
            Due
          </div>
          <div
            style={{ cursor: "pointer", padding: "4px 0", fontSize: 13, color: "var(--color-new)" }}
            onClick={() => setSearchQuery("is:new")}
          >
            New
          </div>
          <div
            style={{ cursor: "pointer", padding: "4px 0", fontSize: 13, color: "var(--color-learn)" }}
            onClick={() => setSearchQuery("is:learn")}
          >
            Learning
          </div>
          <div
            style={{ cursor: "pointer", padding: "4px 0", fontSize: 13 }}
            onClick={() => setSearchQuery("is:suspended")}
          >
            Suspended
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", marginTop: 16, marginBottom: 8 }}>
            DECKS
          </div>
          {Object.values(collection.decks).map(d => (
            <div
              key={d.id}
              style={{ cursor: "pointer", padding: "4px 0", fontSize: 13, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}
              onClick={() => setSearchQuery(`deck:"${d.name}"`)}
            >
              {d.name}
            </div>
          ))}
        </div>

        {/* Card Table & Detail Editor */}
        <div className="browser-main">
          {/* Card list */}
          <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--border-color)", borderRadius: 6 }}>
            <table className="card-list-table">
              <thead>
                <tr>
                  <th>Sort Field</th>
                  <th style={{ width: 100 }}>Deck</th>
                  <th style={{ width: 60 }}>Reps</th>
                  <th style={{ width: 60 }}>Lapses</th>
                </tr>
              </thead>
              <tbody>
                {searchResults.map(({ card, note, deckName }) => {
                  const isSelected = selectedCardItem?.card.id === card.id;
                  return (
                    <tr
                      key={card.id}
                      className={isSelected ? "selected" : ""}
                      onClick={() => setSelectedCardId(card.id)}
                      style={{ cursor: "pointer" }}
                    >
                      <td style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", maxWidth: 220 }}>
                        {card.queue === -1 && <span style={{ color: "var(--text-muted)", marginRight: 4 }}>[S]</span>}
                        {note.sfld || note.fields[0]}
                      </td>
                      <td>{deckName}</td>
                      <td>{card.reps}</td>
                      <td>{card.lapses}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Card Editor Pane */}
          {selectedCardItem && model && (
            <div
              style={{
                border: "1px solid var(--border-color)",
                borderRadius: 6,
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                maxHeight: 260,
                overflowY: "auto"
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{model.name}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={handleToggleSuspend} style={{ padding: "3px 8px", fontSize: 12 }}>
                    {selectedCardItem.card.queue === -1 ? "Unsuspend" : "Suspend"}
                  </button>
                  <button onClick={handleToggleBury} style={{ padding: "3px 8px", fontSize: 12 }}>
                    {selectedCardItem.card.queue < -1 ? "Unbury" : "Bury"}
                  </button>
                  <button onClick={handleResetCard} style={{ padding: "3px 8px", fontSize: 12 }}>
                    Reset
                  </button>
                  <button onClick={handleDelete} style={{ padding: "3px 8px", fontSize: 12, color: "var(--color-again)" }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              {model.flds.map((fld, idx) => (
                <div key={fld.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>{fld.name}</label>
                  <input
                    type="text"
                    value={selectedCardItem.note.fields[idx] || ""}
                    onChange={e => handleFieldChange(idx, e.target.value)}
                  />
                </div>
              ))}

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>Tags</label>
                <input
                  type="text"
                  value={selectedCardItem.note.tags.join(" ")}
                  onChange={e => handleTagsChange(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
