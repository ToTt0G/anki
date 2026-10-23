// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { createDefaultCollection } from "../src/core/default-data";

// Valid 1x1 transparent PNG data URL for server media validation tests
const VALID_PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

let mf: Miniflare;
before(async () => {
    const built = await build({
        entryPoints: ["tests/fixtures/sync-worker.ts"],
        bundle: true,
        format: "esm",
        platform: "browser",
        external: ["cloudflare:workers"],
        write: false,
        plugins: [{
            name: "push-network-stub",
            setup(build) {
                build.onResolve({ filter: /^web-push$/ }, () => ({ path: "web-push", namespace: "test" }));
                build.onLoad(
                    { filter: /.*/, namespace: "test" },
                    () => ({
                        contents:
                            "export default { generateRequestDetails() { throw new Error(\"Unexpected push delivery in test\"); } };",
                    }),
                );
            },
        }],
    });
    mf = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: built.outputFiles[0].text,
            compatibilityDate: "2024-12-01",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: { SYNC: { className: "TestSyncServer", useSQLite: true } },
        }),
    );
    await mf.ready;
});
after(async () => {
    await mf?.dispose();
});

function request(user: string, path: string, body?: object, method = "POST") {
    return mf.dispatchFetch(`https://test.example${path}`, {
        method: body ? method : method === "POST" ? "GET" : method,
        headers: { "Content-Type": "application/json", "X-Test-User": user },
        body: body ? JSON.stringify(body) : undefined,
    });
}
async function socketFor(user: string) {
    const nonce = crypto.randomUUID();
    await request(user, "/internal/issue-ticket", { nonce, exp: Date.now() + 60000 });
    const res = await mf.dispatchFetch("https://test.example/ws", {
        headers: { Upgrade: "websocket", "X-Ticket-Nonce": nonce, "X-Test-User": user },
    });
    assert.equal(res.status, 101);
    const socket = res.webSocket!;
    socket.accept();
    const queued: any[] = [];
    let waiter: ((msg: any) => void) | undefined;
    socket.addEventListener("message", event => {
        const msg = JSON.parse(String(event.data));
        if (waiter) {
            const resolve = waiter;
            waiter = undefined;
            resolve(msg);
        } else { queued.push(msg); }
    });
    return {
        socket,
        async send(msg: object) {
            socket.send(JSON.stringify(msg));
            if (queued.length) { return queued.shift(); }
            return new Promise<any>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    waiter = undefined;
                    reject(new Error("WebSocket reply timed out"));
                }, 3000);
                waiter = msg => {
                    clearTimeout(timeout);
                    resolve(msg);
                };
            });
        },
        async nextMessage() {
            if (queued.length) { return queued.shift(); }
            return new Promise<any>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    waiter = undefined;
                    reject(new Error("WebSocket message timed out"));
                }, 3000);
                waiter = msg => {
                    clearTimeout(timeout);
                    resolve(msg);
                };
            });
        },
    };
}

it("DATA-01: HTTP and WebSocket replacements and backup restores require current revisions or explicit forceOverwrite across concurrent clients", async () => {
    const user = "cas";
    const col = createDefaultCollection();
    assert.equal((await request(user, "/collection", col)).status, 409);
    assert.equal((await request(user, "/collection", { ...col, expectedRevision: 0 })).status, 200);
    assert.equal((await request(user, "/collection", { ...col, expectedRevision: 0 })).status, 409);
    assert.equal(
        (await request(user, "/collection", { ...col, expectedRevision: 1, opId: "http-import" })).status,
        200,
    );
    assert.equal(
        (await request(user, "/collection", { ...col, expectedRevision: 1, opId: "http-import" })).status,
        200,
    );
    assert.equal((await request(user, "/collection/restore-backup", {})).status, 409);
    assert.equal((await request(user, "/collection/restore-backup", { expectedRevision: 1 })).status, 409);

    // Connect two concurrent devices: Device B edits a deck while Device A tries to import at stale revision 2
    const deviceA = await socketFor(user);
    const deviceB = await socketFor(user);
    try {
        const editAck = await deviceB.send({
            type: "upsert_deck",
            opId: "device-b-edit",
            deck: { ...col.decks[1], name: "Edited on Device B" },
        });
        assert.equal(editAck.type, "ack");
        assert.equal(editAck.revision, 3);
        // Consume broadcast on deviceA
        await deviceA.nextMessage();

        // Device A attempts import anchored to old revision 2 -> conflict_revision
        const staleImport = createDefaultCollection();
        staleImport.decks[1].name = "Stale Snapshot from Device A";
        const errReply = await deviceA.send({
            type: "import_collection",
            opId: "stale",
            collection: staleImport,
            expectedRevision: 2,
        });
        assert.equal(errReply.kind, "conflict_revision");

        // Verify Device B's edit was NOT lost
        const currentAfterConflict: any = await (await request(user, "/collection")).json();
        assert.equal(currentAfterConflict.revision, 3);
        assert.equal(currentAfterConflict.decks[1].name, "Edited on Device B");

        // Explicit forceOverwrite: true succeeds when confirmed by user
        const forcedReply = await deviceA.send({
            type: "import_collection",
            opId: "forced-overwrite",
            collection: staleImport,
            expectedRevision: 2,
            forceOverwrite: true,
        });
        assert.equal(forcedReply.type, "ack");
        const currentAfterForce: any = await (await request(user, "/collection")).json();
        assert.equal(currentAfterForce.decks[1].name, "Stale Snapshot from Device A");
    } finally {
        deviceA.socket.close();
        deviceB.socket.close();
    }
});

it("DATA-03: deletion rejects stale seeding and ordinary edits, while allowing deliberate actions in the new generation", async () => {
    const user = "deletion";
    const col = createDefaultCollection();
    await request(user, "/collection", { ...col, expectedRevision: 0 });
    await request(user, "/account-data", undefined, "DELETE");
    assert.equal((await request(user, "/collection", { ...col, expectedRevision: 0 })).status, 410);
    const { socket, send } = await socketFor(user);
    try {
        const state = await send({ type: "init" });
        assert.equal(state.deleted, true);
        assert.equal(state.revision, 2);
        assert.notEqual(state.generation, "0");
        const stale = { type: "upsert_deck", opId: "old-device-edit", deck: { ...col.decks[1], name: "Stale" } };
        assert.equal((await send(stale)).kind, "deleted");
        assert.equal(
            (await send({
                type: "import_collection",
                opId: "seed",
                collection: col,
                seedOnUninitialized: true,
                expectedRevision: 0,
            })).kind,
            "deleted",
        );
        assert.equal(
            (await send({
                type: "import_collection",
                opId: "deliberate",
                collection: col,
                expectedRevision: 2,
                generation: state.generation,
            })).type,
            "ack",
        );
        assert.equal((await send(stale)).kind, "deleted");
        const current: any = await (await request(user, "/collection")).json();
        assert.equal(current.decks[1].name, col.decks[1].name);
    } finally {
        socket.close();
    }
});

it("D06/DATA-14: new-record collisions leave existing data untouched and old lost acknowledgements never double-apply reviews", async () => {
    const user = "idempotency";
    const col = createDefaultCollection();
    await request(user, "/collection", { ...col, expectedRevision: 0 });
    const { socket, send } = await socketFor(user);
    try {
        assert.equal(
            (await send({
                type: "upsert_deck",
                opId: "collision",
                isNew: true,
                deck: { ...col.decks[1], name: "Clobbered" },
            })).kind,
            "id_collision",
        );
        const card = Object.values(col.cards)[0];
        const review = {
            type: "answer_card",
            opId: "lost-ack",
            cardId: card.id,
            nextState: { reps: 1 },
            revlogEntry: {
                id: 1700000000000,
                cid: card.id,
                usn: 0,
                ease: 3,
                ivl: 1,
                lastIvl: 0,
                factor: 2500,
                time: 1000,
                type: 0,
            },
        };
        const firstAck = await send(review);
        assert.equal(firstAck.type, "ack");
        await request(user, "/test/age-operations", {});
        assert.deepEqual(await send(review), firstAck);
        const current: any = await (await request(user, "/collection")).json();
        assert.equal(current.decks[1].name, col.decks[1].name);
        assert.equal(current.cards[card.id].reps, 1);
        assert.equal(current.revlog.length, 1);
    } finally {
        socket.close();
    }
});

it("SEC-01: push detachment rejects missing or wrong unsubSecret with 403 and only detaches when valid", async () => {
    const user = "push-owner";
    const endpoint = "https://fcm.googleapis.com/fcm/send/example";
    const res: any = await (await request(user, "/push/subscribe", {
        endpoint,
        keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
    })).json();
    assert.ok(res.unsubSecret);
    for (const unsubSecret of [undefined, "", "wrong-secret-from-account-a"]) {
        const badRes = await request(user, "/push/detach", { endpoint, unsubSecret });
        assert.equal(badRes.status, 403, "Unauthorized detach must be rejected with 403");
        assert.equal((await (await request(user, "/push/status")).json() as any).subscriptions, 1);
    }
    const okRes = await request(user, "/push/detach", { endpoint, unsubSecret: res.unsubSecret });
    assert.equal(okRes.status, 200);
    assert.equal((await (await request(user, "/push/status")).json() as any).subscriptions, 0);
});

it("DATA-02: delete_note ignores client-supplied cardIds belonging to other notes", async () => {
    const user = "delete-note-isolation";
    const col = createDefaultCollection();
    const notes = Object.values(col.notes);
    assert.ok(notes.length >= 2, "Default collection has multiple notes");
    const noteToDelete = notes[0];
    const noteToKeep = notes[1];
    const cardToKeep = Object.values(col.cards).find(c => c.nid === noteToKeep.id)!;
    assert.ok(cardToKeep);

    await request(user, "/collection", { ...col, expectedRevision: 0 });
    const { socket, send } = await socketFor(user);
    try {
        // Maliciously pass cardToKeep.id in cardIds when deleting noteToDelete.id
        const ack = await send({
            type: "delete_note",
            opId: "del-note-1",
            noteId: noteToDelete.id,
            cardIds: [cardToKeep.id, 999999],
        });
        assert.equal(ack.type, "ack");

        const after: any = await (await request(user, "/collection")).json();
        assert.equal(after.notes[noteToDelete.id], undefined, "Target note deleted");
        assert.ok(after.notes[noteToKeep.id], "Unrelated note preserved");
        assert.ok(after.cards[cardToKeep.id], "Unrelated card must NOT be deleted via client cardIds");
    } finally {
        socket.close();
    }
});

it("DATA-09 & DATA-10: full collection replacement deletes obsolete media and backup restore reverts media accurately", async () => {
    const user = "media-lifecycle";
    const col1 = createDefaultCollection();
    col1.media["original.png"] = VALID_PNG_DATA_URL;
    await request(user, "/collection", { ...col1, expectedRevision: 0 });

    const col2 = createDefaultCollection();
    col2.media = { "imported.png": VALID_PNG_DATA_URL };
    await request(user, "/collection", { ...col2, expectedRevision: 1 });

    // DATA-09: original.png must be deleted after full replacement with col2
    const afterImport: any = await (await request(user, "/collection")).json();
    assert.equal(afterImport.media["original.png"], undefined, "Obsolete media must be removed");
    assert.equal(afterImport.media["imported.png"], VALID_PNG_DATA_URL, "New media must exist");

    // DATA-10: restoring backup must restore original.png and remove imported.png
    const restoreRes = await request(user, "/collection/restore-backup", { expectedRevision: 2 });
    assert.equal(restoreRes.status, 200);
    const afterRestore: any = await (await request(user, "/collection")).json();
    assert.equal(afterRestore.media["original.png"], VALID_PNG_DATA_URL, "Backed-up media restored");
    assert.equal(afterRestore.media["imported.png"], undefined, "Newly imported media removed on rollback");
});

it("UX-01: renaming a parent deck on the server cascades to all Parent::Child subdecks", async () => {
    const user = "rename-parent-deck";
    const col = createDefaultCollection();
    col.decks[10] = {
        id: 10,
        name: "Science",
        desc: "",
        collapsed: false,
        conf: 1,
        dyn: 0,
        mod: 1,
        usn: 0,
    };
    col.decks[11] = {
        id: 11,
        name: "Science::Chemistry",
        desc: "",
        collapsed: false,
        conf: 1,
        dyn: 0,
        mod: 1,
        usn: 0,
    };
    await request(user, "/collection", { ...col, expectedRevision: 0 });

    const { socket, send } = await socketFor(user);
    try {
        const ack = await send({
            type: "upsert_deck",
            opId: "rename-science",
            deck: { ...col.decks[10], name: "Natural Science" },
        });
        assert.equal(ack.type, "ack");

        const after: any = await (await request(user, "/collection")).json();
        assert.equal(after.decks[10].name, "Natural Science");
        assert.equal(after.decks[11].name, "Natural Science::Chemistry");
    } finally {
        socket.close();
    }
});

it("DATA-11, DATA-12 & SEC-09: rejects orphaned card/note references, mismatched revlog cid, and oversized messages", async () => {
    const user = "server-validation";
    const col = createDefaultCollection();
    await request(user, "/collection", { ...col, expectedRevision: 0 });
    const { socket, send } = await socketFor(user);
    try {
        // DATA-12: answer_card where revlogEntry.cid !== cardId
        const firstCard = Object.values(col.cards)[0];
        const mismatchedRev = await send({
            type: "answer_card",
            opId: "bad-rev",
            cardId: firstCard.id,
            nextState: { reps: 1 },
            revlogEntry: {
                id: Date.now(),
                cid: firstCard.id + 999,
                usn: 0,
                ease: 3,
                ivl: 1,
                lastIvl: 0,
                factor: 2500,
                time: 1000,
                type: 0,
            },
        });
        assert.equal(mismatchedRev.type, "op_error");
        assert.equal(mismatchedRev.kind, "validation");

        // DATA-11: update_card referencing nonexistent deck
        const orphanCard = await send({
            type: "update_card",
            opId: "orphan-card",
            card: { ...firstCard, did: 999999 },
        });
        assert.equal(orphanCard.type, "op_error");
        assert.equal(orphanCard.kind, "validation");

        // SEC-09: oversized standard WebSocket message (> 1 MB)
        const hugeDeck = await send({
            type: "upsert_deck",
            opId: "huge-msg",
            deck: { ...col.decks[1], desc: "X".repeat(1_100_000) },
        });
        assert.equal(hugeDeck.type, "op_error");
        assert.equal(hugeDeck.kind, "validation");
    } finally {
        socket.close();
    }
});

it("SCHED-01 & SCHED-02: server due counts and daily push alarms use IANA timezone calendar days across UTC midnight and DST transitions", async () => {
    const user = "timezone";
    const col = createDefaultCollection();
    const card = Object.values(col.cards)[0];
    card.queue = 2;
    card.type = 2;
    card.due = Math.floor(Date.UTC(2026, 0, 2) / 86400000);
    await request(user, "/collection", { ...col, expectedRevision: 0 });
    for (
        const [timeZone, now, expected] of [
            ["Asia/Tokyo", Date.UTC(2026, 0, 1, 16), 1],
            ["America/Los_Angeles", Date.UTC(2026, 0, 2, 1), 0],
        ] as const
    ) {
        const summary: any =
            await (await request(user, "/test/due-summary", { now, prefs: { timeZone, tzOffsetMinutes: 0 } })).json();
        assert.equal(summary.reviewDueCount, expected, timeZone);
    }

    // SCHED-02: Test spring-forward DST transition in America/New_York (2026-03-08: EST UTC-5 -> EDT UTC-4)
    // At 2026-03-07 15:00 UTC (10:00 EST, after 09:00 reminder window), next daily alarm for 09:00 must be
    // 2026-03-08 13:00 UTC (09:00 EDT), which is 23 hours after 2026-03-07 09:00 EST (NOT 24 hours / 10:00 EDT!).
    const satAfterNineUtc = Date.UTC(2026, 2, 7, 15, 0, 0);
    const dstAlarm: any = await (await request(user, "/test/next-daily-alarm", {
        now: satAfterNineUtc,
        prefs: {
            dailyMode: "fixed",
            dailyTime: "09:00",
            timeZone: "America/New_York",
            tzOffsetMinutes: 300,
            learningAlerts: true,
        },
    })).json();
    assert.equal(
        dstAlarm.targetUtcMs,
        Date.UTC(2026, 2, 8, 13, 0, 0),
        "Spring-forward DST alarm must fire at 09:00 EDT (13:00 UTC), not 10:00 EDT (14:00 UTC)",
    );
});
