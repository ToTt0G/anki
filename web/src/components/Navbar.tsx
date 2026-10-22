import React from "react";
import { SyncStatus } from "../core/sync-client";
import { Layers, PlusCircle, Search, BarChart2, RefreshCw } from "lucide-react";

export type NavView = "decks" | "add" | "browse" | "stats";

interface Props {
  currentView: NavView;
  onSelectView: (view: NavView) => void;
  syncStatus: SyncStatus;
  onSyncClick: () => void;
}

export const Navbar: React.FC<Props> = ({
  currentView,
  onSelectView,
  syncStatus,
  onSyncClick
}) => {
  return (
    <>
      <header className="navbar">
        <div className="navbar-inner">
          <div className="nav-brand" onClick={() => onSelectView("decks")}>
            Anki
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

          <div className="nav-right">
            <button
              onClick={onSyncClick}
              title={`Sync: ${syncStatus}`}
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
