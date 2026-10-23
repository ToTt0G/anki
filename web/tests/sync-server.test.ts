// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { createDefaultCollection } from "../src/core/default-data";

let mf: Miniflare;
before(async () => {
    const built = await build({
        entryPoints: ["tests/fixtures/sync-worker.ts"],
        bundle: true,
        format: "esm",
        platform: "browser",
        external: ["cloudflare:workers"],
        write: false,
        // These tests never send real push notifications; fail if that network boundary is reached.
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
    };
}

it("HTTP and WebSocket replacements and backup restores require current revisions", async () => {
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
    const { socket, send } = await socketFor(user);
    try {
        assert.equal(
            (await send({ type: "import_collection", opId: "stale", collection: col, expectedRevision: 1 })).kind,
            "conflict_revision",
        );
        assert.equal((await request(user, "/collection", undefined)).status, 200);
        const current: any = await (await request(user, "/collection")).json();
        assert.equal(current.revision, 2);
    } finally {
        socket.close();
    }
});

it("deletion rejects stale seeding and ordinary edits even after a deliberate restore", async () => {
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

it("new-record collisions leave existing data untouched and old lost acknowledgements never double-apply reviews", async () => {
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

it("push detachment requires the subscription secret", async () => {
    const user = "push-owner";
    const endpoint = "https://fcm.googleapis.com/fcm/send/example";
    const res: any = await (await request(user, "/push/subscribe", {
        endpoint,
        keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
    })).json();
    assert.ok(res.unsubSecret);
    for (const unsubSecret of [undefined, "wrong"]) {
        await request(user, "/push/detach", { endpoint, unsubSecret });
        assert.equal((await (await request(user, "/push/status")).json() as any).subscriptions, 1);
    }
    await request(user, "/push/detach", { endpoint, unsubSecret: res.unsubSecret });
    assert.equal((await (await request(user, "/push/status")).json() as any).subscriptions, 0);
});

it("server due counts use the user's calendar date on either side of UTC midnight", async () => {
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
});
