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
        if (url.pathname === "/test/due-summary") {
            const { now, prefs } = await request.json() as any;
            const original = Date.now;
            Date.now = () => now;
            try {
                return Response.json((this as any).computeDueSummary(prefs));
            } finally {
                Date.now = original;
            }
        }
        return super.fetch(request);
    }
}

export default {
    fetch(request: Request, env: any) {
        return env.SYNC.get(env.SYNC.idFromName(request.headers.get("X-Test-User") || "test-user")).fetch(request);
    },
};
