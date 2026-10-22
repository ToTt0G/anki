import React, { useState, useEffect, useRef } from "react";
import { Card, Collection, Deck, Rating, RevlogEntry } from "../core/types";
import { calculateScheduling, getDeckCounts, getNextStudyCard } from "../core/scheduler";
import { renderCardTemplate } from "../core/template";
import { ArrowLeft, MoreHorizontal } from "lucide-react";

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
  const cardStartTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    const next = getNextStudyCard(collection, deck.id);
    setCurrentCard(next);
    setIsAnswerShown(false);
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
    const revlog: RevlogEntry = {
      id: Date.now(),
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) {
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
        onEditNote(currentCard.nid);
      } else if (e.key === "Escape") {
        onExitStudy();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isAnswerShown, currentCard]);

  if (!currentCard) {
    return (
      <div style={{ maxWidth: 500, margin: "40px auto", textAlign: "center" }}>
        <h3 style={{ fontSize: 18, marginBottom: 12 }}>Finished</h3>
        <p style={{ color: "var(--text-secondary)", marginBottom: 24, fontSize: 14 }}>
          You have finished this deck for now.
        </p>
        <button onClick={onExitStudy}>Decks</button>
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

  return (
    <div className="reviewer-container">
      {/* Minimal Header */}
      <div className="reviewer-header">
        <button onClick={onExitStudy} style={{ padding: "5px 9px" }} title="Back to Decks">
          <ArrowLeft size={16} />
        </button>

        <div className="reviewer-counts">
          <span
            className={`count-new ${currentCard.queue === 0 ? "active-queue" : ""}`}
          >
            {counts.newCount}
          </span>
          <span
            className={`count-learn ${
              currentCard.queue === 1 || currentCard.queue === 3 ? "active-queue" : ""
            }`}
          >
            {counts.learnCount}
          </span>
          <span
            className={`count-due ${currentCard.queue === 2 ? "active-queue" : ""}`}
          >
            {counts.reviewCount}
          </span>
        </div>

        <div style={{ position: "relative" }}>
          <button
            onClick={() => setShowMoreMenu(!showMoreMenu)}
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
                style={{
                  position: "absolute",
                  right: 0,
                  top: 34,
                  background: "var(--bg-primary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: 6,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  zIndex: 20,
                  minWidth: 120,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column"
                }}
              >
                <button
                  style={{ border: "none", justifyContent: "flex-start", borderRadius: 0 }}
                  onClick={() => {
                    setShowMoreMenu(false);
                    onEditNote(currentCard.nid);
                  }}
                >
                  Edit
                </button>
                <button
                  style={{ border: "none", justifyContent: "flex-start", borderRadius: 0 }}
                  onClick={() => {
                    setShowMoreMenu(false);
                    onBuryCard(currentCard.id);
                  }}
                >
                  Bury
                </button>
                <button
                  style={{ border: "none", justifyContent: "flex-start", borderRadius: 0 }}
                  onClick={() => {
                    setShowMoreMenu(false);
                    onSuspendCard(currentCard.id);
                  }}
                >
                  Suspend
                </button>
                <button
                  style={{
                    border: "none",
                    justifyContent: "flex-start",
                    borderRadius: 0,
                    color: "var(--color-again)"
                  }}
                  onClick={() => {
                    setShowMoreMenu(false);
                    onDeleteCard(currentCard.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Card Body */}
      <div
        className="review-card-area"
        onClick={() => {
          if (!isAnswerShown) handleShowAnswer();
        }}
      >
        {!isAnswerShown ? (
          <div
            className="reviewer-card-content"
            dangerouslySetInnerHTML={{ __html: rendered.frontHtml }}
          />
        ) : backIncludesFrontSide ? (
          <div
            className="reviewer-card-content"
            dangerouslySetInnerHTML={{ __html: rendered.backHtml }}
          />
        ) : (
          <div className="reviewer-card-content">
            <div dangerouslySetInnerHTML={{ __html: rendered.frontHtml }} />
            <hr id="answer" className="card-divider" />
            <div dangerouslySetInnerHTML={{ __html: rendered.backHtml }} />
          </div>
        )}
      </div>

      {/* Footer Rating Controls */}
      <div className="reviewer-footer">
        {!isAnswerShown ? (
          <button
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
    </div>
  );
};
