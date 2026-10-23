// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

function loadPublishableKeyFromConfig(): string {
    if (process.env.VITE_CLERK_PUBLISHABLE_KEY?.trim()) {
        return process.env.VITE_CLERK_PUBLISHABLE_KEY.trim();
    }
    try {
        const raw = readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8");
        const parsed = JSON.parse(raw);
        const key = parsed?.vars?.CLERK_PUBLISHABLE_KEY;
        if (typeof key === "string" && key.trim()) {
            return key.trim();
        }
    } catch {
        // Fall through to explicit build failure
    }
    throw new Error(
        "Missing Clerk publishable key: set VITE_CLERK_PUBLISHABLE_KEY or configure vars.CLERK_PUBLISHABLE_KEY in wrangler.jsonc (L-01).",
    );
}

const resolvedPublishableKey = loadPublishableKeyFromConfig();

export default defineConfig({
    plugins: [react()],
    define: {
        "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(resolvedPublishableKey),
    },
    server: {
        port: 5173,
        host: true,
    },
    build: {
        outDir: "dist",
        target: "es2022",
    },
});
