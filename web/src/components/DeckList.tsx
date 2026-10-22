import React, { useState } from "react";
import { Collection, Deck } from "../core/types";
import { getDeckCounts } from "../core/scheduler";
import { Settings, FolderPlus, Download, Upload } from "lucide-react";

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

  const decks = Object.values(collection.decks).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const handleCreatePrompt = () => {
    const name = window.prompt("Deck name:");
    if (name && name.trim()) {
      onCreateDeck(name.trim());
    }
  };

  const handleRenamePrompt = (did: number, currentName: string) => {
    const name = window.prompt("New deck name:", currentName);
    if (name && name.trim() && name !== currentName) {
      onRenameDeck(did, name.trim());
    }
    setActiveMenu(null);
  };

  const handleDeleteConfirm = (did: number, name: string) => {
    if (window.confirm(`Delete deck '${name}' and its cards?`)) {
      onDeleteDeck(did);
    }
    setActiveMenu(null);
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
              onClick={() => handleRenamePrompt(activeDeck.id, activeDeck.name)}
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
                onClick={() => handleDeleteConfirm(activeDeck.id, activeDeck.name)}
              >
                Delete
              </button>
            )}
          </div>
        </>
      )}

      {/* Bottom action buttons */}
      <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 16, flexWrap: "wrap", width: "100%", boxSizing: "border-box" }}>
        <button onClick={handleCreatePrompt}>
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
    </div>
  );
};
