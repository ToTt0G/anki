import React, { useState } from "react";
import { SyncStatus } from "../core/sync-client";
import { X, RefreshCw, Smartphone, Laptop } from "lucide-react";

interface Props {
  syncStatus: SyncStatus;
  onForceSync: () => void;
  onClose: () => void;
}

export const SyncModal: React.FC<Props> = ({
  syncStatus,
  onForceSync,
  onClose
}) => {
  return (
    <div className="modal-backdrop">
      <div className="modal-content" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Sync</h3>
          <button onClick={onClose} style={{ border: "none", padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px",
              background: "var(--bg-secondary)",
              borderRadius: 8,
              border: "1px solid var(--border-color)"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className={`sync-status ${syncStatus}`} />
              <span style={{ fontSize: 14, fontWeight: 500, textTransform: "capitalize" }}>
                {syncStatus === "connected" ? "Real-time Connected" : syncStatus}
              </span>
            </div>
            <button onClick={onForceSync} style={{ padding: "4px 10px", fontSize: 13 }}>
              <RefreshCw size={13} />
              <span>Sync</span>
            </button>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 0", color: "var(--text-secondary)", fontSize: 13 }}>
            <Laptop size={20} />
            <span>↔</span>
            <Smartphone size={20} />
            <span>Real-time cross-device sync active without accounts</span>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};
