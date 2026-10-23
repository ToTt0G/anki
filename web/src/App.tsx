// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { AuthenticateWithRedirectCallback, Show, SignInButton, SignUpButton, useAuth, useClerk } from "@clerk/react";
import { Moon, Sun } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { AddNote } from "./components/AddNote";
import { CardBrowser } from "./components/CardBrowser";
import { CustomStudyModal } from "./components/CustomStudyModal";
import { CyborgDuckLoader } from "./components/CyborgDuckLoader";
import { DeckList } from "./components/DeckList";
import { DeckOptionsModal } from "./components/DeckOptionsModal";
import { DeckOverview } from "./components/DeckOverview";
import { ImportModal } from "./components/ImportModal";
import { InstallPrompt } from "./components/InstallPrompt";
import { LandingPage } from "./components/LandingPage";
import { Navbar, NavView } from "./components/Navbar";
import { Reviewer } from "./components/Reviewer";
import { StatsView } from "./components/StatsView";
import { SyncModal } from "./components/SyncModal";
import { clearUserOfflineData, getClearDataOnSignOutPreference, OutboxEntry } from "./core/idb-storage";
import { generateUniqueId } from "./core/ids";
import { exportApkg, exportDeckCsv, importEp1100Decks } from "./core/import-export";
import { syncPushSubscriptionForUser } from "./core/push-manager";
import { registerServiceWorker } from "./core/pwa";
import { getCustomStudyCardIds, getTodayDay } from "./core/scheduler";
import { SyncClient, SyncStatus } from "./core/sync-client";
import { setStoredTheme } from "./core/theme";
import { Card, Collection, Deck, DeckConfig, Note, RevlogEntry } from "./core/types";

interface UrlNavState {
    view: NavView;
    deckId: number | null;
    studying: boolean;
}

function readNavStateFromUrl(): UrlNavState {
    if (typeof window === "undefined") {
        return { view: "decks", deckId: null, studying: false };
    }
    const params = new URLSearchParams(window.location.search);
    const rawView = params.get("view");
    const view: NavView = rawView === "add" || rawView === "browse" || rawView === "stats" || rawView === "decks"
        ? rawView
        : "decks";
    const rawDeck = params.get("deck");
    const deckId = rawDeck && Number.isFinite(Number(rawDeck)) && Number(rawDeck) > 0
        ? Number(rawDeck)
        : null;
    const studying = params.get("study") === "1" && deckId !== null;
    return { view, deckId, studying };
}

function writeNavStateToUrl(next: UrlNavState, mode: "push" | "replace" = "push"): void {
    if (typeof window === "undefined") { return; }
    try {
        const url = new URL(window.location.href);
        if (next.view === "decks") {
            url.searchParams.delete("view");
        } else {
            url.searchParams.set("view", next.view);
        }
        if (next.view === "decks" && next.deckId !== null) {
            url.searchParams.set("deck", String(next.deckId));
        } else {
            url.searchParams.delete("deck");
        }
        if (next.view === "decks" && next.studying && next.deckId !== null) {
            url.searchParams.set("study", "1");
        } else {
            url.searchParams.delete("study");
        }
        if (url.toString() === window.location.href) { return; }
        if (mode === "push") {
            window.history.pushState(next, "", url.toString());
        } else {
            window.history.replaceState(next, "", url.toString());
        }
    } catch {
        // ignore
    }
}

export const App: React.FC = () => {
    const { isLoaded, isSignedIn, userId, getToken } = useAuth();
    const clerk = useClerk();
    const initialNav = readNavStateFromUrl();
    const [collection, setCollection] = useState<Collection | null>(null);
    const [currentView, setCurrentView] = useState<NavView>(initialNav.view);
    const [selectedDeckId, setSelectedDeckId] = useState<number | null>(initialNav.deckId);
    const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
    const [isStudying, setIsStudying] = useState<boolean>(initialNav.studying);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>("offline");
    const [syncBannerError, setSyncBannerError] = useState<string | null>(null);
    const [customStudySession, setCustomStudySession] = useState<
        {
            deckId: number;
            cardIds: number[];
        } | null
    >(null);
    const [conflictedOps, setConflictedOps] = useState<OutboxEntry[]>([]);

    // Modals state
    const [optionsDeckId, setOptionsDeckId] = useState<number | null>(null);
    const [isCustomStudyOpen, setIsCustomStudyOpen] = useState<boolean>(false);
    const [isImportOpen, setIsImportOpen] = useState<boolean>(false);
    const [isSyncModalOpen, setIsSyncModalOpen] = useState<boolean>(false);
    const [showManualInstallGuide, setShowManualInstallGuide] = useState<boolean>(false);

    const syncClientRef = useRef<SyncClient | null>(null);
    const previousUserIdRef = useRef<string | null>(null);
    const getTokenRef = useRef(getToken);
    getTokenRef.current = getToken;

    useEffect(() => {
        registerServiceWorker().catch(err => {
            console.warn("Service Worker initialization error:", err);
        });

        // UX-14: Synchronize view, selected deck, and study state with browser Back/Forward history
        const onPopState = (event: PopStateEvent) => {
            const state = (event.state as UrlNavState | null) || readNavStateFromUrl();
            setCurrentView(state.view);
            setSelectedDeckId(state.deckId);
            setIsStudying(state.studying);
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
        writeNavStateToUrl({ view, deckId: null, studying: false }, "push");
    };

    const handleSelectDeck = (did: number | null) => {
        setSelectedDeckId(did);
        setIsStudying(false);
        writeNavStateToUrl({ view: "decks", deckId: did, studying: false }, "push");
    };

    useEffect(() => {
        if (!isLoaded) { return; }

        if (!isSignedIn || !userId) {
            const prevUserId = previousUserIdRef.current;
            previousUserIdRef.current = null;
            if (syncClientRef.current) {
                syncClientRef.current.disconnect();
                syncClientRef.current = null;
            }
            // SEC-04: Remove previous user's local study data on sign-out when enabled (default: true)
            if (prevUserId && getClearDataOnSignOutPreference()) {
                clearUserOfflineData(prevUserId).catch(() => {});
            }
            setCollection(null);
            setSyncStatus("offline");
            setCustomStudySession(null);
            setSelectedDeckId(null);
            setIsStudying(false);
            syncPushSubscriptionForUser(null).catch(() => {});
            return;
        }

        // SEC-04: If switching directly between two accounts on a shared device,
        // always purge the previous account's offline storage.
        const prevUserId = previousUserIdRef.current;
        if (prevUserId && prevUserId !== userId) {
            clearUserOfflineData(prevUserId).catch(() => {});
        }
        previousUserIdRef.current = userId;

        const tokenGetter = () => getTokenRef.current();
        const client = new SyncClient(
            userId,
            tokenGetter,
            col => {
                if (syncClientRef.current !== client) { return; }
                setCollection(col);
                void client.getConflictedOps().then(ops => {
                    if (syncClientRef.current === client) { setConflictedOps(ops); }
                });
            },
            status => setSyncStatus(status),
            err => {
                setSyncBannerError(err);
                window.setTimeout(() => setSyncBannerError(null), 5000);
            },
        );
        syncClientRef.current = client;
        setCollection(client.getCollection());
        setCustomStudySession(null);
        setConflictedOps([]);
        client.connect();
        client.getConflictedOps().then(setConflictedOps);

        syncPushSubscriptionForUser(userId, tokenGetter).catch(() => {});

        return () => {
            client.disconnect();
            if (syncClientRef.current === client) {
                syncClientRef.current = null;
            }
        };
    }, [isLoaded, isSignedIn, userId]);

    useEffect(() => {
        if (!isLoaded || isSignedIn) { return; }
        const client = (clerk as any)?.client;
        const signInAttempt = client?.signIn;
        const signUpAttempt = client?.signUp;

        if (signInAttempt?.status === "complete" && signInAttempt?.createdSessionId) {
            clerk.setActive({ session: signInAttempt.createdSessionId }).catch(() => {});
        } else if (signUpAttempt?.status === "complete" && signUpAttempt?.createdSessionId) {
            clerk.setActive({ session: signUpAttempt.createdSessionId }).catch(() => {});
        }
    }, [isLoaded, isSignedIn, clerk]);

    const isOAuthCallbackRoute = typeof window !== "undefined"
        && (window.location.pathname.startsWith("/sso-callback")
            || window.location.hash.includes("sso-callback")
            || window.location.search.includes("__clerk_status")
            || window.location.search.includes("__clerk_created_session"));

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
                                    const isDark = current === "dark"
                                        || (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
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

                <footer
                    style={{ textAlign: "center", padding: "12px 16px 24px", fontSize: 12, color: "var(--text-muted)" }}
                >
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
    const pendingOutboxCount = syncClientRef.current?.getPendingOutboxCount() || 0;

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
            usn: 0,
        };
        syncClientRef.current?.upsertDeck(newDeck, true);
    };

    const handleRenameDeck = (did: number, newName: string) => {
        const d = collection.decks[did];
        if (!d) { return; }
        const updated = { ...d, name: newName, mod: Math.floor(Date.now() / 1000) };
        syncClientRef.current?.upsertDeck(updated);
    };

    const handleDeleteDeck = (did: number) => {
        syncClientRef.current?.deleteDeck(did);
        if (selectedDeckId === did) {
            setSelectedDeckId(null);
            setIsStudying(false);
            writeNavStateToUrl({ view: "decks", deckId: null, studying: false }, "replace");
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
        if (!card) { return; }
        const updated = { ...card, queue: -1 as const, mod: Math.floor(Date.now() / 1000) };
        syncClientRef.current?.updateCard(updated);
    };

    const handleBuryCard = (cardId: number) => {
        const card = collection.cards[cardId];
        if (!card) { return; }
        const updated = { ...card, queue: -3 as const, mod: Math.floor(Date.now() / 1000) };
        syncClientRef.current?.updateCard(updated);
    };

    const handleDeleteCard = (cardId: number) => {
        const card = collection.cards[cardId];
        if (!card) { return; }
        syncClientRef.current?.deleteNote(card.nid);
    };

    const handleAddNote = (note: Note, cards: Card[]) => {
        syncClientRef.current?.upsertNote(note, cards, true);
    };

    const handleUpdateNote = (note: Note) => {
        const cards = Object.values(collection.cards).filter(c => c.nid === note.id);
        syncClientRef.current?.upsertNote(note, cards, false);
    };

    const handleUpdateCard = (card: Card) => {
        syncClientRef.current?.updateCard(card);
    };

    const handleDeleteNote = (noteId: number) => {
        syncClientRef.current?.deleteNote(noteId);
    };

    // UX-05: Support isolating a deck config preset to a single deck when shared
    const handleSaveDeckConfig = (config: DeckConfig, createSeparateForDeckId?: number) => {
        if (createSeparateForDeckId !== undefined && collection.decks[createSeparateForDeckId]) {
            const targetDeck = collection.decks[createSeparateForDeckId];
            const newConfId = generateUniqueId(collection.dconf);
            const dedicatedConfig: DeckConfig = {
                ...config,
                id: newConfId,
                name: `${targetDeck.name} Preset`,
            };
            syncClientRef.current?.upsertDeckConfig(dedicatedConfig);
            syncClientRef.current?.upsertDeck({
                ...targetDeck,
                conf: newConfId,
                mod: Math.floor(Date.now() / 1000),
            });
            return;
        }
        syncClientRef.current?.upsertDeckConfig(config);
    };

    // Ephemeral per-day, per-deck Custom Study extra limit override (C09)
    const handleApplyExtraLimit = (extraNew: number, extraRev: number) => {
        if (!activeDeck) { return; }
        const today = getTodayDay();
        const prevCustom = activeDeck.customStudy && activeDeck.customStudy.day === today
            ? activeDeck.customStudy
            : { day: today, extraNew: 0, extraRev: 0 };

        const updatedDeck: Deck = {
            ...activeDeck,
            mod: Math.floor(Date.now() / 1000),
            customStudy: {
                day: today,
                extraNew: prevCustom.extraNew + Math.max(0, extraNew),
                extraRev: prevCustom.extraRev + Math.max(0, extraRev),
            },
        };
        syncClientRef.current?.upsertDeck(updatedDeck);
    };

    const handleResetForgotten = () => {
        if (!activeDeck) { return; }
        const cardIds = getCustomStudyCardIds(collection, activeDeck.id);
        if (cardIds.length === 0) {
            setSyncBannerError("No cards were forgotten in this deck today.");
            window.setTimeout(() => setSyncBannerError(null), 5000);
            return;
        }
        setSelectedDeckId(activeDeck.id);
        setCustomStudySession({ deckId: activeDeck.id, cardIds });
        setIsStudying(true);
        writeNavStateToUrl({ view: "decks", deckId: activeDeck.id, studying: true }, "push");
    };

    const handleStartStudy = () => {
        setCustomStudySession(null);
        setIsStudying(true);
        writeNavStateToUrl({ view: "decks", deckId: selectedDeckId, studying: true }, "push");
    };

    const optionsDeck = optionsDeckId !== null ? collection.decks[optionsDeckId] : undefined;
    const optionsConfig = optionsDeckId !== null
        ? (collection.dconf[optionsDeck?.conf ?? 1]
            || collection.dconf[1]
            || Object.values(collection.dconf)[0])
        : undefined;
    const sharedDeckCount = optionsConfig
        ? Object.values(collection.decks).filter(d => (d.conf || 1) === optionsConfig.id).length
        : 1;

    return (
        <div className="app-container">
            <Navbar
                currentView={currentView}
                onSelectView={handleSelectView}
                syncStatus={syncStatus}
                onSyncClick={async () => {
                    setIsSyncModalOpen(true);
                    setConflictedOps((await syncClientRef.current?.getConflictedOps()) || []);
                }}
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
                        fontSize: 13,
                    }}
                >
                    {syncBannerError}
                </div>
            )}

            <main className="main-content">
                {currentView === "decks" && (
                    <>
                        {isStudying && activeDeck
                            ? (
                                <Reviewer
                                    collection={collection}
                                    deck={activeDeck}
                                    onExitStudy={() => {
                                        setIsStudying(false);
                                        if (customStudySession) {
                                            setCustomStudySession(null);
                                        }
                                        writeNavStateToUrl(
                                            { view: "decks", deckId: activeDeck.id, studying: false },
                                            "push",
                                        );
                                    }}
                                    onAnswerCard={handleAnswerCard}
                                    onEditNote={nid => {
                                        setEditingNoteId(nid);
                                        setIsStudying(false);
                                        if (customStudySession) {
                                            setCustomStudySession(null);
                                        }
                                        handleSelectView("browse");
                                        setEditingNoteId(nid);
                                    }}
                                    onSuspendCard={handleSuspendCard}
                                    onBuryCard={handleBuryCard}
                                    onDeleteCard={handleDeleteCard}
                                    customCardIds={customStudySession && customStudySession.deckId === activeDeck.id
                                        ? customStudySession.cardIds
                                        : undefined}
                                />
                            )
                            : selectedDeckId && activeDeck
                            ? (
                                <DeckOverview
                                    collection={collection}
                                    deck={activeDeck}
                                    onBack={() => handleSelectDeck(null)}
                                    onStartStudy={handleStartStudy}
                                    onOptions={() => setOptionsDeckId(activeDeck.id)}
                                    onCustomStudy={() => setIsCustomStudyOpen(true)}
                                />
                            )
                            : (
                                <DeckList
                                    collection={collection}
                                    onSelectDeck={did => handleSelectDeck(did)}
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
                        syncStatus={syncStatus}
                        pendingOutboxCount={pendingOutboxCount}
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
            {optionsDeckId !== null && optionsConfig && (
                <DeckOptionsModal
                    config={optionsConfig}
                    deck={optionsDeck}
                    sharedDeckCount={sharedDeckCount}
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
                    syncStatus={syncStatus}
                    pendingOutboxCount={pendingOutboxCount}
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
                    pendingOutboxCount={pendingOutboxCount}
                    conflictedOps={conflictedOps}
                    onRetryConflict={async opId => {
                        await syncClientRef.current?.retryConflictedOp(opId, true);
                        setConflictedOps((await syncClientRef.current?.getConflictedOps()) || []);
                    }}
                    onDiscardConflict={async opId => {
                        await syncClientRef.current?.discardConflictedOp(opId);
                        setConflictedOps((await syncClientRef.current?.getConflictedOps()) || []);
                    }}
                    onForceSync={async () => {
                        syncClientRef.current?.syncNow();
                        setConflictedOps((await syncClientRef.current?.getConflictedOps()) || []);
                    }}
                    onClearOfflineData={async options => {
                        await syncClientRef.current?.clearOfflineStorage(options);
                    }}
                    onDeleteAccountData={async () => {
                        // DATA-04: Verify HTTP success before clearing local storage or reloading
                        const token = await getToken();
                        if (!token) {
                            throw new Error("Authentication required to delete cloud data.");
                        }
                        const res = await fetch("/api/account-data", {
                            method: "DELETE",
                            headers: { Authorization: `Bearer ${token}` },
                        });
                        if (!res.ok) {
                            const errBody = await res.json().catch(() => ({}));
                            const errMsg = errBody?.error
                                || `Server failed to delete cloud data (HTTP ${res.status}).`;
                            setSyncBannerError(errMsg);
                            throw new Error(errMsg);
                        }
                        await syncClientRef.current?.clearOfflineStorage({ forceDiscardPending: true });
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
