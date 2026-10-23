// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { AnkiSyncServer } from "../../server/sync-server";

export class TestSyncServer extends AnkiSyncServer {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/test/age-operations") {
            this.ctx.storage.sql.exec("UPDATE applied_ops SET applied_at = ?", Date.now() - 30 * 86400000);
            return Response.json({ ok: true });
        }
        if (url.pathname === "/test/set-meta") {
            const { key, val } = (await request.json()) as { key: string; val: string };
            this.ctx.storage.sql.exec("INSERT OR REPLACE INTO col_meta (key, val) VALUES (?, ?)", key, val);
            return Response.json({ ok: true });
        }
        if (url.pathname === "/test/due-summary") {
            const { now, prefs } = await request.json() as any;
            const original = Date.now;
            Date.now = () => now;
            try {
                return Response.json((this as any).computeDueSummary(prefs, now));
            } finally {
                Date.now = original;
            }
        }
        if (url.pathname === "/test/next-daily-alarm") {
            const { now, prefs } = await request.json() as any;
            const summary = (this as any).computeDueSummary(prefs, now);
            const targetUtcMs = this.computeNextDailyTargetUtcMs(now, prefs, summary);
            return Response.json({ targetUtcMs, summary });
        }
        return super.fetch(request);
    }
}

export default {
    fetch(request: Request, env: any) {
        return env.SYNC.get(env.SYNC.idFromName(request.headers.get("X-Test-User") || "test-user")).fetch(request);
    },
};
