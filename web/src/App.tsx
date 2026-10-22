import React, { useState, useEffect, useRef } from "react";
import { Collection, Deck, Note, Card, DeckConfig, RevlogEntry } from "./core/types";
import { SyncClient, SyncStatus } from "./core/sync-client";
import { exportDeckCsv, exportApkg } from "./core/import-export";
import { Navbar, NavView } from "./components/Navbar";
import { DeckList } from "./components/DeckList";
import { DeckOverview } from "./components/DeckOverview";
import { Reviewer } from "./components/Reviewer";
import { CardBrowser } from "./components/CardBrowser";
import { AddNote } from "./components/AddNote";
import { StatsView } from "./components/StatsView";
import { DeckOptionsModal } from "./components/DeckOptionsModal";
import { CustomStudyModal } from "./components/CustomStudyModal";
import { ImportModal } from "./components/ImportModal";
import { SyncModal } from "./components/SyncModal";

export const App: React.FC = () => {
  const [collection, setCollection] = useState<Collection | null>(null);
  const [currentView, setCurrentView] = useState<NavView>("decks");
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);
  const [isStudying, setIsStudying] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("offline");

  // Modals state
  const [optionsDeckId, setOptionsDeckId] = useState<number | null>(null);
  const [isCustomStudyOpen, setIsCustomStudyOpen] = useState<boolean>(false);
  const [isImportOpen, setIsImportOpen] = useState<boolean>(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState<boolean>(false);

  const syncClientRef = useRef<SyncClient | null>(null);

  useEffect(() => {
    const client = new SyncClient(
      col => setCollection(col),
      status => setSyncStatus(status)
    );
    syncClientRef.current = client;
    setCollection(client.getCollection());
    client.connect();
  }, []);

  if (!collection) {
    return <div style={{ padding: 40, textAlign: "center" }}>Loading...</div>;
  }

  const activeDeck = selectedDeckId ? collection.decks[selectedDeckId] || null : null;

  // Deck mutations
  const handleCreateDeck = (name: string) => {
    const id = Date.now();
    const newDeck: Deck = {
      id,
      name,
      desc: "",
      collapsed: false,
      conf: 1,
      dyn: 0,
      mod: Math.floor(Date.now() / 1000),
      usn: 0
    };
    syncClientRef.current?.upsertDeck(newDeck);
  };

  const handleRenameDeck = (did: number, newName: string) => {
    const d = collection.decks[did];
    if (!d) return;
    const updated = { ...d, name: newName, mod: Math.floor(Date.now() / 1000) };
    syncClientRef.current?.upsertDeck(updated);
  };

  const handleDeleteDeck = (did: number) => {
    syncClientRef.current?.deleteDeck(did);
    if (selectedDeckId === did) {
      setSelectedDeckId(null);
      setIsStudying(false);
    }
  };

  const handleExportDeckApkg = async (did?: number) => {
    try {
      const blob = await exportApkg(collection, did);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const deckName = did ? collection.decks[did]?.name?.replace(/::/g, "_") || "deck" : "collection";
      a.download = `${deckName}.apkg`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Export error:", e);
      alert("Failed to export .apkg");
    }
  };

  const handleExportDeckCsv = (did: number) => {
    const csv = exportDeckCsv(collection, did);
    const blob = new Blob([csv], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${collection.decks[did]?.name || "deck"}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Card reviews
  const handleAnswerCard = (cardId: number, nextState: any, revlog: RevlogEntry) => {
    syncClientRef.current?.answerCard(cardId, nextState, revlog);
  };

  const handleSuspendCard = (cardId: number) => {
    const card = collection.cards[cardId];
    if (!card) return;
    const updated = { ...card, queue: -1 as const, mod: Math.floor(Date.now() / 1000) };
    syncClientRef.current?.updateCard(updated);
  };

  const handleBuryCard = (cardId: number) => {
    const card = collection.cards[cardId];
    if (!card) return;
    const updated = { ...card, queue: -3 as const, mod: Math.floor(Date.now() / 1000) };
    syncClientRef.current?.updateCard(updated);
  };

  const handleDeleteCard = (cardId: number) => {
    const card = collection.cards[cardId];
    if (!card) return;
    syncClientRef.current?.deleteNote(card.nid);
  };

  // Note actions
  const handleAddNote = (note: Note, cards: Card[]) => {
    syncClientRef.current?.upsertNote(note, cards);
  };

  const handleUpdateNote = (note: Note) => {
    const cards = Object.values(collection.cards).filter(c => c.nid === note.id);
    syncClientRef.current?.upsertNote(note, cards);
  };

  const handleUpdateCard = (card: Card) => {
    syncClientRef.current?.updateCard(card);
  };

  const handleDeleteNote = (noteId: number) => {
    syncClientRef.current?.deleteNote(noteId);
  };

  const handleSaveDeckConfig = (config: DeckConfig) => {
    syncClientRef.current?.upsertDeckConfig(config);
  };

  // Custom study
  const handleApplyExtraLimit = (extraNew: number, extraRev: number) => {
    if (!activeDeck) return;
    const conf = collection.dconf[activeDeck.conf] || collection.dconf[1];
    if (!conf) return;
    const updated = {
      ...conf,
      new: { ...conf.new, perDay: conf.new.perDay + extraNew },
      rev: { ...conf.rev, perDay: conf.rev.perDay + extraRev }
    };
    syncClientRef.current?.upsertDeckConfig(updated);
  };

  const handleResetForgotten = () => {
    if (!activeDeck) return;
    for (const card of Object.values(collection.cards)) {
      if (card.did === activeDeck.id && card.lapses > 0) {
        const updated = { ...card, queue: 1 as const, due: Math.floor(Date.now() / 1000) };
        syncClientRef.current?.updateCard(updated);
      }
    }
  };

  return (
    <div className="app-container">
      <Navbar
        currentView={currentView}
        onSelectView={view => {
          setCurrentView(view);
          setIsStudying(false);
          setSelectedDeckId(null);
        }}
        syncStatus={syncStatus}
        onSyncClick={() => setIsSyncModalOpen(true)}
      />

      <main className="main-content">
        {currentView === "decks" && (
          <>
            {isStudying && activeDeck ? (
              <Reviewer
                collection={collection}
                deck={activeDeck}
                onExitStudy={() => setIsStudying(false)}
                onAnswerCard={handleAnswerCard}
                onEditNote={nid => {
                  setCurrentView("browse");
                }}
                onSuspendCard={handleSuspendCard}
                onBuryCard={handleBuryCard}
                onDeleteCard={handleDeleteCard}
              />
            ) : selectedDeckId && activeDeck ? (
              <DeckOverview
                collection={collection}
                deck={activeDeck}
                onBack={() => setSelectedDeckId(null)}
                onStartStudy={() => setIsStudying(true)}
                onOptions={() => setOptionsDeckId(activeDeck.id)}
                onCustomStudy={() => setIsCustomStudyOpen(true)}
              />
            ) : (
              <DeckList
                collection={collection}
                onSelectDeck={did => setSelectedDeckId(did)}
                onCreateDeck={handleCreateDeck}
                onRenameDeck={handleRenameDeck}
                onDeleteDeck={handleDeleteDeck}
                onOptionsDeck={did => setOptionsDeckId(did)}
                onExportDeckApkg={did => handleExportDeckApkg(did)}
                onExportDeckCsv={handleExportDeckCsv}
                onExportCollectionApkg={() => handleExportDeckApkg()}
                onImportClick={() => setIsImportOpen(true)}
              />
            )}
          </>
        )}

        {currentView === "add" && (
          <AddNote
            collection={collection}
            defaultDeckId={selectedDeckId || 1}
            onAddNote={handleAddNote}
            onSaveMedia={(filename, dataUrl) => syncClientRef.current?.saveMedia(filename, dataUrl)}
          />
        )}

        {currentView === "browse" && (
          <CardBrowser
            collection={collection}
            onUpdateNote={handleUpdateNote}
            onUpdateCard={handleUpdateCard}
            onDeleteNote={handleDeleteNote}
            onSaveMedia={(filename, dataUrl) => syncClientRef.current?.saveMedia(filename, dataUrl)}
          />
        )}

        {currentView === "stats" && <StatsView collection={collection} />}
      </main>

      {/* Modals */}
      {optionsDeckId !== null && (
        <DeckOptionsModal
          config={
            collection.dconf[collection.decks[optionsDeckId]?.conf] ||
            collection.dconf[1] ||
            Object.values(collection.dconf)[0]
          }
          onSave={handleSaveDeckConfig}
          onClose={() => setOptionsDeckId(null)}
        />
      )}

      {isCustomStudyOpen && (
        <CustomStudyModal
          onApplyExtraLimit={handleApplyExtraLimit}
          onResetForgotten={handleResetForgotten}
          onClose={() => setIsCustomStudyOpen(false)}
        />
      )}

      {isImportOpen && (
        <ImportModal
          collection={collection}
          onImportComplete={updated => {
            syncClientRef.current?.importCollection(updated);
          }}
          onClose={() => setIsImportOpen(false)}
        />
      )}

      {isSyncModalOpen && (
        <SyncModal
          syncStatus={syncStatus}
          onForceSync={() => syncClientRef.current?.connect()}
          onClose={() => setIsSyncModalOpen(false)}
        />
      )}
    </div>
  );
};
