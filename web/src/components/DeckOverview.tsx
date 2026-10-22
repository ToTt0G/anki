import React from "react";
import { Collection, Deck } from "../core/types";
import { getDeckCounts } from "../core/scheduler";
import { ArrowLeft, Play, Settings, Sliders } from "lucide-react";

interface Props {
  collection: Collection;
  deck: Deck;
  onBack: () => void;
  onStartStudy: () => void;
  onOptions: () => void;
  onCustomStudy: () => void;
}

export const DeckOverview: React.FC<Props> = ({
  collection,
  deck,
  onBack,
  onStartStudy,
  onOptions,
  onCustomStudy
}) => {
  const counts = getDeckCounts(collection, deck.id);
  const totalDue = counts.newCount + counts.learnCount + counts.reviewCount;

  return (
    <div style={{ maxWidth: 500, margin: "20px auto", display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ padding: "6px 10px" }}>
          <ArrowLeft size={16} />
        </button>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>{deck.name}</h2>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-around",
          padding: "20px",
          background: "var(--bg-secondary)",
          borderRadius: 8,
          border: "1px solid var(--border-color)"
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4 }}>New</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--color-new)" }}>
            {counts.newCount}
          </div>
        </div>

        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4 }}>Learning</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--color-learn)" }}>
            {counts.learnCount}
          </div>
        </div>

        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4 }}>To Review</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--color-due)" }}>
            {counts.reviewCount}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {totalDue > 0 ? (
          <button
            className="primary"
            onClick={onStartStudy}
            style={{ padding: "12px", fontSize: 16, fontWeight: 600 }}
          >
            <Play size={18} />
            <span>Study Now</span>
          </button>
        ) : (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              color: "var(--text-secondary)",
              fontSize: 15
            }}
          >
            Congratulations! You have finished this deck for now.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button onClick={onCustomStudy}>
            <Sliders size={15} />
            <span>Custom Study</span>
          </button>
          <button onClick={onOptions}>
            <Settings size={15} />
            <span>Options</span>
          </button>
        </div>
      </div>
    </div>
  );
};
