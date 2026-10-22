import { AnkiSyncServer } from "./sync-server";
import {
  AuthEnv,
  issueSignedWsTicket,
  verifyClerkRequest,
  verifySignedWsTicket
} from "./auth";

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
      // 1. Issue a short-lived, single-use WebSocket connection ticket for an authenticated user
      if (url.pathname === "/api/ws-ticket" && request.method === "POST") {
        const session = await verifyClerkRequest(request, env);
        if (!session) {
          return Response.json({ error: "Authentication required" }, { status: 401 });
        }
        if (!env.CLERK_SECRET_KEY) {
          return Response.json({ error: "Server auth secret not configured" }, { status: 500 });
        }

        const { ticket, nonce, exp } = await issueSignedWsTicket(
          session.userId,
          env.CLERK_SECRET_KEY
        );

        const stub = getUserStub(env, session.userId);
        const regRes = await stub.fetch("https://do.internal/internal/issue-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nonce, exp })
        });
        if (!regRes.ok) {
          return Response.json({ error: "Failed to register WebSocket ticket" }, { status: 500 });
        }

        return Response.json({
          ticket,
          userId: session.userId,
          expiresAt: exp
        });
      }

      // 2. Authenticate WebSocket connections using the short-lived connection ticket
      if (url.pathname === "/api/ws" || request.headers.get("Upgrade") === "websocket") {
        const ticket = url.searchParams.get("ticket") || "";
        if (!env.CLERK_SECRET_KEY) {
          return Response.json({ error: "Server auth secret not configured" }, { status: 500 });
        }

        const verifiedTicket = await verifySignedWsTicket(ticket, env.CLERK_SECRET_KEY);
        if (!verifiedTicket) {
          return Response.json(
            { error: "Invalid or expired WebSocket connection ticket" },
            { status: 401 }
          );
        }

        const stub = getUserStub(env, verifiedTicket.sub);
        const headers = new Headers(request.headers);
        headers.set("X-Ticket-Nonce", verifiedTicket.nonce);
        headers.set("X-Verified-User-Id", verifiedTicket.sub);

        const doUrl = new URL(request.url);
        doUrl.pathname = "/ws";
        doUrl.search = "";
        return stub.fetch(new Request(doUrl.toString(), {
          method: request.method,
          headers
        }));
      }

      // 3. Block direct external access to /api/internal/*
      if (url.pathname.startsWith("/api/internal/")) {
        return Response.json({ error: "Not Found" }, { status: 404 });
      }

      // 4. Authenticate every HTTP API request using a verified Clerk session token
      const session = await verifyClerkRequest(request, env);
      if (!session) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }

      // Derive Durable Object ID strictly from the verified Clerk user ID
      const stub = getUserStub(env, session.userId);
      const doUrl = new URL(request.url);
      doUrl.pathname = url.pathname.replace(/^\/api/, "");
      doUrl.searchParams.delete("room");

      const headers = new Headers(request.headers);
      headers.set("X-Verified-User-Id", session.userId);

      return stub.fetch(
        new Request(doUrl.toString(), {
          method: request.method,
          headers,
          body: request.body
        })
      );
    }

    // 5. Serve static assets (HTML, JS, CSS, fonts)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("klanki Web Server running.", { status: 200 });
  }
};
