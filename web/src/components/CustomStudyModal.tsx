import React, { useState } from "react";
import { X } from "lucide-react";

interface Props {
  onApplyExtraLimit: (extraNew: number, extraReview: number) => void;
  onResetForgotten: () => void;
  onClose: () => void;
}

export const CustomStudyModal: React.FC<Props> = ({
  onApplyExtraLimit,
  onResetForgotten,
  onClose
}) => {
  const [extraNew, setExtraNew] = useState<number>(10);
  const [extraReview, setExtraReview] = useState<number>(50);
  const [mode, setMode] = useState<"limits" | "forgotten">("limits");

  const handleApply = () => {
    if (mode === "limits") {
      onApplyExtraLimit(extraNew, extraReview);
    } else {
      onResetForgotten();
    }
    onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-content" style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Custom Study</h3>
          <button onClick={onClose} style={{ border: "none", padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14 }}>
              <input
                type="radio"
                name="study_mode"
                checked={mode === "limits"}
                onChange={() => setMode("limits")}
              />
              <span>Increase today's limits</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14 }}>
              <input
                type="radio"
                name="study_mode"
                checked={mode === "forgotten"}
                onChange={() => setMode("forgotten")}
              />
              <span>Review forgotten cards</span>
            </label>
          </div>

          {mode === "limits" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
              <div>
                <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  Increase new card limit by:
                </label>
                <input
                  type="number"
                  value={extraNew}
                  onChange={e => setExtraNew(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  Increase review card limit by:
                </label>
                <input
                  type="number"
                  value={extraReview}
                  onChange={e => setExtraReview(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </div>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "8px 0" }}>
              Makes cards that were lapsed recently available for review right now.
            </p>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={handleApply}>OK</button>
        </div>
      </div>
    </div>
  );
};
