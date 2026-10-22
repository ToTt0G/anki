import React, { useState, useEffect, useRef } from "react";
import { Collection } from "../core/types";
import { getDeckCounts } from "../core/scheduler";
import { Settings, FolderPlus, Download, Upload, X } from "lucide-react";

interface Props {
  collection: Collection;
  onSelectDeck: (did: number) => void;
  onCreateDeck: (name: string) => void;
  onRenameDeck: (did: number, newName: string) => void;
  onDeleteDeck: (did: number) => void;
  onOptionsDeck: (did: number) => void;
  onExportDeckApkg: (did: number) => void;
  onExportDeckCsv: (did: number) => void;
  onExportCollectionApkg: () => void;
  onImportClick: () => void;
}

type DeckDialogState =
  | { mode: "create"; name: string }
  | { mode: "rename"; did: number; currentName: string; name: string }
  | { mode: "delete"; did: number; name: string }
  | null;

export const DeckList: React.FC<Props> = ({
  collection,
  onSelectDeck,
  onCreateDeck,
  onRenameDeck,
  onDeleteDeck,
  onOptionsDeck,
  onExportDeckApkg,
  onExportDeckCsv,
  onExportCollectionApkg,
  onImportClick
}) => {
  const [activeMenu, setActiveMenu] = useState<{
    did: number;
    top: number;
    right: number;
  } | null>(null);
  const [dialog, setDialog] = useState<DeckDialogState>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (dialog && (dialog.mode === "create" || dialog.mode === "rename")) {
      window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 10);
    }
  }, [dialog?.mode]);

  const decks = Object.values(collection.decks).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const handleDialogSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dialog) return;

    if (dialog.mode === "create") {
      const trimmed = dialog.name.trim();
      if (!trimmed) return;
      onCreateDeck(trimmed);
      setDialog(null);
    } else if (dialog.mode === "rename") {
      const trimmed = dialog.name.trim();
      if (trimmed && trimmed !== dialog.currentName) {
        onRenameDeck(dialog.did, trimmed);
      }
      setDialog(null);
    } else if (dialog.mode === "delete") {
      onDeleteDeck(dialog.did);
      setDialog(null);
    }
  };

  const activeDeck = activeMenu ? collection.decks[activeMenu.did] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%", maxWidth: "100%", boxSizing: "border-box" }}>
      <div className="deck-table-container">
        <table className="deck-table">
          <thead>
            <tr>
              <th>Deck</th>
              <th style={{ width: 60 }}>New</th>
              <th style={{ width: 60 }}>Learn</th>
              <th style={{ width: 60 }}>Due</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {decks.map(deck => {
              const counts = getDeckCounts(collection, deck.id);
              const indentLevel = (deck.name.match(/::/g) || []).length;
              const displayName = deck.name.split("::").pop() || deck.name;

              return (
                <tr key={deck.id} className="deck-row">
                  <td>
                    <div
                      className="deck-name-cell"
                      style={{ paddingLeft: indentLevel * 18 }}
                      onClick={() => onSelectDeck(deck.id)}
                    >
                      <span>{displayName}</span>
                    </div>
                  </td>
                  <td className="count-badge count-new">
                    {counts.newCount > 0 ? counts.newCount : ""}
                  </td>
                  <td className="count-badge count-learn">
                    {counts.learnCount > 0 ? counts.learnCount : ""}
                  </td>
                  <td className="count-badge count-due">
                    {counts.reviewCount > 0 ? counts.reviewCount : ""}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      onClick={e => {
                        if (activeMenu?.did === deck.id) {
                          setActiveMenu(null);
                          return;
                        }
                        const rect = e.currentTarget.getBoundingClientRect();
                        const menuHeight = deck.id !== 1 ? 185 : 150;
                        const openUpward = rect.bottom + menuHeight > window.innerHeight - 70;
                        setActiveMenu({
                          did: deck.id,
                          top: openUpward ? Math.max(8, rect.top - menuHeight - 4) : rect.bottom + 4,
                          right: Math.max(8, window.innerWidth - rect.right)
                        });
                      }}
                      style={{ padding: "4px 6px", border: "none", background: "transparent" }}
                    >
                      <Settings size={15} color="var(--text-secondary)" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {activeMenu && activeDeck && (
        <>
          <div
            onClick={() => setActiveMenu(null)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 90
            }}
          />
          <div
            style={{
              position: "fixed",
              top: activeMenu.top,
              right: activeMenu.right,
              background: "var(--bg-primary)",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              zIndex: 100,
              minWidth: 140,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column"
            }}
          >
            <button
              style={{ border: "none", justifyContent: "flex-start", borderRadius: 0 }}
              onClick={() => {
                const did = activeDeck.id;
                setActiveMenu(null);
                onOptionsDeck(did);
              }}
            >
              Options
            </button>
            <button
              style={{ border: "none", justifyContent: "flex-start", borderRadius: 0 }}
              onClick={() => {
                setDialog({
                  mode: "rename",
                  did: activeDeck.id,
                  currentName: activeDeck.name,
                  name: activeDeck.name
                });
                setActiveMenu(null);
              }}
            >
              Rename
            </button>
            <button
              style={{ border: "none", justifyContent: "flex-start", borderRadius: 0 }}
              onClick={() => {
                const did = activeDeck.id;
                setActiveMenu(null);
                onExportDeckApkg(did);
              }}
            >
              Export (.apkg)
            </button>
            <button
              style={{ border: "none", justifyContent: "flex-start", borderRadius: 0 }}
              onClick={() => {
                const did = activeDeck.id;
                setActiveMenu(null);
                onExportDeckCsv(did);
              }}
            >
              Export (.tsv)
            </button>
            {activeDeck.id !== 1 && (
              <button
                style={{
                  border: "none",
                  justifyContent: "flex-start",
                  borderRadius: 0,
                  color: "var(--color-again)"
                }}
                onClick={() => {
                  setDialog({
                    mode: "delete",
                    did: activeDeck.id,
                    name: activeDeck.name
                  });
                  setActiveMenu(null);
                }}
              >
                Delete
              </button>
            )}
          </div>
        </>
      )}

      {/* Bottom action buttons */}
      <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 16, flexWrap: "wrap", width: "100%", boxSizing: "border-box" }}>
        <button onClick={() => setDialog({ mode: "create", name: "" })}>
          <FolderPlus size={16} />
          <span>Create Deck</span>
        </button>
        <button onClick={onImportClick}>
          <Upload size={16} />
          <span>Import (.apkg)</span>
        </button>
        <button onClick={onExportCollectionApkg}>
          <Download size={16} />
          <span>Export Collection (.apkg)</span>
        </button>
      </div>

      {/* Native In-App Modal for Create / Rename / Delete Deck */}
      {dialog && (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <form
            className="modal-content"
            style={{ maxWidth: 400 }}
            onClick={e => e.stopPropagation()}
            onSubmit={handleDialogSubmit}
          >
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>
                {dialog.mode === "create"
                  ? "Create Deck"
                  : dialog.mode === "rename"
                  ? "Rename Deck"
                  : "Delete Deck"}
              </h3>
              <button
                type="button"
                onClick={() => setDialog(null)}
                style={{ border: "none", padding: 4, background: "transparent" }}
              >
                <X size={18} />
              </button>
            </div>

            {dialog.mode === "delete" ? (
              <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                Delete <strong style={{ color: "var(--text-primary)" }}>{dialog.name}</strong> and all of its cards?
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12.5, color: "var(--text-secondary)", fontWeight: 500 }}>
                  Deck Name
                </label>
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="e.g. Biology or Languages::Spanish"
                  value={dialog.name}
                  onChange={e =>
                    setDialog(prev => (prev && prev.mode !== "delete" ? { ...prev, name: e.target.value } : prev))
                  }
                  style={{ width: "100%" }}
                />
              </div>
            )}

            <div className="modal-footer">
              <button type="button" onClick={() => setDialog(null)}>
                Cancel
              </button>
              {dialog.mode === "delete" ? (
                <button
                  type="submit"
                  style={{
                    background: "var(--color-again)",
                    borderColor: "var(--color-again)",
                    color: "#ffffff"
                  }}
                >
                  Delete
                </button>
              ) : (
                <button type="submit" className="primary" disabled={!dialog.name.trim()}>
                  {dialog.mode === "create" ? "Create" : "Save"}
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
