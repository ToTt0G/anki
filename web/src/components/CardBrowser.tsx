import React, { useState } from "react";
import { Collection, Card, Note } from "../core/types";
import { searchCards } from "../core/search";
import { Search, Trash2, Image as ImageIcon, X } from "lucide-react";

interface Props {
  collection: Collection;
  onUpdateNote: (note: Note) => void;
  onUpdateCard: (card: Card) => void;
  onDeleteNote: (noteId: number) => void;
  onSaveMedia?: (filename: string, dataUrl: string) => void;
}

function formatCardState(card: Card): { label: string; color: string } {
  if (card.queue === -1) return { label: "Suspended", color: "var(--text-muted)" };
  if (card.queue < -1) return { label: "Buried", color: "var(--text-muted)" };
  if (card.queue === 0) return { label: "New", color: "var(--color-new)" };
  if (card.queue === 1 || card.queue === 3) return { label: "Learn", color: "var(--color-learn)" };
  if (card.queue === 2) {
    return {
      label: card.ivl > 0 ? `${card.ivl}d` : "Due",
      color: "var(--color-due)"
    };
  }
  return { label: "New", color: "var(--color-new)" };
}

function stripHtmlPreview(raw: string): string {
  return raw
    .replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, "[Image: $1] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{\{c\d+::([^}:]+)(?:::[^}]*)?\}\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export const CardBrowser: React.FC<Props> = ({
  collection,
  onUpdateNote,
  onUpdateCard,
  onDeleteNote,
  onSaveMedia
}) => {
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [confirmAction, setConfirmAction] = useState<"reset" | "delete" | null>(null);
  const browserFileRef = React.useRef<HTMLInputElement | null>(null);
  const editingFieldIdxRef = React.useRef<number>(0);

  const searchResults = searchCards(collection, searchQuery);

  const selectedCardItem = selectedCardId
    ? searchResults.find(r => r.card.id === selectedCardId) || searchResults[0] || null
    : searchResults[0] || null;

  const handleBrowserImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedCardItem) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = "paste_" + Date.now() + "_" + cleanName;
      if (onSaveMedia) {
        onSaveMedia(filename, dataUrl);
      } else {
        collection.media[filename] = dataUrl;
      }
      const idx = editingFieldIdxRef.current;
      const cur = selectedCardItem.note.fields[idx] || "";
      const imgTag = `<img src="${filename}">`;
      handleFieldChange(idx, cur ? cur + "\n" + imgTag : imgTag);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

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
      card.queue = card.type === 0 ? 0 : 2;
    } else {
      card.queue = -1;
    }
    card.mod = Math.floor(Date.now() / 1000);
    onUpdateCard(card);
  };

  const handleToggleBury = () => {
    if (!selectedCardItem) return;
    const card = { ...selectedCardItem.card };
    if (card.queue < -1) {
      card.queue = card.type === 0 ? 0 : 2;
    } else {
      card.queue = -2;
    }
    card.mod = Math.floor(Date.now() / 1000);
    onUpdateCard(card);
  };

  const executeResetCard = () => {
    if (!selectedCardItem) return;
    const card = {
      ...selectedCardItem.card,
      type: 0 as const,
      queue: 0 as const,
      due: 0,
      ivl: 0,
      factor: 2500,
      reps: 0,
      lapses: 0,
      left: 0,
      mod: Math.floor(Date.now() / 1000)
    };
    onUpdateCard(card);
    setConfirmAction(null);
  };

  const executeDeleteNote = () => {
    if (!selectedCardItem) return;
    onDeleteNote(selectedCardItem.note.id);
    setSelectedCardId(null);
    setConfirmAction(null);
  };

  const model = selectedCardItem ? collection.models[selectedCardItem.note.mid] : null;
  const allCards = Object.values(collection.cards);
  const nowSec = Math.floor(Date.now() / 1000);

  const stateFilters = [
    { label: "All Cards", query: "", count: allCards.length, color: "var(--text-primary)" },
    {
      label: "Due",
      query: "is:due",
      count: allCards.filter(c => c.queue === 2 || (c.queue === 1 && c.due <= nowSec)).length,
      color: "var(--color-due)"
    },
    {
      label: "New",
      query: "is:new",
      count: allCards.filter(c => c.queue === 0).length,
      color: "var(--color-new)"
    },
    {
      label: "Learning",
      query: "is:learn",
      count: allCards.filter(c => c.queue === 1 || c.queue === 3).length,
      color: "var(--color-learn)"
    },
    {
      label: "Suspended",
      query: "is:suspended",
      count: allCards.filter(c => c.queue === -1).length,
      color: "var(--text-secondary)"
    }
  ];

  const sortedDecks = Object.values(collection.decks).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <div className="browser-root">
      <input
        type="file"
        ref={browserFileRef}
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleBrowserImageUpload}
      />

      {/* Search Header */}
      <div className="browser-search-bar">
        <div className="browser-search-input-wrap">
          <Search size={15} className="browser-search-icon" />
          <input
            type="text"
            placeholder="Search cards (e.g. deck:Default tag:anki is:due)..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="browser-search-input"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="browser-search-clear"
              title="Clear filter"
            >
              <X size={14} />
            </button>
          )}
          <span className="browser-search-count">
            {searchResults.length} {searchResults.length === 1 ? "card" : "cards"}
          </span>
        </div>
      </div>

      {/* Main split view: Sidebar + Right Pane (Table + Editor) */}
      <div className="browser-layout">
        {/* Quick Filter Sidebar */}
        <aside className="browser-sidebar">
          <div className="browser-sidebar-group">
            {stateFilters.map(item => {
              const active = searchQuery.trim() === item.query;
              return (
                <button
                  key={item.label}
                  type="button"
                  className={`browser-filter-btn ${active ? "active" : ""}`}
                  onClick={() => setSearchQuery(item.query)}
                >
                  <span style={{ color: item.color }}>{item.label}</span>
                  <span className="browser-filter-count">{item.count}</span>
                </button>
              );
            })}
          </div>

          <div className="browser-sidebar-divider" />

          <div className="browser-sidebar-group">
            {sortedDecks.map(d => {
              const deckQuery = d.name.includes(" ") ? `deck:"${d.name}"` : `deck:${d.name}`;
              const active =
                searchQuery.trim() === deckQuery || searchQuery.trim() === `deck:"${d.name}"`;
              const deckCount = allCards.filter(c => c.did === d.id).length;
              return (
                <button
                  key={d.id}
                  type="button"
                  className={`browser-filter-btn ${active ? "active" : ""}`}
                  onClick={() => setSearchQuery(deckQuery)}
                  title={d.name}
                >
                  <span className="browser-filter-label">{d.name}</span>
                  <span className="browser-filter-count">{deckCount}</span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Card Table & Detail Editor */}
        <div className="browser-main">
          <div className="browser-table-container">
            <table className="browser-table">
              <thead>
                <tr>
                  <th style={{ width: "44%" }}>Sort Field</th>
                  <th style={{ width: "18%" }}>Card</th>
                  <th style={{ width: "16%" }}>Deck</th>
                  <th style={{ width: "11%" }}>State</th>
                  <th style={{ width: "11%", textAlign: "right" }}>Reps</th>
                </tr>
              </thead>
              <tbody>
                {searchResults.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="browser-empty-cell">
                      No matching cards found.
                    </td>
                  </tr>
                ) : (
                  searchResults.map(({ card, note, deckName }) => {
                    const isSelected = selectedCardItem?.card.id === card.id;
                    const cardModel = collection.models[note.mid];
                    const tmplName =
                      cardModel?.tmpls?.[card.ord]?.name || `Card ${card.ord + 1}`;
                    const stateInfo = formatCardState(card);
                    const previewText = stripHtmlPreview(note.sfld || note.fields[0] || "");

                    return (
                      <tr
                        key={card.id}
                        className={isSelected ? "selected" : ""}
                        onClick={() => setSelectedCardId(card.id)}
                      >
                        <td className="browser-cell-primary" title={previewText}>
                          {previewText || "(empty)"}
                        </td>
                        <td className="browser-cell-muted">{tmplName}</td>
                        <td className="browser-cell-muted">{deckName}</td>
                        <td>
                          <span
                            className="browser-state-pill"
                            style={{ color: stateInfo.color }}
                          >
                            {stateInfo.label}
                          </span>
                        </td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {card.reps}
                          {card.lapses > 0 ? (
                            <span style={{ color: "var(--color-again)", marginLeft: 4 }}>
                              ({card.lapses})
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Card Editor Pane */}
          {selectedCardItem && model && (
            <div className="browser-editor-card">
              <div className="browser-editor-header">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="browser-model-badge">{model.name}</span>
                  <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                    {model.tmpls?.[selectedCardItem.card.ord]?.name ||
                      `Card ${selectedCardItem.card.ord + 1}`}
                  </span>
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={handleToggleSuspend}
                    style={{ padding: "4px 10px", fontSize: 12.5 }}
                  >
                    {selectedCardItem.card.queue === -1 ? "Unsuspend" : "Suspend"}
                  </button>
                  <button
                    type="button"
                    onClick={handleToggleBury}
                    style={{ padding: "4px 10px", fontSize: 12.5 }}
                  >
                    {selectedCardItem.card.queue < -1 ? "Unbury" : "Bury"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmAction("reset")}
                    style={{ padding: "4px 10px", fontSize: 12.5 }}
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmAction("delete")}
                    style={{ padding: "4px 8px", fontSize: 12.5, color: "var(--color-again)" }}
                    title="Delete Note"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="browser-editor-fields">
                {model.flds.map((fld, idx) => (
                  <div key={fld.name} className="browser-field-group">
                    <div className="browser-field-label-row">
                      <label>{fld.name}</label>
                      <button
                        type="button"
                        className="browser-image-btn"
                        onClick={() => {
                          editingFieldIdxRef.current = idx;
                          browserFileRef.current?.click();
                        }}
                        title="Insert Image"
                      >
                        <ImageIcon size={12} />
                        <span>Image</span>
                      </button>
                    </div>
                    <textarea
                      rows={idx === 0 ? 2 : 3}
                      value={selectedCardItem.note.fields[idx] || ""}
                      onChange={e => handleFieldChange(idx, e.target.value)}
                      className="browser-field-textarea"
                    />
                  </div>
                ))}

                <div className="browser-field-group">
                  <div className="browser-field-label-row">
                    <label>Tags</label>
                  </div>
                  <input
                    type="text"
                    placeholder="space-separated tags"
                    value={selectedCardItem.note.tags.join(" ")}
                    onChange={e => handleTagsChange(e.target.value)}
                  />
                </div>
              </div>

              <div className="browser-editor-footer">
                <span>Interval: {selectedCardItem.card.ivl}d</span>
                <span>Ease: {Math.round(selectedCardItem.card.factor / 10)}%</span>
                <span>Reviews: {selectedCardItem.card.reps}</span>
                <span>Lapses: {selectedCardItem.card.lapses}</span>
              </div>
            </div>
          )}

          {confirmAction && selectedCardItem && (
            <div className="modal-backdrop" onClick={() => setConfirmAction(null)}>
              <div
                className="modal-content"
                style={{ maxWidth: 380 }}
                onClick={e => e.stopPropagation()}
              >
                <div className="modal-header">
                  <h3 style={{ fontSize: 16, fontWeight: 600 }}>
                    {confirmAction === "reset" ? "Reset Card Progress" : "Delete Note"}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setConfirmAction(null)}
                    style={{ border: "none", padding: 4, background: "transparent" }}
                  >
                    <X size={18} />
                  </button>
                </div>

                <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                  {confirmAction === "reset"
                    ? "Reset this card's learning progress and interval back to New?"
                    : "Delete this note and all of its associated cards?"}
                </div>

                <div className="modal-footer">
                  <button type="button" onClick={() => setConfirmAction(null)}>
                    Cancel
                  </button>
                  {confirmAction === "reset" ? (
                    <button type="button" className="primary" onClick={executeResetCard}>
                      Reset
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={executeDeleteNote}
                      style={{
                        background: "var(--color-again)",
                        borderColor: "var(--color-again)",
                        color: "#ffffff"
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
