import React, { useState, useEffect, useRef } from "react";
import { Card, Collection, Deck, Rating, RevlogEntry } from "../core/types";
import { calculateScheduling, getDeckCounts, getNextStudyCard } from "../core/scheduler";
import { renderCardTemplate } from "../core/template";
import { generateUniqueId } from "../core/ids";
import { SandboxedCardFrame } from "./SandboxedCardFrame";
import { ArrowLeft, MoreHorizontal, X } from "lucide-react";

interface Props {
  collection: Collection;
  deck: Deck;
  onExitStudy: () => void;
  onAnswerCard: (cardId: number, nextState: any, revlog: RevlogEntry) => void;
  onEditNote: (noteId: number) => void;
  onSuspendCard: (cardId: number) => void;
  onBuryCard: (cardId: number) => void;
  onDeleteCard: (cardId: number) => void;
}

export const Reviewer: React.FC<Props> = ({
  collection,
  deck,
  onExitStudy,
  onAnswerCard,
  onEditNote,
  onSuspendCard,
  onBuryCard,
  onDeleteCard
}) => {
  const [currentCard, setCurrentCard] = useState<Card | null>(() =>
    getNextStudyCard(collection, deck.id)
  );
  const [isAnswerShown, setIsAnswerShown] = useState<boolean>(false);
  const [showMoreMenu, setShowMoreMenu] = useState<boolean>(false);
  const [confirmDeleteNote, setConfirmDeleteNote] = useState<boolean>(false);
  const cardStartTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    const next = getNextStudyCard(collection, deck.id);
    setCurrentCard(next);
    setIsAnswerShown(false);
    setConfirmDeleteNote(false);
    cardStartTimeRef.current = Date.now();
  }, [collection, deck.id]);

  const config = collection.dconf[deck.conf] || Object.values(collection.dconf)[0];
  const counts = getDeckCounts(collection, deck.id);

  const handleShowAnswer = () => {
    setIsAnswerShown(true);
  };

  const handleRate = (rating: Rating) => {
    if (!currentCard) return;

    const options = calculateScheduling(currentCard, config);
    const chosen = options.find(o => o.rating === rating);
    if (!chosen) return;

    const timeSpentMs = Math.max(500, Date.now() - cardStartTimeRef.current);
    const existingRevIds = new Set((collection.revlog || []).map(r => r.id));
    const revlog: RevlogEntry = {
      id: generateUniqueId(existingRevIds),
      cid: currentCard.id,
      usn: 0,
      ease: rating,
      ivl: chosen.nextState.ivl,
      lastIvl: currentCard.ivl,
      factor: chosen.nextState.factor,
      time: timeSpentMs,
      type: currentCard.type === 0 ? 0 : currentCard.type === 2 ? 1 : 2
    };

    onAnswerCard(currentCard.id, chosen.nextState, revlog);
  };

  // Scoped keyboard shortcuts that never hijack focused buttons/selects/inputs or modals (U03)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      if (confirmDeleteNote) {
        if (e.key === "Escape") {
          e.preventDefault();
          setConfirmDeleteNote(false);
        }
        return;
      }

      if (showMoreMenu) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowMoreMenu(false);
        }
        return;
      }

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName || "";
      if (
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag) ||
        target?.isContentEditable ||
        target?.closest("[role='dialog']")
      ) {
        return;
      }

      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!isAnswerShown) {
          handleShowAnswer();
        } else {
          handleRate(3);
        }
      } else if (isAnswerShown) {
        if (e.key === "1") {
          e.preventDefault();
          handleRate(1);
        } else if (e.key === "2") {
          e.preventDefault();
          handleRate(2);
        } else if (e.key === "3") {
          e.preventDefault();
          handleRate(3);
        } else if (e.key === "4") {
          e.preventDefault();
          handleRate(4);
        }
      } else if (e.key.toLowerCase() === "e" && currentCard) {
        e.preventDefault();
        onEditNote(currentCard.nid);
      } else if (e.key === "Escape") {
        onExitStudy();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isAnswerShown, currentCard, showMoreMenu, confirmDeleteNote]);

  if (!currentCard) {
    return (
      <div style={{ maxWidth: 500, margin: "40px auto", textAlign: "center" }}>
        <h3 style={{ fontSize: 18, marginBottom: 12 }}>Finished</h3>
        <p style={{ color: "var(--text-secondary)", marginBottom: 24, fontSize: 14 }}>
          You have finished this deck for now.
        </p>
        <button type="button" onClick={onExitStudy}>
          Decks
        </button>
      </div>
    );
  }

  const note = collection.notes[currentCard.nid];
  const model = note ? collection.models[note.mid] : null;

  if (!note || !model) {
    return <div>Card data missing</div>;
  }

  const rendered = renderCardTemplate(currentCard, note, model, collection.media);
  const schedulingOptions = calculateScheduling(currentCard, config);
  const tmpl = model.tmpls[currentCard.ord] || model.tmpls[0];
  const backIncludesFrontSide = Boolean(tmpl?.afmt?.includes("FrontSide"));

  const displayedHtml = !isAnswerShown
    ? rendered.frontHtml
    : backIncludesFrontSide
    ? rendered.backHtml
    : `${rendered.frontHtml}<hr id="answer" class="card-divider" />${rendered.backHtml}`;

  const siblingCardCount = Object.values(collection.cards).filter(
    c => c.nid === currentCard.nid
  ).length;

  return (
    <div className="reviewer-container">
      {/* Minimal Header */}
      <div className="reviewer-header">
        <button
          type="button"
          onClick={onExitStudy}
          aria-label="Back to Decks"
          style={{ padding: "5px 9px" }}
          title="Back to Decks"
        >
          <ArrowLeft size={16} />
        </button>

        <div className="reviewer-counts" aria-label="Remaining card counts">
          <span
            className={`count-new ${currentCard.queue === 0 ? "active-queue" : ""}`}
            title="New cards"
          >
            {counts.newCount}
          </span>
          <span
            className={`count-learn ${
              currentCard.queue === 1 || currentCard.queue === 3 ? "active-queue" : ""
            }`}
            title="Learning cards"
          >
            {counts.learnCount}
          </span>
          <span
            className={`count-due ${currentCard.queue === 2 ? "active-queue" : ""}`}
            title="Review cards due"
          >
            {counts.reviewCount}
          </span>
        </div>

        <div style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setShowMoreMenu(!showMoreMenu)}
            aria-label="More card actions"
            aria-expanded={showMoreMenu}
            style={{ padding: "5px 9px" }}
            title="Card actions"
          >
            <MoreHorizontal size={16} />
          </button>

          {showMoreMenu && (
            <>
              <div
                onClick={() => setShowMoreMenu(false)}
                style={{
                  position: "fixed",
                  inset: 0,
                  zIndex: 15
                }}
              />
              <div
                role="menu"
                style={{
                  position: "absolute",
                  right: 0,
                  top: 34,
                  background: "var(--bg-primary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: 6,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  zIndex: 20,
                  minWidth: 135,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column"
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  style={{ border: "none", justifyContent: "flex-start", borderRadius: 0 }}
                  onClick={() => {
                    setShowMoreMenu(false);
                    onEditNote(currentCard.nid);
                  }}
                >
                  Edit Note
                </button>
                <button
                  type="button"
                  role="menuitem"
                  style={{ border: "none", justifyContent: "flex-start", borderRadius: 0 }}
                  onClick={() => {
                    setShowMoreMenu(false);
                    onBuryCard(currentCard.id);
                  }}
                >
                  Bury Card
                </button>
                <button
                  type="button"
                  role="menuitem"
                  style={{ border: "none", justifyContent: "flex-start", borderRadius: 0 }}
                  onClick={() => {
                    setShowMoreMenu(false);
                    onSuspendCard(currentCard.id);
                  }}
                >
                  Suspend Card
                </button>
                <button
                  type="button"
                  role="menuitem"
                  style={{
                    border: "none",
                    justifyContent: "flex-start",
                    borderRadius: 0,
                    color: "var(--color-again)"
                  }}
                  onClick={() => {
                    setShowMoreMenu(false);
                    setConfirmDeleteNote(true);
                  }}
                >
                  Delete Note
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Sandboxed Card Body (S01, C12, U09) */}
      <div
        className="review-card-area"
        onClick={() => {
          if (!isAnswerShown) handleShowAnswer();
        }}
      >
        <SandboxedCardFrame
          html={displayedHtml}
          css={rendered.css}
          onCardClick={() => {
            if (!isAnswerShown) handleShowAnswer();
          }}
        />
      </div>

      {/* Footer Rating Controls */}
      <div className="reviewer-footer">
        {!isAnswerShown ? (
          <button
            type="button"
            className="primary btn-show-answer"
            onClick={handleShowAnswer}
          >
            Show Answer
          </button>
        ) : (
          <div className="rating-bar">
            {schedulingOptions.map(opt => {
              const btnClass =
                opt.rating === 1
                  ? "btn-again"
                  : opt.rating === 2
                  ? "btn-hard"
                  : opt.rating === 3
                  ? "btn-good"
                  : "btn-easy";

              return (
                <button
                  key={opt.rating}
                  type="button"
                  className={`btn-rating ${btnClass}`}
                  onClick={() => handleRate(opt.rating)}
                >
                  <span>{opt.label}</span>
                  <span>{opt.intervalText}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete Note Confirmation Dialog (U13, U08) */}
      {confirmDeleteNote && (
        <div
          className="modal-backdrop"
          onClick={() => setConfirmDeleteNote(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reviewer-delete-note-title"
            className="modal-content"
            style={{ maxWidth: 380 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="reviewer-delete-note-title" style={{ fontSize: 16, fontWeight: 600 }}>
                Delete Note
              </h3>
              <button
                type="button"
                aria-label="Close dialog"
                onClick={() => setConfirmDeleteNote(false)}
                style={{ border: "none", padding: 4, background: "transparent" }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              Delete this note and {siblingCardCount === 1 ? "its card" : `all ${siblingCardCount} of its cards`} permanently?
            </div>

            <div className="modal-footer">
              <button type="button" onClick={() => setConfirmDeleteNote(false)}>
                Cancel
              </button>
              <button
                type="button"
                style={{
                  background: "var(--color-again)",
                  borderColor: "var(--color-again)",
                  color: "#ffffff"
                }}
                onClick={() => {
                  setConfirmDeleteNote(false);
                  onDeleteCard(currentCard.id);
                }}
              >
                Delete Note
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
