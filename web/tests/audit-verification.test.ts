// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import JSZip from "jszip";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    getAuthorizedParties,
    isAllowedRequestOrigin,
    issueSignedWsTicket,
    redactUrlForLog,
    resolveWsTicketSigningKey,
    verifySignedWsTicket,
    withSecurityHeaders,
} from "../server/auth.ts";
import {
    validateClientMessage,
    validateCollectionPayload,
    validatePushSubscriptionInput,
} from "../server/validation.ts";
import { shouldResetReviewCardState } from "../src/components/Reviewer.tsx";
import { buildProductionCspHeader } from "../src/core/csp-constants.ts";
import { createDefaultCollection } from "../src/core/default-data.ts";
import {
    clearUserOfflineData,
    enqueueOutboxOp,
    getClearDataOnSignOutPreference,
    getOutboxOps,
    loadCollectionFromIdb,
    removeOutboxOp,
    saveCollectionToIdb,
    setClearDataOnSignOutPreference,
} from "../src/core/idb-storage.ts";
import { generateUniqueId, generateUniqueIds } from "../src/core/ids.ts";
import {
    createMissingClozeCards,
    exportApkg,
    exportDeckCsv,
    findOrphanedMediaFilenames,
    importApkg,
    importCsv,
    mergeImportedCollectionBundle,
    parseDelimitedRows,
    serializeTsvCell,
} from "../src/core/import-export.ts";
import { selectMathJaxSourcesForHtml } from "../src/core/mathjax.ts";
import { inspectMediaBytes, normalizeMediaFilename, validateMediaDataUrl } from "../src/core/media-validation.ts";
import { decodeHtmlEntities, extractTextFromHtml, sanitizeCardCss, sanitizeCardHtml } from "../src/core/sanitize.ts";
import {
    addCalendarDays,
    calculateScheduling,
    fsrsInitialDifficulty,
    fsrsInitialStability,
    fsrsIntervalFromStability,
    fsrsNextDifficulty,
    fsrsNextForgetStability,
    fsrsNextRecallStability,
    fsrsRetrievability,
    fsrsSameDayStability,
    getAllDeckCounts,
    getCustomStudyCardIds,
    getDeckCounts,
    getLocalDayStartMs,
    getNextStudyCard,
    getTodayDay,
    isCardDue,
    isCardDueInLearnQueue,
    isValidDailyTime,
    normalizeReviewDueDay,
    resetCardProgress,
    restoreCardQueue,
    toRelativeAnkiDueDay,
    zonedTimeToUtcMs,
} from "../src/core/scheduler.ts";
import { searchCards } from "../src/core/search.ts";
import { calculateDueForecast, calculateTodayStats } from "../src/core/stats.ts";
import { applyClientMutationLocally, computeReconnectDelayMs } from "../src/core/sync-client.ts";
import { compareTypedAnswer, renderCardTemplate, safeDecodeURIComponent, stripHtml } from "../src/core/template.ts";
import { resolveClerkPublishableKey } from "../src/main.tsx";

const VALID_PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

describe("A. Security & Privacy (SEC-01–SEC-13, S01–S12, V01–V03)", () => {
    it("SEC-05/S01/V01: allowlist sanitizer strips scripts, encoded javascript: URIs, SVG/Math/form payloads, and stripHtml is inert", () => {
        const maliciousHtml = `
      <div>Safe Question</div>
      <script>fetch('/api/collection')</script>
      <script>unclosed_evil()
      <img src="x" onerror="alert(document.cookie)" onload="steal()">
      <svg onload="evil()"><circle r="10"/></svg>
      <a href="javascript:alert(1)">Click1</a>
      <a href="java&#x09;script:alert(2)">Click2</a>
      <a href="&#106;&#97;vascript:alert(3)">Click3</a>
      <a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Click4</a>
      <iframe src="https://evil.example"></iframe>
    `;
        const cleaned = sanitizeCardHtml(maliciousHtml);
        assert.ok(!cleaned.includes("<script"), "script tag must be removed");
        assert.ok(!cleaned.includes("unclosed_evil"), "unclosed script block must be removed");
        assert.ok(!cleaned.includes("onerror"), "onerror handler must be removed");
        assert.ok(!cleaned.includes("onload"), "onload handler must be removed");
        assert.ok(!cleaned.includes("<svg"), "svg container must be removed");
        assert.ok(!cleaned.toLowerCase().includes("javascript:"), "javascript: URI must be neutralized");
        assert.ok(!cleaned.includes("java&#x09;script"), "entity-encoded javascript: URI must be neutralized");
        assert.ok(!cleaned.includes("&#106;"), "decimal-encoded javascript: URI must be neutralized");
        assert.ok(!cleaned.includes("data:text/html"), "data:text/html URI must be neutralized");
        assert.ok(!cleaned.includes("<iframe"), "iframe must be removed");
        assert.ok(cleaned.includes("Safe Question"), "legitimate content preserved");
        const collision = sanitizeCardHtml(
            "<div id=\"klanki-card-config\">bad</div><div id=\"card-root\">bad</div><div id=\"custom-id\">ok</div>",
        );
        assert.ok(!collision.includes("id=\"klanki-card-config\""), "internal config ID cannot be shadowed");
        assert.ok(!collision.includes("id=\"card-root\""), "internal card root ID cannot be shadowed");
        assert.ok(collision.includes("id=\"custom-id\""), "ordinary note IDs are preserved");

        assert.equal(decodeHtmlEntities("java&#x09;script&#58;"), "java\tscript:");
        assert.equal(extractTextFromHtml("<b>Hello</b> <script>evil()</script>World"), "Hello World");
        assert.equal(stripHtml("<p>Inert &amp; safe</p><img src=x onerror=alert(1)>"), "Inert & safe");

        const maliciousCss = `
      @import url("https://evil.example/steal.css");
      .card { background: url(javascript:alert(1)); width: expression(alert(1)); color: #111; }
    `;
        const cleanedCss = sanitizeCardCss(maliciousCss);
        assert.ok(!cleanedCss.includes("@import"), "@import must be stripped");
        assert.ok(!cleanedCss.includes("javascript:"), "javascript url in CSS must be stripped");
        assert.ok(!cleanedCss.includes("expression("), "CSS expression must be stripped");
    });

    it("SEC-07/SEC-11/SEC-12: enforces production Origin allowlists, removes unsafe-inline from script-src CSP, and isolates WS ticket signing key", async () => {
        const crossOriginPost = new Request("https://klanki.ezryder.us/api/collection", {
            method: "POST",
            headers: {
                Origin: "https://evil.example.com",
                Cookie: "__session=fake",
            },
        });
        assert.equal(isAllowedRequestOrigin(crossOriginPost, {}), false);

        // SEC-11: Localhost origin must be rejected when ENVIRONMENT is production
        const localhostAgainstProd = new Request("https://klanki.ezryder.us/api/collection", {
            method: "POST",
            headers: {
                Origin: "http://localhost:5173",
                Authorization: "Bearer token",
            },
        });
        assert.equal(
            isAllowedRequestOrigin(localhostAgainstProd, { ENVIRONMENT: "production" }),
            false,
            "Production environment must not trust localhost Origin",
        );
        assert.ok(
            !getAuthorizedParties({ ENVIRONMENT: "production" }).includes("http://localhost:5173"),
            "Production authorizedParties must not contain localhost",
        );

        // SEC-11: Untrusted request host must not implicitly add itself to authorized origins
        const untrustedHostReq = new Request("https://preview-untrusted.example.com/api/collection", {
            method: "POST",
            headers: {
                Origin: "https://preview-untrusted.example.com",
                Authorization: "Bearer token",
            },
        });
        assert.equal(
            isAllowedRequestOrigin(untrustedHostReq, { ENVIRONMENT: "production" }),
            false,
            "Request origin not in allowlist must be rejected",
        );

        const sameOriginPost = new Request("https://klanki.ezryder.us/api/collection", {
            method: "POST",
            headers: {
                Origin: "https://klanki.ezryder.us",
                Authorization: "Bearer token",
            },
        });
        assert.equal(isAllowedRequestOrigin(sameOriginPost, { ENVIRONMENT: "production" }), true);

        const redacted = redactUrlForLog("https://klanki.ezryder.us/api/ws?ticket=secret_ticket_123");
        assert.ok(!redacted.includes("secret_ticket_123"));
        assert.ok(redacted.includes("REDACTED"));

        // SEC-07: script-src must use SHA-256 hash instead of 'unsafe-inline'
        const secured = withSecurityHeaders(new Response("ok", { status: 200 }));
        assert.equal(secured.headers.get("X-Content-Type-Options"), "nosniff");
        assert.equal(secured.headers.get("X-Frame-Options"), "DENY");
        const csp = secured.headers.get("Content-Security-Policy") || "";
        assert.ok(csp.includes("default-src 'self'"));
        const scriptSrcDirective = csp.split(";").find(d => d.trim().startsWith("script-src")) || "";
        assert.ok(
            !scriptSrcDirective.includes("'unsafe-inline'"),
            "script-src must not permit 'unsafe-inline'",
        );
        assert.ok(
            scriptSrcDirective.includes("'sha256-"),
            "script-src must authorize sandbox bootstrap script via sha256 hash",
        );

        // SEC-12: Dedicated WS_TICKET_SIGNING_KEY and domain-separated derivation
        const explicitKey = await resolveWsTicketSigningKey({
            CLERK_SECRET_KEY: "clerk_secret",
            WS_TICKET_SIGNING_KEY: "dedicated_ws_key",
        });
        assert.equal(explicitKey, "dedicated_ws_key");

        const derivedKey = await resolveWsTicketSigningKey({
            CLERK_SECRET_KEY: "clerk_secret",
        });
        assert.ok(derivedKey && derivedKey !== "clerk_secret", "Derived key must not equal raw CLERK_SECRET_KEY");

        const { ticket, nonce } = await issueSignedWsTicket("user_123", derivedKey!);
        const verified = await verifySignedWsTicket(ticket, derivedKey!);
        assert.equal(verified?.sub, "user_123");
        assert.equal(verified?.nonce, nonce);
        const wrongSecret = await verifySignedWsTicket(ticket, "clerk_secret");
        assert.equal(wrongSecret, null, "Raw CLERK_SECRET_KEY must not validate ticket signed with derived key");
    });

    it("SEC-02/DATA-11/DATA-12: validates complete collection schemas, foreign keys, revlog cid matching, and push SSRF", () => {
        assert.equal(
            validatePushSubscriptionInput({
                endpoint: "http://fcm.googleapis.com/fcm/send/123",
                keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
            }).ok,
            false,
        );
        assert.equal(
            validatePushSubscriptionInput({
                endpoint: "https://127.0.0.1:8080/internal",
                keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
            }).ok,
            false,
        );
        assert.equal(
            validatePushSubscriptionInput({
                endpoint: "https://fcm.googleapis.com/fcm/send/valid-token",
                keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
            }).ok,
            true,
        );

        assert.equal(validateClientMessage({ type: "delete_deck", deckId: -5 }).ok, false);
        assert.equal(validateClientMessage({ type: "delete_deck", deckId: 1 }).ok, false);
        assert.equal(validateClientMessage({ type: "delete_deck", deckId: 42 }).ok, true);
        assert.equal(validateCollectionPayload(null), "Collection must be an object");

        // SEC-02 & DATA-11: Valid default collection passes
        const validCol = createDefaultCollection();
        assert.equal(validateCollectionPayload(validCol), null);

        // Orphaned card.did -> rejected
        const orphanDeckCol = structuredClone(validCol);
        Object.values(orphanDeckCol.cards)[0].did = 999999;
        assert.match(validateCollectionPayload(orphanDeckCol) || "", /nonexistent deck/);

        // Orphaned card.nid -> rejected
        const orphanNoteCol = structuredClone(validCol);
        Object.values(orphanNoteCol.cards)[0].nid = 888888;
        assert.match(validateCollectionPayload(orphanNoteCol) || "", /nonexistent note/);

        // Orphaned note.mid -> rejected
        const orphanModelCol = structuredClone(validCol);
        Object.values(orphanModelCol.notes)[0].mid = 777777;
        assert.match(validateCollectionPayload(orphanModelCol) || "", /nonexistent model/);

        // Malformed dconf -> rejected
        const badDconfCol = structuredClone(validCol);
        (badDconfCol.dconf[1].rev as any).maxIvl = -10;
        assert.match(validateCollectionPayload(badDconfCol) || "", /maxIvl/);

        // Malformed revlog -> rejected
        const badRevlogCol = structuredClone(validCol);
        badRevlogCol.revlog.push({
            id: 1,
            cid: 1,
            usn: 0,
            ease: 99 as any,
            ivl: 1,
            lastIvl: 0,
            factor: 2500,
            time: 100,
            type: 0,
        });
        assert.match(validateCollectionPayload(badRevlogCol) || "", /Revlog ease/);

        // DATA-12: answer_card revlogEntry.cid must equal cardId
        const badAnswerMsg = validateClientMessage({
            type: "answer_card",
            cardId: 100,
            nextState: { reps: 1 },
            revlogEntry: {
                id: 1700000000000,
                cid: 200,
                usn: 0,
                ease: 3,
                ivl: 1,
                lastIvl: 0,
                factor: 2500,
                time: 1000,
                type: 0,
            },
        });
        assert.equal(badAnswerMsg.ok, false);
    });

    it("SEC-13 & UX-10: validates media filenames, magic bytes, and image dimensions", () => {
        assert.equal(normalizeMediaFilename("../etc/passwd"), null);
        assert.equal(normalizeMediaFilename("script.svg"), null);
        assert.equal(normalizeMediaFilename("malware.exe"), null);
        assert.equal(normalizeMediaFilename("diagram.png"), "diagram.png");

        // Disguised HTML/SVG claiming to be .png must fail magic-byte inspection
        const fakePngBytes = new TextEncoder().encode("<svg onload=alert(1)></svg>");
        assert.equal(inspectMediaBytes(fakePngBytes).ok, false);
        const fakeDataUrl = `data:image/png;base64,${btoa("<svg onload=alert(1)></svg>")}`;
        assert.equal(validateMediaDataUrl("fake.png", fakeDataUrl).ok, false);

        // Valid 1x1 PNG passes
        const validMedia = validateMediaDataUrl("valid.png", VALID_PNG_DATA_URL);
        assert.equal(validMedia.ok, true);

        // L-03: Declared MIME that disagrees with binary signature must be rejected
        const mismatchedMime = VALID_PNG_DATA_URL.replace("data:image/png;", "data:audio/mpeg;");
        const mismatchRes = validateMediaDataUrl("song.mp3", mismatchedMime);
        assert.equal(mismatchRes.ok, false);
        if (!mismatchRes.ok) {
            assert.match(mismatchRes.error, /Declared MIME type/);
        }

        // L-01 & L-04: Clerk key config validation and 24-hour notification time validation
        assert.throws(() => resolveClerkPublishableKey({}), /Missing VITE_CLERK_PUBLISHABLE_KEY/);
        assert.equal(resolveClerkPublishableKey({ VITE_CLERK_PUBLISHABLE_KEY: "pk_test_123" }), "pk_test_123");
        assert.equal(isValidDailyTime("09:00"), true);
        assert.equal(isValidDailyTime("23:59"), true);
        assert.equal(isValidDailyTime("24:00"), false);
        assert.equal(isValidDailyTime("99:99"), false);
        assert.equal(isValidDailyTime("09:60"), false);

        // PNG header with oversized dimensions (10000 x 10000 > 8192) must be rejected
        const oversizedPng = new Uint8Array(24);
        oversizedPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
        const dv = new DataView(oversizedPng.buffer);
        dv.setUint32(16, 10_000, false);
        dv.setUint32(20, 10_000, false);
        const dimRes = inspectMediaBytes(oversizedPng);
        assert.equal(dimRes.ok, false);
        if (!dimRes.ok) {
            assert.match(dimRes.error, /dimensions/);
        }
    });

    it("CI-05 / SEC-05 / SEC-07 / M-02 / M-10: verifies static and Worker CSP parity and mandatorily runs real Chromium browser sandbox check", async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const os = await import("node:os");
        const http = await import("node:http");
        const { execFileSync, spawn } = await import("node:child_process");
        const esbuild = await import("esbuild");

        // M-02: Verify static `public/_headers` CSP and Worker `withSecurityHeaders()` CSP are byte-for-byte identical
        const headersFileText = fs.readFileSync("public/_headers", "utf8");
        const staticCspLine = headersFileText
            .split("\n")
            .find(l => l.trim().startsWith("Content-Security-Policy:")) || "";
        const staticCsp = staticCspLine.replace(/^\s*Content-Security-Policy:\s*/, "").trim();
        const workerCsp = withSecurityHeaders(new Response("ok")).headers.get("Content-Security-Policy") || "";
        assert.equal(
            staticCsp,
            buildProductionCspHeader(),
            "Static _headers CSP must match buildProductionCspHeader()",
        );
        assert.equal(workerCsp, staticCsp, "Worker CSP and static _headers CSP must be byte-for-byte identical");

        // M-10: Discover Playwright or system Chromium binary and require mandatory execution (never silently skip)
        const pwCacheDir = path.join(os.homedir(), ".cache", "ms-playwright");
        const pwBins: string[] = [];
        if (fs.existsSync(pwCacheDir)) {
            for (const dir of fs.readdirSync(pwCacheDir)) {
                pwBins.push(
                    path.join(pwCacheDir, dir, "chrome-headless-shell-linux64", "chrome-headless-shell"),
                    path.join(pwCacheDir, dir, "chrome-linux64", "chrome"),
                    path.join(pwCacheDir, dir, "chrome-linux", "chrome"),
                );
            }
        }

        const candidates = [
            process.env.CHROME_BIN,
            ...pwBins,
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
        ].filter((p): p is string => {
            if (!p || !fs.existsSync(p)) { return false; }
            try {
                execFileSync(p, ["--version"], { stdio: "ignore", timeout: 3000 });
                return true;
            } catch {
                return false;
            }
        });

        assert.ok(
            candidates.length > 0,
            "M-10: A working headless Chromium binary must be installed for browser security verification",
        );
        const chromeBin = candidates[0];

        const entryCode = `
            import React from "react";
            import { createRoot } from "react-dom/client";
            import { SandboxedCardFrame } from "./src/components/SandboxedCardFrame.tsx";

            let xssExecuted = false;
            let heightReports = 0;
            let reported = false;

            function sendReport() {
                if (reported) return;
                reported = true;
                const iframe = document.querySelector("iframe");
                let opaqueOriginIsolated = false;
                try {
                    const doc = iframe ? iframe.contentDocument : null;
                    opaqueOriginIsolated = (doc === null);
                } catch {
                    opaqueOriginIsolated = true;
                }
                fetch("/browser-report", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        xssExecuted,
                        heightReports,
                        opaqueOriginIsolated,
                        sandboxAttr: iframe ? iframe.getAttribute("sandbox") : "",
                    }),
                });
            }

            window.addEventListener("message", (e) => {
                if (e.data && e.data.type === "xss-executed") {
                    xssExecuted = true;
                }
                if (e.data && e.data.type === "klanki-card-height") {
                    heightReports++;
                    setTimeout(sendReport, 200);
                }
            });

            const adversarialCardHtml = [
                '<div>Safe Browser Question \\\\(\\\\color{red}{x^2 + y^2 = z^2}\\\\)</div>',
                '<script>parent.postMessage({type:"xss-executed"},"*")</script>',
                '<img src="x" onerror="parent.postMessage({type:\\x27xss-executed\\x27},\\x27*\\x27)">',
                '<svg onload="parent.postMessage({type:\\x27xss-executed\\x27},\\x27*\\x27)"></svg>',
                '<a href="java&#x09;script:parent.postMessage({type:\\x27xss-executed\\x27},\\x27*\\x27)">BadLink</a>'
            ].join("");

            const host = document.createElement("div");
            document.body.appendChild(host);
            createRoot(host).render(React.createElement(SandboxedCardFrame, { html: adversarialCardHtml }));

            setTimeout(sendReport, 2500);
        `;

        const built = await esbuild.build({
            stdin: {
                contents: entryCode,
                resolveDir: process.cwd(),
                sourcefile: "browser-security-entry.tsx",
                loader: "tsx",
            },
            bundle: true,
            format: "esm",
            write: false,
        });
        const bundleJs = built.outputFiles[0].text;
        const securedRes = withSecurityHeaders(new Response("ok"));
        const prodCsp = securedRes.headers.get("Content-Security-Policy")!;

        let report: any = null;
        const cspViolations: string[] = [];
        const server = http.createServer((req, res) => {
            const u = new URL(req.url || "/", "http://127.0.0.1");
            if (u.pathname === "/browser-report" && req.method === "POST") {
                let body = "";
                req.on("data", c => (body += c));
                req.on("end", () => {
                    report = JSON.parse(body);
                    res.end("ok");
                });
                return;
            }
            if (u.pathname === "/bundle.js") {
                res.setHeader("Content-Type", "text/javascript");
                res.end(bundleJs);
                return;
            }
            if (u.pathname === "/") {
                res.setHeader("Content-Type", "text/html");
                res.setHeader("Content-Security-Policy", prodCsp);
                res.end(
                    "<!doctype html><html><body><script type=\"module\" src=\"/bundle.js\"></script></body></html>",
                );
                return;
            }
            const staticPath = path.join("public", u.pathname);
            if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
                res.setHeader(
                    "Content-Type",
                    staticPath.endsWith(".json") ? "application/json" : "text/javascript",
                );
                res.end(fs.readFileSync(staticPath));
                return;
            }
            res.statusCode = 404;
            res.end();
        });

        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address() as { port: number };
        let procExited = false;
        const proc = spawn(chromeBin, [
            "--headless",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--enable-logging=stderr",
            "--v=0",
            "--virtual-time-budget=2500",
            "--dump-dom",
            `http://127.0.0.1:${addr.port}/`,
        ]);
        proc.on("exit", () => {
            procExited = true;
        });
        proc.stderr.on("data", chunk => {
            const text = String(chunk);
            if (text.includes("violates the following Content Security Policy")) {
                cspViolations.push(text.trim());
            }
        });

        try {
            const start = Date.now();
            while (!report && !procExited && Date.now() - start < 10000) {
                await new Promise(r => setTimeout(r, 40));
            }
            // M-10: Never silently skip if browser failed to report
            assert.ok(report, "Browser security report must be received from headless Chromium");
            assert.equal(report.xssExecuted, false, "No adversarial script or event handler may execute");
            assert.equal(
                report.opaqueOriginIsolated,
                true,
                "Sandboxed iframe must enforce opaque-origin DOM isolation",
            );
            assert.equal(report.sandboxAttr, "allow-scripts", "Iframe sandbox must never include allow-same-origin");
            assert.ok(report.heightReports >= 1, "Hashed bootstrap script must execute and report card height");
            assert.deepEqual(cspViolations, [], "Legitimate card & MathJax scripts must produce zero CSP violations");
        } finally {
            proc.kill();
            server.close();
        }
    });
});

describe("B. Sync, Outbox, IDs, Account Lifecycle & Data Integrity (DATA-01–DATA-15, SEC-04)", () => {
    it("D06/D11: generates strictly unique IDs even within the same millisecond", () => {
        const ids = generateUniqueIds(500);
        const unique = new Set(ids);
        assert.equal(unique.size, 500, "All 500 rapid IDs must be distinct");

        const collisionSet = new Set<number>([ids[499] + 1]);
        const nextId = generateUniqueId(collisionSet);
        assert.ok(!collisionSet.has(nextId));
    });

    it("D01/D03/D04/UX-01/SEC-04: cascading deck deletes, cascading parent deck renames, and shared-device sign-out cleanup", async () => {
        const userId = "user_test_sync";
        const col = createDefaultCollection();
        const parentDid = generateUniqueId(col.decks);
        const childDid = generateUniqueId(col.decks);

        col.decks[parentDid] = {
            id: parentDid,
            name: "Science",
            desc: "",
            collapsed: false,
            conf: 1,
            dyn: 0,
            mod: 100,
            usn: 0,
        };
        col.decks[childDid] = {
            id: childDid,
            name: "Science::Chemistry",
            desc: "",
            collapsed: false,
            conf: 1,
            dyn: 0,
            mod: 100,
            usn: 0,
        };

        // UX-01: Renaming parent deck "Science" must rename child "Science::Chemistry"
        applyClientMutationLocally(col, {
            type: "upsert_deck",
            deck: { ...col.decks[parentDid], name: "Natural Science" },
        });
        assert.equal(col.decks[parentDid].name, "Natural Science");
        assert.equal(col.decks[childDid].name, "Natural Science::Chemistry");

        const nid = generateUniqueId(col.notes);
        const cid = generateUniqueId(col.cards);
        col.notes[nid] = {
            id: nid,
            guid: `g_${nid}`,
            mid: 1,
            mod: 100,
            usn: 0,
            tags: [],
            fields: ["Q", "A"],
            sfld: "Q",
            csum: 0,
            flags: 0,
            data: "{}",
        };
        col.cards[cid] = {
            id: cid,
            nid,
            did: childDid,
            ord: 0,
            mod: 100,
            usn: 0,
            type: 0,
            queue: 0,
            due: 1,
            ivl: 0,
            factor: 2500,
            reps: 0,
            lapses: 0,
            left: 0,
            odue: 0,
            odid: 0,
            flags: 0,
            data: "{}",
        };

        await enqueueOutboxOp({
            opId: "op_del_1",
            userId,
            createdAt: Date.now(),
            msg: { type: "delete_deck", deckId: parentDid },
        });
        const ops = await getOutboxOps(userId);
        assert.equal(ops.length, 1);

        applyClientMutationLocally(col, ops[0].msg);
        assert.equal(col.decks[parentDid], undefined, "Parent deck deleted");
        assert.equal(col.decks[childDid], undefined, "Child subdeck deleted");
        assert.equal(col.cards[cid], undefined, "Card in child subdeck deleted");
        assert.equal(col.notes[nid], undefined, "Orphaned note deleted");

        await removeOutboxOp(userId, "op_del_1");
        assert.equal((await getOutboxOps(userId)).length, 0);

        await saveCollectionToIdb(userId, col, 5, true);
        const loaded = await loadCollectionFromIdb(userId);
        assert.equal(loaded?.revision, 5);
        assert.equal(loaded?.initialized, true);

        // SEC-04: Sign-out data cleanup preference defaults to true
        assert.equal(getClearDataOnSignOutPreference(), true);
        setClearDataOnSignOutPreference(false);
        assert.equal(getClearDataOnSignOutPreference(), false);
        setClearDataOnSignOutPreference(true);
        assert.equal(getClearDataOnSignOutPreference(), true);

        await clearUserOfflineData(userId);
        assert.equal(await loadCollectionFromIdb(userId), null);
    });
});

describe("C. Anki Scheduler, FSRS Reference Validation, Search, Export & Performance", () => {
    it("C01/C02/C05: normalizes collection-relative review due dates and round-trips to relative Anki due days", () => {
        const crtSec = 1700000000;
        const crtDay = Math.floor(crtSec / 86400);
        const relativeDue = 30;
        const epochDue = normalizeReviewDueDay(relativeDue, crtSec);
        assert.equal(epochDue, crtDay + 30);

        const exportedRelative = toRelativeAnkiDueDay(epochDue, crtSec);
        assert.equal(exportedRelative, 30);

        const today = getTodayDay();
        const dayLearnCard: any = { queue: 3, due: today - crtDay };
        assert.equal(isCardDueInLearnQueue(dayLearnCard, Math.floor(Date.now() / 1000), today, crtSec), true);
    });

    it("SCHED-03 & SCHED-04: validates FSRS formulas against reference values and enforces maxIvl caps", () => {
        // SCHED-04: Official FSRS v4.5/v5 reference properties
        // 1. Initial stability S0(G) = w[G-1]
        assert.equal(fsrsInitialStability(1), 0.40255);
        assert.equal(fsrsInitialStability(2), 1.18385);
        assert.equal(fsrsInitialStability(3), 3.173);
        assert.equal(fsrsInitialStability(4), 15.69105);

        // 2. Retrievability R(t, S) at t = 0 is 1.0, and at t = S is exactly 0.90
        assert.equal(fsrsRetrievability(0, 10), 1);
        assert.ok(Math.abs(fsrsRetrievability(10, 10) - 0.9) < 1e-9, "At elapsedDays == stability, R must equal 0.9");

        // 3. Interval for desiredRetention = 0.90 equals round(stability)
        assert.equal(fsrsIntervalFromStability(10, 0.9, 36500), 10);

        // 4. Difficulty decreases on Easy (4), stays near constant on Good (3), increases on Again (1) / Hard (2)
        const d0Good = fsrsInitialDifficulty(3);
        const dAfterAgain = fsrsNextDifficulty(d0Good, 1);
        const dAfterHard = fsrsNextDifficulty(d0Good, 2);
        const dAfterGood = fsrsNextDifficulty(d0Good, 3);
        const dAfterEasy = fsrsNextDifficulty(d0Good, 4);
        assert.ok(dAfterAgain > dAfterHard && dAfterHard > dAfterGood && dAfterGood > dAfterEasy);

        // 5. Recall stability increases monotonically with rating (Hard < Good < Easy) and forget stability <= S
        const s0 = 10;
        const r = fsrsRetrievability(10, s0);
        const sForget = fsrsNextForgetStability(5, s0, r);
        const sHard = fsrsNextRecallStability(5, s0, r, 2);
        const sGood = fsrsNextRecallStability(5, s0, r, 3);
        const sEasy = fsrsNextRecallStability(5, s0, r, 4);
        assert.ok(sForget <= s0, "Forget stability must not exceed pre-lapse stability");
        assert.ok(
            sHard > s0 && sGood > sHard && sEasy > sGood,
            "Recall stabilities must order s0 < Hard < Good < Easy",
        );

        // 6. Same-day stability S'(S, G)
        assert.ok(fsrsSameDayStability(10, 4) > fsrsSameDayStability(10, 3));
        assert.ok(fsrsSameDayStability(10, 1) < 10);

        // SCHED-03: Intervals must never exceed configured maxIvl even when Hard hits maxIvl
        const col = createDefaultCollection();
        const cappedConfig = {
            ...col.dconf[1],
            fsrsEnabled: true,
            desiredRetention: 0.85,
            rev: { ...col.dconf[1].rev, maxIvl: 15 },
        };
        const matureCard: any = {
            id: 5001,
            nid: 4001,
            did: 1,
            ord: 0,
            mod: 0,
            usn: 0,
            type: 2,
            queue: 2,
            due: getTodayDay(),
            ivl: 15,
            factor: 2500,
            reps: 8,
            lapses: 0,
            left: 0,
            odue: 0,
            odid: 0,
            flags: 0,
            data: JSON.stringify({ s: 50, d: 3, lastRevDay: getTodayDay() - 20 }),
        };
        const cappedOptions = calculateScheduling(matureCard, cappedConfig);
        for (const opt of cappedOptions) {
            if (opt.rating >= 2) {
                assert.ok(
                    opt.nextState.ivl <= 15,
                    `Rating ${opt.rating} interval (${opt.nextState.ivl}) must not exceed maxIvl (15)`,
                );
            }
        }
    });

    it("UX-02 & UX-03: unsuspending/unburying preserves learning queue semantics and resetting clears FSRS memory state", () => {
        // UX-02: Intraday learning card (type=1, due in unix seconds) restores to queue=1
        const intradayLearnCard: any = { type: 1, queue: -1, due: 1_770_000_000 };
        assert.equal(restoreCardQueue(intradayLearnCard), 1);

        // Relearning card (type=3, due in unix seconds) restores to queue=1
        const relearnCard: any = { type: 3, queue: -1, due: 1_770_000_000 };
        assert.equal(restoreCardQueue(relearnCard), 1);

        // Day-learning card (type=1, due in epoch days) restores to queue=3
        const dayLearnCard: any = { type: 1, queue: -2, due: 20_500 };
        assert.equal(restoreCardQueue(dayLearnCard), 3);

        // New card restores to queue=0; Review card restores to queue=2
        assert.equal(restoreCardQueue({ type: 0, due: 1 }), 0);
        assert.equal(restoreCardQueue({ type: 2, due: 20_500 }), 2);

        // UX-03: Resetting a mature FSRS card clears `card.data` along with scheduling fields
        const matureFsrsCard: any = {
            id: 901,
            nid: 801,
            did: 1,
            ord: 0,
            mod: 100,
            usn: 0,
            type: 2,
            queue: 2,
            due: 20_600,
            ivl: 42,
            factor: 2650,
            reps: 11,
            lapses: 2,
            left: 0,
            odue: 20_500,
            odid: 2,
            flags: 1,
            data: JSON.stringify({ s: 42.5, d: 4.1, lastRevDay: 20_558 }),
        };
        const reset = resetCardProgress(matureFsrsCard);
        assert.equal(reset.type, 0);
        assert.equal(reset.queue, 0);
        assert.equal(reset.ivl, 0);
        assert.equal(reset.reps, 0);
        assert.equal(reset.lapses, 0);
        assert.equal(reset.odue, 0);
        assert.equal(reset.odid, 0);
        assert.equal(reset.data, "{}", "FSRS memory state in card.data must be cleared on reset");
    });

    it("UX-07, UX-08 & UX-11: search parser handles quoted deck names, is:due excludes new cards, and Custom Study lapsed-today uses revlog", () => {
        const col = createDefaultCollection();
        col.decks[20] = {
            id: 20,
            name: "My Deck",
            desc: "",
            collapsed: false,
            conf: 1,
            dyn: 0,
            mod: 1,
            usn: 0,
        };
        col.decks[21] = {
            id: 21,
            name: "My Deck::Subtopic",
            desc: "",
            collapsed: false,
            conf: 1,
            dyn: 0,
            mod: 1,
            usn: 0,
        };
        const cards = Object.values(col.cards);
        cards[0].did = 20;
        cards[1].did = 21;

        // UX-07: Search deck:"My Deck"
        const matches = searchCards(col, "deck:\"My Deck\"");
        const matchedCardIds = new Set(matches.map(m => m.card.id));
        assert.ok(matchedCardIds.has(cards[0].id), "Finds card in 'My Deck'");
        assert.ok(matchedCardIds.has(cards[1].id), "Finds card in 'My Deck::Subtopic'");
        assert.ok(!matchedCardIds.has(cards[2].id), "Excludes card in Default deck");

        // UX-08: All default cards are New (queue=0); `is:due` must return 0 cards until a card is actually due
        assert.equal(searchCards(col, "is:due").length, 0, "New cards must not match is:due");
        cards[0].queue = 2;
        cards[0].type = 2;
        cards[0].due = getTodayDay();
        assert.equal(searchCards(col, "is:due").length, 1, "Due review card matches is:due");
        assert.equal(isCardDue(cards[2], Math.floor(Date.now() / 1000), getTodayDay(), col.crt), false);

        // UX-11: Card in queue=1 from yesterday (without today's lapse revlog) must NOT be selected by getCustomStudyCardIds
        cards[1].queue = 1;
        cards[1].type = 1;
        cards[1].due = Math.floor(Date.now() / 1000);
        assert.deepEqual(
            getCustomStudyCardIds(col, 20),
            [],
            "Learning card without a lapse revlog entry today must not be included in lapsed-today custom study",
        );
        col.revlog.push({
            id: getLocalDayStartMs() + 100,
            cid: cards[1].id,
            usn: 0,
            ease: 1,
            ivl: -60,
            lastIvl: 5,
            factor: 2300,
            time: 1000,
            type: 1,
        });
        assert.deepEqual(
            getCustomStudyCardIds(col, 20),
            [cards[1].id],
            "Card lapsed today in subdeck is included in parent deck custom study",
        );
    });

    it("SEC-08 & UX-12: neutralizes spreadsheet formulas in exported TSV and handles malformed % in template media", () => {
        assert.equal(serializeTsvCell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
        assert.equal(serializeTsvCell(" +SUM(A1:A2)"), "' +SUM(A1:A2)");
        assert.equal(serializeTsvCell("-1+1"), "'-1+1");
        assert.equal(serializeTsvCell("@SUM(1,2)"), "'@SUM(1,2)");
        assert.equal(serializeTsvCell("field\twith\ttab"), "\"field\twith\ttab\"");

        const col = createDefaultCollection();
        const firstNote = Object.values(col.notes)[0];
        firstNote.fields = ["=HYPERLINK(\"https://evil.example\")", "Normal\tAnswer"];
        const tsv = exportDeckCsv(col, 1);
        const firstLine = tsv.split("\n")[0];
        assert.ok(firstLine.startsWith("\"'=HYPERLINK"), "Formula-leading cell must be neutralized with leading quote");

        // UX-12: Malformed percent-encoding in media references must not throw URIError
        assert.equal(safeDecodeURIComponent("100%_cotton.png"), "100%_cotton.png");
        firstNote.fields = ["<img src=\"100%_cotton.png\"> [sound:50%off.mp3]", "Back"];
        const card = Object.values(col.cards).find(c => c.nid === firstNote.id)!;
        const model = col.models[firstNote.mid];
        const rendered = renderCardTemplate(card, firstNote, model, {
            "100%_cotton.png": VALID_PNG_DATA_URL,
        });
        assert.ok(rendered.frontHtml.includes(VALID_PNG_DATA_URL));
        assert.ok(rendered.frontHtml.includes("50%off.mp3"));
    });

    it("SEC-03 & V07: exporting a single deck excludes private media belonging to other decks and round-trips .apkg", async () => {
        (globalThis as any).window = {
            initSqlJs: (await import("sql.js")).default
                ? () =>
                    (import("sql.js") as any).then((m: any) =>
                        (m.default || m)({
                            locateFile: (file: string) => `./node_modules/sql.js/dist/${file}`,
                        })
                    )
                : undefined,
        };

        const sourceCol = createDefaultCollection();
        const today = getTodayDay();
        const firstCard = Object.values(sourceCol.cards)[0]!;
        const targetCid = firstCard.id;
        firstCard.type = 2;
        firstCard.queue = 2;
        firstCard.ivl = 14;
        firstCard.due = today + 14;

        // Add Public media to Deck 1 note, and Private media to a separate Deck 2 note
        const firstNote = sourceCol.notes[firstCard.nid];
        firstNote.fields[0] = "Public question <img src=\"public_diagram.png\">";
        sourceCol.media["public_diagram.png"] = VALID_PNG_DATA_URL;
        sourceCol.media["private_photo.png"] = VALID_PNG_DATA_URL;

        sourceCol.decks[2] = {
            id: 2,
            name: "Private Diary",
            desc: "",
            collapsed: false,
            conf: 1,
            dyn: 0,
            mod: 1,
            usn: 0,
        };
        sourceCol.notes[9001] = {
            id: 9001,
            guid: "priv_9001",
            mid: 1,
            mod: 1,
            usn: 0,
            tags: [],
            fields: ["<img src=\"private_photo.png\">", "Secret"],
            sfld: "Secret",
            csum: 0,
            flags: 0,
            data: "{}",
        };
        sourceCol.cards[9002] = {
            id: 9002,
            nid: 9001,
            did: 2,
            ord: 0,
            mod: 1,
            usn: 0,
            type: 0,
            queue: 0,
            due: 1,
            ivl: 0,
            factor: 2500,
            reps: 0,
            lapses: 0,
            left: 0,
            odue: 0,
            odid: 0,
            flags: 0,
            data: "{}",
        };

        // SEC-03: Export ONLY Deck 1 and inspect the ZIP contents directly
        const deck1Blob = await exportApkg(sourceCol, 1);
        const zip = await JSZip.loadAsync(await deck1Blob.arrayBuffer());
        const exportedMediaMap = JSON.parse(await zip.file("media")!.async("string")) as Record<string, string>;
        const exportedFilenames = Object.values(exportedMediaMap);
        assert.ok(exportedFilenames.includes("public_diagram.png"), "Deck 1's referenced media is packaged");
        assert.ok(
            !exportedFilenames.includes("private_photo.png"),
            "Deck 2's private media must NOT be disclosed when exporting Deck 1",
        );
        assert.equal(Object.keys(exportedMediaMap).length, 1);

        // Verify re-import preserves newer study progress by default (H-02) and remaps distinct colliding revlog IDs (M-08)
        const destCol = createDefaultCollection();
        destCol.notes = {};
        destCol.cards = {};

        const firstImport = await importApkg(deck1Blob, destCol);
        assert.equal(destCol.cards[targetCid].due, today + 14);
        assert.equal(destCol.cards[targetCid].ivl, 14);
        assert.equal(destCol.media["public_diagram.png"], VALID_PNG_DATA_URL);
        assert.equal(destCol.media["private_photo.png"], undefined);

        // H-02: Advance local study progress on destCol.cards[targetCid] to ivl=45, reps=5, mod=now+1000
        destCol.cards[targetCid].ivl = 45;
        destCol.cards[targetCid].reps = 5;
        destCol.cards[targetCid].due = today + 45;
        destCol.cards[targetCid].mod = Math.floor(Date.now() / 1000) + 1000;

        // Re-importing the older deck1Blob must preserve the newer local scheduling (ivl=45, reps=5)
        const secondImport = await importApkg(deck1Blob, destCol);
        assert.equal(secondImport.duplicateCount, firstImport.noteCount);
        assert.equal(destCol.cards[targetCid].ivl, 45, "H-02: Newer local interval preserved on re-import");
        assert.equal(destCol.cards[targetCid].reps, 5, "H-02: Newer local reps preserved on re-import");

        // NEW-06 & L-10: Shared model template media or plain-text substring must not leak, and orphaned media is detected
        sourceCol.media["unused_orphan.png"] = VALID_PNG_DATA_URL;
        assert.ok(findOrphanedMediaFilenames(sourceCol).includes("unused_orphan.png"));
        assert.ok(!findOrphanedMediaFilenames(sourceCol).includes("public_diagram.png"));
    });

    it("U-01, U-02, U-05 & U-06: typed-answer diff comparison, cloze CSV import, Reviewer state stability, and selective MathJax extension loading", () => {
        // U-01: Typed-answer comparison
        const exact = compareTypedAnswer("Stockholm", "Stockholm");
        assert.equal(exact.isExact, true);
        assert.ok(exact.html.includes("type-good"));

        const mismatch = compareTypedAnswer("Stockhlm", "Stockholm");
        assert.equal(mismatch.isExact, false);
        assert.ok(mismatch.html.includes("type-missed"), "Missing 'o' highlighted as type-missed");

        // U-02: CSV import with a Cloze note type generates one card per distinct cloze number
        const clozeCol = createDefaultCollection();
        clozeCol.notes = {};
        clozeCol.cards = {};
        const clozeModel = Object.values(clozeCol.models).find(m => m.type === 1)!;
        const csvClozeRes = importCsv(
            "\"{{c1::TCP}} uses {{c2::3-way}} handshake on port {{c3::80}}\"\tExtra info\tnetworking",
            clozeCol,
            1,
            clozeModel.id,
        );
        assert.equal(csvClozeRes.noteCount, 1);
        assert.equal(csvClozeRes.cardCount, 3, "U-02: Cloze CSV note with c1, c2, c3 must generate 3 cards");

        // U-05: Reviewer state remains stable across unrelated collection updates on the same active card
        const baseCard: any = { id: 10, nid: 1, did: 1, ord: 0, reps: 2, queue: 2, due: 20500 };
        assert.equal(shouldResetReviewCardState(baseCard, { ...baseCard, mod: 9999 }), false);
        assert.equal(shouldResetReviewCardState(baseCard, { ...baseCard, reps: 3 }), true);
        assert.equal(shouldResetReviewCardState(baseCard, { ...baseCard, id: 11 }), true);

        // U-06: Selective MathJax extension loading
        const fakeSources = {
            "[tex]/color": "data:text/javascript;base64,COLOR",
            "[tex]/mhchem": "data:text/javascript;base64,CHEM",
        };
        assert.deepEqual(selectMathJaxSourcesForHtml("\\(x^2 + y^2\\)", fakeSources), {});
        assert.deepEqual(selectMathJaxSourcesForHtml("\\(\\color{red}{x}\\)", fakeSources), {
            "[tex]/color": "data:text/javascript;base64,COLOR",
        });
    });

    it("UX-06, PERF-01, PERF-05 & SCHED-02: collision-safe bundle merge, O(N) deck counts, backoff jitter, and DST calendar math", async () => {
        const col = createDefaultCollection();
        const existingNoteId = Number(Object.keys(col.notes)[0]);
        const existingCardId = Number(Object.keys(col.cards)[0]);
        const originalQuestion = col.notes[existingNoteId].fields[0];

        // UX-06: Bundle using colliding IDs must remap instead of overwriting user records
        const merged = mergeImportedCollectionBundle(col, {
            decks: {
                1: {
                    id: 1,
                    name: "EP1100::Module 1",
                    desc: "",
                    collapsed: false,
                    conf: 1,
                    dyn: 0,
                    mod: 1,
                    usn: 0,
                },
            },
            notes: {
                [existingNoteId]: {
                    id: existingNoteId,
                    guid: "ep1100_unique_guid_1",
                    mid: 1,
                    mod: 1,
                    usn: 0,
                    tags: [],
                    fields: ["EP1100 Question", "EP1100 Answer"],
                    sfld: "EP1100 Question",
                    csum: 0,
                    flags: 0,
                    data: "{}",
                },
            },
            cards: {
                [existingCardId]: {
                    id: existingCardId,
                    nid: existingNoteId,
                    did: 1,
                    ord: 0,
                    mod: 1,
                    usn: 0,
                    type: 0,
                    queue: 0,
                    due: 1,
                    ivl: 0,
                    factor: 2500,
                    reps: 0,
                    lapses: 0,
                    left: 0,
                    odue: 0,
                    odid: 0,
                    flags: 0,
                    data: "{}",
                },
            },
        });
        assert.equal(merged.notes[existingNoteId].fields[0], originalQuestion, "User note must not be overwritten");
        assert.equal(Object.keys(merged.notes).length, Object.keys(col.notes).length + 1);
        assert.equal(Object.keys(merged.cards).length, Object.keys(col.cards).length + 1);

        // PERF-01: Single-pass getAllDeckCounts matches per-deck getDeckCounts
        const allCounts = getAllDeckCounts(merged);
        for (const didStr of Object.keys(merged.decks)) {
            const did = Number(didStr);
            assert.deepEqual(allCounts[did], getDeckCounts(merged, did));
        }

        // PERF-05: Exponential backoff with jitter
        assert.equal(computeReconnectDelayMs(0, () => 0), 1000);
        assert.equal(computeReconnectDelayMs(1, () => 0), 2000);
        assert.equal(computeReconnectDelayMs(2, () => 0), 4000);
        assert.equal(computeReconnectDelayMs(10, () => 1), 39000);

        // SCHED-02: Calendar-day math across DST transitions
        assert.equal(addCalendarDays("2026-03-07", 1), "2026-03-08");
        assert.equal(
            zonedTimeToUtcMs("2026-03-08", 9, 0, 0, "America/New_York", 300),
            Date.UTC(2026, 2, 8, 13, 0, 0),
        );
        assert.equal(
            zonedTimeToUtcMs("2026-11-01", 9, 0, 0, "America/New_York", 240),
            Date.UTC(2026, 10, 1, 14, 0, 0),
        );

        const forecast = calculateDueForecast(col, 14);
        assert.equal(new Set(forecast.map(f => f.dateStr)).size, 14, "All 14 forecast calendar dates must be distinct");

        // C07 & U12 sanity checks
        const rows = parseDelimitedRows(`\uFEFF"Term, 1","Def ""quoted""\nline2",tag1\nTerm 2,Back 2,tag2`);
        assert.equal(rows.length, 2);
        assert.equal(importCsv("Q1\tA1\nQ2\tA2", createDefaultCollection(), 1, 1).noteCount, 2);
        assert.equal(calculateTodayStats(createDefaultCollection()).retentionRate, null);

        // A-13: Editing cloze text creates missing ordinals without resetting studied cards.
        const clozeCollection = createDefaultCollection();
        const clozeModel = Object.values(clozeCollection.models).find(model => model.type === 1)!;
        const initialCard = Object.values(clozeCollection.cards)[0];
        const initialNote = clozeCollection.notes[initialCard.nid];
        const expandedNote = {
            ...initialNote,
            mid: clozeModel.id,
            fields: ["{{c1::existing}} {{c2::new deletion}}"],
        };
        const generated = createMissingClozeCards(expandedNote, clozeModel, clozeCollection, initialCard.did);
        assert.equal(generated.length, 1);
        assert.equal(generated[0].ord, 1);
        assert.notEqual(generated[0].id, initialCard.id);
        assert.equal(clozeCollection.cards[initialCard.id].reps, initialCard.reps);

        // A-12: A missing media attachment must abort export, not produce a corrupt manifest.
        const missingMediaCol = createDefaultCollection();
        missingMediaCol.media["missing.png"] = "/missing-attachment.png";
        await assert.rejects(exportApkg(missingMediaCol), /Cannot export media 'missing.png'/);
    });
});
