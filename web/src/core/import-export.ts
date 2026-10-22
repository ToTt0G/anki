import JSZip from "jszip";
import initSqlJs from "sql.js";
import { Collection, Deck, Note, Card, CardType, CardQueue, NoteType, DeckConfig, RevlogEntry } from "./types";

export interface ImportResult {
  deckCount: number;
  noteCount: number;
  cardCount: number;
  revlogCount: number;
  mediaCount: number;
}

async function getSql(): Promise<any> {
  const isBrowser = typeof window !== "undefined";
  const initSql = (isBrowser && (window as any).initSqlJs) || initSqlJs;
  
  if (isBrowser) {
    return await initSql({
      locateFile: (file: string) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/${file}`
    });
  } else {
    return await initSql();
  }
}

export async function importApkg(
  file: File | Blob,
  targetCol: Collection
): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(file);

  // 1. Find collection database
  let dbFile = zip.file("collection.anki21") || zip.file("collection.anki2");
  if (!dbFile) {
    throw new Error("Invalid .apkg: missing collection database (collection.anki2)");
  }

  const dbBuffer = await dbFile.async("uint8array");

  // 2. Initialize SQL.js
  const SQL = await getSql();
  const db = new SQL.Database(dbBuffer);

  // 3. Extract media map if present
  const mediaFile = zip.file("media");
  const extractedMedia: Record<string, string> = {};
  let mediaCount = 0;

  if (mediaFile) {
    try {
      const mediaJsonStr = await mediaFile.async("string");
      const mediaMap: Record<string, string> = JSON.parse(mediaJsonStr);
      for (const [idxStr, originalFilename] of Object.entries(mediaMap)) {
        const itemFile = zip.file(idxStr);
        if (itemFile) {
          const itemBase64 = await itemFile.async("base64");
          // Determine mime type including all modern web image formats
          let mime = "application/octet-stream";
          const lower = originalFilename.toLowerCase();
          if (lower.endsWith(".png")) mime = "image/png";
          else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mime = "image/jpeg";
          else if (lower.endsWith(".webp")) mime = "image/webp";
          else if (lower.endsWith(".gif")) mime = "image/gif";
          else if (lower.endsWith(".svg")) mime = "image/svg+xml";
          else if (lower.endsWith(".avif")) mime = "image/avif";
          else if (lower.endsWith(".bmp")) mime = "image/bmp";
          else if (lower.endsWith(".mp3")) mime = "audio/mpeg";
          else if (lower.endsWith(".ogg")) mime = "audio/ogg";
          else if (lower.endsWith(".wav")) mime = "audio/wav";
          else if (lower.endsWith(".m4a") || lower.endsWith(".aac")) mime = "audio/mp4";

          extractedMedia[originalFilename] = `data:${mime};base64,${itemBase64}`;
          mediaCount++;
        }
      }
    } catch (e) {
      console.warn("Failed to parse media map:", e);
    }
  }

  // 4. Read decks and models from 'col' table
  let deckCount = 0;
  let noteCount = 0;
  let cardCount = 0;
  let revlogCount = 0;

  const colRes = db.exec("SELECT id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf FROM col LIMIT 1");
  if (colRes.length > 0 && colRes[0].values.length > 0) {
    const row = colRes[0].values[0];
    const modelsJson = row[9] as string;
    const decksJson = row[10] as string;
    const dconfJson = row[11] as string;

    try {
      const importedModels: Record<string, NoteType> = JSON.parse(modelsJson);
      for (const [mid, model] of Object.entries(importedModels)) {
        targetCol.models[Number(mid)] = model;
      }
    } catch (e) {
      console.warn("Failed to parse models from col:", e);
    }

    try {
      const importedDecks: Record<string, Deck> = JSON.parse(decksJson);
      for (const [did, deck] of Object.entries(importedDecks)) {
        targetCol.decks[Number(did)] = deck;
        deckCount++;
      }
    } catch (e) {
      console.warn("Failed to parse decks from col:", e);
    }

    try {
      const importedDconf: Record<string, DeckConfig> = JSON.parse(dconfJson);
      for (const [dcid, conf] of Object.entries(importedDconf)) {
        targetCol.dconf[Number(dcid)] = conf;
      }
    } catch (e) {
      console.warn("Failed to parse dconf from col:", e);
    }
  }

  // 5. Read notes
  const notesRes = db.exec("SELECT id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data FROM notes");
  if (notesRes.length > 0) {
    for (const row of notesRes[0].values) {
      const [id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data] = row;
      const fieldList = (flds as string).split("\x1f");
      const tagList = (tags as string).trim().split(/\s+/).filter(Boolean);

      targetCol.notes[id as number] = {
        id: id as number,
        guid: guid as string,
        mid: mid as number,
        mod: mod as number,
        usn: usn as number,
        tags: tagList,
        fields: fieldList,
        sfld: sfld as string,
        csum: csum as number,
        flags: flags as number,
        data: data as string
      };
      noteCount++;
    }
  }

  // 6. Read cards
  const cardsRes = db.exec("SELECT id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards");
  if (cardsRes.length > 0) {
    for (const row of cardsRes[0].values) {
      const [id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data] = row;

      targetCol.cards[id as number] = {
        id: id as number,
        nid: nid as number,
        did: did as number,
        ord: ord as number,
        mod: mod as number,
        usn: usn as number,
        type: (type as number) as CardType,
        queue: (queue as number) as CardQueue,
        due: due as number,
        ivl: ivl as number,
        factor: factor as number,
        reps: reps as number,
        lapses: lapses as number,
        left: left as number,
        odue: (odue as number) || 0,
        odid: (odid as number) || 0,
        flags: (flags as number) || 0,
        data: (data as string) || "{}"
      };
      cardCount++;
    }
  }

  // 7. Read revlog (learning progress and review history)
  try {
    const revlogRes = db.exec("SELECT id, cid, usn, ease, ivl, lastIvl, factor, time, type FROM revlog");
    if (revlogRes.length > 0) {
      if (!targetCol.revlog) {
        targetCol.revlog = [];
      }
      for (const row of revlogRes[0].values) {
        const [id, cid, usn, ease, ivl, lastIvl, factor, time, type] = row;
        targetCol.revlog.push({
          id: id as number,
          cid: cid as number,
          usn: (usn as number) || 0,
          ease: (ease as any) || 3,
          ivl: ivl as number,
          lastIvl: (lastIvl as number) || 0,
          factor: (factor as number) || 2500,
          time: (time as number) || 0,
          type: (type as number) || 0
        });
        revlogCount++;
      }
    }
  } catch (e) {
    console.warn("Notice: revlog table not found or empty in apkg:", e);
  }

  // Merge media
  Object.assign(targetCol.media, extractedMedia);

  db.close();

  return {
    deckCount,
    noteCount,
    cardCount,
    revlogCount,
    mediaCount
  };
}

export async function exportApkg(col: Collection, did?: number): Promise<Blob> {
  const SQL = await getSql();
  const db = new SQL.Database();

  // 1. Create standard Anki SQLite schema
  db.exec(`
    CREATE TABLE col (
      id integer PRIMARY KEY,
      crt integer NOT NULL,
      mod integer NOT NULL,
      scm integer NOT NULL,
      ver integer NOT NULL,
      dty integer NOT NULL,
      usn integer NOT NULL,
      ls integer NOT NULL,
      conf text NOT NULL,
      models text NOT NULL,
      decks text NOT NULL,
      dconf text NOT NULL,
      tags text NOT NULL
    );
    CREATE TABLE notes (
      id integer PRIMARY KEY,
      guid text NOT NULL,
      mid integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      tags text NOT NULL,
      flds text NOT NULL,
      sfld integer NOT NULL,
      csum integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE cards (
      id integer PRIMARY KEY,
      nid integer NOT NULL,
      did integer NOT NULL,
      ord integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      type integer NOT NULL,
      queue integer NOT NULL,
      due integer NOT NULL,
      ivl integer NOT NULL,
      factor integer NOT NULL,
      reps integer NOT NULL,
      lapses integer NOT NULL,
      left integer NOT NULL,
      odue integer NOT NULL,
      odid integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE revlog (
      id integer PRIMARY KEY,
      cid integer NOT NULL,
      usn integer NOT NULL,
      ease integer NOT NULL,
      ivl integer NOT NULL,
      lastIvl integer NOT NULL,
      factor integer NOT NULL,
      time integer NOT NULL,
      type integer NOT NULL
    );
    CREATE TABLE graves (
      usn integer NOT NULL,
      oid integer NOT NULL,
      type integer NOT NULL
    );
    CREATE INDEX ix_notes_usn ON notes (usn);
    CREATE INDEX ix_cards_usn ON cards (usn);
    CREATE INDEX ix_revlog_usn ON revlog (usn);
    CREATE INDEX ix_cards_nid ON cards (nid);
    CREATE INDEX ix_cards_sched ON cards (did, queue, due);
    CREATE INDEX ix_revlog_cid ON revlog (cid);
    CREATE INDEX ix_notes_csum ON notes (csum);
  `);

  // 2. Filter decks, cards, notes, models
  const matchingDeckIds = new Set<number>();
  if (did !== undefined) {
    matchingDeckIds.add(did);
    const targetDeck = col.decks[did];
    const prefix = targetDeck ? `${targetDeck.name}::` : "";
    for (const [idStr, d] of Object.entries(col.decks)) {
      if (d.name.startsWith(prefix)) {
        matchingDeckIds.add(Number(idStr));
      }
    }
  } else {
    for (const idStr of Object.keys(col.decks)) {
      matchingDeckIds.add(Number(idStr));
    }
  }

  const exportedCards = Object.values(col.cards).filter(c => matchingDeckIds.has(c.did));
  const matchingNoteIds = new Set(exportedCards.map(c => c.nid));
  const exportedNotes = Object.values(col.notes).filter(n => matchingNoteIds.has(n.id));
  const matchingModelIds = new Set(exportedNotes.map(n => n.mid));

  const exportedDecks: Record<string, any> = {};
  for (const id of matchingDeckIds) {
    if (col.decks[id]) exportedDecks[String(id)] = col.decks[id];
  }

  const exportedModels: Record<string, any> = {};
  for (const id of matchingModelIds) {
    if (col.models[id]) exportedModels[String(id)] = col.models[id];
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // 3. Insert into col table
  db.run(
    "INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, '{}', ?, ?, ?, '{}')",
    [
      col.crt || nowSec,
      nowSec,
      nowSec,
      JSON.stringify(exportedModels),
      JSON.stringify(exportedDecks),
      JSON.stringify(col.dconf || {})
    ]
  );

  // 4. Insert notes
  const noteStmt = db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const note of exportedNotes) {
    const tagsStr = note.tags.length > 0 ? ` ${note.tags.join(" ")} ` : "";
    const fldsStr = note.fields.join("\x1f");
    noteStmt.run([
      note.id,
      note.guid || String(note.id),
      note.mid,
      note.mod || nowSec,
      note.usn || 0,
      tagsStr,
      fldsStr,
      note.sfld || note.fields[0] || "",
      note.csum || 0,
      note.flags || 0,
      note.data || "{}"
    ]);
  }
  noteStmt.free();

  // 5. Insert cards with full scheduling state
  const cardStmt = db.prepare(
    "INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const card of exportedCards) {
    cardStmt.run([
      card.id,
      card.nid,
      card.did,
      card.ord,
      card.mod || nowSec,
      card.usn || 0,
      card.type,
      card.queue,
      card.due,
      card.ivl,
      card.factor,
      card.reps,
      card.lapses,
      card.left,
      card.odue || 0,
      card.odid || 0,
      card.flags || 0,
      card.data || "{}"
    ]);
  }
  cardStmt.free();

  // 6. Insert revlogs
  const revlogStmt = db.prepare(
    "INSERT INTO revlog VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const cardIdSet = new Set(exportedCards.map(c => c.id));
  for (const r of col.revlog || []) {
    if (cardIdSet.has(r.cid)) {
      revlogStmt.run([
        r.id,
        r.cid,
        r.usn || 0,
        r.ease,
        r.ivl,
        r.lastIvl || 0,
        r.factor,
        r.time || 0,
        r.type || 0
      ]);
    }
  }
  revlogStmt.free();

  // 7. Binary export of the database
  const binaryDb = db.export();
  db.close();

  // 8. Package into ZIP with media
  const zip = new JSZip();
  zip.file("collection.anki2", binaryDb);
  zip.file("collection.anki21", binaryDb);

  const mediaMap: Record<string, string> = {};
  let mediaIdx = 0;

  for (const [filename, dataUrl] of Object.entries(col.media || {})) {
    const idxStr = String(mediaIdx++);
    mediaMap[idxStr] = filename;

    if (dataUrl.startsWith("data:")) {
      const base64 = dataUrl.split(",")[1];
      zip.file(idxStr, base64, { base64: true });
    } else if (dataUrl.startsWith("blob:") || dataUrl.startsWith("http")) {
      try {
        const resp = await fetch(dataUrl);
        const ab = await resp.arrayBuffer();
        zip.file(idxStr, ab);
      } catch (e) {
        console.warn(`Failed to package media ${filename}:`, e);
      }
    }
  }

  zip.file("media", JSON.stringify(mediaMap));

  return await zip.generateAsync({ type: "blob", mimeType: "application/apkg" });
}

export function importCsv(
  text: string,
  targetCol: Collection,
  deckId: number,
  modelId: number,
  delimiter: string = "\t"
): ImportResult {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  const model = targetCol.models[modelId];
  if (!model) {
    throw new Error(`Note type ${modelId} not found`);
  }

  let noteCount = 0;
  let cardCount = 0;
  let nowMs = Date.now();

  for (const line of lines) {
    const fields = line.split(delimiter);
    while (fields.length < model.flds.length) {
      fields.push("");
    }

    const note: Note = {
      id: nowMs++,
      guid: `csv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      mid: modelId,
      mod: Math.floor(Date.now() / 1000),
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

    for (let ord = 0; ord < model.tmpls.length; ord++) {
      nowMs++;
      const card: Card = {
        id: nowMs,
        nid: note.id,
        did: deckId,
        ord,
        mod: Math.floor(Date.now() / 1000),
        usn: 0,
        type: 0, // New
        queue: 0,
        due: cardCount + 1,
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
    revlogCount: 0,
    mediaCount: 0
  };
}

export function exportDeckCsv(col: Collection, did: number): string {
  const deckCards = Object.values(col.cards).filter(c => c.did === did);
  const noteIds = new Set(deckCards.map(c => c.nid));
  const notes = Object.values(col.notes).filter(n => noteIds.has(n.id));

  return notes.map(n => n.fields.join("\t")).join("\n");
}
