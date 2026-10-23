// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { Image as ImageIcon, Search, Trash2, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { generateUniqueId } from "../core/ids";
import { sanitizeCardHtml } from "../core/sanitize";
import { getTodayDay, isCardDueInLearnQueue, normalizeReviewDueDay } from "../core/scheduler";
import { searchCards } from "../core/search";
import { Card, Collection, Note } from "../core/types";

interface Props {
    collection: Collection;
    initialNoteId?: number | null;
    onUpdateNote: (note: Note) => void;
    onUpdateCard: (card: Card) => void;
    onDeleteNote: (noteId: number) => void;
    onSaveMedia?: (filename: string, dataUrl: string) => void;
}

function formatCardState(card: Card): { label: string; color: string } {
    if (card.queue === -1) { return { label: "Suspended", color: "var(--text-muted)" }; }
    if (card.queue < -1) { return { label: "Buried", color: "var(--text-muted)" }; }
    if (card.queue === 0) { return { label: "New", color: "var(--color-new)" }; }
    if (card.queue === 1 || card.queue === 3) { return { label: "Learn", color: "var(--color-learn)" }; }
    if (card.queue === 2) {
        return {
            label: card.ivl > 0 ? `${card.ivl}d` : "Due",
            color: "var(--color-due)",
        };
    }
    return { label: "New", color: "var(--color-new)" };
}

function stripHtmlPreview(raw: string): string {
    return raw
        .replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, "[Image: $1] ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\{\{c\d+::([^}:]+)(?:::[^}]*)?\}\}/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

export const CardBrowser: React.FC<Props> = ({
    collection,
    initialNoteId,
    onUpdateNote,
    onUpdateCard,
    onDeleteNote,
    onSaveMedia,
}) => {
    const [searchQuery, setSearchQuery] = useState<string>("");
    const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
    const [confirmAction, setConfirmAction] = useState<"reset" | "delete" | null>(null);

    // Local debounced editor state to prevent per-keystroke persistence thrash (P02)
    const [draftFields, setDraftFields] = useState<string[]>([]);
    const [draftTags, setDraftTags] = useState<string>("");
    const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
    const debounceTimerRef = useRef<any>(null);
    const browserFileRef = useRef<HTMLInputElement | null>(null);
    const editingFieldIdxRef = useRef<number>(0);

    const searchResults = useMemo(
        () => searchCards(collection, searchQuery),
        [collection, searchQuery],
    );

    // Select card corresponding to `initialNoteId` when navigating from Reviewer Edit (U06)
    useEffect(() => {
        if (initialNoteId) {
            const match = Object.values(collection.cards).find(c => c.nid === initialNoteId);
            if (match) {
                setSearchQuery("");
                setSelectedCardId(match.id);
            }
        }
    }, [initialNoteId]);

    const selectedCardItem = useMemo(() => {
        if (selectedCardId) {
            const found = searchResults.find(r => r.card.id === selectedCardId);
            if (found) { return found; }
        }
        return searchResults[0] || null;
    }, [searchResults, selectedCardId]);

    // Synchronize local draft fields when selected note changes
    useEffect(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        if (selectedCardItem) {
            setDraftFields([...selectedCardItem.note.fields]);
            setDraftTags(selectedCardItem.note.tags.join(" "));
            setSaveState("saved");
        }
    }, [selectedCardItem?.note.id]);

    // Escape handler for confirmation modal (U08)
    useEffect(() => {
        if (!confirmAction) { return; }
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                setConfirmAction(null);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [confirmAction]);

    const commitNoteUpdate = (
        note: Note,
        nextFields: string[],
        nextTagsStr: string,
    ) => {
        const sanitizedFields = nextFields.map(f => sanitizeCardHtml(f));
        const tags = nextTagsStr.trim().split(/\s+/).filter(Boolean);
        const updatedNote: Note = {
            ...note,
            fields: sanitizedFields,
            sfld: sanitizedFields[0] || "",
            tags,
            mod: Math.floor(Date.now() / 1000),
        };
        onUpdateNote(updatedNote);
        setSaveState("saved");
    };

    const scheduleDebouncedNoteSave = (
        note: Note,
        nextFields: string[],
        nextTagsStr: string,
    ) => {
        setSaveState("saving");
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }
        debounceTimerRef.current = setTimeout(() => {
            commitNoteUpdate(note, nextFields, nextTagsStr);
            debounceTimerRef.current = null;
        }, 320);
    };

    const handleFieldChange = (fieldIdx: number, val: string) => {
        if (!selectedCardItem) { return; }
        const nextFields = [...draftFields];
        nextFields[fieldIdx] = val;
        setDraftFields(nextFields);
        scheduleDebouncedNoteSave(selectedCardItem.note, nextFields, draftTags);
    };

    const handleTagsChange = (val: string) => {
        if (!selectedCardItem) { return; }
        setDraftTags(val);
        scheduleDebouncedNoteSave(selectedCardItem.note, draftFields, val);
    };

    const handleBrowserImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !selectedCardItem) { return; }
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result as string;
            const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
            const filename = `paste_${generateUniqueId()}_${cleanName}`;
            if (onSaveMedia) {
                onSaveMedia(filename, dataUrl);
            } else {
                collection.media[filename] = dataUrl;
            }
            const idx = editingFieldIdxRef.current;
            const cur = draftFields[idx] || "";
            const imgTag = `<img src="${filename}">`;
            handleFieldChange(idx, cur ? `${cur}\n${imgTag}` : imgTag);
        };
        reader.readAsDataURL(file);
        e.target.value = "";
    };

    const handleToggleSuspend = () => {
        if (!selectedCardItem) { return; }
        const card = { ...selectedCardItem.card };
        if (card.queue === -1) {
            card.queue = card.type === 0 ? 0 : 2;
        } else {
            card.queue = -1;
        }
        card.mod = Math.floor(Date.now() / 1000);
        onUpdateCard(card);
    };

    const handleToggleBury = () => {
        if (!selectedCardItem) { return; }
        const card = { ...selectedCardItem.card };
        if (card.queue < -1) {
            card.queue = card.type === 0 ? 0 : 2;
        } else {
            card.queue = -2;
        }
        card.mod = Math.floor(Date.now() / 1000);
        onUpdateCard(card);
    };

    const executeResetCard = () => {
        if (!selectedCardItem) { return; }
        const card = {
            ...selectedCardItem.card,
            type: 0 as const,
            queue: 0 as const,
            due: 0,
            ivl: 0,
            factor: 2500,
            reps: 0,
            lapses: 0,
            left: 0,
            mod: Math.floor(Date.now() / 1000),
        };
        onUpdateCard(card);
        setConfirmAction(null);
    };

    const executeDeleteNote = () => {
        if (!selectedCardItem) { return; }
        onDeleteNote(selectedCardItem.note.id);
        setSelectedCardId(null);
        setConfirmAction(null);
    };

    const model = selectedCardItem ? collection.models[selectedCardItem.note.mid] : null;

    const { stateFilters, sortedDecks, deckCounts } = useMemo(() => {
        const allCards = Object.values(collection.cards);
        const nowSec = Math.floor(Date.now() / 1000);
        const today = getTodayDay();

        let dueCnt = 0;
        let newCnt = 0;
        let learnCnt = 0;
        let suspCnt = 0;
        const perDeck: Record<number, number> = {};

        for (const c of allCards) {
            perDeck[c.did] = (perDeck[c.did] || 0) + 1;
            if (c.queue === -1) {
                suspCnt++;
            } else if (c.queue === 0) {
                newCnt++;
            } else if (c.queue === 1 || c.queue === 3) {
                learnCnt++;
                if (isCardDueInLearnQueue(c, nowSec, today, collection.crt)) {
                    dueCnt++;
                }
            } else if (c.queue === 2) {
                if (normalizeReviewDueDay(c.due, collection.crt) <= today) {
                    dueCnt++;
                }
            }
        }

        return {
            stateFilters: [
                { label: "All Cards", query: "", count: allCards.length, color: "var(--text-primary)" },
                { label: "Due", query: "is:due", count: dueCnt, color: "var(--color-due)" },
                { label: "New", query: "is:new", count: newCnt, color: "var(--color-new)" },
                { label: "Learning", query: "is:learn", count: learnCnt, color: "var(--color-learn)" },
                { label: "Suspended", query: "is:suspended", count: suspCnt, color: "var(--text-secondary)" },
            ],
            sortedDecks: Object.values(collection.decks).sort((a, b) => a.name.localeCompare(b.name)),
            deckCounts: perDeck,
        };
    }, [collection.cards, collection.decks, collection.crt]);

    return (
        <div className="browser-root">
            <input
                type="file"
                ref={browserFileRef}
                accept="image/*"
                style={{ display: "none" }}
                onChange={handleBrowserImageUpload}
            />

            {/* Search Header */}
            <div className="browser-search-bar">
                <div className="browser-search-input-wrap">
                    <Search size={15} className="browser-search-icon" />
                    <input
                        type="text"
                        aria-label="Search cards"
                        placeholder="Search cards (e.g. deck:Default tag:anki is:due)..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="browser-search-input"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => setSearchQuery("")}
                            className="browser-search-clear"
                            aria-label="Clear search filter"
                            title="Clear filter"
                        >
                            <X size={14} />
                        </button>
                    )}
                    <span className="browser-search-count">
                        {searchResults.length} {searchResults.length === 1 ? "card" : "cards"}
                    </span>
                </div>
            </div>

            {/* Main split view: Sidebar + Right Pane (Table + Editor) */}
            <div className="browser-layout">
                {/* Quick Filter Sidebar */}
                <aside className="browser-sidebar" aria-label="Card filters">
                    <div className="browser-sidebar-group">
                        {stateFilters.map(item => {
                            const active = searchQuery.trim() === item.query;
                            return (
                                <button
                                    key={item.label}
                                    type="button"
                                    className={`browser-filter-btn ${active ? "active" : ""}`}
                                    onClick={() => setSearchQuery(item.query)}
                                >
                                    <span style={{ color: item.color }}>{item.label}</span>
                                    <span className="browser-filter-count">{item.count}</span>
                                </button>
                            );
                        })}
                    </div>

                    <div className="browser-sidebar-divider" />

                    <div className="browser-sidebar-group">
                        {sortedDecks.map(d => {
                            const deckQuery = d.name.includes(" ") ? `deck:"${d.name}"` : `deck:${d.name}`;
                            const active = searchQuery.trim() === deckQuery
                                || searchQuery.trim() === `deck:"${d.name}"`;
                            const deckCount = deckCounts[d.id] || 0;
                            return (
                                <button
                                    key={d.id}
                                    type="button"
                                    className={`browser-filter-btn ${active ? "active" : ""}`}
                                    onClick={() => setSearchQuery(deckQuery)}
                                    title={d.name}
                                >
                                    <span className="browser-filter-label">{d.name}</span>
                                    <span className="browser-filter-count">{deckCount}</span>
                                </button>
                            );
                        })}
                    </div>
                </aside>

                {/* Card Table & Detail Editor */}
                <div className="browser-main">
                    <div className="browser-table-container">
                        <table className="browser-table">
                            <thead>
                                <tr>
                                    <th style={{ width: "44%" }}>Sort Field</th>
                                    <th style={{ width: "18%" }}>Card</th>
                                    <th style={{ width: "16%" }}>Deck</th>
                                    <th style={{ width: "11%" }}>State</th>
                                    <th style={{ width: "11%", textAlign: "right" }}>Reps</th>
                                </tr>
                            </thead>
                            <tbody>
                                {searchResults.length === 0
                                    ? (
                                        <tr>
                                            <td colSpan={5} className="browser-empty-cell">
                                                No matching cards found.
                                            </td>
                                        </tr>
                                    )
                                    : (
                                        searchResults.map(({ card, note, deckName }) => {
                                            const isSelected = selectedCardItem?.card.id === card.id;
                                            const cardModel = collection.models[note.mid];
                                            const tmplName = cardModel?.tmpls?.[card.ord]?.name
                                                || `Card ${card.ord + 1}`;
                                            const stateInfo = formatCardState(card);
                                            const previewText = stripHtmlPreview(note.sfld || note.fields[0] || "");

                                            return (
                                                <tr
                                                    key={card.id}
                                                    className={isSelected ? "selected" : ""}
                                                    onClick={() => setSelectedCardId(card.id)}
                                                >
                                                    <td className="browser-cell-primary" title={previewText}>
                                                        {previewText || "(empty)"}
                                                    </td>
                                                    <td className="browser-cell-muted">{tmplName}</td>
                                                    <td className="browser-cell-muted">{deckName}</td>
                                                    <td>
                                                        <span
                                                            className="browser-state-pill"
                                                            style={{ color: stateInfo.color }}
                                                        >
                                                            {stateInfo.label}
                                                        </span>
                                                    </td>
                                                    <td
                                                        style={{
                                                            textAlign: "right",
                                                            fontVariantNumeric: "tabular-nums",
                                                        }}
                                                    >
                                                        {card.reps}
                                                        {card.lapses > 0
                                                            ? (
                                                                <span
                                                                    style={{
                                                                        color: "var(--color-again)",
                                                                        marginLeft: 4,
                                                                    }}
                                                                >
                                                                    ({card.lapses})
                                                                </span>
                                                            )
                                                            : null}
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                            </tbody>
                        </table>
                    </div>

                    {/* Card Editor Pane */}
                    {selectedCardItem && model && (
                        <div className="browser-editor-card">
                            <div className="browser-editor-header">
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span className="browser-model-badge">{model.name}</span>
                                    <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                                        {model.tmpls?.[selectedCardItem.card.ord]?.name
                                            || `Card ${selectedCardItem.card.ord + 1}`}
                                    </span>
                                    <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                                        {saveState === "saving" ? "Saving..." : "Saved"}
                                    </span>
                                </div>

                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                    <button
                                        type="button"
                                        onClick={handleToggleSuspend}
                                        style={{ padding: "4px 10px", fontSize: 12.5 }}
                                    >
                                        {selectedCardItem.card.queue === -1 ? "Unsuspend" : "Suspend"}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleToggleBury}
                                        style={{ padding: "4px 10px", fontSize: 12.5 }}
                                    >
                                        {selectedCardItem.card.queue < -1 ? "Unbury" : "Bury"}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setConfirmAction("reset")}
                                        style={{ padding: "4px 10px", fontSize: 12.5 }}
                                    >
                                        Reset
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setConfirmAction("delete")}
                                        aria-label="Delete Note"
                                        style={{ padding: "4px 8px", fontSize: 12.5, color: "var(--color-again)" }}
                                        title="Delete Note"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>

                            <div className="browser-editor-fields">
                                {model.flds.map((fld, idx) => (
                                    <div key={fld.name} className="browser-field-group">
                                        <div className="browser-field-label-row">
                                            <label>{fld.name}</label>
                                            <button
                                                type="button"
                                                className="browser-image-btn"
                                                onClick={() => {
                                                    editingFieldIdxRef.current = idx;
                                                    browserFileRef.current?.click();
                                                }}
                                                title="Insert Image"
                                            >
                                                <ImageIcon size={12} />
                                                <span>Image</span>
                                            </button>
                                        </div>
                                        <textarea
                                            rows={idx === 0 ? 2 : 3}
                                            value={draftFields[idx] ?? ""}
                                            onChange={e => handleFieldChange(idx, e.target.value)}
                                            onBlur={() => {
                                                if (debounceTimerRef.current) {
                                                    clearTimeout(debounceTimerRef.current);
                                                    debounceTimerRef.current = null;
                                                    commitNoteUpdate(selectedCardItem.note, draftFields, draftTags);
                                                }
                                            }}
                                            className="browser-field-textarea"
                                        />
                                    </div>
                                ))}

                                <div className="browser-field-group">
                                    <div className="browser-field-label-row">
                                        <label>Tags</label>
                                    </div>
                                    <input
                                        type="text"
                                        placeholder="space-separated tags"
                                        value={draftTags}
                                        onChange={e => handleTagsChange(e.target.value)}
                                        onBlur={() => {
                                            if (debounceTimerRef.current) {
                                                clearTimeout(debounceTimerRef.current);
                                                debounceTimerRef.current = null;
                                                commitNoteUpdate(selectedCardItem.note, draftFields, draftTags);
                                            }
                                        }}
                                    />
                                </div>
                            </div>

                            <div className="browser-editor-footer">
                                <span>Interval: {selectedCardItem.card.ivl}d</span>
                                <span>Ease: {Math.round(selectedCardItem.card.factor / 10)}%</span>
                                <span>Reviews: {selectedCardItem.card.reps}</span>
                                <span>Lapses: {selectedCardItem.card.lapses}</span>
                            </div>
                        </div>
                    )}

                    {confirmAction && selectedCardItem && (
                        <div
                            className="modal-backdrop"
                            onClick={() => setConfirmAction(null)}
                        >
                            <div
                                role="dialog"
                                aria-modal="true"
                                aria-labelledby="browser-confirm-title"
                                className="modal-content"
                                style={{ maxWidth: 380 }}
                                onClick={e => e.stopPropagation()}
                            >
                                <div className="modal-header">
                                    <h3 id="browser-confirm-title" style={{ fontSize: 16, fontWeight: 600 }}>
                                        {confirmAction === "reset" ? "Reset Card Progress" : "Delete Note"}
                                    </h3>
                                    <button
                                        type="button"
                                        aria-label="Close dialog"
                                        onClick={() => setConfirmAction(null)}
                                        style={{ border: "none", padding: 4, background: "transparent" }}
                                    >
                                        <X size={18} />
                                    </button>
                                </div>

                                <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                                    {confirmAction === "reset"
                                        ? "Reset this card's learning progress and interval back to New?"
                                        : "Delete this note and all of its associated cards?"}
                                </div>

                                <div className="modal-footer">
                                    <button type="button" onClick={() => setConfirmAction(null)}>
                                        Cancel
                                    </button>
                                    {confirmAction === "reset"
                                        ? (
                                            <button type="button" className="primary" onClick={executeResetCard}>
                                                Reset
                                            </button>
                                        )
                                        : (
                                            <button
                                                type="button"
                                                onClick={executeDeleteNote}
                                                style={{
                                                    background: "var(--color-again)",
                                                    borderColor: "var(--color-again)",
                                                    color: "#ffffff",
                                                }}
                                            >
                                                Delete
                                            </button>
                                        )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
