import React, { useState, useEffect } from "react";
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleApply = () => {
    if (mode === "limits") {
      onApplyExtraLimit(Math.max(0, extraNew), Math.max(0, extraReview));
    } else {
      onResetForgotten();
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-study-title"
        className="modal-content"
        style={{ maxWidth: 440 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="custom-study-title" style={{ fontSize: 16, fontWeight: 600 }}>
            Custom Study
          </h3>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            style={{ border: "none", padding: 4, background: "transparent" }}
          >
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
              <span>Increase today's limits for this deck</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14 }}>
              <input
                type="radio"
                name="study_mode"
                checked={mode === "forgotten"}
                onChange={() => setMode("forgotten")}
              />
              <span>Review cards lapsed today</span>
            </label>
          </div>

          {mode === "limits" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
              <div>
                <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  Increase today's new card limit by:
                </label>
                <input
                  type="number"
                  min={0}
                  value={extraNew}
                  onChange={e => setExtraNew(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  Increase today's review card limit by:
                </label>
                <input
                  type="number"
                  min={0}
                  value={extraReview}
                  onChange={e => setExtraReview(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </div>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "8px 0" }}>
              Schedules cards that were forgotten today for an immediate review pass without resetting mature intervals.
            </p>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={handleApply}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
};
