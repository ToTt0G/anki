import JSZip from "jszip";
import initSqlJs from "sql.js";
import { Collection, Deck, Note, Card, NoteType, DeckConfig } from "./types";

export interface ImportResult {
  deckCount: number;
  noteCount: number;
  cardCount: number;
  mediaCount: number;
}

export async function importApkg(
  file: File | Blob,
  targetCol: Collection
): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(file);

  // 1. Find collection database
  let dbFile = zip.file("collection.anki21") || zip.file("collection.anki2");
  if (!dbFile) {
    throw new Error("Invalid .apkg: missing collection.anki2 database");
  }

  const dbBuffer = await dbFile.async("uint8array");

  // 2. Initialize SQL.js
  const SQL = await initSqlJs({
    // Load wasm from public CDN if not bundled
    locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/${file}`
  });

  const db = new SQL.Database(dbBuffer);

  // 3. Extract media map if present
  const mediaFile = zip.file("media");
  const extractedMedia: Record<string, string> = {};
  let mediaCount = 0;

  if (mediaFile) {
    try {
      const mediaJsonStr = await mediaFile.async("string");
      const mediaMapping: Record<string, string> = JSON.parse(mediaJsonStr);
      for (const [archiveKey, originalName] of Object.entries(mediaMapping)) {
        const itemFile = zip.file(archiveKey);
        if (itemFile) {
          const blob = await itemFile.async("blob");
          extractedMedia[originalName] = URL.createObjectURL(blob);
          mediaCount++;
        }
      }
    } catch (e) {
      console.warn("Failed to parse apkg media map:", e);
    }
  }

  // 4. Query collection metadata (decks, models, dconf)
  let deckCount = 0;
  let noteCount = 0;
  let cardCount = 0;

  const colRes = db.exec("SELECT decks, models, dconf FROM col LIMIT 1");
  if (colRes.length > 0 && colRes[0].values.length > 0) {
    const [decksJson, modelsJson, dconfJson] = colRes[0].values[0];
    try {
      const importedDecks: Record<string, any> = JSON.parse(decksJson as string);
      for (const [idStr, d] of Object.entries(importedDecks)) {
        const id = parseInt(idStr, 10);
        if (id && d.name) {
          targetCol.decks[id] = {
            id,
            name: d.name,
            desc: d.desc || "",
            collapsed: !!d.collapsed,
            conf: d.conf || 1,
            dyn: d.dyn || 0,
            mod: d.mod || Math.floor(Date.now() / 1000),
            usn: 0
          };
          deckCount++;
        }
      }
    } catch (e) {}

    try {
      const importedModels: Record<string, any> = JSON.parse(modelsJson as string);
      for (const [idStr, m] of Object.entries(importedModels)) {
        const id = parseInt(idStr, 10);
        if (id && m.name) {
          targetCol.models[id] = {
            id,
            name: m.name,
            type: m.type || 0,
            mod: m.mod || Math.floor(Date.now() / 1000),
            usn: 0,
            flds: (m.flds || []).map((f: any, idx: number) => ({
              name: f.name || `Field ${idx + 1}`,
              ord: f.ord ?? idx,
              sticky: !!f.sticky,
              rtl: !!f.rtl,
              font: f.font || "Arial",
              size: f.size || 20
            })),
            tmpls: (m.tmpls || []).map((t: any, idx: number) => ({
              name: t.name || `Card ${idx + 1}`,
              ord: t.ord ?? idx,
              qfmt: t.qfmt || "",
              afmt: t.afmt || ""
            })),
            css: m.css || ""
          };
        }
      }
    } catch (e) {}
  }

  // 5. Query notes
  const notesRes = db.exec("SELECT id, guid, mid, mod, tags, flds, sfld, csum, flags, data FROM notes");
  if (notesRes.length > 0) {
    for (const row of notesRes[0].values) {
      const [id, guid, mid, mod, tagsStr, fldsStr, sfld, csum, flags, data] = row;
      const tags = (tagsStr as string || "").trim().split(/\s+/).filter(Boolean);
      const fields = (fldsStr as string || "").split("\x1f");

      const note: Note = {
        id: id as number,
        guid: (guid as string) || String(id),
        mid: mid as number,
        mod: mod as number,
        usn: 0,
        tags,
        fields,
        sfld: String(sfld || ""),
        csum: (csum as number) || 0,
        flags: (flags as number) || 0,
        data: (data as string) || "{}"
      };

      targetCol.notes[note.id] = note;
      noteCount++;
    }
  }

  // 6. Query cards
  const cardsRes = db.exec("SELECT id, nid, did, ord, mod, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards");
  if (cardsRes.length > 0) {
    for (const row of cardsRes[0].values) {
      const [id, nid, did, ord, mod, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data] = row;

      const card: Card = {
        id: id as number,
        nid: nid as number,
        did: did as number,
        ord: ord as number,
        mod: mod as number,
        usn: 0,
        type: (type as any) || 0,
        queue: (queue as any) || 0,
        due: due as number,
        ivl: ivl as number,
        factor: (factor as number) || 2500,
        reps: (reps as number) || 0,
        lapses: (lapses as number) || 0,
        left: (left as number) || 0,
        odue: (odue as number) || 0,
        odid: (odid as number) || 0,
        flags: (flags as number) || 0,
        data: (data as string) || "{}"
      };

      targetCol.cards[card.id] = card;
      cardCount++;
    }
  }

  // Merge media
  Object.assign(targetCol.media, extractedMedia);

  db.close();

  return {
    deckCount,
    noteCount,
    cardCount,
    mediaCount
  };
}

export function importCsv(
  text: string,
  targetCol: Collection,
  targetDid: number,
  targetMid: number,
  delimiter = "\t"
): ImportResult {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  let noteCount = 0;
  let cardCount = 0;
  const now = Math.floor(Date.now() / 1000);
  let nowMs = Date.now();

  const model = targetCol.models[targetMid] || Object.values(targetCol.models)[0];

  for (const line of lines) {
    const rawFields = line.includes(delimiter) ? line.split(delimiter) : line.split(",");
    const fields = rawFields.map(f => f.trim().replace(/^"|"$/g, ""));
    nowMs++;

    const noteId = nowMs;
    const note: Note = {
      id: noteId,
      guid: `csv_${noteId}`,
      mid: model.id,
      mod: now,
      usn: 0,
      tags: [],
      fields,
      sfld: fields[0] || "",
      csum: 0,
      flags: 0,
      data: "{}"
    };
    targetCol.notes[note.id] = note;
    noteCount++;

    // Generate cards for templates
    for (let ord = 0; ord < model.tmpls.length; ord++) {
      nowMs++;
      const card: Card = {
        id: nowMs,
        nid: note.id,
        did: targetDid,
        ord,
        mod: now,
        usn: 0,
        type: 0,
        queue: 0,
        due: Object.keys(targetCol.cards).length + 1,
        ivl: 0,
        factor: 2500,
        reps: 0,
        lapses: 0,
        left: 0,
        odue: 0,
        odid: 0,
        flags: 0,
        data: "{}"
      };
      targetCol.cards[card.id] = card;
      cardCount++;
    }
  }

  return {
    deckCount: 1,
    noteCount,
    cardCount,
    mediaCount: 0
  };
}

export function exportCollectionJson(col: Collection): string {
  return JSON.stringify(col, null, 2);
}

export function exportDeckCsv(col: Collection, did: number): string {
  const matchingNotes = new Set<number>();
  for (const card of Object.values(col.cards)) {
    if (card.did === did) {
      matchingNotes.add(card.nid);
    }
  }

  const lines: string[] = [];
  for (const nid of matchingNotes) {
    const note = col.notes[nid];
    if (note) {
      lines.push(note.fields.join("\t"));
    }
  }

  return lines.join("\n");
}
