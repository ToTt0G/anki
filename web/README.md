# klanki

A full-featured, zero-account, real-time syncing web port of Anki built for Cloudflare Workers with Durable Objects SQLite and WebSockets, hosted at **https://klanki.ezryder.us**.

## Architecture

- **Core Engine**: Complete Anki V3 spaced repetition scheduler (learning steps, graduating/easy intervals, ease factor adjustments, lapse multiplier, leech actions, review fuzzing, and FSRS algorithm compatibility).
- **Template & Cloze Engine**: Native Cloze deletion syntax `{{c1::answer::hint}}`, field replacement `{{Field}}`, inverted conditionals `{{^Field}}`, conditional sections `{{#Field}}`, `{{FrontSide}}`, MathJax/LaTeX mathematical typesetting, and audio playback.
- **Card Browser & Search**: Anki search syntax (`deck:`, `tag:`, `is:due`, `is:new`, `is:learn`, `is:suspended`, `note:`, full text search), card editor, reset/bury/suspend.
- **Memory & Daily Recap Statistics**: Real-time study statistics, retention rate, forecast calendar, 30-day activity heatmap, and card state breakdown (Mature, Young, Learn, New, Suspended).
- **Import & Export**: Client-side `.apkg` extraction with SQLite database parsing via WebAssembly (`sql.js` + `jszip`), CSV/TSV import with automatic delimiters, and deck export.
- **Minimalist Mobile-First UI**: Strict adherence to Anki's original minimal UI conventions—zero redundant marketing labels, fluff text, or decorative clutter. Fully responsive for desktop, tablets, and smartphones.
- **Multi-User Isolation & Real-Time Sync**: Clerk authentication (`@clerk/react` + `@clerk/backend`) with Google & Email sign-in. Every Cloudflare Worker API request verifies the Clerk session token and derives the user's isolated SQLite Durable Object (`user:${userId}`). WebSocket connections authenticate via short-lived (60s), single-use HMAC-signed connection tickets (`POST /api/ws-ticket` → `wss://.../api/ws?ticket=...`), and local offline storage & Web Push subscriptions are strictly scoped per authenticated user.

## Running Locally

```bash
cd web
npm install --legacy-peer-deps
npm run build
npm run worker:dev
```

Open `http://localhost:8787`.

## Deploying to Cloudflare Workers

```bash
cd web
npm run build
npx wrangler deploy
```
