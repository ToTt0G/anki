// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { ArrowLeft, MoreHorizontal, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { generateReviewId } from "../core/ids";
import { calculateScheduling, getDeckCounts, getNextStudyCard } from "../core/scheduler";
import { renderCardTemplate } from "../core/template";
import { Card, Collection, Deck, Rating, RevlogEntry } from "../core/types";
import { SandboxedCardFrame } from "./SandboxedCardFrame";
import { useAccessibleModal } from "./useAccessibleModal";

interface Props {
    collection: Collection;
    deck: Deck;
    onExitStudy: () => void;
    onAnswerCard: (cardId: number, nextState: any, revlog: RevlogEntry) => void;
    onEditNote: (noteId: number) => void;
    onSuspendCard: (cardId: number) => void;
    onBuryCard: (cardId: number) => void;
    onDeleteCard: (cardId: number) => void;
    customCardIds?: number[];
}

/**
 * Determine whether the Reviewer UI should reset (`isAnswerShown = false`, `typedAnswer = ""`)
 * when `collection` updates (U-05). Unrelated sync acknowledgments or note text edits on the
 * same active card scheduling state must NOT reset the visible study card.
 */
export function shouldResetReviewCardState(
    prevCard: Card | null,
    nextCard: Card | null,
): boolean {
    if (!prevCard || !nextCard) {
        return prevCard !== nextCard;
    }
    if (prevCard.id !== nextCard.id) {
        return true;
    }
    if (
        prevCard.reps !== nextCard.reps
        || prevCard.queue !== nextCard.queue
        || prevCard.due !== nextCard.due
    ) {
        return true;
    }
    return false;
}

export const Reviewer: React.FC<Props> = ({
    collection,
    deck,
    onExitStudy,
    onAnswerCard,
    onEditNote,
    onSuspendCard,
    onBuryCard,
    onDeleteCard,
    customCardIds,
}) => {
    const [currentCard, setCurrentCard] = useState<Card | null>(() =>
        customCardIds && customCardIds.length
            ? collection.cards[customCardIds[0]] || null
            : getNextStudyCard(collection, deck.id)
    );
    const [isAnswerShown, setIsAnswerShown] = useState<boolean>(false);
    const [typedAnswer, setTypedAnswer] = useState<string>("");
    const [showMoreMenu, setShowMoreMenu] = useState<boolean>(false);
    const [confirmDeleteNote, setConfirmDeleteNote] = useState<boolean>(false);
    const cardStartTimeRef = useRef<number>(Date.now());
    const prevDeckIdRef = useRef<number>(deck.id);
    // UX-09: Synchronous lock preventing duplicate rating submissions before React re-renders
    const ratingLockRef = useRef<string | null>(null);
    const deleteDialogRef = useAccessibleModal<HTMLDivElement>(
        confirmDeleteNote,
        () => setConfirmDeleteNote(false),
    );

    const [customRemainingIds, setCustomRemainingIds] = useState<number[] | null>(
        customCardIds ? [...customCardIds] : null,
    );
    const answeredCustomIdsRef = useRef<Set<number>>(new Set());

    useEffect(() => {
        setCustomRemainingIds(customCardIds ? [...customCardIds] : null);
        answeredCustomIdsRef.current = new Set();
    }, [customCardIds]);

    const pickNextCard = (col: Collection): Card | null => {
        if (customRemainingIds) {
            for (const cid of customRemainingIds) {
                const card = col.cards[cid];
                if (card && card.queue >= 0 && !answeredCustomIdsRef.current.has(cid)) {
                    return card;
                }
            }
            return null;
        }
        return getNextStudyCard(col, deck.id);
    };

    // U-05: Keep review UI state stable across unrelated collection updates
    useEffect(() => {
        const deckChanged = prevDeckIdRef.current !== deck.id;
        prevDeckIdRef.current = deck.id;

        if (!deckChanged && currentCard) {
            const updatedActive = collection.cards[currentCard.id];
            const stillInCustomQueue = !customRemainingIds
                || (customRemainingIds.includes(currentCard.id)
                    && !answeredCustomIdsRef.current.has(currentCard.id));
            if (
                updatedActive
                && updatedActive.queue >= 0
                && stillInCustomQueue
                && !shouldResetReviewCardState(currentCard, updatedActive)
            ) {
                setCurrentCard(updatedActive);
                return;
            }
        }

        const next = pickNextCard(collection);
        if (!shouldResetReviewCardState(currentCard, next) && !deckChanged) {
            setCurrentCard(next);
            return;
        }
        setCurrentCard(next);
        setIsAnswerShown(false);
        setTypedAnswer("");
        setConfirmDeleteNote(false);
        ratingLockRef.current = null;
        cardStartTimeRef.current = Date.now();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [collection, deck.id, customRemainingIds]);

    const config = collection.dconf[deck.conf] || Object.values(collection.dconf)[0];
    const counts = getDeckCounts(collection, deck.id);

    const handleShowAnswer = () => {
        setIsAnswerShown(true);
    };

    const handleToggleAnswer = () => {
        setIsAnswerShown(prev => !prev);
    };

    const handleRate = (rating: Rating) => {
        if (!currentCard) { return; }
        const lockKey = `${currentCard.id}:${currentCard.reps}:${currentCard.due}`;
        if (ratingLockRef.current === lockKey) {
            return;
        }
        ratingLockRef.current = lockKey;

        if (customRemainingIds) {
            answeredCustomIdsRef.current.add(currentCard.id);
            setCustomRemainingIds(ids => ids?.filter(id => id !== currentCard.id) ?? null);
        }

        const options = calculateScheduling(currentCard, config);
        const chosen = options.find(o => o.rating === rating);
        if (!chosen) {
            ratingLockRef.current = null;
            return;
        }

        const timeSpentMs = Math.max(500, Date.now() - cardStartTimeRef.current);
        const existingRevIds = new Set((collection.revlog || []).map(r => r.id));
        const revlog: RevlogEntry = {
            id: generateReviewId(existingRevIds),
            cid: currentCard.id,
            usn: 0,
            ease: rating,
            ivl: chosen.nextState.ivl,
            lastIvl: currentCard.ivl,
            factor: chosen.nextState.factor,
            time: timeSpentMs,
            type: currentCard.type === 0 ? 0 : currentCard.type === 2 ? 1 : 2,
        };

        onAnswerCard(currentCard.id, chosen.nextState, revlog);
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.altKey || e.metaKey) { return; }

            if (confirmDeleteNote) {
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
                ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)
                || target?.isContentEditable
                || target?.closest("[role='dialog']")
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
                <h3 style={{ fontSize: 18, marginBottom: 12 }}>
                    {customRemainingIds !== null ? "Custom Study Session Complete" : "Finished"}
                </h3>
                <p style={{ color: "var(--text-secondary)", marginBottom: 24, fontSize: 14 }}>
                    {customRemainingIds !== null
                        ? "You reviewed all requested cards. Cards you did not answer keep their original schedule."
                        : "You have finished this deck for now."}
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

    const rendered = renderCardTemplate(currentCard, note, model, collection.media, typedAnswer);
    const schedulingOptions = calculateScheduling(currentCard, config);
    const tmpl = model.tmpls[currentCard.ord] || model.tmpls[0];
    const backIncludesFrontSide = Boolean(tmpl?.afmt?.includes("FrontSide"));

    const displayedHtml = !isAnswerShown
        ? rendered.frontHtml
        : backIncludesFrontSide
        ? rendered.backHtml
        : `${rendered.frontHtml}<hr id="answer" class="card-divider" />${rendered.backHtml}`;

    const siblingCardCount = Object.values(collection.cards).filter(
        c => c.nid === currentCard.nid,
    ).length;

    return (
        <div className="reviewer-container">
            <div className="reviewer-header">
                <button
                    type="button"
                    onClick={onExitStudy}
                    aria-label="Back to Decks"
                    style={{ padding: "6px 10px" }}
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
                        style={{ padding: "6px 10px" }}
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
                                    zIndex: 15,
                                }}
                            />
                            <div
                                role="menu"
                                style={{
                                    position: "absolute",
                                    right: 0,
                                    top: 36,
                                    background: "var(--bg-primary)",
                                    border: "1px solid var(--border-color)",
                                    borderRadius: 6,
                                    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                                    zIndex: 20,
                                    minWidth: 145,
                                    overflow: "hidden",
                                    display: "flex",
                                    flexDirection: "column",
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
                                        color: "var(--color-again)",
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

            <div
                className="review-card-area"
                onClick={handleToggleAnswer}
            >
                <SandboxedCardFrame
                    html={displayedHtml}
                    css={rendered.css}
                    typedValue={typedAnswer}
                    onCardClick={handleToggleAnswer}
                    onTypedAnswerChange={val => setTypedAnswer(val)}
                    onTypedAnswerSubmit={() => {
                        if (!isAnswerShown) { handleShowAnswer(); }
                    }}
                />
            </div>

            <div className="reviewer-footer">
                {!isAnswerShown
                    ? (
                        <button
                            type="button"
                            className="primary btn-show-answer"
                            onClick={handleShowAnswer}
                        >
                            Show Answer
                        </button>
                    )
                    : (
                        <div className="rating-bar">
                            {schedulingOptions.map(opt => {
                                const btnClass = opt.rating === 1
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

            {confirmDeleteNote && (
                <div
                    className="modal-backdrop"
                    onClick={() => setConfirmDeleteNote(false)}
                >
                    <div
                        ref={deleteDialogRef}
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
                            Delete this note and{" "}
                            {siblingCardCount === 1 ? "its card" : `all ${siblingCardCount} of its cards`} permanently?
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
                                    color: "#ffffff",
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
