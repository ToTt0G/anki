// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { UserButton } from "@clerk/react";
import { BarChart2, Download, Layers, PlusCircle, RefreshCw, Search } from "lucide-react";
import React, { useEffect, useState } from "react";
import { isStandalone, onInstallPromptChange, promptPwaInstall } from "../core/pwa";
import { SyncStatus } from "../core/sync-client";

export type NavView = "decks" | "add" | "browse" | "stats";

interface Props {
    currentView: NavView;
    onSelectView: (view: NavView) => void;
    syncStatus: SyncStatus;
    onSyncClick: () => void;
    onInstallClick?: () => void;
}

export const Navbar: React.FC<Props> = ({
    currentView,
    onSelectView,
    syncStatus,
    onSyncClick,
    onInstallClick,
}) => {
    const [standalone, setStandalone] = useState(true);
    const [canPrompt, setCanPrompt] = useState(false);

    useEffect(() => {
        const isApp = isStandalone();
        setStandalone(isApp);
        if (!isApp) {
            const unsub = onInstallPromptChange(available => {
                setCanPrompt(available);
            });
            return () => unsub();
        }
    }, []);

    const handleInstall = async () => {
        if (canPrompt) {
            const res = await promptPwaInstall();
            if (res) { setStandalone(true); }
        } else if (onInstallClick) {
            onInstallClick();
        }
    };

    const showInstall = !standalone;

    return (
        <>
            <header className="navbar">
                <div className="navbar-inner">
                    <button
                        type="button"
                        className="nav-brand"
                        onClick={() => onSelectView("decks")}
                        aria-label="klanki home"
                        style={{ border: "none", background: "transparent", padding: 0 }}
                    >
                        klanki
                    </button>

                    <nav className="nav-links" aria-label="Main navigation">
                        <button
                            type="button"
                            className={`nav-item ${currentView === "decks" ? "active" : ""}`}
                            aria-current={currentView === "decks" ? "page" : undefined}
                            onClick={() => onSelectView("decks")}
                        >
                            <Layers size={17} />
                            <span>Decks</span>
                        </button>
                        <button
                            type="button"
                            className={`nav-item ${currentView === "add" ? "active" : ""}`}
                            aria-current={currentView === "add" ? "page" : undefined}
                            onClick={() => onSelectView("add")}
                        >
                            <PlusCircle size={17} />
                            <span>Add</span>
                        </button>
                        <button
                            type="button"
                            className={`nav-item ${currentView === "browse" ? "active" : ""}`}
                            aria-current={currentView === "browse" ? "page" : undefined}
                            onClick={() => onSelectView("browse")}
                        >
                            <Search size={17} />
                            <span>Browse</span>
                        </button>
                        <button
                            type="button"
                            className={`nav-item ${currentView === "stats" ? "active" : ""}`}
                            aria-current={currentView === "stats" ? "page" : undefined}
                            onClick={() => onSelectView("stats")}
                        >
                            <BarChart2 size={17} />
                            <span>Stats</span>
                        </button>
                    </nav>

                    <div className="nav-right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {showInstall && (
                            <button
                                type="button"
                                onClick={handleInstall}
                                aria-label="Install klanki as an application"
                                title="Install klanki as an application"
                                style={{
                                    padding: "4px 10px",
                                    fontSize: "12px",
                                    fontWeight: 500,
                                    borderRadius: 6,
                                    background: "rgba(2, 132, 199, 0.1)",
                                    color: "var(--color-new)",
                                    border: "1px solid rgba(2, 132, 199, 0.2)",
                                }}
                            >
                                <Download size={13} />
                                <span>Install App</span>
                            </button>
                        )}

                        <button
                            type="button"
                            onClick={onSyncClick}
                            aria-label={`Settings and Sync (${syncStatus})`}
                            title={`Settings & Sync (${syncStatus})`}
                            style={{ padding: "4px 8px" }}
                        >
                            <RefreshCw
                                size={15}
                                className={syncStatus === "connecting" ? "spin" : ""}
                            />
                            <span className={`sync-status ${syncStatus}`} />
                        </button>

                        <UserButton />
                    </div>
                </div>
            </header>

            {/* Mobile bottom navigation */}
            <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
                <button
                    type="button"
                    className={`nav-item ${currentView === "decks" ? "active" : ""}`}
                    aria-current={currentView === "decks" ? "page" : undefined}
                    onClick={() => onSelectView("decks")}
                >
                    <Layers size={20} />
                    <span>Decks</span>
                </button>
                <button
                    type="button"
                    className={`nav-item ${currentView === "add" ? "active" : ""}`}
                    aria-current={currentView === "add" ? "page" : undefined}
                    onClick={() => onSelectView("add")}
                >
                    <PlusCircle size={20} />
                    <span>Add</span>
                </button>
                <button
                    type="button"
                    className={`nav-item ${currentView === "browse" ? "active" : ""}`}
                    aria-current={currentView === "browse" ? "page" : undefined}
                    onClick={() => onSelectView("browse")}
                >
                    <Search size={20} />
                    <span>Browse</span>
                </button>
                <button
                    type="button"
                    className={`nav-item ${currentView === "stats" ? "active" : ""}`}
                    aria-current={currentView === "stats" ? "page" : undefined}
                    onClick={() => onSelectView("stats")}
                >
                    <BarChart2 size={20} />
                    <span>Stats</span>
                </button>
            </nav>
        </>
    );
};
