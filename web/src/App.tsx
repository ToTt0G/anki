import React, { useState, useEffect, useRef } from "react";
import {
  AuthenticateWithRedirectCallback,
  Show,
  SignInButton,
  SignUpButton,
  useAuth,
  useClerk
} from "@clerk/react";
import { Collection, Deck, Note, Card, DeckConfig, RevlogEntry } from "./core/types";
import { SyncClient, SyncStatus } from "./core/sync-client";
import { exportDeckCsv, exportApkg, importEp1100Decks } from "./core/import-export";
import { registerServiceWorker } from "./core/pwa";
import { syncPushSubscriptionForUser } from "./core/push-manager";
import { getLocalDayStartMs, getTodayDay } from "./core/scheduler";
import { generateUniqueId } from "./core/ids";
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
import { InstallPrompt } from "./components/InstallPrompt";
import { LandingPage } from "./components/LandingPage";
import { CyborgDuckLoader } from "./components/CyborgDuckLoader";
import { setStoredTheme } from "./core/theme";
import { Sun, Moon } from "lucide-react";

function readViewFromUrl(): NavView {
  if (typeof window === "undefined") return "decks";
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "add" || view === "browse" || view === "stats" || view === "decks") {
    return view;
  }
  return "decks";
}

export const App: React.FC = () => {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const clerk = useClerk();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [currentView, setCurrentView] = useState<NavView>(() => readViewFromUrl());
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [isStudying, setIsStudying] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("offline");
  const [syncBannerError, setSyncBannerError] = useState<string | null>(null);

  // Modals state
  const [optionsDeckId, setOptionsDeckId] = useState<number | null>(null);
  const [isCustomStudyOpen, setIsCustomStudyOpen] = useState<boolean>(false);
  const [isImportOpen, setIsImportOpen] = useState<boolean>(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState<boolean>(false);
  const [showManualInstallGuide, setShowManualInstallGuide] = useState<boolean>(false);

  const syncClientRef = useRef<SyncClient | null>(null);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    registerServiceWorker().catch(err => {
      console.warn("Service Worker initialization error:", err);
    });

    // Synchronize view state with URL query string for PWA shortcuts & browser back/forward (U04)
    const onPopState = () => {
      setCurrentView(readViewFromUrl());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const handleSelectView = (view: NavView) => {
    setCurrentView(view);
    setIsStudying(false);
    setSelectedDeckId(null);
    if (view !== "browse") {
      setEditingNoteId(null);
    }
    try {
      const url = new URL(window.location.href);
      if (view === "decks") {
        url.searchParams.delete("view");
      } else {
        url.searchParams.set("view", view);
      }
      window.history.replaceState({}, "", url.toString());
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!isLoaded) return;

    if (!isSignedIn || !userId) {
      if (syncClientRef.current) {
        syncClientRef.current.disconnect();
        syncClientRef.current = null;
      }
      setCollection(null);
      setSyncStatus("offline");
      setSelectedDeckId(null);
      setIsStudying(false);
      syncPushSubscriptionForUser(null).catch(() => {});
      return;
    }

    const tokenGetter = () => getTokenRef.current();
    const client = new SyncClient(
      userId,
      tokenGetter,
      col => setCollection(col),
      status => setSyncStatus(status),
      err => {
        setSyncBannerError(err);
        window.setTimeout(() => setSyncBannerError(null), 5000);
      }
    );
    syncClientRef.current = client;
    setCollection(client.getCollection());
    client.connect();

    syncPushSubscriptionForUser(userId, tokenGetter).catch(() => {});

    return () => {
      client.disconnect();
      if (syncClientRef.current === client) {
        syncClientRef.current = null;
      }
    };
  }, [isLoaded, isSignedIn, userId]);

  useEffect(() => {
    if (!isLoaded || isSignedIn) return;
    const client = (clerk as any)?.client;
    const signInAttempt = client?.signIn;
    const signUpAttempt = client?.signUp;

    if (signInAttempt?.status === "complete" && signInAttempt?.createdSessionId) {
      clerk.setActive({ session: signInAttempt.createdSessionId }).catch(() => {});
    } else if (signUpAttempt?.status === "complete" && signUpAttempt?.createdSessionId) {
      clerk.setActive({ session: signUpAttempt.createdSessionId }).catch(() => {});
    }
  }, [isLoaded, isSignedIn, clerk]);

  const isOAuthCallbackRoute =
    typeof window !== "undefined" &&
    (window.location.pathname.startsWith("/sso-callback") ||
      window.location.hash.includes("sso-callback") ||
      window.location.search.includes("__clerk_status") ||
      window.location.search.includes("__clerk_created_session"));

  if (isOAuthCallbackRoute && !isSignedIn) {
    return (
      <CyborgDuckLoader>
        <AuthenticateWithRedirectCallback
          signInForceRedirectUrl="/"
          signUpForceRedirectUrl="/"
          continueSignUpUrl="/"
        />
      </CyborgDuckLoader>
    );
  }

  if (!isLoaded) {
    return <CyborgDuckLoader />;
  }

  if (!isSignedIn || !userId) {
    return (
      <div className="app-container">
        <header className="navbar">
          <div className="navbar-inner">
            <div className="nav-brand">klanki</div>
            <div className="nav-right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                aria-label="Toggle theme"
                onClick={() => {
                  const current = document.documentElement.getAttribute("data-theme");
                  const isDark =
                    current === "dark" ||
                    (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
                  setStoredTheme(isDark ? "light" : "dark");
                }}
                style={{ padding: "5px 8px" }}
                title="Toggle theme"
              >
                <Sun size={14} />
                <Moon size={14} />
              </button>
              <Show when="signed-out">
                <SignInButton mode="modal">
                  <button type="button">Sign In</button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <button type="button" className="primary">
                    Sign Up
                  </button>
                </SignUpButton>
              </Show>
            </div>
          </div>
        </header>

        <main className="main-content landing-main">
          <LandingPage />
        </main>

        <footer style={{ textAlign: "center", padding: "12px 16px 24px", fontSize: 12, color: "var(--text-muted)" }}>
          <a
            href="https://github.com/ToTt0G/anki"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--text-muted)", textDecoration: "none" }}
          >
            Open Source (AGPL-3.0) · Source Code
          </a>
        </footer>

        <InstallPrompt
          externalOpenGuide={showManualInstallGuide}
          onCloseExternalGuide={() => setShowManualInstallGuide(false)}
        />
      </div>
    );
  }

  if (!collection) {
    return <CyborgDuckLoader />;
  }

  const activeDeck = selectedDeckId ? collection.decks[selectedDeckId] || null : null;

  // Deck mutations using collision-resistant IDs (D06)
  const handleCreateDeck = (name: string) => {
    const id = generateUniqueId(collection.decks);
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
    } catch (e: any) {
      console.error("Export error:", e);
      setSyncBannerError(e?.message || "Failed to export .apkg");
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

  // Ephemeral per-day, per-deck Custom Study extra limit override (C09)
  const handleApplyExtraLimit = (extraNew: number, extraRev: number) => {
    if (!activeDeck) return;
    const today = getTodayDay();
    const prevCustom =
      activeDeck.customStudy && activeDeck.customStudy.day === today
        ? activeDeck.customStudy
        : { day: today, extraNew: 0, extraRev: 0 };

    const updatedDeck: Deck = {
      ...activeDeck,
      mod: Math.floor(Date.now() / 1000),
      customStudy: {
        day: today,
        extraNew: prevCustom.extraNew + Math.max(0, extraNew),
        extraRev: prevCustom.extraRev + Math.max(0, extraRev)
      }
    };
    syncClientRef.current?.upsertDeck(updatedDeck);
  };

  // Non-destructive review of cards lapsed today (C10)
  const handleResetForgotten = () => {
    if (!activeDeck) return;
    const startOfTodayMs = getLocalDayStartMs();
    const lapsedTodayCardIds = new Set<number>();
    for (const r of collection.revlog || []) {
      if (r.id >= startOfTodayMs && r.ease === 1) {
        lapsedTodayCardIds.add(r.cid);
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    for (const card of Object.values(collection.cards)) {
      if (
        card.did === activeDeck.id &&
        card.lapses > 0 &&
        (lapsedTodayCardIds.has(card.id) || card.queue === 1)
      ) {
        const updated: Card = {
          ...card,
          odue: card.odue || card.due,
          odid: card.odid || card.did,
          queue: 1,
          due: nowSec,
          mod: nowSec
        };
        syncClientRef.current?.updateCard(updated);
      }
    }
  };

  return (
    <div className="app-container">
      <Navbar
        currentView={currentView}
        onSelectView={handleSelectView}
        syncStatus={syncStatus}
        onSyncClick={() => setIsSyncModalOpen(true)}
        onInstallClick={() => setShowManualInstallGuide(true)}
      />

      {syncBannerError && (
        <div
          role="alert"
          style={{
            maxWidth: 900,
            margin: "8px auto 0",
            padding: "8px 14px",
            borderRadius: 6,
            background: "rgba(220, 38, 38, 0.1)",
            border: "1px solid var(--color-again)",
            color: "var(--color-again)",
            fontSize: 13
          }}
        >
          {syncBannerError}
        </div>
      )}

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
                  setEditingNoteId(nid);
                  setIsStudying(false);
                  handleSelectView("browse");
                  setEditingNoteId(nid);
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
                onImportEp1100={async () => {
                  const updated = await importEp1100Decks(collection);
                  syncClientRef.current?.importCollection(updated);
                }}
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
            initialNoteId={editingNoteId}
            onUpdateNote={handleUpdateNote}
            onUpdateCard={handleUpdateCard}
            onDeleteNote={handleDeleteNote}
            onSaveMedia={(filename, dataUrl) => syncClientRef.current?.saveMedia(filename, dataUrl)}
          />
        )}

        {currentView === "stats" && <StatsView collection={collection} />}
      </main>

      <InstallPrompt
        externalOpenGuide={showManualInstallGuide}
        onCloseExternalGuide={() => setShowManualInstallGuide(false)}
      />

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
          hasBackup={syncClientRef.current?.getHasServerBackup()}
          onImportComplete={updated => {
            syncClientRef.current?.importCollection(updated);
          }}
          onRestoreBackup={async () => {
            return (await syncClientRef.current?.restoreServerBackup()) || false;
          }}
          onClose={() => setIsImportOpen(false)}
        />
      )}

      {isSyncModalOpen && (
        <SyncModal
          syncStatus={syncStatus}
          pendingOutboxCount={syncClientRef.current?.getPendingOutboxCount() || 0}
          onForceSync={() => {
            syncClientRef.current?.syncNow();
          }}
          onClearOfflineData={async () => {
            await syncClientRef.current?.clearOfflineStorage();
          }}
          onDeleteAccountData={async () => {
            const token = await getToken();
            if (token) {
              await fetch("/api/account-data", {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` }
              });
            }
            await syncClientRef.current?.clearOfflineStorage();
            window.location.reload();
          }}
          onClose={() => setIsSyncModalOpen(false)}
          onShowInstallGuide={() => {
            setIsSyncModalOpen(false);
            setShowManualInstallGuide(true);
          }}
        />
      )}
    </div>
  );
};
