// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { AlertCircle, CheckCircle, RotateCcw, UploadCloud, X } from "lucide-react";
import React, { useRef, useState } from "react";
import { importApkg, importCsv, ImportResult } from "../core/import-export";
import { SyncStatus } from "../core/sync-client";
import { Collection } from "../core/types";
import { useAccessibleModal } from "./useAccessibleModal";

interface Props {
    collection: Collection;
    syncStatus?: SyncStatus;
    pendingOutboxCount?: number;
    onImportComplete: (updatedCol: Collection) => Promise<boolean>;
    onRestoreBackup?: (options?: { discardPending?: boolean }) => Promise<boolean>;
    hasBackup?: boolean;
    onClose: () => void;
}

/**
 * Shallow per-map clone that avoids duplicating multi-megabyte media base64 strings in memory (U-04).
 */
function cloneCollectionForImport(col: Collection): Collection {
    return {
        ...col,
        decks: { ...(col.decks || {}) },
        dconf: { ...(col.dconf || {}) },
        models: { ...(col.models || {}) },
        notes: { ...(col.notes || {}) },
        cards: { ...(col.cards || {}) },
        revlog: [...(col.revlog || [])],
        media: { ...(col.media || {}) },
    };
}

export const ImportModal: React.FC<Props> = ({
    collection,
    syncStatus = "offline",
    pendingOutboxCount = 0,
    onImportComplete,
    onRestoreBackup,
    hasBackup,
    onClose,
}) => {
    const [isProcessing, setIsProcessing] = useState<boolean>(false);
    const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
    const [progressStage, setProgressStage] = useState<string>("Inspecting package...");
    const [preserveScheduling, setPreserveScheduling] = useState<boolean>(true);
    const [stagedCol, setStagedCol] = useState<Collection | null>(null);
    const [previewResult, setPreviewResult] = useState<ImportResult | null>(null);
    const [committedResult, setCommittedResult] = useState<ImportResult | null>(null);
    const [restoredSuccess, setRestoredSuccess] = useState<boolean>(false);
    const [confirmRestoreDiscard, setConfirmRestoreDiscard] = useState<boolean>(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    const handleClose = () => {
        abortControllerRef.current?.abort();
        onClose();
    };
    const dialogRef = useAccessibleModal<HTMLDivElement>(true, handleClose);

    const handleFile = async (file: File) => {
        abortControllerRef.current?.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsProcessing(true);
        setProgressStage("Inspecting package...");
        setErrorMsg(null);
        setPreviewResult(null);
        setWarningsAcknowledged(false);
        setCommittedResult(null);
        setStagedCol(null);
        setRestoredSuccess(false);

        try {
            const clonedCol = cloneCollectionForImport(collection);

            if (
                file.name.endsWith(".apkg")
                || file.name.endsWith(".colpkg")
                || file.name.endsWith(".zip")
            ) {
                const res = await importApkg(file, clonedCol, {
                    signal: controller.signal,
                    onProgress: stage => setProgressStage(stage),
                    overwriteScheduling: !preserveScheduling,
                });
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
            abortControllerRef.current = null;
        }
    };

    const handleConfirmImport = async () => {
        if (!stagedCol || !previewResult || isProcessing) { return; }
        setIsProcessing(true);
        setErrorMsg(null);
        try {
            const saved = await onImportComplete(stagedCol);
            if (!saved) {
                throw new Error("Import was not saved locally. Your preview is still available; try again.");
            }
            setCommittedResult(previewResult);
            setPreviewResult(null);
            setStagedCol(null);
        } catch (err: any) {
            setErrorMsg(err?.message || "Could not queue the import.");
        } finally {
            setIsProcessing(false);
        }
    };

    const handleRestore = async (discardPending: boolean = false) => {
        if (!onRestoreBackup) { return; }
        if (pendingOutboxCount > 0 && !discardPending) {
            setConfirmRestoreDiscard(true);
            return;
        }
        setIsProcessing(true);
        setErrorMsg(null);
        try {
            const ok = await onRestoreBackup({ discardPending });
            if (ok) {
                setRestoredSuccess(true);
                setCommittedResult(null);
                setConfirmRestoreDiscard(false);
            } else {
                setErrorMsg("No pre-import backup snapshot found.");
            }
        } catch (err: any) {
            setErrorMsg(err?.message || "Could not restore backup.");
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

    // Queue durability is not equivalent to the operation-specific cloud acknowledgement.
    const commitStatusHeading = syncStatus === "connected"
        ? "Saved locally · Check cloud sync in Settings"
        : "Saved locally · Waiting to sync";

    return (
        <div className="modal-backdrop" onClick={handleClose}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="import-modal-title"
                className="modal-content"
                style={{ maxWidth: 450 }}
                onClick={e => e.stopPropagation()}
            >
                <div className="modal-header">
                    <h3 id="import-modal-title" style={{ fontSize: 16, fontWeight: 600 }}>
                        Import
                    </h3>
                    <button
                        type="button"
                        aria-label="Close dialog"
                        onClick={handleClose}
                        style={{ border: "none", padding: 4, background: "transparent" }}
                    >
                        <X size={18} />
                    </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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

                    {/* H-02: Opt-in toggle for preserving vs resetting duplicate card scheduling */}
                    <label
                        htmlFor="import-preserve-scheduling"
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                            padding: "8px 12px",
                            borderRadius: 8,
                            background: "var(--bg-secondary)",
                            border: "1px solid var(--border-color)",
                            fontSize: 12.5,
                            color: "var(--text-secondary)",
                            cursor: "pointer",
                        }}
                    >
                        <span>Preserve existing study progress on duplicate cards</span>
                        <input
                            id="import-preserve-scheduling"
                            type="checkbox"
                            checked={preserveScheduling}
                            onChange={e => setPreserveScheduling(e.target.checked)}
                        />
                    </label>

                    <button
                        type="button"
                        onDragOver={e => e.preventDefault()}
                        onDrop={onDrop}
                        onClick={() => fileInputRef.current?.click()}
                        style={{
                            border: "2px dashed var(--border-color)",
                            borderRadius: 8,
                            padding: "28px 16px",
                            textAlign: "center",
                            cursor: "pointer",
                            background: "var(--bg-secondary)",
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 8,
                            width: "100%",
                        }}
                    >
                        <UploadCloud size={32} color="var(--text-secondary)" />
                        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                            Choose or drop .apkg or CSV/TSV file
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                            Previews decks, notes, cards, duplicates, and warnings before committing
                        </div>
                    </button>

                    {isProcessing && (
                        <div
                            role="status"
                            aria-live="polite"
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 8,
                                fontSize: 13.5,
                                color: "var(--color-new)",
                            }}
                        >
                            <span>{progressStage}</span>
                            {abortControllerRef.current && (
                                <button
                                    type="button"
                                    onClick={() => abortControllerRef.current?.abort()}
                                    style={{ fontSize: 12, padding: "4px 10px" }}
                                >
                                    Cancel
                                </button>
                            )}
                        </div>
                    )}

                    {errorMsg && (
                        <div
                            role="alert"
                            style={{ color: "var(--color-again)", fontSize: 13, textAlign: "center" }}
                        >
                            {errorMsg}
                        </div>
                    )}

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

                            {/* M-07: Surface partial import warnings clearly in the preview UI */}
                            {previewResult.warnings && previewResult.warnings.length > 0 && (
                                <div
                                    role="alert"
                                    style={{
                                        padding: "8px 10px",
                                        borderRadius: 6,
                                        background: "rgba(217, 119, 6, 0.1)",
                                        border: "1px solid rgba(217, 119, 6, 0.4)",
                                        fontSize: 12,
                                        color: "var(--text-primary)",
                                    }}
                                >
                                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                                        <AlertCircle size={13} color="var(--color-again)" />
                                        <span>{previewResult.warnings.length} import warning(s):</span>
                                    </div>
                                    <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                                        {previewResult.warnings.slice(0, 5).map((w, idx) => <li key={idx}>{w}</li>)}
                                    </ul>
                                </div>
                            )}

                            {previewResult.warnings && previewResult.warnings.length > 0 && (
                                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                                    <input
                                        type="checkbox"
                                        checked={warningsAcknowledged}
                                        onChange={e =>
                                            setWarningsAcknowledged(e.target.checked)}
                                    />
                                    I understand this import may omit unsupported media or review data.
                                </label>
                            )}
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
                                <button
                                    type="button"
                                    className="primary"
                                    onClick={handleConfirmImport}
                                    disabled={isProcessing
                                        || (Boolean(previewResult.warnings?.length) && !warningsAcknowledged)}
                                >
                                    Confirm Import
                                </button>
                            </div>
                        </div>
                    )}

                    {committedResult && (
                        <div
                            role="status"
                            aria-live="polite"
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
                                <span>{commitStatusHeading}</span>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.9 }}>
                                {committedResult.cardCount} cards ({committedResult.noteCount} notes,{" "}
                                {committedResult.deckCount} decks, {committedResult.revlogCount} reviews)
                            </div>
                        </div>
                    )}

                    {restoredSuccess && (
                        <div
                            role="status"
                            aria-live="polite"
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

                    {/* H-05: Confirmation when restoring a backup while pending outbox ops exist */}
                    {confirmRestoreDiscard && (
                        <div
                            role="alert"
                            style={{
                                padding: "10px 12px",
                                borderRadius: 8,
                                background: "rgba(217, 119, 6, 0.1)",
                                border: "1px solid rgba(217, 119, 6, 0.4)",
                                fontSize: 12.5,
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                            }}
                        >
                            <div style={{ color: "var(--color-again)", fontWeight: 500 }}>
                                You have {pendingOutboxCount} unsynced local{" "}
                                {pendingOutboxCount === 1 ? "change" : "changes"}. Restoring the pre-import backup will
                                discard those unsynced changes so they do not replay over the restored backup.
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                                <button type="button" onClick={() => setConfirmRestoreDiscard(false)}>
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="primary"
                                    onClick={() => void handleRestore(true)}
                                >
                                    Discard Unsynced & Restore
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div className="modal-footer" style={{ justifyContent: "space-between" }}>
                    {(hasBackup || committedResult) && onRestoreBackup
                        ? (
                            <button
                                type="button"
                                onClick={() => void handleRestore(false)}
                                disabled={isProcessing}
                                style={{ fontSize: 12.5 }}
                            >
                                <RotateCcw size={13} />
                                <span>Undo Last Import</span>
                            </button>
                        )
                        : <span />}
                    <button type="button" onClick={handleClose}>
                        {committedResult || restoredSuccess ? "Done" : "Cancel"}
                    </button>
                </div>
            </div>
        </div>
    );
};
