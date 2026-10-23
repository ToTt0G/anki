// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { ClerkProvider } from "@clerk/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./core/theme";
import "./styles/index.css";

// Initialize theme immediately to prevent layout / color flash
initTheme();

/**
 * Resolve Clerk publishable key from explicit build/runtime configuration without
 * silently falling back to a hardcoded production key (L-01).
 */
export function resolveClerkPublishableKey(envRecord?: Record<string, unknown>): string {
    const raw = envRecord?.VITE_CLERK_PUBLISHABLE_KEY;
    if (typeof raw !== "string" || !raw.trim()) {
        throw new Error(
            "Missing VITE_CLERK_PUBLISHABLE_KEY environment configuration. Set VITE_CLERK_PUBLISHABLE_KEY before starting the app.",
        );
    }
    return raw.trim();
}

const rootElement = typeof document !== "undefined" ? document.getElementById("root") : null;
if (rootElement) {
    const publishableKey = resolveClerkPublishableKey((import.meta as any).env);
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <ClerkProvider publishableKey={publishableKey}>
                <App />
            </ClerkProvider>
        </React.StrictMode>,
    );
}
