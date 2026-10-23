# klanki

A minimalist, multi-device syncing web port of Anki built for Cloudflare Workers with per-user Durable Object SQLite storage, Clerk authentication, Progressive Web App offline support, and native Web Push study reminders, hosted at **https://klanki.ezryder.us**.

## Architecture & Security

- **Authentication & Per-User Isolation (`server/auth.ts`, `server/index.ts`)**:
  - Users sign in via **Clerk** (`@clerk/react` + `@clerk/backend`) using Google or email.
  - Every API request verifies the Clerk session token (with explicit `authorizedParties` and `Origin` CSRF validation) and derives a dedicated Durable Object instance strictly from the verified user ID (`user:${userId}`).
  - WebSocket connections use short-lived (60s), single-use HMAC-SHA256 signed connection tickets (`POST /api/ws-ticket` → `wss://.../api/ws?ticket=...`) with query-parameter log redaction.
- **Sandboxed Card Rendering (`src/components/SandboxedCardFrame.tsx`, `src/core/sanitize.ts`)**:
  - Flashcard HTML and card model CSS are sanitized and rendered inside a strictly sandboxed `<iframe sandbox="allow-scripts">` (`srcDoc` with an opaque `null` origin) with zero access to the parent application's DOM, storage, or session credentials.
- **Spaced Repetition Engine (`src/core/scheduler.ts`)**:
  - Supports both Anki's **V3 / SM-2** scheduler and **FSRS** (Free Spaced Repetition Scheduler with configurable desired retention `0.70–0.97`).
  - Enforces daily per-deck new and review card limits (`new.perDay`, `rev.perDay`), ephemeral same-day Custom Study overrides, and canonical review due-date normalization across imports and exports.
- **Reliable Sync & Offline Outbox (`src/core/idb-storage.ts`, `src/core/sync-client.ts`, `server/sync-server.ts`)**:
  - Stores collections and media in **IndexedDB** alongside a persistent operation outbox (`opId` deduplication, monotonic server revisions, and per-operation `ack` responses).
  - Supports server-side pre-import backup snapshots (`POST /api/collection/restore-backup`), cascading deck/note deletions, local offline cache clearing, and full cloud account data deletion (`DELETE /api/account-data`).
- **Import & Export (`src/core/import-export.ts`)**:
  - Supports `.apkg` and `.colpkg` (`collection.anki21` / `collection.anki2` SQLite schemas; packages using Anki's newer compressed `.anki21b` format should be exported from desktop Anki with *"Support older Anki versions"* checked) and RFC 4180 CSV/TSV files, with pre-commit import preview and one-click undo/restore.

## Running Locally (Requires Node.js >= 22)

```bash
cd web
npm install --legacy-peer-deps
npm run typecheck
npm test
npm run build
npm run worker:dev
```

## Deploying to Cloudflare Workers

```bash
cd web
npm run build
npx wrangler deploy
```

## License & Attribution

This project is a fork of [Anki](https://github.com/ankitects/anki) and is distributed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)** (see root [`LICENSE`](../LICENSE) and [`SECURITY.md`](../SECURITY.md)). Complete source code is publicly available at [https://github.com/ToTt0G/anki](https://github.com/ToTt0G/anki).
