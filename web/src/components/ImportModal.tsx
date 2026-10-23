// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { CheckCircle, RotateCcw, UploadCloud, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { importApkg, importCsv, ImportResult } from "../core/import-export";
import { Collection } from "../core/types";

interface Props {
    collection: Collection;
    onImportComplete: (updatedCol: Collection) => void;
    onRestoreBackup?: () => Promise<boolean>;
    hasBackup?: boolean;
    onClose: () => void;
}

export const ImportModal: React.FC<Props> = ({
    collection,
    onImportComplete,
    onRestoreBackup,
    hasBackup,
    onClose,
}) => {
    const [isProcessing, setIsProcessing] = useState<boolean>(false);
    const [stagedCol, setStagedCol] = useState<Collection | null>(null);
    const [previewResult, setPreviewResult] = useState<ImportResult | null>(null);
    const [committedResult, setCommittedResult] = useState<ImportResult | null>(null);
    const [restoredSuccess, setRestoredSuccess] = useState<boolean>(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

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

    const handleFile = async (file: File) => {
        setIsProcessing(true);
        setErrorMsg(null);
        setPreviewResult(null);
        setCommittedResult(null);
        setStagedCol(null);
        setRestoredSuccess(false);

        try {
            const clonedCol: Collection = JSON.parse(JSON.stringify(collection));

            if (
                file.name.endsWith(".apkg")
                || file.name.endsWith(".colpkg")
                || file.name.endsWith(".zip")
            ) {
                const res = await importApkg(file, clonedCol);
                setStagedCol(clonedCol);
                setPreviewResult(res);
            } else {
                const text = await file.text();
                const firstDeckId = Object.keys(clonedCol.decks)[0]
                    ? Number(Object.keys(clonedCol.decks)[0])
                    : 1;
                const firstModelId = Object.keys(clonedCol.models)[0]
                    ? Number(Object.keys(clonedCol.models)[0])
                    : 1;
                const res = importCsv(text, clonedCol, firstDeckId, firstModelId);
                setStagedCol(clonedCol);
                setPreviewResult(res);
            }
        } catch (err: any) {
            console.error("Import error:", err);
            setErrorMsg(err.message || "Failed to parse import file.");
        } finally {
            setIsProcessing(false);
        }
    };

    const handleConfirmImport = () => {
        if (!stagedCol || !previewResult) { return; }
        onImportComplete(stagedCol);
        setCommittedResult(previewResult);
        setPreviewResult(null);
        setStagedCol(null);
    };

    const handleRestore = async () => {
        if (!onRestoreBackup) { return; }
        setIsProcessing(true);
        setErrorMsg(null);
        try {
            const ok = await onRestoreBackup();
            if (ok) {
                setRestoredSuccess(true);
                setCommittedResult(null);
            } else {
                setErrorMsg("No pre-import backup snapshot found.");
            }
        } finally {
            setIsProcessing(false);
        }
    };

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFile(e.dataTransfer.files[0]);
        }
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="import-modal-title"
                className="modal-content"
                style={{ maxWidth: 440 }}
                onClick={e => e.stopPropagation()}
            >
                <div className="modal-header">
                    <h3 id="import-modal-title" style={{ fontSize: 16, fontWeight: 600 }}>
                        Import
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

                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <input
                        type="file"
                        ref={fileInputRef}
                        style={{ display: "none" }}
                        accept=".apkg,.colpkg,.csv,.tsv,.txt"
                        onChange={e => {
                            if (e.target.files && e.target.files[0]) {
                                handleFile(e.target.files[0]);
                            }
                        }}
                    />

                    <div
                        onDragOver={e => e.preventDefault()}
                        onDrop={onDrop}
                        onClick={() => fileInputRef.current?.click()}
                        style={{
                            border: "2px dashed var(--border-color)",
                            borderRadius: 8,
                            padding: "32px 16px",
                            textAlign: "center",
                            cursor: "pointer",
                            background: "var(--bg-secondary)",
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 8,
                        }}
                    >
                        <UploadCloud size={32} color="var(--text-secondary)" />
                        <div style={{ fontSize: 14, fontWeight: 500 }}>
                            Choose or drop .apkg or CSV/TSV file
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                            Previews decks, notes, cards, and duplicates before committing
                        </div>
                    </div>

                    {isProcessing && (
                        <div style={{ textAlign: "center", fontSize: 14, color: "var(--color-new)" }}>
                            Inspecting package...
                        </div>
                    )}

                    {errorMsg && (
                        <div style={{ color: "var(--color-again)", fontSize: 13, textAlign: "center" }}>
                            {errorMsg}
                        </div>
                    )}

                    {/* Import Preview Confirmation Step (U14) */}
                    {previewResult && (
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                                padding: "12px 14px",
                                background: "var(--bg-secondary)",
                                border: "1px solid var(--border-color)",
                                borderRadius: 8,
                                fontSize: 13,
                            }}
                        >
                            <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                                Ready to import
                            </div>
                            <div style={{ color: "var(--text-secondary)", lineHeight: 1.5 }}>
                                <div>
                                    New notes: <strong>{previewResult.noteCount}</strong> ({previewResult.cardCount}
                                    {" "}
                                    cards)
                                </div>
                                <div>
                                    Decks added: <strong>{previewResult.deckCount}</strong>
                                </div>
                                {previewResult.duplicateCount
                                    ? (
                                        <div>
                                            Existing notes merged by GUID:{" "}
                                            <strong>{previewResult.duplicateCount}</strong>
                                        </div>
                                    )
                                    : null}
                                {previewResult.mediaCount > 0 && (
                                    <div>
                                        Media files: <strong>{previewResult.mediaCount}</strong>
                                    </div>
                                )}
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setPreviewResult(null);
                                        setStagedCol(null);
                                    }}
                                >
                                    Discard
                                </button>
                                <button type="button" className="primary" onClick={handleConfirmImport}>
                                    Confirm Import
                                </button>
                            </div>
                        </div>
                    )}

                    {committedResult && (
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 6,
                                padding: "10px 14px",
                                background: "rgba(22, 163, 74, 0.1)",
                                borderRadius: 6,
                                color: "var(--color-due)",
                                fontSize: 13,
                            }}
                        >
                            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                                <CheckCircle size={18} />
                                <span>Import committed</span>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.9 }}>
                                {committedResult.cardCount} cards ({committedResult.noteCount} notes,{" "}
                                {committedResult.deckCount} decks, {committedResult.revlogCount} reviews)
                            </div>
                        </div>
                    )}

                    {restoredSuccess && (
                        <div
                            style={{
                                padding: "10px 14px",
                                background: "rgba(2, 132, 199, 0.1)",
                                borderRadius: 6,
                                color: "var(--color-new)",
                                fontSize: 13,
                                fontWeight: 500,
                            }}
                        >
                            Previous collection backup restored.
                        </div>
                    )}
                </div>

                <div className="modal-footer" style={{ justifyContent: "space-between" }}>
                    {(hasBackup || committedResult) && onRestoreBackup
                        ? (
                            <button
                                type="button"
                                onClick={handleRestore}
                                disabled={isProcessing}
                                style={{ fontSize: 12.5 }}
                            >
                                <RotateCcw size={13} />
                                <span>Undo Last Import</span>
                            </button>
                        )
                        : <span />}
                    <button type="button" onClick={onClose}>
                        {committedResult || restoredSuccess ? "Done" : "Cancel"}
                    </button>
                </div>
            </div>
        </div>
    );
};
