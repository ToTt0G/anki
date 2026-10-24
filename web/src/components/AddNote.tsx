// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { Image as ImageIcon, Plus } from "lucide-react";
import React, { useRef, useState } from "react";
import { findClozeNumbers, wrapInCloze } from "../core/cloze";
import { generateUniqueId } from "../core/ids";
import { createCardsForNote } from "../core/import-export";
import { inspectMediaBytes, MAX_SINGLE_MEDIA_BYTES, normalizeMediaFilename } from "../core/media-validation";
import { sanitizeCardHtml } from "../core/sanitize";
import { Card, Collection, Note } from "../core/types";

interface Props {
    collection: Collection;
    defaultDeckId?: number;
    onAddNote: (note: Note, cards: Card[]) => Promise<boolean>;
    onSaveMedia?: (
        filename: string,
        dataUrl: string,
    ) => Promise<{ ok: boolean; filename: string; error?: string }> | void;
}

function escapeAttr(val: string): string {
    return val
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function defaultAltFromFilename(filename: string): string {
    const base = filename.replace(/\.[a-z0-9]+$/i, "").replace(/^paste_\d+_/, "");
    return base.replace(/[_-]+/g, " ").trim() || "Flashcard image";
}

export const AddNote: React.FC<Props> = ({
    collection,
    defaultDeckId = 1,
    onAddNote,
    onSaveMedia,
}) => {
    const models = Object.values(collection.models);
    const decks = Object.values(collection.decks);

    const [selectedMid, setSelectedMid] = useState<number>(models[0]?.id || 1);
    const [selectedDid, setSelectedDid] = useState<number>(defaultDeckId);
    const [fieldValues, setFieldValues] = useState<Record<number, string>>({});
    const [tagsStr, setTagsStr] = useState<string>("");
    const [imageAltText, setImageAltText] = useState<string>("");
    const [addedStatus, setAddedStatus] = useState<boolean>(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const activeFieldIdxRef = useRef<number>(0);

    const activeModel = collection.models[selectedMid] || models[0];
    const fieldRefs = useRef<Record<number, HTMLTextAreaElement | null>>({});

    const handleFieldChange = (idx: number, val: string) => {
        if (idx === 0 && errorMsg) { setErrorMsg(null); }
        setFieldValues(prev => ({ ...prev, [idx]: val }));
    };

    const handleInsertCloze = (idx: number) => {
        const input = fieldRefs.current[idx];
        if (!input) { return; }

        const start = input.selectionStart || 0;
        const end = input.selectionEnd || 0;
        const currentVal = fieldValues[idx] || "";
        const selectedText = currentVal.substring(start, end) || "text";

        const existingNums = findClozeNumbers(currentVal);
        const nextClozeNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1;

        const wrapped = wrapInCloze(selectedText, nextClozeNum);
        const newVal = currentVal.substring(0, start) + wrapped + currentVal.substring(end);

        setFieldValues(prev => ({ ...prev, [idx]: newVal }));
    };

    const triggerImageUpload = (fieldIdx: number) => {
        activeFieldIdxRef.current = fieldIdx;
        fileInputRef.current?.click();
    };

    const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) { return; }

        // Capture the target once; subsequent field changes must not redirect an in-flight upload.
        const targetIdx = activeFieldIdxRef.current;
        const initialValue = fieldValues[targetIdx] || "";
        const fieldInput = fieldRefs.current[targetIdx];
        const insertionStart = fieldInput?.selectionStart ?? initialValue.length;
        const insertionEnd = fieldInput?.selectionEnd ?? initialValue.length;

        // UX-10, SEC-13, NEW-02, L-02, L-03, L-08
        setErrorMsg(null);
        if (file.size > MAX_SINGLE_MEDIA_BYTES) {
            setErrorMsg(
                `Image exceeds maximum allowed size (${Math.round(MAX_SINGLE_MEDIA_BYTES / 1024 / 1024)} MB).`,
            );
            return;
        }
        const safeBase = normalizeMediaFilename(file.name);
        if (!safeBase || !file.type.startsWith("image/")) {
            setErrorMsg("Unsupported image format. Please choose a PNG, JPEG, GIF, WebP, or AVIF image.");
            return;
        }

        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const inspected = inspectMediaBytes(bytes);
            if (!inspected.ok || !inspected.mime.startsWith("image/")) {
                setErrorMsg(inspected.ok ? "File is not a supported image." : inspected.error);
                return;
            }

            let binary = "";
            for (let i = 0; i < bytes.length; i += 0x8000) {
                binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
            }
            const dataUrl = `data:${inspected.mime};base64,${btoa(binary)}`;
            const rawFilename = `paste_${generateUniqueId()}_${safeBase}`;
            let canonicalFilename = normalizeMediaFilename(rawFilename) || rawFilename;

            if (onSaveMedia) {
                const res = await onSaveMedia(canonicalFilename, dataUrl);
                if (res && !res.ok) {
                    setErrorMsg(res.error || "Failed to persist image attachment.");
                    return;
                }
                if (res?.filename) {
                    canonicalFilename = res.filename;
                }
            } else {
                collection.media[canonicalFilename] = dataUrl;
            }

            const altDesc = imageAltText.trim() || defaultAltFromFilename(safeBase);
            const imgTag = `<img src="${escapeAttr(canonicalFilename)}" alt="${escapeAttr(altDesc)}">`;
            setFieldValues(prev => {
                const currentVal = prev[targetIdx] || "";
                // If typing continued during upload, append rather than replacing the newer draft.
                const newVal = currentVal !== initialValue
                    ? (currentVal ? `${currentVal}\n${imgTag}` : imgTag)
                    : currentVal.substring(0, insertionStart) + imgTag + currentVal.substring(insertionEnd);
                return { ...prev, [targetIdx]: newVal };
            });
        } catch {
            setErrorMsg("Could not read image file.");
        }
    };

    const handleAdd = async () => {
        if (!activeModel) { return; }

        const fields = activeModel.flds.map((_, idx) => sanitizeCardHtml(fieldValues[idx] || ""));
        const firstField = fields[0] || "";
        if (!firstField.trim()) {
            setErrorMsg(`${activeModel.flds[0]?.name || "First field"} is required.`);
            fieldRefs.current[0]?.focus();
            return;
        }
        setErrorMsg(null);

        const now = Math.floor(Date.now() / 1000);
        const noteId = generateUniqueId(collection.notes);
        const tags = tagsStr.trim().split(/\s+/).filter(Boolean);

        const note: Note = {
            id: noteId,
            guid: `web_${noteId}`,
            mid: activeModel.id,
            mod: now,
            usn: 0,
            tags,
            fields,
            sfld: firstField,
            csum: 0,
            flags: 0,
            data: "{}",
        };

        const allocatedCardIds = new Set<number>(Object.keys(collection.cards).map(Number));
        const nextDueRef = { value: allocatedCardIds.size + 1 };
        const cards = createCardsForNote(
            note,
            activeModel,
            selectedDid,
            allocatedCardIds,
            nextDueRef,
            now,
        );

        try {
            const saved = await onAddNote(note, cards);
            if (!saved) {
                setErrorMsg("Your note was not saved reliably. Keep the draft and retry when storage is available.");
                return;
            }
        } catch {
            setErrorMsg("Saving failed. Your draft has been preserved.");
            return;
        }

        const newFieldVals: Record<number, string> = {};
        activeModel.flds.forEach((fld, idx) => {
            if (fld.sticky) {
                newFieldVals[idx] = fieldValues[idx] || "";
            }
        });
        setFieldValues(newFieldVals);

        setAddedStatus(true);
        setTimeout(() => setAddedStatus(false), 2000);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            handleAdd();
        }
    };

    return (
        <div
            style={{ maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}
            onKeyDown={handleKeyDown}
        >
            <input
                type="file"
                ref={fileInputRef}
                accept="image/*"
                style={{ display: "none" }}
                onChange={handleImageFileChange}
            />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label htmlFor="add-note-type-select" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                        Type
                    </label>
                    <select
                        id="add-note-type-select"
                        value={selectedMid}
                        onChange={e => setSelectedMid(Number(e.target.value))}
                    >
                        {models.map(m => (
                            <option key={m.id} value={m.id}>
                                {m.name}
                            </option>
                        ))}
                    </select>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label htmlFor="add-note-deck-select" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                        Deck
                    </label>
                    <select
                        id="add-note-deck-select"
                        value={selectedDid}
                        onChange={e => setSelectedDid(Number(e.target.value))}
                    >
                        {decks.map(d => (
                            <option key={d.id} value={d.id}>
                                {d.name}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Note Fields */}
            {activeModel.flds.map((fld, idx) => {
                const fieldId = `add-note-field-${idx}`;
                return (
                    <div key={fld.name} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <label htmlFor={fieldId} style={{ fontSize: 13, fontWeight: 500 }}>
                                {fld.name}
                            </label>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                <button
                                    type="button"
                                    onClick={() => triggerImageUpload(idx)}
                                    style={{
                                        padding: "4px 10px",
                                        fontSize: 12.5,
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 4,
                                    }}
                                    title="Insert Image"
                                >
                                    <ImageIcon size={13} />
                                    <span>Image</span>
                                </button>
                                {activeModel.type === 1 && idx === 0 && (
                                    <button
                                        type="button"
                                        onClick={() => handleInsertCloze(idx)}
                                        style={{ padding: "4px 10px", fontSize: 12.5 }}
                                        title="Cloze deletion ([...])"
                                    >
                                        [...]
                                    </button>
                                )}
                            </div>
                        </div>
                        <textarea
                            id={fieldId}
                            ref={el => {
                                fieldRefs.current[idx] = el;
                            }}
                            rows={fld.name.toLowerCase().includes("back")
                                    || fld.name.toLowerCase().includes("text")
                                ? 4
                                : 2}
                            value={fieldValues[idx] || ""}
                            onChange={e => handleFieldChange(idx, e.target.value)}
                        />
                    </div>
                );
            })}

            {/* Tags & Image Alt Text (L-08) */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label htmlFor="add-note-tags-input" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                        Tags
                    </label>
                    <input
                        id="add-note-tags-input"
                        type="text"
                        value={tagsStr}
                        placeholder="tag1 tag2"
                        onChange={e => setTagsStr(e.target.value)}
                    />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label htmlFor="add-note-img-alt-input" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                        Image Alt Text (optional)
                    </label>
                    <input
                        id="add-note-img-alt-input"
                        type="text"
                        value={imageAltText}
                        placeholder="Description for inserted images"
                        onChange={e => setImageAltText(e.target.value)}
                    />
                </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, marginTop: 8 }}>
                {errorMsg && (
                    <span role="alert" style={{ fontSize: 13, color: "var(--color-again)" }}>
                        {errorMsg}
                    </span>
                )}
                {addedStatus && (
                    <span role="status" aria-live="polite" style={{ fontSize: 13, color: "var(--color-due)" }}>
                        Added
                    </span>
                )}
                <button type="button" className="primary" onClick={handleAdd} style={{ padding: "8px 24px" }}>
                    <Plus size={16} />
                    <span>Add</span>
                </button>
            </div>
        </div>
    );
};
