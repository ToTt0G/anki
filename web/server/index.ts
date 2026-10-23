// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import {
    AuthEnv,
    isAllowedRequestOrigin,
    issueSignedWsTicket,
    resolveWsTicketSigningKey,
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

const MAX_HTTP_API_BYTES = 64 * 1024; // 64 KB for standard API requests (SEC-09)
const MAX_HTTP_IMPORT_BYTES = 25 * 1024 * 1024; // 25 MB for full collection import (SEC-09)

function getUserStub(env: Env, userId: string): DurableObjectStub {
    const doId = env.ANKI_SYNC.idFromName(`user:${userId}`);
    return env.ANKI_SYNC.get(doId);
}

async function readBoundedBodyText(
    request: Request,
    maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
    const contentLengthHeader = request.headers.get("content-length") || request.headers.get("Content-Length");
    if (contentLengthHeader) {
        const declared = Number(contentLengthHeader);
        if (Number.isFinite(declared) && declared > maxBytes) {
            return {
                ok: false,
                status: 413,
                error: `Request payload exceeds maximum allowed size (${maxBytes} bytes)`,
            };
        }
    }
    if (!request.body) {
        return { ok: true, text: "" };
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) { break; }
            if (value) {
                total += value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel().catch(() => {});
                    return {
                        ok: false,
                        status: 413,
                        error: `Request payload exceeds maximum allowed size (${maxBytes} bytes)`,
                    };
                }
                chunks.push(value);
            }
        }
    } finally {
        reader.releaseLock();
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        combined.set(c, offset);
        offset += c.byteLength;
    }
    return { ok: true, text: new TextDecoder().decode(combined) };
}

export default {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/api/")) {
            // Enforce Origin/CSRF protection on all state-changing API requests (S02, SEC-11)
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
                const signingKey = await resolveWsTicketSigningKey(env);
                if (!signingKey) {
                    return withSecurityHeaders(
                        Response.json({ error: "Server ticket signing secret not configured" }, { status: 500 }),
                    );
                }

                const { ticket, nonce, exp } = await issueSignedWsTicket(
                    session.userId,
                    signingKey,
                );

                const stub = getUserStub(env, session.userId);
                const regRes = await stub.fetch("https://do.internal/internal/issue-ticket", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ nonce, exp }),
                });
                if (!regRes.ok) {
                    const status = regRes.status === 429 ? 429 : 500;
                    return withSecurityHeaders(
                        Response.json({ error: "Failed to register WebSocket ticket" }, { status }),
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
                const signingKey = await resolveWsTicketSigningKey(env);
                if (!signingKey) {
                    return withSecurityHeaders(
                        Response.json({ error: "Server ticket signing secret not configured" }, { status: 500 }),
                    );
                }

                const verifiedTicket = await verifySignedWsTicket(ticket, signingKey);
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

            // 4. Detach a push endpoint from a previous user's Durable Object during account switch (SEC-01)
            // Authorization model: caller must be authenticated AND must present the server-issued
            // per-subscription `unsubSecret` bound to that exact `(previousUserId, endpoint)`.
            // Requests without a valid secret are explicitly rejected with 403 Forbidden.
            if (url.pathname === "/api/push/detach-previous" && request.method === "POST") {
                const session = await verifyClerkRequest(request, env);
                if (!session) {
                    return withSecurityHeaders(
                        Response.json({ error: "Authentication required" }, { status: 401 }),
                    );
                }
                const bounded = await readBoundedBodyText(request, MAX_HTTP_API_BYTES);
                if (!bounded.ok) {
                    return withSecurityHeaders(
                        Response.json({ error: bounded.error }, { status: bounded.status }),
                    );
                }
                try {
                    const body: {
                        previousUserId?: string;
                        endpoint?: string;
                        unsubSecret?: string;
                    } = JSON.parse(bounded.text || "{}");
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

                    if (previousUserId === session.userId) {
                        return withSecurityHeaders(
                            Response.json(
                                { error: "Use /api/push/unsubscribe for the active user" },
                                { status: 400 },
                            ),
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
                            Response.json(
                                { error: "Unauthorized push detachment" },
                                { status: detachRes.status === 403 ? 403 : 400 },
                            ),
                        );
                    }
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

            // Enforce request body size limits before forwarding to Durable Object (SEC-09, NEW-05)
            let forwardBody: string | null = null;
            if (request.method !== "GET" && request.method !== "HEAD") {
                const maxBytes = url.pathname === "/api/collection" || url.pathname === "/api/media"
                    ? MAX_HTTP_IMPORT_BYTES
                    : MAX_HTTP_API_BYTES;
                const bounded = await readBoundedBodyText(request, maxBytes);
                if (!bounded.ok) {
                    return withSecurityHeaders(
                        Response.json({ error: bounded.error }, { status: bounded.status }),
                    );
                }
                forwardBody = bounded.text;
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
                    body: forwardBody && forwardBody.length > 0 ? forwardBody : undefined,
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
