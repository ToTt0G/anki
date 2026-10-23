// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import {
    AuthEnv,
    isAllowedRequestOrigin,
    issueSignedWsTicket,
    verifyClerkRequest,
    verifySignedWsTicket,
    withSecurityHeaders,
} from "./auth";
import { AnkiSyncServer } from "./sync-server";

export { AnkiSyncServer };

export interface Env extends AuthEnv {
    ANKI_SYNC: DurableObjectNamespace;
    ASSETS: Fetcher;
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    VAPID_SUBJECT?: string;
}

function getUserStub(env: Env, userId: string): DurableObjectStub {
    const doId = env.ANKI_SYNC.idFromName(`user:${userId}`);
    return env.ANKI_SYNC.get(doId);
}

export default {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/api/")) {
            // Enforce Origin/CSRF protection on all state-changing API requests (S02)
            if (!isAllowedRequestOrigin(request, env)) {
                return withSecurityHeaders(
                    Response.json({ error: "Cross-origin request forbidden" }, { status: 403 }),
                );
            }

            // 1. Issue a short-lived, single-use WebSocket connection ticket for an authenticated user
            if (url.pathname === "/api/ws-ticket" && request.method === "POST") {
                const session = await verifyClerkRequest(request, env);
                if (!session) {
                    return withSecurityHeaders(
                        Response.json({ error: "Authentication required" }, { status: 401 }),
                    );
                }
                if (!env.CLERK_SECRET_KEY) {
                    return withSecurityHeaders(
                        Response.json({ error: "Server auth secret not configured" }, { status: 500 }),
                    );
                }

                const { ticket, nonce, exp } = await issueSignedWsTicket(
                    session.userId,
                    env.CLERK_SECRET_KEY,
                );

                const stub = getUserStub(env, session.userId);
                const regRes = await stub.fetch("https://do.internal/internal/issue-ticket", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ nonce, exp }),
                });
                if (!regRes.ok) {
                    return withSecurityHeaders(
                        Response.json({ error: "Failed to register WebSocket ticket" }, { status: 500 }),
                    );
                }

                return withSecurityHeaders(
                    Response.json({
                        ticket,
                        userId: session.userId,
                        expiresAt: exp,
                    }),
                );
            }

            // 2. Authenticate WebSocket connections using the short-lived connection ticket
            if (url.pathname === "/api/ws" || request.headers.get("Upgrade") === "websocket") {
                const ticket = url.searchParams.get("ticket") || "";
                if (!env.CLERK_SECRET_KEY) {
                    return withSecurityHeaders(
                        Response.json({ error: "Server auth secret not configured" }, { status: 500 }),
                    );
                }

                const verifiedTicket = await verifySignedWsTicket(ticket, env.CLERK_SECRET_KEY);
                if (!verifiedTicket) {
                    return withSecurityHeaders(
                        Response.json(
                            { error: "Invalid or expired WebSocket connection ticket" },
                            { status: 401 },
                        ),
                    );
                }

                const stub = getUserStub(env, verifiedTicket.sub);
                const headers = new Headers(request.headers);
                headers.set("X-Ticket-Nonce", verifiedTicket.nonce);
                headers.set("X-Verified-User-Id", verifiedTicket.sub);

                const doUrl = new URL(request.url);
                doUrl.pathname = "/ws";
                doUrl.search = ""; // Redact ticket query string before forwarding (S11)
                return stub.fetch(
                    new Request(doUrl.toString(), {
                        method: request.method,
                        headers,
                    }),
                );
            }

            // 3. Block direct external access to /api/internal/*
            if (url.pathname.startsWith("/api/internal/")) {
                return withSecurityHeaders(Response.json({ error: "Not Found" }, { status: 404 }));
            }

            // 4. Detach a push endpoint from a previous user's Durable Object during account switch (S03)
            // Authorization model (S13): the caller must be authenticated, AND the previous user's
            // DO only executes the delete when the request proves possession of the per-subscription
            // unsubscribe secret that was issued to this device at subscription time. Caller-supplied
            // identifiers alone never authorize a mutation against another user's Durable Object.
            if (url.pathname === "/api/push/detach-previous" && request.method === "POST") {
                const session = await verifyClerkRequest(request, env);
                if (!session) {
                    return withSecurityHeaders(
                        Response.json({ error: "Authentication required" }, { status: 401 }),
                    );
                }
                try {
                    const body: {
                        previousUserId?: string;
                        endpoint?: string;
                        unsubSecret?: string;
                    } = await request.json();
                    const previousUserId = typeof body.previousUserId === "string"
                        ? body.previousUserId.slice(0, 191)
                        : "";
                    const endpoint = typeof body.endpoint === "string" ? body.endpoint.slice(0, 2048) : "";
                    const unsubSecret = typeof body.unsubSecret === "string" ? body.unsubSecret.slice(0, 256) : "";

                    if (!previousUserId || !endpoint || !unsubSecret) {
                        return withSecurityHeaders(
                            Response.json({ error: "Invalid detach request" }, { status: 400 }),
                        );
                    }

                    // Never route a user's own ID through this path: a caller deleting the subscription
                    // bound to their CURRENT user does it via /push/unsubscribe, which is scoped to the
                    // verified session user only.
                    if (previousUserId === session.userId) {
                        return withSecurityHeaders(
                            Response.json({ success: true }),
                        );
                    }

                    const prevStub = getUserStub(env, previousUserId);
                    const detachRes = await prevStub.fetch("https://do.internal/push/detach", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ endpoint, unsubSecret }),
                    });
                    if (!detachRes.ok) {
                        return withSecurityHeaders(
                            Response.json({ error: "Invalid detach request" }, { status: 400 }),
                        );
                    }
                    // Do not disclose whether the subscription existed (no oracle).
                    return withSecurityHeaders(Response.json({ success: true }));
                } catch {
                    return withSecurityHeaders(
                        Response.json({ error: "Invalid detach request" }, { status: 400 }),
                    );
                }
            }

            // 5. Authenticate every HTTP API request using a verified Clerk session token
            const session = await verifyClerkRequest(request, env);
            if (!session) {
                return withSecurityHeaders(
                    Response.json({ error: "Authentication required" }, { status: 401 }),
                );
            }

            const stub = getUserStub(env, session.userId);
            const doUrl = new URL(request.url);
            doUrl.pathname = url.pathname.replace(/^\/api/, "");
            doUrl.searchParams.delete("room");

            const headers = new Headers(request.headers);
            headers.set("X-Verified-User-Id", session.userId);

            const res = await stub.fetch(
                new Request(doUrl.toString(), {
                    method: request.method,
                    headers,
                    body: request.body,
                }),
            );
            return withSecurityHeaders(res);
        }

        // 6. Serve static assets with security headers (S08)
        if (env.ASSETS) {
            const assetRes = await env.ASSETS.fetch(request);
            return withSecurityHeaders(assetRes);
        }

        return withSecurityHeaders(new Response("klanki Web Server running.", { status: 200 }));
    },
};
