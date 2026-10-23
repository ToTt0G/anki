// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { IDBDatabase, IDBKeyRange, indexedDB } from "fake-indexeddb";
import JSZip from "jszip";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createDefaultCollection } from "../src/core/default-data";
import {
    clearUserOfflineData,
    enqueueOutboxOp,
    getOutboxOps,
    removeOutboxOp,
    saveCollectionToIdb,
    updateOutboxOpStatus,
} from "../src/core/idb-storage";
import { generateReviewId, generateUniqueId } from "../src/core/ids";
import { importApkg, inflateZipMember, MAX_EXPANDED_BYTES } from "../src/core/import-export";
import { loadMathJaxAssets } from "../src/core/mathjax";
import { getCustomStudyCardIds, getLocalDayStartMs } from "../src/core/scheduler";
import { SyncClient } from "../src/core/sync-client";

Object.assign(globalThis, { indexedDB, IDBKeyRange });

async function until(predicate: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 200; i++) {
        if (await predicate()) { return; }
        await setImmediate();
    }
    assert.fail("Expected asynchronous state was not reached");
}

class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    static instances: Socket[] = [];
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    messages: any[] = [];
    constructor(_url: string) {
        Socket.instances.push(this);
    }
    send(data: string) {
        this.messages.push(JSON.parse(data));
    }
    close() {
        this.readyState = 3;
    }
    receive(data: object) {
        this.onmessage?.({ data: JSON.stringify(data) });
    }
}

it("outbox commits durably, reports transaction aborts, and clears fallback entries", async () => {
    const userId = "storage-regression";
    const entry = { userId, opId: "commit", createdAt: 1, msg: { type: "delete_note" as const, noteId: 123 } };
    assert.equal((await enqueueOutboxOp(entry)).durable, true);
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(...args: any[]) {
        const tx = original.apply(this, args as any);
        if (args[1] === "readwrite") { queueMicrotask(() => tx.abort()); }
        return tx;
    };
    try {
        const result = await enqueueOutboxOp({ ...entry, opId: "aborted" });
        assert.equal(result.durable, false);
        assert.ok(result.error);
        assert.deepEqual((await getOutboxOps(userId)).map(op => op.opId), ["commit", "aborted"]);
        await assert.rejects(updateOutboxOpStatus(userId, "commit", "conflict", "Rejected"));
        assert.equal((await getOutboxOps(userId)).find(op => op.opId === "commit")?.status, "conflict");
        await assert.rejects(removeOutboxOp(userId, "commit"), /Could not remove/);
        await assert.rejects(clearUserOfflineData(userId), /Could not clear/);
    } finally {
        IDBDatabase.prototype.transaction = original;
    }
    await clearUserOfflineData(userId);
    assert.deepEqual(await getOutboxOps(userId), []);
});

it("connect awaits hydration; rejected edits are retained and reconciled; deletion generations discard old edits", async () => {
    const userId = "client-regression";
    const col = createDefaultCollection();
    col.decks[1].name = "Offline copy";
    await saveCollectionToIdb(userId, col, 5, true, true);
    const oldWindow = globalThis.window;
    const oldFetch = globalThis.fetch;
    const oldSocket = globalThis.WebSocket;
    Object.assign(globalThis, {
        window: { location: { protocol: "https:", host: "test.example" } },
        WebSocket: Socket,
    });
    globalThis.fetch = async () => Response.json({ ticket: "test" });
    const errors: string[] = [];
    let client: SyncClient;
    client = new SyncClient(
        userId,
        async () => {
            assert.equal(client.getCollection().decks[1].name, "Offline copy");
            return "token";
        },
        () => {},
        () => {},
        err => errors.push(err),
    );
    try {
        await client.connect();
        const socket = Socket.instances.at(-1)!;
        socket.onopen?.();
        client.upsertDeck({ ...col.decks[1], name: "Rejected edit" });
        await until(() => socket.messages.some(m => m.type === "upsert_deck"));
        const op = socket.messages.find(m => m.type === "upsert_deck");
        socket.receive({ type: "op_error", opId: op.opId, kind: "internal", error: "Rejected", revision: 5 });
        const server = createDefaultCollection();
        server.decks[1].name = "Server copy";
        socket.receive({ type: "full_state", collection: server, initialized: true, revision: 5, generation: "0" });
        await until(() => client.getCollection().decks[1].name === "Server copy");
        assert.equal((await client.getConflictedOps())[0].msg.type, "upsert_deck");
        assert.equal(client.getPendingOutboxCount(), 0);
        socket.receive({
            type: "full_state",
            collection: server,
            initialized: false,
            deleted: true,
            revision: 6,
            generation: "deleted-generation",
        });
        await until(async () => (await getOutboxOps(userId)).length === 0);
        await until(() => errors.some(e => e.includes("deleted")));
        assert.equal(socket.messages.filter(m => m.type === "import_collection").length, 0);
        client.importCollection(server);
        await until(() => socket.messages.some(m => m.type === "import_collection"));
        const imported = socket.messages.find(m => m.type === "import_collection");
        assert.equal(imported.generation, "deleted-generation");
        assert.equal(imported.expectedRevision, 6);
    } finally {
        client.disconnect();
        Object.assign(globalThis, { window: oldWindow, fetch: oldFetch, WebSocket: oldSocket });
        await clearUserOfflineData(userId);
    }
});

it("entity IDs do not depend on allocation time while review IDs preserve timestamps", t => {
    t.mock.method(Date, "now", () => 1700000000000);
    const first = generateUniqueId();
    const second = generateUniqueId(new Set([first]));
    assert.ok(Number.isSafeInteger(first) && first > 0);
    assert.notEqual(first, second);
    assert.equal(generateReviewId(new Set([Date.now()])), Date.now() + 1);
});

it("Custom Study selects forgotten cards without changing their original scheduling", () => {
    const col = createDefaultCollection();
    const cards = Object.values(col.cards);
    cards[0].queue = 2;
    cards[0].due = 30000;
    col.revlog.push({ id: getLocalDayStartMs() + 1, cid: cards[0].id, ease: 1 } as any);
    const before = structuredClone(col);
    assert.ok(getCustomStudyCardIds(col, cards[0].did).includes(cards[0].id));
    assert.deepEqual(col, before);
});

it("ZIP member inflation stops at the actual byte budget even when metadata claims a small size", async () => {
    const zip = new JSZip();
    zip.file("collection.anki2", "A".repeat(65536));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length - 46; i++) {
        if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 1, true); }
    }
    const loaded = await JSZip.loadAsync(bytes);
    await assert.rejects(inflateZipMember(loaded.file("collection.anki2")!, 1024), /memory budget/);
});

it("oversized database members are rejected from their headers before decompression", async () => {
    const zip = new JSZip();
    zip.file("collection.anki2", "small");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length - 46; i++) {
        if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, MAX_EXPANDED_BYTES + 1, true); }
    }
    await assert.rejects(importApkg(new Blob([bytes]), createDefaultCollection()), /Decompressed database exceeds/);
});

it("large imports keep media atomic over the versioned HTTP transport", async () => {
    const userId = "large-import";
    const col = createDefaultCollection();
    await saveCollectionToIdb(userId, col, 3, true);
    const originals = { window: globalThis.window, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
    Object.assign(globalThis, {
        window: { location: { protocol: "https:", host: "test.example" } },
        WebSocket: Socket,
    });
    let upload: any;
    globalThis.fetch = async (url, options) => {
        if (String(url) === "/api/collection") {
            upload = JSON.parse(String(options?.body));
            return Response.json({ revision: 4 });
        }
        return Response.json({ ticket: "test" });
    };
    const client = new SyncClient(userId, async () => "token", () => {}, () => {});
    try {
        await client.connect();
        const socket = Socket.instances.at(-1)!;
        socket.onopen?.();
        col.media["large.png"] = "data:image/png;base64," + "A".repeat(600000);
        client.importCollection(col);
        await until(() => Boolean(upload));
        await until(() => client.getPendingOutboxCount() === 0);
        assert.equal(upload.expectedRevision, 3);
        assert.equal(upload.generation, "0");
        assert.equal(upload.media["large.png"], col.media["large.png"]);
        assert.equal(socket.messages.some(m => m.type === "import_collection"), false);
    } finally {
        client.disconnect();
        Object.assign(globalThis, originals);
        await clearUserOfflineData(userId);
    }
});

it("offline math assets embed the renderer and optional extensions without font requests", async t => {
    const requested: string[] = [];
    t.mock.method(globalThis, "fetch", async (path: string) => {
        requested.push(path);
        return new Response(await readFile(`public${path}`));
    });
    const assets = await loadMathJaxAssets();
    assert.ok(assets.script.startsWith("data:text/javascript;base64,"));
    assert.ok(assets.sources["[tex]/color"].startsWith("data:text/javascript;base64,"));
    assert.ok(requested.every(path => path.startsWith("/vendor/mathjax/")));
    assert.equal(requested.some(path => path.endsWith(".woff")), false);
});
