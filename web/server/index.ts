import { AnkiSyncServer } from "./sync-server";

export { AnkiSyncServer };

export interface Env {
  ANKI_SYNC: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. Route API requests and WebSockets to the default sync Durable Object room
    if (url.pathname.startsWith("/api/")) {
      const roomParam = url.searchParams.get("room") || "default";
      const id = env.ANKI_SYNC.idFromName(roomParam);
      const stub = env.ANKI_SYNC.get(id);

      // Strip /api prefix before forwarding to DO
      const doUrl = new URL(request.url);
      doUrl.pathname = url.pathname.replace(/^\/api/, "");
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // 2. Serve static assets (HTML, JS, CSS, fonts)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Anki Web Server running.", { status: 200 });
  }
};
