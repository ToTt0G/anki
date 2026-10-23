import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeCardCss, sanitizeCardHtml } from "../src/core/sanitize.ts";
import { generateUniqueId, generateUniqueIds } from "../src/core/ids.ts";
import {
  calculateScheduling,
  getDeckCounts,
  getNextStudyCard,
  getTodayDay,
  isCardDueInLearnQueue,
  normalizeReviewDueDay,
  toRelativeAnkiDueDay
} from "../src/core/scheduler.ts";
import { createDefaultCollection } from "../src/core/default-data.ts";
import { calculateTodayStats } from "../src/core/stats.ts";
import { parseDelimitedRows, importCsv, importApkg, exportApkg } from "../src/core/import-export.ts";
import {
  applyClientMutationLocally
} from "../src/core/sync-client.ts";
import {
  clearUserOfflineData,
  enqueueOutboxOp,
  getOutboxOps,
  removeOutboxOp,
  saveCollectionToIdb,
  loadCollectionFromIdb
} from "../src/core/idb-storage.ts";
import {
  validateClientMessage,
  validateCollectionPayload,
  validatePushSubscriptionInput
} from "../server/validation.ts";
import {
  isAllowedRequestOrigin,
  issueSignedWsTicket,
  redactUrlForLog,
  verifySignedWsTicket,
  withSecurityHeaders
} from "../server/auth.ts";

describe("A. Security & Privacy (S01–S12, V01–V03)", () => {
  it("S01/V01: strips scripts, inline event handlers, iframes, and javascript: URIs from card HTML and CSS", () => {
    const maliciousHtml = `
      <div>Safe Question</div>
      <script>fetch('/api/collection')</script>
      <img src="x" onerror="alert(document.cookie)" onload="steal()">
      <svg onload="evil()"><circle r="10"/></svg>
      <a href="javascript:alert(1)">Click</a>
      <iframe src="https://evil.example"></iframe>
    `;
    const cleaned = sanitizeCardHtml(maliciousHtml);
    assert.ok(!cleaned.includes("<script"), "script tag must be removed");
    assert.ok(!cleaned.includes("onerror"), "onerror handler must be removed");
    assert.ok(!cleaned.includes("onload"), "onload handler must be removed");
    assert.ok(!cleaned.includes("javascript:"), "javascript: URI must be neutralized");
    assert.ok(!cleaned.includes("<iframe"), "iframe must be removed");
    assert.ok(cleaned.includes("Safe Question"), "legitimate content preserved");

    const maliciousCss = `
      @import url("https://evil.example/steal.css");
      .card { background: url(javascript:alert(1)); width: expression(alert(1)); color: #111; }
    `;
    const cleanedCss = sanitizeCardCss(maliciousCss);
    assert.ok(!cleanedCss.includes("@import"), "@import must be stripped");
    assert.ok(!cleanedCss.includes("javascript:"), "javascript url in CSS must be stripped");
    assert.ok(!cleanedCss.includes("expression("), "CSS expression must be stripped");
  });

  it("S02/S08/S11: enforces Origin/CSRF checks, redacts tickets in logs, and applies CSP headers", async () => {
    const crossOriginPost = new Request("https://klanki.ezryder.us/api/collection", {
      method: "POST",
      headers: {
        Origin: "https://evil.example.com",
        Cookie: "__session=fake"
      }
    });
    assert.equal(isAllowedRequestOrigin(crossOriginPost, {}), false);

    const sameOriginPost = new Request("https://klanki.ezryder.us/api/collection", {
      method: "POST",
      headers: {
        Origin: "https://klanki.ezryder.us",
        Authorization: "Bearer token"
      }
    });
    assert.equal(isAllowedRequestOrigin(sameOriginPost, {}), true);

    const redacted = redactUrlForLog("https://klanki.ezryder.us/api/ws?ticket=secret_ticket_123");
    assert.ok(!redacted.includes("secret_ticket_123"));
    assert.ok(redacted.includes("REDACTED"));

    const secured = withSecurityHeaders(new Response("ok", { status: 200 }));
    assert.equal(secured.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(secured.headers.get("X-Frame-Options"), "DENY");
    assert.ok(secured.headers.get("Content-Security-Policy")?.includes("default-src 'self'"));

    const { ticket, nonce } = await issueSignedWsTicket("user_123", "test_secret_key");
    const verified = await verifySignedWsTicket(ticket, "test_secret_key");
    assert.equal(verified?.sub, "user_123");
    assert.equal(verified?.nonce, nonce);
    const wrongSecret = await verifySignedWsTicket(ticket, "wrong_secret");
    assert.equal(wrongSecret, null);
  });

  it("S04/S12/V03: validates push endpoints against SSRF and rejects malformed WebSocket messages", () => {
    assert.equal(
      validatePushSubscriptionInput({
        endpoint: "http://fcm.googleapis.com/fcm/send/123",
        keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) }
      }).ok,
      false,
      "HTTP push endpoint must be rejected"
    );

    assert.equal(
      validatePushSubscriptionInput({
        endpoint: "https://127.0.0.1:8080/internal",
        keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) }
      }).ok,
      false,
      "Localhost/private push endpoint must be rejected"
    );

    assert.equal(
      validatePushSubscriptionInput({
        endpoint: "https://fcm.googleapis.com/fcm/send/valid-token",
        keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) }
      }).ok,
      true,
      "Valid FCM HTTPS push endpoint with valid key lengths must pass"
    );

    assert.equal(validateClientMessage({ type: "delete_deck", deckId: -5 }).ok, false);
    assert.equal(validateClientMessage({ type: "delete_deck", deckId: 1 }).ok, false);
    assert.equal(validateClientMessage({ type: "delete_deck", deckId: 42 }).ok, true);
    assert.equal(validateCollectionPayload(null), "Collection must be an object");
  });
});

describe("B. Sync, Outbox, IDs & Data Integrity (D01–D12, V04–V06)", () => {
  it("D06/D11: generates strictly unique IDs even within the same millisecond", () => {
    const ids = generateUniqueIds(500);
    const unique = new Set(ids);
    assert.equal(unique.size, 500, "All 500 rapid IDs must be distinct");

    const collisionSet = new Set<number>([ids[499] + 1]);
    const nextId = generateUniqueId(collisionSet);
    assert.ok(!collisionSet.has(nextId));
  });

  it("D01/D03/D04/S07: persists offline outbox, applies cascading deck deletes, and clears offline storage", async () => {
    const userId = "user_test_sync";
    const col = createDefaultCollection();
    const parentDid = generateUniqueId(col.decks);
    const childDid = generateUniqueId(col.decks);

    col.decks[parentDid] = {
      id: parentDid,
      name: "Course",
      desc: "",
      collapsed: false,
      conf: 1,
      dyn: 0,
      mod: 100,
      usn: 0
    };
    col.decks[childDid] = {
      id: childDid,
      name: "Course::Module1",
      desc: "",
      collapsed: false,
      conf: 1,
      dyn: 0,
      mod: 100,
      usn: 0
    };
    const nid = generateUniqueId(col.notes);
    const cid = generateUniqueId(col.cards);
    col.notes[nid] = {
      id: nid,
      guid: `g_${nid}`,
      mid: 1,
      mod: 100,
      usn: 0,
      tags: [],
      fields: ["Q", "A"],
      sfld: "Q",
      csum: 0,
      flags: 0,
      data: "{}"
    };
    col.cards[cid] = {
      id: cid,
      nid,
      did: childDid,
      ord: 0,
      mod: 100,
      usn: 0,
      type: 0,
      queue: 0,
      due: 1,
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

    // Enqueue offline delete_deck op
    await enqueueOutboxOp({
      opId: "op_del_1",
      userId,
      createdAt: Date.now(),
      msg: { type: "delete_deck", deckId: parentDid }
    });
    const ops = await getOutboxOps(userId);
    assert.equal(ops.length, 1);

    // Apply cascading delete locally
    applyClientMutationLocally(col, ops[0].msg);
    assert.equal(col.decks[parentDid], undefined, "Parent deck deleted");
    assert.equal(col.decks[childDid], undefined, "Child subdeck deleted");
    assert.equal(col.cards[cid], undefined, "Card in child subdeck deleted");
    assert.equal(col.notes[nid], undefined, "Orphaned note deleted");

    await removeOutboxOp(userId, "op_del_1");
    assert.equal((await getOutboxOps(userId)).length, 0);

    await saveCollectionToIdb(userId, col, 5, true);
    const loaded = await loadCollectionFromIdb(userId);
    assert.equal(loaded?.revision, 5);
    assert.equal(loaded?.initialized, true);

    await clearUserOfflineData(userId);
    assert.equal(await loadCollectionFromIdb(userId), null);
  });
});

describe("C. Anki Scheduler, FSRS, Due Dates, Daily Limits & CSV (C01–C12, V07–V08)", () => {
  it("C01/C02/C05: normalizes collection-relative review due dates and round-trips to relative Anki due days", () => {
    const crtSec = 1700000000; // Day 19675
    const crtDay = Math.floor(crtSec / 86400);
    const relativeDue = 30;
    const epochDue = normalizeReviewDueDay(relativeDue, crtSec);
    assert.equal(epochDue, crtDay + 30);

    const exportedRelative = toRelativeAnkiDueDay(epochDue, crtSec);
    assert.equal(exportedRelative, 30);

    // Queue 3 day-learning card due today
    const today = getTodayDay();
    const dayLearnCard: any = { queue: 3, due: today - crtDay };
    assert.equal(isCardDueInLearnQueue(dayLearnCard, Math.floor(Date.now() / 1000), today, crtSec), true);
  });

  it("C03: executes real FSRS scheduling when fsrsEnabled is true and scales intervals by desiredRetention", () => {
    const col = createDefaultCollection();
    const baseConfig = col.dconf[1];
    const reviewCard: any = {
      id: 5001,
      nid: 4001,
      did: 1,
      ord: 0,
      mod: 0,
      usn: 0,
      type: 2,
      queue: 2,
      due: getTodayDay(),
      ivl: 10,
      factor: 2500,
      reps: 3,
      lapses: 0,
      left: 0,
      odue: 0,
      odid: 0,
      flags: 0,
      data: JSON.stringify({ s: 10, d: 5, lastRevDay: getTodayDay() - 10 })
    };

    const highRetentionOpts = calculateScheduling(reviewCard, {
      ...baseConfig,
      fsrsEnabled: true,
      desiredRetention: 0.95
    });
    const lowRetentionOpts = calculateScheduling(reviewCard, {
      ...baseConfig,
      fsrsEnabled: true,
      desiredRetention: 0.80
    });

    const goodHigh = highRetentionOpts.find(o => o.rating === 3)!;
    const goodLow = lowRetentionOpts.find(o => o.rating === 3)!;

    assert.ok(
      goodLow.nextState.ivl > goodHigh.nextState.ivl,
      `Lower target retention (0.80 -> ${goodLow.nextState.ivl}d) must schedule a longer interval than higher target retention (0.95 -> ${goodHigh.nextState.ivl}d)`
    );
    const parsedData = JSON.parse(goodHigh.nextState.data);
    assert.ok(typeof parsedData.s === "number" && parsedData.s > 10);
  });

  it("C04/C09: enforces daily new and review limits and respects ephemeral Custom Study overrides", () => {
    const col = createDefaultCollection();
    col.dconf[1].new.perDay = 1;
    col.dconf[1].rev.perDay = 1;

    // Default collection has 3 new cards in deck 1; with perDay=1, only 1 new card is available today
    const countsBefore = getDeckCounts(col, 1);
    assert.equal(countsBefore.newCount, 1);

    // Record 1 new card studied today
    const firstCard = getNextStudyCard(col, 1)!;
    assert.ok(firstCard);
    col.revlog.push({
      id: Date.now(),
      cid: firstCard.id,
      usn: 0,
      ease: 3,
      ivl: 1,
      lastIvl: 0,
      factor: 2500,
      time: 1000,
      type: 0
    });

    const countsAfterOne = getDeckCounts(col, 1);
    assert.equal(countsAfterOne.newCount, 0, "Daily new limit of 1 reached");
    assert.equal(getNextStudyCard(col, 1), null, "No more cards selectable after daily limit");

    // Apply ephemeral Custom Study override for today (+2 new)
    col.decks[1].customStudy = { day: getTodayDay(), extraNew: 2, extraRev: 0 };
    assert.equal(getDeckCounts(col, 1).newCount, 2, "Custom Study extraNew unlocks remaining 2 new cards");
  });

  it("C07: parses RFC 4180 CSV with quoted commas, escaped quotes, and multiline fields", () => {
    const csvText = `\uFEFF"Term, with comma","Definition with ""quoted"" word\nand second line",tag1 tag2\nSecond Term,Simple Back,tag3`;
    const rows = parseDelimitedRows(csvText);
    assert.equal(rows.length, 2);
    assert.equal(rows[0][0], "Term, with comma");
    assert.equal(rows[0][1], 'Definition with "quoted" word\nand second line');
    assert.equal(rows[0][2], "tag1 tag2");

    const col = createDefaultCollection();
    const res = importCsv(csvText, col, 1, 1);
    assert.equal(res.noteCount, 2);
  });

  it("U12: calculateTodayStats returns null retention when 0 cards studied and counts Hard as passing", () => {
    const col = createDefaultCollection();
    const emptyStats = calculateTodayStats(col);
    assert.equal(emptyStats.retentionRate, null);

    col.revlog.push({
      id: Date.now(),
      cid: 3001,
      usn: 0,
      ease: 2, // Hard
      ivl: 1,
      lastIvl: 1,
      factor: 2350,
      time: 1500,
      type: 1
    });
    const statsWithHard = calculateTodayStats(col);
    assert.equal(statsWithHard.retentionRate, 100);
  });

  it("V07/C01/C02/C06: exports .apkg with relative due days and re-imports with exact due dates and GUID deduplication", async () => {
    // Point initSqlJs locateFile to local node_modules wasm for Node test runtime
    (globalThis as any).window = {
      initSqlJs: (await import("sql.js")).default
        ? (opts: any) =>
            (import("sql.js") as any).then((m: any) =>
              (m.default || m)({
                locateFile: (file: string) => `./node_modules/sql.js/dist/${file}`
              })
            )
        : undefined
    };

    const sourceCol = createDefaultCollection();
    const today = getTodayDay();
    const firstCard = Object.values(sourceCol.cards)[0]!;
    const targetCid = firstCard.id;
    const expectedNoteCount = Object.keys(sourceCol.notes).length;
    firstCard.type = 2;
    firstCard.queue = 2;
    firstCard.ivl = 14;
    firstCard.due = today + 14;

    const apkgBlob = await exportApkg(sourceCol);
    assert.ok(apkgBlob.size > 0);

    const destCol = createDefaultCollection();
    destCol.notes = {};
    destCol.cards = {};

    const firstImport = await importApkg(apkgBlob, destCol);
    assert.equal(firstImport.noteCount, expectedNoteCount);
    assert.equal(destCol.cards[targetCid].due, today + 14, "Imported review due date must match exact epoch day (today + 14)");
    assert.equal(destCol.cards[targetCid].ivl, 14);

    // Re-importing the same .apkg must deduplicate by GUID rather than duplicating notes (C06)
    const secondImport = await importApkg(apkgBlob, destCol);
    assert.equal(secondImport.duplicateCount, expectedNoteCount);
    assert.equal(Object.keys(destCol.notes).length, expectedNoteCount);
  });
});
