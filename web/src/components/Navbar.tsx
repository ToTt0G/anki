import React, { useState, useEffect } from "react";
import { SyncStatus } from "../core/sync-client";
import { Layers, PlusCircle, Search, BarChart2, RefreshCw, Download } from "lucide-react";
import { isStandalone, onInstallPromptChange, promptPwaInstall } from "../core/pwa";

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
  onInstallClick
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
      if (res) setStandalone(true);
    } else if (onInstallClick) {
      onInstallClick();
    }
  };

  const showInstall = !standalone;

  return (
    <>
      <header className="navbar">
        <div className="navbar-inner">
          <div className="nav-brand" onClick={() => onSelectView("decks")}>
            klanki
          </div>

          <nav className="nav-links">
            <div
              className={`nav-item ${currentView === "decks" ? "active" : ""}`}
              onClick={() => onSelectView("decks")}
            >
              <Layers size={17} />
              <span>Decks</span>
            </div>
            <div
              className={`nav-item ${currentView === "add" ? "active" : ""}`}
              onClick={() => onSelectView("add")}
            >
              <PlusCircle size={17} />
              <span>Add</span>
            </div>
            <div
              className={`nav-item ${currentView === "browse" ? "active" : ""}`}
              onClick={() => onSelectView("browse")}
            >
              <Search size={17} />
              <span>Browse</span>
            </div>
            <div
              className={`nav-item ${currentView === "stats" ? "active" : ""}`}
              onClick={() => onSelectView("stats")}
            >
              <BarChart2 size={17} />
              <span>Stats</span>
            </div>
          </nav>

          <div className="nav-right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {showInstall && (
              <button
                onClick={handleInstall}
                title="Install klanki as an application"
                style={{
                  padding: "4px 10px",
                  fontSize: "12px",
                  fontWeight: 500,
                  borderRadius: 6,
                  background: "rgba(2, 132, 199, 0.1)",
                  color: "var(--color-new)",
                  border: "1px solid rgba(2, 132, 199, 0.2)"
                }}
              >
                <Download size={13} />
                <span>Install App</span>
              </button>
            )}

            <button
              onClick={onSyncClick}
              title={`Settings & Sync (${syncStatus})`}
              style={{ padding: "4px 8px" }}
            >
              <RefreshCw
                size={15}
                className={syncStatus === "connecting" ? "spin" : ""}
              />
              <span className={`sync-status ${syncStatus}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile bottom navigation */}
      <nav className="mobile-bottom-nav">
        <div
          className={`nav-item ${currentView === "decks" ? "active" : ""}`}
          onClick={() => onSelectView("decks")}
        >
          <Layers size={20} />
          <span>Decks</span>
        </div>
        <div
          className={`nav-item ${currentView === "add" ? "active" : ""}`}
          onClick={() => onSelectView("add")}
        >
          <PlusCircle size={20} />
          <span>Add</span>
        </div>
        <div
          className={`nav-item ${currentView === "browse" ? "active" : ""}`}
          onClick={() => onSelectView("browse")}
        >
          <Search size={20} />
          <span>Browse</span>
        </div>
        <div
          className={`nav-item ${currentView === "stats" ? "active" : ""}`}
          onClick={() => onSelectView("stats")}
        >
          <BarChart2 size={20} />
          <span>Stats</span>
        </div>
      </nav>
    </>
  );
};
