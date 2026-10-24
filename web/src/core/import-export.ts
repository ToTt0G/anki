// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import JSZip from "jszip";
import initSqlJs from "sql.js";
import { findClozeNumbers } from "./cloze";
import { generateUniqueId } from "./ids";
import { inspectMediaBytes, MAX_SINGLE_MEDIA_BYTES, normalizeMediaFilename } from "./media-validation";
import { sanitizeCardCss, sanitizeCardHtml } from "./sanitize";
import { normalizeReviewDueDay, toRelativeAnkiDueDay } from "./scheduler";
import { safeDecodeURIComponent } from "./template";
import { Card, CardQueue, CardType, Collection, Deck, Note, NoteType, RevlogEntry } from "./types";

export { MAX_SINGLE_MEDIA_BYTES };

let sqlPromise: Promise<any> | null = null;

async function getSql() {
    if (!sqlPromise) {
        const initFn = (window as any).initSqlJs || initSqlJs;
        sqlPromise = initFn({
            locateFile: (file: string) => `/vendor/sql.js/${file}`,
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
    warnings?: string[];
}

export interface ImportOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    onProgress?: (stage: string) => void;
    /** Opt-in to overwrite existing card scheduling when re-importing duplicate cards (H-02). Defaults to false. */
    overwriteScheduling?: boolean;
}

// Resource budgets for untrusted archives (SEC-06)
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_EXPANDED_BYTES = 160 * 1024 * 1024; // 160 MB
export const MAX_ZIP_ENTRIES = 2_500;
export const MAX_IMPORT_RECORDS = 50_000;
export const MAX_IMPORT_REVLOG_RECORDS = 250_000;
export const MAX_IMPORT_MODELS = 500;
export const MAX_IMPORT_DECKS = 2_000;
export const MAX_IMPORT_DCONF = 500;
export const MAX_MEDIA_MAP_BYTES = 16 * 1024 * 1024; // 16 MB for the decompressed media map
const DEFAULT_IMPORT_TIMEOUT_MS = 30_000;

interface ZipMemberInfo {
    name: string;
    compressedSize: number;
    uncompressedSize: number;
}

const EOCD_SIG = 0x06054b50; // "PK\x05\x06"
const EOCD64_LOCATOR_SIG = 0x07064b50; // "PK\x06\x07"
const EOCD64_SIG = 0x06064b50; // "PK\x06\x06"
const CD_SIG = 0x02014b50; // "PK\x01\x02"
const ZIP64_EXTRA_ID = 0x0001;

const LE16 = (dv: DataView, off: number) => dv.getUint16(off, true);
const LE32 = (dv: DataView, off: number) => dv.getUint32(off, true);
function LE64(dv: DataView, off: number): number {
    const lo = LE32(dv, off);
    const hi = LE32(dv, off + 4);
    if (hi > 0x1f_ffff) { return Infinity; }
    return hi * 0x1_0000_0000 + lo;
}

/**
 * Parse the ZIP central directory so each member's *uncompressed* size is known before any
 * decompression happens (SEC-06).
 */
export function readZipCentralDirectory(bytes: ArrayBuffer): Map<string, ZipMemberInfo> {
    const dv = new DataView(bytes);
    const len = dv.byteLength;

    const earliestEocd = Math.max(0, len - 22 - 0xffff);
    let eocdOffset = -1;
    for (let off = len - 22; off >= earliestEocd; off--) {
        if (LE32(dv, off) === EOCD_SIG && off + 22 + LE16(dv, off + 20) === len) {
            eocdOffset = off;
            break;
        }
    }
    if (eocdOffset < 0) {
        throw new Error("Invalid ZIP archive (no central directory found).");
    }

    let entryCount = LE16(dv, eocdOffset + 10);
    let cdSize = LE32(dv, eocdOffset + 12);
    let cdOffset = LE32(dv, eocdOffset + 16);

    if (
        entryCount === 0xffff
        || cdSize === 0xffffffff
        || cdOffset === 0xffffffff
    ) {
        const locatorOffset = eocdOffset - 20;
        if (locatorOffset >= 0 && LE32(dv, locatorOffset) === EOCD64_LOCATOR_SIG) {
            const eocd64Offset = LE64(dv, locatorOffset + 8);
            if (eocd64Offset >= 0 && eocd64Offset + 56 <= len && LE32(dv, eocd64Offset) === EOCD64_SIG) {
                entryCount = Math.min(LE64(dv, eocd64Offset + 32), 0xffffff);
                cdSize = LE64(dv, eocd64Offset + 40);
                cdOffset = LE64(dv, eocd64Offset + 48);
            }
        }
    }

    const result = new Map<string, ZipMemberInfo>();
    if (
        !Number.isFinite(cdOffset)
        || cdOffset < 0
        || cdOffset + cdSize > len
        || entryCount <= 0
        || entryCount > MAX_ZIP_ENTRIES * 4
    ) {
        throw new Error("Invalid or oversized ZIP central directory.");
    }

    let off = cdOffset;
    const entriesEnd = Math.min(cdOffset + cdSize, len);
    for (let i = 0; i < entryCount && off + 46 <= entriesEnd; i++) {
        if (LE32(dv, off) !== CD_SIG) { break; }

        let compressedSize = LE32(dv, off + 20);
        let uncompressedSize = LE32(dv, off + 24);
        const nameLen = LE16(dv, off + 28);
        const extraLen = LE16(dv, off + 30);
        const commentLen = LE16(dv, off + 32);

        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
            let e = off + 46 + nameLen;
            const extraEnd = e + extraLen;
            while (e + 4 <= extraEnd && off + 46 + nameLen + extraLen <= len) {
                const fieldId = LE16(dv, e);
                const fieldSize = LE16(dv, e + 2);
                if (fieldId === ZIP64_EXTRA_ID) {
                    let p = e + 4;
                    if (uncompressedSize === 0xffffffff && p + 8 <= e + 4 + fieldSize) {
                        uncompressedSize = LE64(dv, p);
                        p += 8;
                    }
                    if (compressedSize === 0xffffffff && p + 8 <= e + 4 + fieldSize) {
                        compressedSize = LE64(dv, p);
                    }
                    break;
                }
                e += 4 + fieldSize;
            }
        }

        const nameStart = off + 46;
        if (nameStart + nameLen <= len) {
            const name = new TextDecoder("utf-8").decode(new Uint8Array(bytes, nameStart, nameLen));
            result.set(name, { name, compressedSize, uncompressedSize });
        }
        off = nameStart + nameLen + extraLen + commentLen;
    }

    return result;
}

/** Stop inflation as soon as the actual output exceeds its budget, even if ZIP metadata lies (SEC-06). */
export function inflateZipMember(
    entry: JSZip.JSZipObject,
    limit: number,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Import cancelled."));
            return;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        let stopped = false;
        const stream = (entry as JSZip.JSZipObject & {
            internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
        }).internalStream("uint8array");

        const onAbort = () => {
            if (stopped) { return; }
            stopped = true;
            stream.pause();
            chunks.length = 0;
            reject(new Error("Import cancelled."));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        stream.on("data", chunk => {
            if (stopped) { return; }
            size += chunk.length;
            if (size > limit) {
                stopped = true;
                stream.pause();
                chunks.length = 0;
                signal?.removeEventListener("abort", onAbort);
                reject(new Error("Archive decompressed member exceeds memory budget."));
                return;
            }
            chunks.push(chunk);
        });
        stream.on("error", err => {
            signal?.removeEventListener("abort", onAbort);
            reject(err);
        });
        stream.on("end", () => {
            signal?.removeEventListener("abort", onAbort);
            if (stopped) { return; }
            const result = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            resolve(result);
        });
        stream.resume();
    });
}

function checkBudgetAndCancellation(startedAtMs: number, timeoutMs: number, signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new Error("Import cancelled.");
    }
    if (Date.now() - startedAtMs > timeoutMs) {
        throw new Error("Archive import timed out (exceeded execution budget).");
    }
}

export async function importApkg(
    file: File | Blob,
    targetCol: Collection,
    options?: ImportOptions,
): Promise<ImportResult> {
    const startedAtMs = Date.now();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;
    const signal = options?.signal;
    const overwriteScheduling = Boolean(options?.overwriteScheduling);
    const warnings: string[] = [];

    if (file.size > MAX_ARCHIVE_BYTES) {
        throw new Error(
            `Package exceeds maximum allowed size (${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB).`,
        );
    }

    checkBudgetAndCancellation(startedAtMs, timeoutMs, signal);
    options?.onProgress?.("Reading archive headers...");

    // U-04: Parse central directory and release the raw archive ArrayBuffer immediately after
    let centralDirectory: Map<string, ZipMemberInfo>;
    {
        const archiveBytes = await file.arrayBuffer();
        try {
            centralDirectory = readZipCentralDirectory(archiveBytes);
        } catch (e) {
            throw new Error((e as Error)?.message || "Invalid ZIP archive.");
        }
    }
    const expandedSizeOf = (name: string): number | undefined => centralDirectory.get(name)?.uncompressedSize;

    const zip = await JSZip.loadAsync(file);
    const fileNames = Object.keys(zip.files);

    if (fileNames.length > MAX_ZIP_ENTRIES) {
        throw new Error(`Archive contains too many entries (${fileNames.length} > ${MAX_ZIP_ENTRIES}).`);
    }

    const hasAnki21b = Boolean(zip.file("collection.anki21b"));
    const dbFile = zip.file("collection.anki21") || zip.file("collection.anki2");

    if (!dbFile) {
        if (hasAnki21b) {
            throw new Error(
                "This package uses Anki's compressed .anki21b format without legacy compatibility. When exporting from desktop Anki, enable 'Support older Anki versions'.",
            );
        }
        throw new Error("Invalid .apkg file: missing collection.anki2 or collection.anki21 database.");
    }

    const dbName = zip.file("collection.anki21") ? "collection.anki21" : "collection.anki2";
    const dbExpandedSize = expandedSizeOf(dbName);
    if (dbExpandedSize !== undefined && dbExpandedSize > MAX_EXPANDED_BYTES) {
        throw new Error(
            `Decompressed database exceeds the memory budget (${dbExpandedSize} > ${MAX_EXPANDED_BYTES} bytes).`,
        );
    }

    checkBudgetAndCancellation(startedAtMs, timeoutMs, signal);
    options?.onProgress?.("Decompressing collection database...");

    let dbBinary: Uint8Array | null = await inflateZipMember(dbFile, MAX_EXPANDED_BYTES, signal);
    let totalExpandedBytes = dbBinary.byteLength;
    if (totalExpandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error("Decompressed database exceeds memory budget.");
    }

    const SQL = await getSql();
    const db = new SQL.Database(dbBinary);
    dbBinary = null; // U-04: Release decompressed buffer copy once SQLite WASM DB is initialized

    let deckCount = 0;
    let noteCount = 0;
    let cardCount = 0;
    let revlogCount = 0;
    let mediaCount = 0;
    let duplicateCount = 0;
    const importedDeckNames: string[] = [];

    try {
        // 1. Parse media map with resource budgets & signature validation (SEC-06, SEC-13, M-07, L-02)
        const mediaFile = zip.file("media");
        const extractedMedia: Record<string, string> = {};
        const originalNames = new Map<string, string>();
        const mediaMapSize = mediaFile ? expandedSizeOf("media") : undefined;
        const mediaMapAllowed = mediaMapSize === undefined || mediaMapSize <= MAX_MEDIA_MAP_BYTES;
        if (mediaFile && !mediaMapAllowed) {
            warnings.push(
                `Skipped media map because its decompressed size (${mediaMapSize} bytes) exceeds the safety budget.`,
            );
        }
        if (mediaFile && mediaMapAllowed) {
            try {
                options?.onProgress?.("Inspecting media attachments...");
                const mediaMapBytes = await inflateZipMember(
                    mediaFile,
                    Math.min(MAX_MEDIA_MAP_BYTES, MAX_EXPANDED_BYTES - totalExpandedBytes),
                    signal,
                );
                totalExpandedBytes += mediaMapBytes.byteLength;
                const mediaJsonStr = new TextDecoder().decode(mediaMapBytes);
                const mediaMap: Record<string, string> = JSON.parse(mediaJsonStr);
                const mediaEntries = Object.entries(mediaMap);
                if (mediaEntries.length > MAX_ZIP_ENTRIES) {
                    throw new Error(`Archive media map contains too many entries (${mediaEntries.length}).`);
                }

                for (const [archiveKey, realFilename] of mediaEntries) {
                    checkBudgetAndCancellation(startedAtMs, timeoutMs, signal);
                    const safeFilename = normalizeMediaFilename(realFilename);
                    if (!safeFilename) {
                        warnings.push(`Skipped media '${String(realFilename)}': invalid or disallowed filename.`);
                        continue;
                    }

                    const previousOriginal = originalNames.get(safeFilename);
                    if (previousOriginal !== undefined && previousOriginal !== realFilename) {
                        throw new Error(`Media filename collision: '${previousOriginal}' and '${realFilename}' both normalize to '${safeFilename}'. Re-export with unique names.`);
                    }
                    originalNames.set(safeFilename, realFilename);
                    const entry = zip.file(archiveKey);
                    if (!entry) { continue; }

                    const memberSize = expandedSizeOf(String(archiveKey));
                    if (memberSize !== undefined) {
                        if (memberSize > MAX_SINGLE_MEDIA_BYTES) {
                            warnings.push(`Skipped media '${safeFilename}': exceeds single-file size limit.`);
                            continue;
                        }
                        totalExpandedBytes += memberSize;
                        if (totalExpandedBytes > MAX_EXPANDED_BYTES) {
                            throw new Error("Archive decompressed media exceeds memory budget.");
                        }
                    }

                    const rawBytes = await inflateZipMember(
                        entry,
                        Math.min(MAX_SINGLE_MEDIA_BYTES, MAX_EXPANDED_BYTES - totalExpandedBytes + (memberSize ?? 0)),
                        signal,
                    );
                    if (rawBytes.byteLength > MAX_SINGLE_MEDIA_BYTES) {
                        warnings.push(`Skipped media '${safeFilename}': exceeds single-file size limit.`);
                        continue;
                    }
                    totalExpandedBytes += rawBytes.byteLength - (memberSize ?? 0);
                    if (totalExpandedBytes > MAX_EXPANDED_BYTES) {
                        throw new Error("Archive decompressed media exceeds memory budget.");
                    }

                    const inspected = inspectMediaBytes(rawBytes);
                    if (!inspected.ok) {
                        warnings.push(`Skipped media '${safeFilename}': ${inspected.error}.`);
                        continue;
                    }

                    let binary = "";
                    const chunkSize = 0x8000;
                    for (let i = 0; i < rawBytes.length; i += chunkSize) {
                        binary += String.fromCharCode.apply(
                            null,
                            Array.from(rawBytes.subarray(i, i + chunkSize)),
                        );
                    }
                    const base64 = btoa(binary);
                    extractedMedia[safeFilename] = `data:${inspected.mime};base64,${base64}`;
                    mediaCount++;
                }
            } catch (e: any) {
                if (
                    e?.message?.includes("memory budget")
                    || e?.message?.includes("cancelled")
                    || e?.message?.includes("timed out")
                    || e?.message?.includes("too many entries")
                    || e?.message?.includes("Media filename collision")
                ) {
                    throw e;
                }
                warnings.push(`Media table could not be parsed: ${e?.message || "malformed media JSON"}.`);
            }
        }

        // 2. Read col metadata including `crt` — abort if required models/decks metadata is corrupt (M-07)
        checkBudgetAndCancellation(startedAtMs, timeoutMs, signal);
        options?.onProgress?.("Reading decks and note types...");
        const colRes = db.exec("SELECT crt, models, decks, dconf FROM col LIMIT 1");
        if (colRes.length === 0 || colRes[0].values.length === 0) {
            throw new Error("Invalid .apkg database: missing required collection metadata (col table).");
        }

        let sourceCrtSec = targetCol.crt || Math.floor(Date.now() / 1000);
        const deckIdRemap = new Map<number, number>();
        const modelIdRemap = new Map<number, number>();

        const [rawCrt, modelsJson, decksJson, dconfJson] = colRes[0].values[0];
        if (typeof rawCrt === "number" && rawCrt > 0) {
            sourceCrtSec = rawCrt;
            if (!targetCol.crt) {
                targetCol.crt = rawCrt;
            }
        }

        // 3. Parse models with collision-safe ID mapping & count limits (C06, SEC-06, M-07)
        let modelsObj: Record<string, any>;
        try {
            modelsObj = JSON.parse(String(modelsJson || ""));
            if (!modelsObj || typeof modelsObj !== "object" || Array.isArray(modelsObj)) {
                throw new Error("models is not an object");
            }
        } catch {
            throw new Error("Invalid .apkg database: corrupt or missing note types (models JSON).");
        }
        const modelEntries = Object.entries<any>(modelsObj);
        if (modelEntries.length === 0) {
            throw new Error("Invalid .apkg database: package contains no note types.");
        }
        if (modelEntries.length > MAX_IMPORT_MODELS) {
            throw new Error(`Archive contains too many note types (${modelEntries.length} > ${MAX_IMPORT_MODELS}).`);
        }
        for (const [midStr, m] of modelEntries) {
            const sourceMid = Number(midStr);
            let targetMid = sourceMid;
            const existingModel = targetCol.models[sourceMid];
            if (existingModel && existingModel.name !== (m.name || "Imported Note Type")) {
                targetMid = generateUniqueId(targetCol.models);
            }
            modelIdRemap.set(sourceMid, targetMid);

            const model: NoteType = {
                id: targetMid,
                name: String(m.name || "Imported Note Type").slice(0, 256),
                type: m.type === 1 ? 1 : 0,
                mod: m.mod || Math.floor(Date.now() / 1000),
                usn: 0,
                flds: (m.flds || []).slice(0, 64).map((f: any, idx: number) => ({
                    name: String(f.name || `Field ${idx + 1}`).slice(0, 256),
                    ord: f.ord ?? idx,
                    sticky: !!f.sticky,
                    rtl: !!f.rtl,
                    font: f.font || "Arial",
                    size: f.size || 20,
                })),
                tmpls: (m.tmpls || []).slice(0, 64).map((t: any, idx: number) => ({
                    name: String(t.name || `Card ${idx + 1}`).slice(0, 256),
                    ord: t.ord ?? idx,
                    qfmt: String(t.qfmt || "{{Front}}").slice(0, 128_000),
                    afmt: String(t.afmt || "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}").slice(0, 128_000),
                })),
                css: sanitizeCardCss(String(m.css || "").slice(0, 128_000)),
            };
            targetCol.models[targetMid] = model;
        }

        // 4. Parse decks with name matching, collision-safe ID mapping & count limits (C06, SEC-06, M-07)
        let decksObj: Record<string, any>;
        try {
            decksObj = JSON.parse(String(decksJson || ""));
            if (!decksObj || typeof decksObj !== "object" || Array.isArray(decksObj)) {
                throw new Error("decks is not an object");
            }
        } catch {
            throw new Error("Invalid .apkg database: corrupt or missing decks metadata.");
        }
        const deckEntries = Object.entries<any>(decksObj);
        if (deckEntries.length === 0) {
            throw new Error("Invalid .apkg database: package contains no decks.");
        }
        if (deckEntries.length > MAX_IMPORT_DECKS) {
            throw new Error(`Archive contains too many decks (${deckEntries.length} > ${MAX_IMPORT_DECKS}).`);
        }
        const existingDeckByName = new Map<string, number>();
        for (const d of Object.values(targetCol.decks)) {
            existingDeckByName.set(d.name, d.id);
        }

        for (const [didStr, d] of deckEntries) {
            const sourceDid = Number(didStr);
            const deckName = String(d.name || "Imported Deck").slice(0, 512);

            if (
                hasAnki21b
                && deckName.toLowerCase().includes("please update to the latest anki")
            ) {
                throw new Error(
                    "This package uses Anki's newer .anki21b format. Please re-export from Anki with 'Support older Anki versions' checked.",
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
                    desc: String(d.desc || "").slice(0, 16_384),
                    collapsed: !!d.collapsed,
                    conf: d.conf || 1,
                    dyn: d.dyn || 0,
                    mod: d.mod || Math.floor(Date.now() / 1000),
                    usn: 0,
                };
                targetCol.decks[targetDid] = deck;
                existingDeckByName.set(deckName, targetDid);
                if (targetDid !== 1) {
                    deckCount++;
                    importedDeckNames.push(deckName);
                }
            }
        }

        // 5. Parse dconf with count limits & warning collection (M-07)
        try {
            if (dconfJson) {
                const dconfObj = JSON.parse(dconfJson as string);
                const dconfEntries = Object.entries<any>(dconfObj);
                if (dconfEntries.length > MAX_IMPORT_DCONF) {
                    throw new Error(`Archive contains too many deck configs (${dconfEntries.length}).`);
                }
                for (const [dcidStr, dc] of dconfEntries) {
                    const dcid = Number(dcidStr);
                    if (!targetCol.dconf[dcid]) {
                        targetCol.dconf[dcid] = {
                            id: dcid,
                            name: String(dc.name || "Default").slice(0, 256),
                            new: {
                                delays: dc.new?.delays || [1, 10],
                                ints: dc.new?.ints || [1, 4],
                                initialFactor: dc.new?.initialFactor || 2500,
                                perDay: dc.new?.perDay ?? 20,
                                order: dc.new?.order ?? 1,
                            },
                            rev: {
                                perDay: dc.rev?.perDay ?? 200,
                                ease4: dc.rev?.ease4 || 1.3,
                                ivlFct: dc.rev?.ivlFct || 1.0,
                                maxIvl: dc.rev?.maxIvl || 36500,
                                hardFactor: dc.rev?.hardFactor || 1.2,
                            },
                            lapse: {
                                delays: dc.lapse?.delays || [10],
                                mult: dc.lapse?.mult ?? 0,
                                minInt: dc.lapse?.minInt || 1,
                                leechFails: dc.lapse?.leechFails || 8,
                                leechAction: dc.lapse?.leechAction ?? 0,
                            },
                            timer: dc.timer || 0,
                            maxTaken: dc.maxTaken || 60,
                        };
                    }
                }
            }
        } catch (e: any) {
            if (e?.message?.includes("too many deck configs")) { throw e; }
            warnings.push(`Deck configuration (dconf) could not be parsed; using default preset.`);
        }

        // 6. Read notes with GUID deduplication & collision-safe ID remapping (C06, S01)
        checkBudgetAndCancellation(startedAtMs, timeoutMs, signal);
        options?.onProgress?.("Importing notes...");
        const existingNotesByGuid = new Map<string, Note>();
        for (const n of Object.values(targetCol.notes)) {
            if (n.guid) { existingNotesByGuid.set(n.guid, n); }
        }

        const noteIdRemap = new Map<number, number>();
        const notesRes = db.exec("SELECT id, guid, mid, mod, tags, flds, sfld FROM notes");
        if (notesRes.length > 0) {
            if (notesRes[0].values.length > MAX_IMPORT_RECORDS) {
                throw new Error(`Archive contains too many notes (${notesRes[0].values.length}).`);
            }

            for (let idx = 0; idx < notesRes[0].values.length; idx++) {
                if ((idx & 0xff) === 0) {
                    checkBudgetAndCancellation(startedAtMs, timeoutMs, signal);
                }
                const row = notesRes[0].values[idx];
                const [id, guid, mid, mod, tagsStr, fldsStr, sfld] = row;
                const sourceNid = id as number;
                const guidStr = String(guid || `guid_${sourceNid}`);
                const fields = (fldsStr as string).split("\x1f").map(f => sanitizeCardHtml(f));
                const tags = (tagsStr as string)
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean);

                if (
                    hasAnki21b
                    && notesRes[0].values.length === 1
                    && fields[0]?.toLowerCase().includes("please update to the latest anki")
                ) {
                    throw new Error(
                        "This package uses Anki's newer .anki21b format. Please re-export from Anki with 'Support older Anki versions' checked.",
                    );
                }

                const existingByGuid = existingNotesByGuid.get(guidStr);
                let targetNid: number;

                if (existingByGuid) {
                    targetNid = existingByGuid.id;
                    duplicateCount++;
                    if ((mod as number) >= (existingByGuid.mod || 0)) {
                        targetCol.notes[targetNid] = {
                            ...existingByGuid,
                            mid: modelIdRemap.get(mid as number) ?? (mid as number),
                            mod: mod as number,
                            tags,
                            fields,
                            sfld: sanitizeCardHtml(String(sfld || fields[0] || "")),
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
                        data: "{}",
                    };
                    targetCol.notes[targetNid] = newNote;
                    existingNotesByGuid.set(guidStr, newNote);
                    noteCount++;
                }

                noteIdRemap.set(sourceNid, targetNid);
            }
        }

        // 7. Read cards and preserve newer existing study progress on duplicates unless overwriteScheduling is set (H-02)
        checkBudgetAndCancellation(startedAtMs, timeoutMs, signal);
        options?.onProgress?.("Importing cards...");
        const cardIdRemap = new Map<number, number>();
        const existingCardByNidOrd = new Map<string, Card>();
        for (const c of Object.values(targetCol.cards)) {
            existingCardByNidOrd.set(`${c.nid}:${c.ord}`, c);
        }

        const cardsRes = db.exec(
            "SELECT id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards",
        );
        if (cardsRes.length > 0) {
            if (cardsRes[0].values.length > MAX_IMPORT_RECORDS) {
                throw new Error(`Archive contains too many cards (${cardsRes[0].values.length}).`);
            }

            for (let idx = 0; idx < cardsRes[0].values.length; idx++) {
                if ((idx & 0xff) === 0) {
                    checkBudgetAndCancellation(startedAtMs, timeoutMs, signal);
                }
                const row = cardsRes[0].values[idx];
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
                    data,
                ] = row;
                const sourceCid = id as number;
                const targetNid = noteIdRemap.get(nid as number) ?? (nid as number);
                const targetDid = deckIdRemap.get(did as number) ?? (did as number);
                const cardOrd = (ord as number) || 0;
                const cardQueue = (queue as number) as CardQueue;
                const rawDue = due as number;

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

                const importedCardObj: Card = {
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
                    data: (data as string) || "{}",
                };

                // H-02: Preserve existing card scheduling when merging duplicate cards unless
                // `overwriteScheduling` is explicitly enabled or the existing card is unstudied
                // and older than the imported card.
                if (existingCard && !overwriteScheduling) {
                    const existingIsMoreStudied = (existingCard.reps || 0) > (importedCardObj.reps || 0);
                    const existingIsNewer = (existingCard.mod || 0) >= (importedCardObj.mod || 0);
                    if (existingIsMoreStudied || existingIsNewer || (existingCard.reps || 0) > 0) {
                        targetCol.cards[targetCid] = existingCard;
                        continue;
                    }
                }

                targetCol.cards[targetCid] = importedCardObj;
                existingCardByNidOrd.set(`${targetNid}:${cardOrd}`, importedCardObj);
                if (!existingCard) {
                    cardCount++;
                }
            }
        }

        // An absent revlog table is legitimate for a minimal archive; corruption is not.
        const hasRevlogTable = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'revlog'")
            .some(result => result.values.length > 0);
        if (!hasRevlogTable) {
            warnings.push("This archive has no review-history table; no historical reviews were imported.");
        } else {
            const countRes = db.exec("SELECT COUNT(*) FROM revlog");
            const totalRevlogInDb = Number(countRes?.[0]?.values?.[0]?.[0] || 0);
            if (totalRevlogInDb > MAX_IMPORT_REVLOG_RECORDS) {
                throw new Error(
                    `Archive contains too many review log entries (${totalRevlogInDb} > ${MAX_IMPORT_REVLOG_RECORDS}).`,
                );
            }

            const revlogRes = db.exec(
                "SELECT id, cid, usn, ease, ivl, lastIvl, factor, time, type FROM revlog",
            );
            if (revlogRes.length > 0) {
                if (revlogRes[0].values.length > MAX_IMPORT_REVLOG_RECORDS) {
                    throw new Error(
                        `Archive contains too many review log entries (${
                            revlogRes[0].values.length
                        } > ${MAX_IMPORT_REVLOG_RECORDS}).`,
                    );
                }
                if (!targetCol.revlog) {
                    targetCol.revlog = [];
                }
                const existingRevById = new Map<number, RevlogEntry>(
                    targetCol.revlog.map(r => [r.id, r]),
                );
                for (let idx = 0; idx < revlogRes[0].values.length; idx++) {
                    if ((idx & 0x3ff) === 0) {
                        checkBudgetAndCancellation(startedAtMs, timeoutMs, signal);
                    }
                    const row = revlogRes[0].values[idx];
                    const [id, cid, usn, ease, ivl, lastIvl, factor, time, type] = row;
                    let revId = id as number;
                    const mappedCid = cardIdRemap.get(cid as number) ?? (cid as number);
                    const easeVal = (ease as any) || 3;
                    const ivlVal = ivl as number;
                    const lastIvlVal = (lastIvl as number) || 0;

                    // M-08: Compare full record identity on revId collision. Skip only if it is the
                    // exact same review; if it is a distinct review with a colliding timestamp ID,
                    // increment revId so distinct review history is preserved.
                    const colliding = existingRevById.get(revId);
                    if (colliding) {
                        if (
                            colliding.cid === mappedCid
                            && colliding.ease === easeVal
                            && colliding.ivl === ivlVal
                            && colliding.lastIvl === lastIvlVal
                        ) {
                            continue;
                        }
                        while (existingRevById.has(revId)) {
                            revId++;
                        }
                    }

                    const newRevEntry: RevlogEntry = {
                        id: revId,
                        cid: mappedCid,
                        usn: (usn as number) || 0,
                        ease: easeVal,
                        ivl: ivlVal,
                        lastIvl: lastIvlVal,
                        factor: (factor as number) || 2500,
                        time: (time as number) || 0,
                        type: (type as number) || 0,
                    };
                    existingRevById.set(revId, newRevEntry);
                    targetCol.revlog.push(newRevEntry);
                    revlogCount++;
                }
            }
        }

        Object.assign(targetCol.media, extractedMedia);

        return {
            deckCount,
            noteCount,
            cardCount,
            revlogCount,
            mediaCount,
            duplicateCount,
            deckNames: importedDeckNames,
            warnings: warnings.length > 0 ? warnings : undefined,
        };
    } finally {
        db.close();
    }
}

/**
 * Determine which media filenames are explicitly referenced by `notes` (and optionally
 * `models` when inspecting the whole collection for orphaned media).
 * Uses exact filename extraction from `src=`, `href=`, `[sound:...]`, and `url(...)` —
 * never broad substring matching or shared note-type templates on single-deck exports (SEC-03, NEW-06).
 */
export function extractReferencedMediaFilenames(
    notes: Note[],
    models: NoteType[] = [],
    includeModelTemplates: boolean = false,
): Set<string> {
    const referenced = new Set<string>();
    const addCandidate = (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("http:") || trimmed.startsWith("https:")) {
            return;
        }
        const decoded = safeDecodeURIComponent(trimmed);
        const baseRaw = trimmed.split("/").pop() || trimmed;
        const baseDecoded = safeDecodeURIComponent(baseRaw);
        const normalized = normalizeMediaFilename(baseDecoded);
        referenced.add(trimmed);
        referenced.add(decoded);
        referenced.add(baseRaw);
        referenced.add(baseDecoded);
        if (normalized) {
            referenced.add(normalized);
        }
    };

    const scanText = (text: string) => {
        if (!text) { return; }
        const attrRe = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
        let m: RegExpExecArray | null;
        while ((m = attrRe.exec(text)) !== null) {
            addCandidate(m[1] ?? m[2] ?? m[3] ?? "");
        }
        const soundRe = /\[sound:([^\]]+)\]/gi;
        while ((m = soundRe.exec(text)) !== null) {
            addCandidate(m[1]);
        }
        const urlRe = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^"')]+))\s*\)/gi;
        while ((m = urlRe.exec(text)) !== null) {
            addCandidate(m[1] ?? m[2] ?? m[3] ?? "");
        }
    };

    for (const note of notes) {
        for (const fld of note.fields || []) {
            scanText(fld);
        }
    }
    if (includeModelTemplates) {
        for (const model of models) {
            scanText(model.css || "");
            for (const tmpl of model.tmpls || []) {
                scanText(tmpl.qfmt || "");
                scanText(tmpl.afmt || "");
            }
        }
    }

    return referenced;
}

/**
 * Find media filenames stored in `col.media` that are not referenced by any note or note type (L-10).
 */
export function findOrphanedMediaFilenames(col: Collection): string[] {
    const referenced = extractReferencedMediaFilenames(
        Object.values(col.notes || {}),
        Object.values(col.models || {}),
        true,
    );
    const orphaned: string[] = [];
    for (const filename of Object.keys(col.media || {})) {
        const normalized = normalizeMediaFilename(filename) || filename;
        if (
            !referenced.has(filename)
            && !referenced.has(normalized)
            && !referenced.has(safeDecodeURIComponent(filename))
        ) {
            orphaned.push(filename);
        }
    }
    return orphaned.sort((a, b) => a.localeCompare(b));
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
        if (col.decks[id]) { exportedDecks[String(id)] = col.decks[id]; }
    }

    const exportedModels: Record<string, NoteType> = {};
    for (const id of matchingModelIds) {
        if (col.models[id]) { exportedModels[String(id)] = col.models[id]; }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const exportCrtSec = col.crt && col.crt > 0 ? col.crt : nowSec;

    db.run("INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, '{}', ?, ?, ?, '{}')", [
        exportCrtSec,
        nowSec,
        nowSec,
        JSON.stringify(exportedModels),
        JSON.stringify(exportedDecks),
        JSON.stringify(col.dconf || {}),
    ]);

    const staticMediaUrls = new Map<string, string>();
    const noteStmt = db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const note of exportedNotes) {
        const tagsStr = note.tags.length > 0 ? ` ${note.tags.join(" ")} ` : "";
        const normalizedFields = note.fields.map(fld =>
            fld.replace(/src=["'](\/ep1100\/media\/([^"']+))["']/gi, (_m, fullUrl, encodedName) => {
                const decodedName = safeDecodeURIComponent(encodedName);
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
            note.data || "{}",
        ]);
    }
    noteStmt.free();

    const cardStmt = db.prepare(
        "INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            card.data || "{}",
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
                r.type || 0,
            ]);
        }
    }
    revlogStmt.free();

    const binaryDb = db.export();
    db.close();

    const zip = new JSZip();
    zip.file("collection.anki2", binaryDb);
    zip.file("collection.anki21", binaryDb);

    // SEC-03 & NEW-06: Build an exact, deck-scoped media reference manifest from `exportedNotes` only
    // when exporting a specific deck, so shared note-type templates or substring matches never
    // leak unrelated media from other decks.
    const referencedMedia = did !== undefined
        ? extractReferencedMediaFilenames(exportedNotes, [], false)
        : null;

    const mediaMap: Record<string, string> = {};
    let mediaIdx = 0;

    for (const [filename, dataUrl] of Object.entries(col.media || {})) {
        const normalizedFn = normalizeMediaFilename(filename) || filename;
        if (
            referencedMedia
            && !referencedMedia.has(filename)
            && !referencedMedia.has(normalizedFn)
            && !referencedMedia.has(safeDecodeURIComponent(filename))
        ) {
            continue;
        }

        const idxStr = String(mediaIdx);
        if (dataUrl.startsWith("data:")) {
            const base64 = dataUrl.split(",")[1];
            if (!base64) { throw new Error(`Cannot export media '${filename}': missing base64 data`); }
            zip.file(idxStr, base64, { base64: true });
        } else if (dataUrl.startsWith("blob:") || dataUrl.startsWith("http") || dataUrl.startsWith("/")) {
            let response: Response;
            try {
                response = await fetch(dataUrl);
            } catch (error) {
                throw new Error(`Cannot export media '${filename}': attachment could not be loaded`, {
                    cause: error,
                });
            }
            if (!response.ok) {
                throw new Error(`Cannot export media '${filename}': HTTP ${response.status}`);
            }
            zip.file(idxStr, await response.arrayBuffer());
        } else {
            throw new Error(`Cannot export media '${filename}': unsupported attachment reference`);
        }
        // The manifest must only reference archive entries that were actually added.
        mediaMap[idxStr] = normalizedFn;
        mediaIdx++;
    }

    for (const [filename, url] of staticMediaUrls.entries()) {
        if (col.media && col.media[filename]) { continue; }
        let response: Response;
        try {
            response = await fetch(url);
        } catch (error) {
            throw new Error(`Cannot export bundled media '${filename}': attachment could not be loaded`, {
                cause: error,
            });
        }
        if (!response.ok) {
            throw new Error(`Cannot export bundled media '${filename}': HTTP ${response.status}`);
        }
        const idxStr = String(mediaIdx++);
        zip.file(idxStr, await response.arrayBuffer());
        mediaMap[idxStr] = filename;
    }

    zip.file("media", JSON.stringify(mediaMap));

    return await zip.generateAsync({ type: "blob", mimeType: "application/apkg" });
}

export function mergeImportedCollectionBundle(
    targetCol: Collection,
    bundle: Partial<Collection>,
): Collection {
    const nowSec = Math.floor(Date.now() / 1000);
    const updated: Collection = {
        ...targetCol,
        mod: nowSec,
        decks: { ...targetCol.decks },
        dconf: { ...targetCol.dconf },
        models: { ...targetCol.models },
        notes: { ...targetCol.notes },
        cards: { ...targetCol.cards },
        revlog: [...(targetCol.revlog || [])],
        media: { ...targetCol.media, ...(bundle.media || {}) },
    };

    const modelIdRemap = new Map<number, number>();
    const existingModelByName = new Map<string, number>();
    for (const m of Object.values(updated.models)) {
        existingModelByName.set(m.name, m.id);
    }

    for (const [midStr, m] of Object.entries(bundle.models || {})) {
        const sourceMid = Number(midStr) || m.id;
        const matchedMid = existingModelByName.get(m.name);
        let targetMid: number;
        if (matchedMid !== undefined) {
            targetMid = matchedMid;
        } else if (!updated.models[sourceMid]) {
            targetMid = sourceMid;
        } else {
            targetMid = generateUniqueId(updated.models);
        }
        modelIdRemap.set(sourceMid, targetMid);
        if (!updated.models[targetMid]) {
            updated.models[targetMid] = {
                ...m,
                id: targetMid,
                css: sanitizeCardCss(m.css || ""),
            };
            existingModelByName.set(m.name, targetMid);
        }
    }

    const deckIdRemap = new Map<number, number>();
    const existingDeckByName = new Map<string, number>();
    for (const d of Object.values(updated.decks)) {
        existingDeckByName.set(d.name, d.id);
    }

    for (const [didStr, d] of Object.entries(bundle.decks || {})) {
        const sourceDid = Number(didStr) || d.id;
        const matchedDid = existingDeckByName.get(d.name);
        let targetDid: number;
        if (matchedDid !== undefined) {
            targetDid = matchedDid;
        } else if (!updated.decks[sourceDid]) {
            targetDid = sourceDid;
        } else {
            targetDid = generateUniqueId(updated.decks);
        }
        deckIdRemap.set(sourceDid, targetDid);
        if (!updated.decks[targetDid]) {
            updated.decks[targetDid] = { ...d, id: targetDid };
            existingDeckByName.set(d.name, targetDid);
        }
    }

    const noteIdRemap = new Map<number, number>();
    const existingNotesByGuid = new Map<string, Note>();
    for (const n of Object.values(updated.notes)) {
        if (n.guid) { existingNotesByGuid.set(n.guid, n); }
    }

    for (const [nidStr, n] of Object.entries(bundle.notes || {})) {
        const sourceNid = Number(nidStr) || n.id;
        const guid = n.guid || `bundle_${sourceNid}`;
        const existingByGuid = existingNotesByGuid.get(guid);
        let targetNid: number;
        if (existingByGuid) {
            targetNid = existingByGuid.id;
        } else if (!updated.notes[sourceNid]) {
            targetNid = sourceNid;
        } else {
            targetNid = generateUniqueId(updated.notes);
        }
        noteIdRemap.set(sourceNid, targetNid);

        if (!existingByGuid) {
            const sanitizedFields = (n.fields || []).map(f => sanitizeCardHtml(f));
            const newNote: Note = {
                ...n,
                id: targetNid,
                guid,
                mid: modelIdRemap.get(n.mid) ?? n.mid,
                fields: sanitizedFields,
                sfld: sanitizeCardHtml(n.sfld || sanitizedFields[0] || ""),
            };
            updated.notes[targetNid] = newNote;
            existingNotesByGuid.set(guid, newNote);
        }
    }

    const existingCardByNidOrd = new Map<string, Card>();
    for (const c of Object.values(updated.cards)) {
        existingCardByNidOrd.set(`${c.nid}:${c.ord}`, c);
    }

    for (const [cidStr, c] of Object.entries(bundle.cards || {})) {
        const sourceCid = Number(cidStr) || c.id;
        const targetNid = noteIdRemap.get(c.nid) ?? c.nid;
        const targetDid = deckIdRemap.get(c.did) ?? c.did;
        const ord = c.ord || 0;
        const existingCard = existingCardByNidOrd.get(`${targetNid}:${ord}`);
        if (existingCard) {
            continue;
        }
        const targetCid = !updated.cards[sourceCid]
            ? sourceCid
            : generateUniqueId(updated.cards);
        const newCard: Card = {
            ...c,
            id: targetCid,
            nid: targetNid,
            did: targetDid,
            ord,
        };
        updated.cards[targetCid] = newCard;
        existingCardByNidOrd.set(`${targetNid}:${ord}`, newCard);
    }

    return updated;
}

export async function importEp1100Decks(targetCol: Collection): Promise<Collection> {
    const res = await fetch("/ep1100/ep1100-bundle.json");
    if (!res.ok) {
        throw new Error(`Failed to fetch EP1100 bundle (HTTP ${res.status})`);
    }
    const bundle = await res.json();
    return mergeImportedCollectionBundle(targetCol, bundle);
}

/**
 * Shared cloze-aware card generator for both manual note creation and CSV/TSV imports (U-02, U-03).
 * Uses an O(1) incrementing `nextDueRef` counter instead of recalculating `Object.keys(cards).length`.
 */
export function createCardsForNote(
    note: Note,
    model: NoteType,
    did: number,
    allocatedCardIds: Set<number>,
    nextDueRef: { value: number },
    nowSec: number,
): Card[] {
    const cards: Card[] = [];
    const isCloze = model.type === 1;

    if (isCloze) {
        const clozeNums = findClozeNumbers((note.fields || []).join("\n"));
        const numsToGenerate = clozeNums.length > 0 ? clozeNums : [1];
        for (const num of numsToGenerate) {
            const cardId = generateUniqueId(allocatedCardIds);
            allocatedCardIds.add(cardId);
            cards.push({
                id: cardId,
                nid: note.id,
                did,
                ord: Math.max(0, num - 1),
                mod: nowSec,
                usn: 0,
                type: 0,
                queue: 0,
                due: nextDueRef.value++,
                ivl: 0,
                factor: 2500,
                reps: 0,
                lapses: 0,
                left: 0,
                odue: 0,
                odid: 0,
                flags: 0,
                data: "{}",
            });
        }
    } else {
        model.tmpls.forEach((_tmpl, ord) => {
            const cardId = generateUniqueId(allocatedCardIds);
            allocatedCardIds.add(cardId);
            cards.push({
                id: cardId,
                nid: note.id,
                did,
                ord,
                mod: nowSec,
                usn: 0,
                type: 0,
                queue: 0,
                due: nextDueRef.value++,
                ivl: 0,
                factor: 2500,
                reps: 0,
                lapses: 0,
                left: 0,
                odue: 0,
                odid: 0,
                flags: 0,
                data: "{}",
            });
        });
    }

    return cards;
}

/**
 * Generate only missing cloze ordinals after an existing note is edited.
 * Previously studied cards retain their identity, scheduling, and review history.
 * Obsolete ordinals are intentionally retained until an explicit removal workflow exists.
 */
export function createMissingClozeCards(
    note: Note,
    model: NoteType,
    col: Collection,
    deckId: number,
): Card[] {
    if (model.type !== 1) { return []; }
    const desired = findClozeNumbers((note.fields || []).join("\n"));
    if (desired.length === 0) { return []; }
    const currentOrdinals = new Set(
        Object.values(col.cards).filter(card => card.nid === note.id).map(card => card.ord),
    );
    if (desired.every(num => currentOrdinals.has(num - 1))) { return []; }

    const takenIds = new Set<number>(Object.keys(col.cards).map(Number));
    const lastNewDue = Object.values(col.cards).reduce(
        (max, card) => card.queue === 0 ? Math.max(max, card.due) : max,
        0,
    );
    const generated = createCardsForNote(
        note,
        model,
        deckId,
        takenIds,
        { value: lastNewDue + 1 },
        Math.floor(Date.now() / 1000),
    );
    return generated.filter(card => !currentOrdinals.has(card.ord));
}

export function parseDelimitedRows(rawText: string, explicitDelimiter?: string): string[][] {
    const text = rawText.replace(/^\uFEFF/, "");
    if (!text.trim()) { return []; }

    let delimiter = explicitDelimiter || "\t";
    if (!explicitDelimiter) {
        const firstLineEnd = text.indexOf("\n");
        const sample = (firstLineEnd >= 0 ? text.slice(0, firstLineEnd) : text).trim();
        const countOutsideQuotes = (char: string) => {
            let count = 0;
            let inQuotes = false;
            for (let i = 0; i < sample.length; i++) {
                if (sample[i] === "\"") { inQuotes = !inQuotes; }
                else if (!inQuotes && sample[i] === char) { count++; }
            }
            return count;
        };
        const tabCount = countOutsideQuotes("\t");
        const commaCount = countOutsideQuotes(",");
        const semiCount = countOutsideQuotes(";");

        if (tabCount > 0) { delimiter = "\t"; }
        else if (commaCount >= semiCount && commaCount > 0) { delimiter = ","; }
        else if (semiCount > 0) { delimiter = ";"; }
    }

    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = "";
    let inQuotes = false;
    let i = 0;

    while (i < text.length) {
        const ch = text[i];

        if (inQuotes) {
            if (ch === "\"") {
                if (i + 1 < text.length && text[i + 1] === "\"") {
                    currentField += "\"";
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
            if (ch === "\"" && currentField.length === 0) {
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
                    currentRow.some(cell => cell.trim().length > 0)
                    && !currentRow[0].trim().startsWith("#")
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
            currentRow.some(cell => cell.trim().length > 0)
            && !currentRow[0].trim().startsWith("#")
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
    delimiter?: string,
): ImportResult {
    if (text.length > 25 * 1024 * 1024) {
        throw new Error("CSV/TSV file exceeds maximum allowed size (25 MB).");
    }

    const rows = parseDelimitedRows(text, delimiter);
    if (rows.length > MAX_IMPORT_RECORDS) {
        throw new Error(`CSV/TSV file contains too many rows (${rows.length} > ${MAX_IMPORT_RECORDS}).`);
    }
    const model = targetCol.models[mid] || Object.values(targetCol.models)[0];
    const fieldCount = model.flds.length;

    let noteCount = 0;
    let cardCount = 0;
    const now = Math.floor(Date.now() / 1000);
    // U-03: Pre-build allocated ID sets and O(1) due counter instead of O(N^2) Object.keys(cards).length
    const allocatedNoteIds = new Set<number>(Object.keys(targetCol.notes).map(Number));
    const allocatedCardIds = new Set<number>(Object.keys(targetCol.cards).map(Number));
    const nextDueRef = { value: allocatedCardIds.size + 1 };

    for (const parts of rows) {
        if (parts.length < 1 || !parts[0]?.trim()) { continue; }

        const fields: string[] = [];
        for (let f = 0; f < fieldCount; f++) {
            fields.push(sanitizeCardHtml(parts[f]?.trim() || ""));
        }

        const tags = parts.length > fieldCount
            ? parts[fieldCount]
                .trim()
                .split(/\s+/)
                .filter(Boolean)
            : [];

        const noteId = generateUniqueId(allocatedNoteIds);
        allocatedNoteIds.add(noteId);
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
            data: "{}",
        };
        targetCol.notes[noteId] = note;
        noteCount++;

        // U-02: Use shared cloze-aware card generator
        const generatedCards = createCardsForNote(
            note,
            model,
            did,
            allocatedCardIds,
            nextDueRef,
            now,
        );
        for (const card of generatedCards) {
            targetCol.cards[card.id] = card;
            cardCount++;
        }
    }

    return {
        deckCount: 0,
        noteCount,
        cardCount,
        revlogCount: 0,
        mediaCount: 0,
    };
}

export function serializeTsvCell(raw: string): string {
    let val = String(raw ?? "").replace(/\r?\n/g, "<br>");
    if (/^\s*[=+\-@]/.test(val) || /^[\t\r]/.test(val)) {
        val = `'${val}`;
    }
    if (val.includes("\t") || val.includes("\"") || val.includes("\n") || val.includes("\r")) {
        return `"${val.replace(/"/g, "\"\"")}"`;
    }
    return val;
}

export function exportDeckCsv(col: Collection, did?: number): string {
    const lines: string[] = [];
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
    }

    const cards = Object.values(col.cards).filter(c => did === undefined || matchingDeckIds.has(c.did));
    const visitedNotes = new Set<number>();

    for (const card of cards) {
        if (visitedNotes.has(card.nid)) { continue; }
        visitedNotes.add(card.nid);

        const note = col.notes[card.nid];
        if (!note) { continue; }

        const escapedFields = note.fields.map(f => serializeTsvCell(f));
        if (note.tags.length > 0) {
            escapedFields.push(serializeTsvCell(note.tags.join(" ")));
        }
        lines.push(escapedFields.join("\t"));
    }

    return lines.join("\n");
}
