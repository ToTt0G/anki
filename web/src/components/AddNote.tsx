import React, { useState, useRef } from "react";
import { Collection, Note, Card } from "../core/types";
import { findClozeNumbers, wrapInCloze } from "../core/cloze";
import { Plus, Image as ImageIcon } from "lucide-react";

interface Props {
  collection: Collection;
  defaultDeckId?: number;
  onAddNote: (note: Note, cards: Card[]) => void;
  onSaveMedia?: (filename: string, dataUrl: string) => void;
}

export const AddNote: React.FC<Props> = ({
  collection,
  defaultDeckId = 1,
  onAddNote,
  onSaveMedia
}) => {
  const models = Object.values(collection.models);
  const decks = Object.values(collection.decks);

  const [selectedMid, setSelectedMid] = useState<number>(models[0]?.id || 1);
  const [selectedDid, setSelectedDid] = useState<number>(defaultDeckId);
  const [fieldValues, setFieldValues] = useState<Record<number, string>>({});
  const [tagsStr, setTagsStr] = useState<string>("");
  const [addedStatus, setAddedStatus] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeFieldIdxRef = useRef<number>(0);

  const activeModel = collection.models[selectedMid] || models[0];
  const fieldRefs = useRef<Record<number, HTMLTextAreaElement | null>>({});

  const handleFieldChange = (idx: number, val: string) => {
    setFieldValues(prev => ({ ...prev, [idx]: val }));
  };

  const handleInsertCloze = (idx: number) => {
    const input = fieldRefs.current[idx];
    if (!input) return;

    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const currentVal = fieldValues[idx] || "";
    const selectedText = currentVal.substring(start, end) || "text";

    // Determine next cloze number
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

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `paste_${Date.now()}_${cleanName}`;

      if (onSaveMedia) {
        onSaveMedia(filename, dataUrl);
      } else {
        collection.media[filename] = dataUrl;
      }

      // Insert img tag into active field
      const targetIdx = activeFieldIdxRef.current;
      const currentVal = fieldValues[targetIdx] || "";
      const imgTag = `<img src="${filename}">`;
      const input = fieldRefs.current[targetIdx];

      if (input) {
        const start = input.selectionStart || 0;
        const end = input.selectionEnd || 0;
        const newVal = currentVal.substring(0, start) + imgTag + currentVal.substring(end);
        setFieldValues(prev => ({ ...prev, [targetIdx]: newVal }));
      } else {
        setFieldValues(prev => ({
          ...prev,
          [targetIdx]: currentVal ? `${currentVal}\n${imgTag}` : imgTag
        }));
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleAdd = () => {
    if (!activeModel) return;

    const fields = activeModel.flds.map((_, idx) => fieldValues[idx] || "");
    const firstField = fields[0] || "";
    if (!firstField.trim()) {
      alert("First field cannot be empty.");
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const noteId = Date.now();
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
      data: "{}"
    };

    const cards: Card[] = [];
    const isCloze = activeModel.type === 1;

    if (isCloze) {
      // Find all cloze numbers in first field
      const clozeNums = findClozeNumbers(fields[0]);
      const numsToGenerate = clozeNums.length > 0 ? clozeNums : [1];

      numsToGenerate.forEach((num, i) => {
        const cardId = noteId + i + 1;
        cards.push({
          id: cardId,
          nid: note.id,
          did: selectedDid,
          ord: num - 1,
          mod: now,
          usn: 0,
          type: 0,
          queue: 0,
          due: Object.keys(collection.cards).length + i + 1,
          ivl: 0,
          factor: 2500,
          reps: 0,
          lapses: 0,
          left: 0,
          odue: 0,
          odid: 0,
          flags: 0,
          data: "{}"
        });
      });
    } else {
      // Standard templates
      activeModel.tmpls.forEach((tmpl, ord) => {
        const cardId = noteId + ord + 1;
        cards.push({
          id: cardId,
          nid: note.id,
          did: selectedDid,
          ord,
          mod: now,
          usn: 0,
          type: 0,
          queue: 0,
          due: Object.keys(collection.cards).length + ord + 1,
          ivl: 0,
          factor: 2500,
          reps: 0,
          lapses: 0,
          left: 0,
          odue: 0,
          odid: 0,
          flags: 0,
          data: "{}"
        });
      });
    }

    onAddNote(note, cards);

    // Clear fields except sticky ones
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
          <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>Type</label>
          <select
            value={selectedMid}
            onChange={e => setSelectedMid(Number(e.target.value))}>
            {models.map(m => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>Deck</label>
          <select
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
      {activeModel.flds.map((fld, idx) => (
        <div key={fld.name} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label style={{ fontSize: 13, fontWeight: 500 }}>{fld.name}</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                type="button"
                onClick={() => triggerImageUpload(idx)}
                style={{ padding: "3px 8px", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}
                title="Insert Image"
              >
                <ImageIcon size={13} />
                <span>Image</span>
              </button>
              {activeModel.type === 1 && idx === 0 && (
                <button
                  type="button"
                  onClick={() => handleInsertCloze(idx)}
                  style={{ padding: "3px 8px", fontSize: 12 }}
                  title="Cloze deletion ([...])"
                >
                  [...]
                </button>
              )}
            </div>
          </div>
          <textarea
            ref={el => {
              fieldRefs.current[idx] = el;
            }}
            rows={fld.name.toLowerCase().includes("back") || fld.name.toLowerCase().includes("text") ? 4 : 2}
            value={fieldValues[idx] || ""}
            onChange={e => handleFieldChange(idx, e.target.value)}
          />
        </div>
      ))}

      {/* Tags */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>Tags</label>
        <input
          type="text"
          value={tagsStr}
          placeholder="tag1 tag2"
          onChange={e => setTagsStr(e.target.value)}
        />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, marginTop: 8 }}>
        {addedStatus && <span style={{ fontSize: 13, color: "var(--color-due)" }}>Added</span>}
        <button className="primary" onClick={handleAdd} style={{ padding: "8px 24px" }}>
          <Plus size={16} />
          <span>Add</span>
        </button>
      </div>
    </div>
  );
};
