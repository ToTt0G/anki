import JSZip from "jszip";
import initSqlJs from "sql.js";
import { Collection, Deck, Note, Card, NoteType, CardType, CardQueue } from "./types";
import { generateUniqueId } from "./ids";
import { normalizeReviewDueDay, toRelativeAnkiDueDay } from "./scheduler";
import { sanitizeCardCss, sanitizeCardHtml } from "./sanitize";

let sqlPromise: Promise<any> | null = null;

async function getSql() {
  if (!sqlPromise) {
    const initFn = (window as any).initSqlJs || initSqlJs;
    sqlPromise = initFn({
      locateFile: (file: string) => `/vendor/sql.js/${file}`
    });
  }
  return sqlPromise;
}

export interface ImportResult {
  deckCount: number;
  noteCount: number;
  cardCount: number;
  revlogCount: number;
  mediaCount: number;
  duplicateCount?: number;
  deckNames?: string[];
}

// Resource budgets for untrusted archives (S06)
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_EXPANDED_BYTES = 160 * 1024 * 1024; // 160 MB
export const MAX_ZIP_ENTRIES = 2_500;
export const MAX_SINGLE_MEDIA_BYTES = 15 * 1024 * 1024; // 15 MB
export const MAX_IMPORT_RECORDS = 50_000;

export async function importApkg(file: File | Blob, targetCol: Collection): Promise<ImportResult> {
  if (file.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `Package exceeds maximum allowed size (${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB).`
    );
  }

  const zip = await JSZip.loadAsync(file);
  const fileNames = Object.keys(zip.files);

  if (fileNames.length > MAX_ZIP_ENTRIES) {
    throw new Error(`Archive contains too many entries (${fileNames.length} > ${MAX_ZIP_ENTRIES}).`);
  }

  // Detect modern protobuf/zstd .anki21b schema when legacy SQLite DB is absent or stubbed (C08)
  const hasAnki21b = Boolean(zip.file("collection.anki21b"));
  const dbFile = zip.file("collection.anki21") || zip.file("collection.anki2");

  if (!dbFile) {
    if (hasAnki21b) {
      throw new Error(
        "This package uses Anki's compressed .anki21b format without legacy compatibility. When exporting from desktop Anki, enable 'Support older Anki versions'."
      );
    }
    throw new Error("Invalid .apkg file: missing collection.anki2 or collection.anki21 database.");
  }

  const dbBinary = await dbFile.async("uint8array");
  let totalExpandedBytes = dbBinary.byteLength;
  if (totalExpandedBytes > MAX_EXPANDED_BYTES) {
    throw new Error("Decompressed database exceeds memory budget.");
  }

  const SQL = await getSql();
  const db = new SQL.Database(dbBinary);

  let deckCount = 0;
  let noteCount = 0;
  let cardCount = 0;
  let revlogCount = 0;
  let mediaCount = 0;
  let duplicateCount = 0;
  const importedDeckNames: string[] = [];

  try {
    // 1. Parse media map with resource budgets (S06)
    const mediaFile = zip.file("media");
    const extractedMedia: Record<string, string> = {};
    if (mediaFile) {
      try {
        const mediaJsonStr = await mediaFile.async("string");
        const mediaMap: Record<string, string> = JSON.parse(mediaJsonStr);

        for (const [archiveKey, realFilename] of Object.entries(mediaMap)) {
          const entry = zip.file(archiveKey);
          if (!entry) continue;

          const rawBytes = await entry.async("uint8array");
          if (rawBytes.byteLength > MAX_SINGLE_MEDIA_BYTES) {
            continue;
          }
          totalExpandedBytes += rawBytes.byteLength;
          if (totalExpandedBytes > MAX_EXPANDED_BYTES) {
            throw new Error("Archive decompressed media exceeds memory budget.");
          }

          let binary = "";
          const chunkSize = 0x8000;
          for (let i = 0; i < rawBytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(
              null,
              Array.from(rawBytes.subarray(i, i + chunkSize))
            );
          }
          const base64 = btoa(binary);
          const ext = realFilename.split(".").pop()?.toLowerCase() || "";
          let mime = "application/octet-stream";
          if (ext === "png") mime = "image/png";
          else if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
          else if (ext === "gif") mime = "image/gif";
          else if (ext === "webp") mime = "image/webp";
          else if (ext === "mp3") mime = "audio/mpeg";
          else if (ext === "wav") mime = "audio/wav";
          else if (ext === "ogg") mime = "audio/ogg";

          const safeFilename = realFilename.replace(/[\\/]/g, "_");
          extractedMedia[safeFilename] = `data:${mime};base64,${base64}`;
          mediaCount++;
        }
      } catch (e: any) {
        if (e?.message?.includes("memory budget")) throw e;
        console.warn("Could not parse media file in apkg:", e);
      }
    }

    // 2. Read col metadata including `crt` for canonical due-date conversion (C01)
    const colRes = db.exec("SELECT crt, models, decks, dconf FROM col LIMIT 1");
    let sourceCrtSec = targetCol.crt || Math.floor(Date.now() / 1000);
    const deckIdRemap = new Map<number, number>();
    const modelIdRemap = new Map<number, number>();

    if (colRes.length > 0 && colRes[0].values.length > 0) {
      const [rawCrt, modelsJson, decksJson, dconfJson] = colRes[0].values[0];
      if (typeof rawCrt === "number" && rawCrt > 0) {
        sourceCrtSec = rawCrt;
        if (!targetCol.crt) {
          targetCol.crt = rawCrt;
        }
      }

      // 3. Parse models with collision-safe ID mapping (C06)
      try {
        const modelsObj = JSON.parse(modelsJson as string);
        for (const [midStr, m] of Object.entries<any>(modelsObj)) {
          const sourceMid = Number(midStr);
          let targetMid = sourceMid;
          const existingModel = targetCol.models[sourceMid];
          if (existingModel && existingModel.name !== (m.name || "Imported Note Type")) {
            targetMid = generateUniqueId(targetCol.models);
          }
          modelIdRemap.set(sourceMid, targetMid);

          const model: NoteType = {
            id: targetMid,
            name: m.name || "Imported Note Type",
            type: m.type === 1 ? 1 : 0,
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
              qfmt: t.qfmt || "{{Front}}",
              afmt: t.afmt || "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}"
            })),
            css: sanitizeCardCss(m.css || "")
          };
          targetCol.models[targetMid] = model;
        }
      } catch (e) {
        console.warn("Failed to parse models JSON:", e);
      }

      // 4. Parse decks with name matching & collision-safe ID mapping (C06)
      try {
        const decksObj = JSON.parse(decksJson as string);
        const existingDeckByName = new Map<string, number>();
        for (const d of Object.values(targetCol.decks)) {
          existingDeckByName.set(d.name, d.id);
        }

        for (const [didStr, d] of Object.entries<any>(decksObj)) {
          const sourceDid = Number(didStr);
          const deckName = d.name || "Imported Deck";

          // Check if modern .anki21b stub deck message is present (C08)
          if (
            hasAnki21b &&
            deckName.toLowerCase().includes("please update to the latest anki")
          ) {
            throw new Error(
              "This package uses Anki's newer .anki21b format. Please re-export from Anki with 'Support older Anki versions' checked."
            );
          }

          const matchedByName = existingDeckByName.get(deckName);
          let targetDid: number;
          if (matchedByName !== undefined) {
            targetDid = matchedByName;
          } else if (!targetCol.decks[sourceDid]) {
            targetDid = sourceDid;
          } else {
            targetDid = generateUniqueId(targetCol.decks);
          }

          deckIdRemap.set(sourceDid, targetDid);
          if (!targetCol.decks[targetDid]) {
            const deck: Deck = {
              id: targetDid,
              name: deckName,
              desc: d.desc || "",
              collapsed: !!d.collapsed,
              conf: d.conf || 1,
              dyn: d.dyn || 0,
              mod: d.mod || Math.floor(Date.now() / 1000),
              usn: 0
            };
            targetCol.decks[targetDid] = deck;
            existingDeckByName.set(deckName, targetDid);
            if (targetDid !== 1) {
              deckCount++;
              importedDeckNames.push(deckName);
            }
          }
        }
      } catch (e: any) {
        if (e?.message?.includes(".anki21b")) throw e;
        console.warn("Failed to parse decks JSON:", e);
      }

      // 5. Parse dconf
      try {
        if (dconfJson) {
          const dconfObj = JSON.parse(dconfJson as string);
          for (const [dcidStr, dc] of Object.entries<any>(dconfObj)) {
            const dcid = Number(dcidStr);
            if (!targetCol.dconf[dcid]) {
              targetCol.dconf[dcid] = {
                id: dcid,
                name: dc.name || "Default",
                new: {
                  delays: dc.new?.delays || [1, 10],
                  ints: dc.new?.ints || [1, 4],
                  initialFactor: dc.new?.initialFactor || 2500,
                  perDay: dc.new?.perDay ?? 20,
                  order: dc.new?.order ?? 1
                },
                rev: {
                  perDay: dc.rev?.perDay ?? 200,
                  ease4: dc.rev?.ease4 || 1.3,
                  ivlFct: dc.rev?.ivlFct || 1.0,
                  maxIvl: dc.rev?.maxIvl || 36500,
                  hardFactor: dc.rev?.hardFactor || 1.2
                },
                lapse: {
                  delays: dc.lapse?.delays || [10],
                  mult: dc.lapse?.mult ?? 0,
                  minInt: dc.lapse?.minInt || 1,
                  leechFails: dc.lapse?.leechFails || 8,
                  leechAction: dc.lapse?.leechAction ?? 0
                },
                timer: dc.timer || 0,
                maxTaken: dc.maxTaken || 60
              };
            }
          }
        }
      } catch (e) {
        console.warn("Failed to parse dconf JSON:", e);
      }
    }

    // 6. Read notes with GUID deduplication & collision-safe ID remapping (C06, S01)
    const existingNotesByGuid = new Map<string, Note>();
    for (const n of Object.values(targetCol.notes)) {
      if (n.guid) existingNotesByGuid.set(n.guid, n);
    }

    const noteIdRemap = new Map<number, number>();
    const notesRes = db.exec("SELECT id, guid, mid, mod, tags, flds, sfld FROM notes");
    if (notesRes.length > 0) {
      if (notesRes[0].values.length > MAX_IMPORT_RECORDS) {
        throw new Error(`Archive contains too many notes (${notesRes[0].values.length}).`);
      }

      for (const row of notesRes[0].values) {
        const [id, guid, mid, mod, tagsStr, fldsStr, sfld] = row;
        const sourceNid = id as number;
        const guidStr = String(guid || `guid_${sourceNid}`);
        const fields = (fldsStr as string).split("\x1f").map(f => sanitizeCardHtml(f));
        const tags = (tagsStr as string)
          .trim()
          .split(/\s+/)
          .filter(Boolean);

        // Check if modern .anki21b stub note is the only note in the archive (C08)
        if (
          hasAnki21b &&
          notesRes[0].values.length === 1 &&
          fields[0]?.toLowerCase().includes("please update to the latest anki")
        ) {
          throw new Error(
            "This package uses Anki's newer .anki21b format. Please re-export from Anki with 'Support older Anki versions' checked."
          );
        }

        const existingByGuid = existingNotesByGuid.get(guidStr);
        let targetNid: number;

        if (existingByGuid) {
          targetNid = existingByGuid.id;
          duplicateCount++;
          // Update existing note if imported note is newer
          if ((mod as number) >= (existingByGuid.mod || 0)) {
            targetCol.notes[targetNid] = {
              ...existingByGuid,
              mid: modelIdRemap.get(mid as number) ?? (mid as number),
              mod: mod as number,
              tags,
              fields,
              sfld: sanitizeCardHtml(String(sfld || fields[0] || ""))
            };
          }
        } else {
          if (!targetCol.notes[sourceNid]) {
            targetNid = sourceNid;
          } else {
            targetNid = generateUniqueId(targetCol.notes);
          }
          const newNote: Note = {
            id: targetNid,
            guid: guidStr,
            mid: modelIdRemap.get(mid as number) ?? (mid as number),
            mod: mod as number,
            usn: 0,
            tags,
            fields,
            sfld: sanitizeCardHtml(String(sfld || fields[0] || "")),
            csum: 0,
            flags: 0,
            data: "{}"
          };
          targetCol.notes[targetNid] = newNote;
          existingNotesByGuid.set(guidStr, newNote);
          noteCount++;
        }

        noteIdRemap.set(sourceNid, targetNid);
      }
    }

    // 7. Read cards and normalize review/day-learning due dates from sourceCrtSec (C01, C05, C06)
    const cardIdRemap = new Map<number, number>();
    const existingCardByNidOrd = new Map<string, Card>();
    for (const c of Object.values(targetCol.cards)) {
      existingCardByNidOrd.set(`${c.nid}:${c.ord}`, c);
    }

    const cardsRes = db.exec(
      "SELECT id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards"
    );
    if (cardsRes.length > 0) {
      if (cardsRes[0].values.length > MAX_IMPORT_RECORDS) {
        throw new Error(`Archive contains too many cards (${cardsRes[0].values.length}).`);
      }

      for (const row of cardsRes[0].values) {
        const [
          id,
          nid,
          did,
          ord,
          mod,
          usn,
          type,
          queue,
          due,
          ivl,
          factor,
          reps,
          lapses,
          left,
          odue,
          odid,
          flags,
          data
        ] = row;
        const sourceCid = id as number;
        const targetNid = noteIdRemap.get(nid as number) ?? (nid as number);
        const targetDid = deckIdRemap.get(did as number) ?? (did as number);
        const cardOrd = (ord as number) || 0;
        const cardQueue = (queue as number) as CardQueue;
        const rawDue = due as number;

        // Normalize review (queue=2) and day-learning (queue=3) due dates to canonical epoch days (C01, C05)
        let normalizedDue = rawDue;
        if (cardQueue === 2 || (cardQueue === 3 && rawDue < 1_000_000_000)) {
          normalizedDue = normalizeReviewDueDay(rawDue, sourceCrtSec);
        }

        const existingCard = existingCardByNidOrd.get(`${targetNid}:${cardOrd}`);
        let targetCid: number;
        if (existingCard) {
          targetCid = existingCard.id;
        } else if (!targetCol.cards[sourceCid]) {
          targetCid = sourceCid;
        } else {
          targetCid = generateUniqueId(targetCol.cards);
        }

        cardIdRemap.set(sourceCid, targetCid);

        const cardObj: Card = {
          id: targetCid,
          nid: targetNid,
          did: targetDid,
          ord: cardOrd,
          mod: mod as number,
          usn: (usn as number) || 0,
          type: (type as number) as CardType,
          queue: cardQueue,
          due: normalizedDue,
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

        targetCol.cards[targetCid] = cardObj;
        existingCardByNidOrd.set(`${targetNid}:${cardOrd}`, cardObj);
        if (!existingCard) {
          cardCount++;
        }
      }
    }

    // 8. Read revlog with remapped card IDs and collision-free revlog IDs (D11)
    try {
      const revlogRes = db.exec(
        "SELECT id, cid, usn, ease, ivl, lastIvl, factor, time, type FROM revlog"
      );
      if (revlogRes.length > 0) {
        if (!targetCol.revlog) {
          targetCol.revlog = [];
        }
        const existingRevIds = new Set(targetCol.revlog.map(r => r.id));
        for (const row of revlogRes[0].values) {
          const [id, cid, usn, ease, ivl, lastIvl, factor, time, type] = row;
          let revId = id as number;
          const mappedCid = cardIdRemap.get(cid as number) ?? (cid as number);
          if (existingRevIds.has(revId)) {
            continue;
          }
          existingRevIds.add(revId);
          targetCol.revlog.push({
            id: revId,
            cid: mappedCid,
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

    Object.assign(targetCol.media, extractedMedia);

    return {
      deckCount,
      noteCount,
      cardCount,
      revlogCount,
      mediaCount,
      duplicateCount,
      deckNames: importedDeckNames
    };
  } finally {
    db.close();
  }
}

export async function exportApkg(col: Collection, did?: number): Promise<Blob> {
  const SQL = await getSql();
  const db = new SQL.Database();

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

  const matchingDeckIds = new Set<number>();
  if (did !== undefined) {
    matchingDeckIds.add(did);
    const targetDeck = col.decks[did];
    const prefix = targetDeck ? `${targetDeck.name}::` : "";
    for (const [idStr, d] of Object.entries(col.decks)) {
      if (prefix && d.name.startsWith(prefix)) {
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
  const exportCrtSec = col.crt && col.crt > 0 ? col.crt : nowSec;

  db.run("INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, '{}', ?, ?, ?, '{}')", [
    exportCrtSec,
    nowSec,
    nowSec,
    JSON.stringify(exportedModels),
    JSON.stringify(exportedDecks),
    JSON.stringify(col.dconf || {})
  ]);

  const staticMediaUrls = new Map<string, string>();
  const noteStmt = db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const note of exportedNotes) {
    const tagsStr = note.tags.length > 0 ? ` ${note.tags.join(" ")} ` : "";
    const normalizedFields = note.fields.map(fld =>
      fld.replace(/src=["'](\/ep1100\/media\/([^"']+))["']/gi, (_m, fullUrl, encodedName) => {
        const decodedName = decodeURIComponent(encodedName);
        staticMediaUrls.set(decodedName, fullUrl);
        return `src="${decodedName}"`;
      })
    );
    const fldsStr = normalizedFields.join("\x1f");
    noteStmt.run([
      note.id,
      note.guid || String(note.id),
      note.mid,
      note.mod || nowSec,
      note.usn || 0,
      tagsStr,
      fldsStr,
      note.sfld || normalizedFields[0] || "",
      note.csum || 0,
      note.flags || 0,
      note.data || "{}"
    ]);
  }
  noteStmt.free();

  // Convert canonical epoch-day `due` back to Anki's collection-relative day format (C02)
  const cardStmt = db.prepare(
    "INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const card of exportedCards) {
    let exportedDue = card.due;
    if (card.queue === 2 || (card.queue === 3 && card.due < 1_000_000_000)) {
      exportedDue = toRelativeAnkiDueDay(card.due, exportCrtSec);
    }
    cardStmt.run([
      card.id,
      card.nid,
      card.did,
      card.ord,
      card.mod || nowSec,
      card.usn || 0,
      card.type,
      card.queue,
      exportedDue,
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

  const revlogStmt = db.prepare("INSERT INTO revlog VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
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

  const binaryDb = db.export();
  db.close();

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
    } else if (dataUrl.startsWith("blob:") || dataUrl.startsWith("http") || dataUrl.startsWith("/")) {
      try {
        const resp = await fetch(dataUrl);
        const ab = await resp.arrayBuffer();
        zip.file(idxStr, ab);
      } catch (e) {
        console.warn(`Failed to package media ${filename}:`, e);
      }
    }
  }

  for (const [filename, url] of staticMediaUrls.entries()) {
    if (col.media && col.media[filename]) continue;
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const ab = await resp.arrayBuffer();
        const idxStr = String(mediaIdx++);
        mediaMap[idxStr] = filename;
        zip.file(idxStr, ab);
      }
    } catch (e) {
      console.warn(`Failed to package static media ${filename}:`, e);
    }
  }

  zip.file("media", JSON.stringify(mediaMap));

  return await zip.generateAsync({ type: "blob", mimeType: "application/apkg" });
}

export async function importEp1100Decks(targetCol: Collection): Promise<Collection> {
  const res = await fetch("/ep1100/ep1100-bundle.json");
  if (!res.ok) {
    throw new Error(`Failed to fetch EP1100 bundle (HTTP ${res.status})`);
  }
  const bundle = await res.json();
  const updated: Collection = {
    ...targetCol,
    mod: Math.floor(Date.now() / 1000),
    decks: { ...targetCol.decks, ...(bundle.decks || {}) },
    models: { ...targetCol.models, ...(bundle.models || {}) },
    notes: { ...targetCol.notes, ...(bundle.notes || {}) },
    cards: { ...targetCol.cards, ...(bundle.cards || {}) }
  };
  return updated;
}

/**
 * Full RFC 4180 compliant CSV / TSV parser with automatic delimiter detection,
 * BOM stripping, quoted fields, escaped quotes (""), and multiline field support (C07).
 */
export function parseDelimitedRows(rawText: string, explicitDelimiter?: string): string[][] {
  const text = rawText.replace(/^\uFEFF/, ""); // Strip UTF-8 BOM
  if (!text.trim()) return [];

  // Auto-detect delimiter from first non-comment line outside quotes
  let delimiter = explicitDelimiter || "\t";
  if (!explicitDelimiter) {
    const firstLineEnd = text.indexOf("\n");
    const sample = (firstLineEnd >= 0 ? text.slice(0, firstLineEnd) : text).trim();
    const countOutsideQuotes = (char: string) => {
      let count = 0;
      let inQuotes = false;
      for (let i = 0; i < sample.length; i++) {
        if (sample[i] === '"') inQuotes = !inQuotes;
        else if (!inQuotes && sample[i] === char) count++;
      }
      return count;
    };
    const tabCount = countOutsideQuotes("\t");
    const commaCount = countOutsideQuotes(",");
    const semiCount = countOutsideQuotes(";");

    if (tabCount > 0) delimiter = "\t";
    else if (commaCount >= semiCount && commaCount > 0) delimiter = ",";
    else if (semiCount > 0) delimiter = ";";
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += ch;
        i++;
        continue;
      }
    } else {
      if (ch === '"' && currentField.length === 0) {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === delimiter) {
        currentRow.push(currentField);
        currentField = "";
        i++;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
          i++;
        }
        currentRow.push(currentField);
        currentField = "";
        if (
          currentRow.some(cell => cell.trim().length > 0) &&
          !currentRow[0].trim().startsWith("#")
        ) {
          rows.push(currentRow);
        }
        currentRow = [];
        i++;
        continue;
      }
      currentField += ch;
      i++;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (
      currentRow.some(cell => cell.trim().length > 0) &&
      !currentRow[0].trim().startsWith("#")
    ) {
      rows.push(currentRow);
    }
  }

  return rows;
}

export function importCsv(
  text: string,
  targetCol: Collection,
  did: number,
  mid: number,
  delimiter?: string
): ImportResult {
  if (text.length > 25 * 1024 * 1024) {
    throw new Error("CSV/TSV file exceeds maximum allowed size (25 MB).");
  }

  const rows = parseDelimitedRows(text, delimiter);
  const model = targetCol.models[mid] || Object.values(targetCol.models)[0];
  const fieldCount = model.flds.length;

  let noteCount = 0;
  let cardCount = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const parts of rows) {
    if (parts.length < 1 || !parts[0]?.trim()) continue;

    const fields: string[] = [];
    for (let f = 0; f < fieldCount; f++) {
      fields.push(sanitizeCardHtml(parts[f]?.trim() || ""));
    }

    const tags =
      parts.length > fieldCount
        ? parts[fieldCount]
            .trim()
            .split(/\s+/)
            .filter(Boolean)
        : [];

    const noteId = generateUniqueId(targetCol.notes);
    const note: Note = {
      id: noteId,
      guid: `csv_${noteId}`,
      mid: model.id,
      mod: now,
      usn: 0,
      tags,
      fields,
      sfld: fields[0] || "",
      csum: 0,
      flags: 0,
      data: "{}"
    };
    targetCol.notes[noteId] = note;
    noteCount++;

    model.tmpls.forEach((_tmpl, ord) => {
      const cardId = generateUniqueId(targetCol.cards);
      const card: Card = {
        id: cardId,
        nid: noteId,
        did,
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
      targetCol.cards[cardId] = card;
      cardCount++;
    });
  }

  return {
    deckCount: 0,
    noteCount,
    cardCount,
    revlogCount: 0,
    mediaCount: 0
  };
}

export function exportDeckCsv(col: Collection, did?: number): string {
  const lines: string[] = [];
  const cards = Object.values(col.cards).filter(c => !did || c.did === did);
  const visitedNotes = new Set<number>();

  for (const card of cards) {
    if (visitedNotes.has(card.nid)) continue;
    visitedNotes.add(card.nid);

    const note = col.notes[card.nid];
    if (!note) continue;

    const escapedFields = note.fields.map(f => f.replace(/\t/g, " ").replace(/\n/g, "<br>"));
    if (note.tags.length > 0) {
      escapedFields.push(note.tags.join(" "));
    }
    lines.push(escapedFields.join("\t"));
  }

  return lines.join("\n");
}
