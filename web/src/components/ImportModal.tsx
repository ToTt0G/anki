import React, { useState, useRef } from "react";
import { Collection } from "../core/types";
import { importApkg, importCsv, ImportResult } from "../core/import-export";
import { X, UploadCloud, CheckCircle } from "lucide-react";

interface Props {
  collection: Collection;
  onImportComplete: (updatedCol: Collection) => void;
  onClose: () => void;
}

export const ImportModal: React.FC<Props> = ({
  collection,
  onImportComplete,
  onClose
}) => {
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFile = async (file: File) => {
    setIsProcessing(true);
    setErrorMsg(null);
    setResult(null);

    try {
      const clonedCol: Collection = JSON.parse(JSON.stringify(collection));

      if (file.name.endsWith(".apkg") || file.name.endsWith(".colpkg") || file.name.endsWith(".zip")) {
        const res = await importApkg(file, clonedCol);
        setResult(res);
        onImportComplete(clonedCol);
      } else {
        // Assume text / CSV / TSV
        const text = await file.text();
        const firstDeckId = Object.keys(clonedCol.decks)[0] ? Number(Object.keys(clonedCol.decks)[0]) : 1;
        const firstModelId = Object.keys(clonedCol.models)[0] ? Number(Object.keys(clonedCol.models)[0]) : 1;
        const res = importCsv(text, clonedCol, firstDeckId, firstModelId);
        setResult(res);
        onImportComplete(clonedCol);
      }
    } catch (err: any) {
      console.error("Import error:", err);
      setErrorMsg(err.message || "Failed to import file.");
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
    <div className="modal-backdrop">
      <div className="modal-content" style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Import</h3>
          <button onClick={onClose} style={{ border: "none", padding: 4 }}>
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
              padding: "36px 16px",
              textAlign: "center",
              cursor: "pointer",
              background: "var(--bg-secondary)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8
            }}
          >
            <UploadCloud size={32} color="var(--text-secondary)" />
            <div style={{ fontSize: 14, fontWeight: 500 }}>
              Choose or drop .apkg or CSV file
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Imports decks, notes, cards, learning progress & review history
            </div>
          </div>

          {isProcessing && (
            <div style={{ textAlign: "center", fontSize: 14, color: "var(--color-new)" }}>
              Importing and extracting cards...
            </div>
          )}

          {errorMsg && (
            <div style={{ color: "var(--color-again)", fontSize: 13, textAlign: "center" }}>
              {errorMsg}
            </div>
          )}

          {result && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "10px 14px",
                background: "rgba(22, 163, 74, 0.1)",
                borderRadius: 6,
                color: "var(--color-due)",
                fontSize: 13
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                <CheckCircle size={18} />
                <span>Import successful</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.9 }}>
                {result.cardCount} cards ({result.noteCount} notes, {result.deckCount} decks, {result.revlogCount} reviews)
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>{result ? "Done" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
};
