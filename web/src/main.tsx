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

const PUBLISHABLE_KEY = (import.meta as any).env?.VITE_CLERK_PUBLISHABLE_KEY
    || "pk_live_Y2xlcmsua2xhbmtpLmV6cnlkZXIudXMk";

const rootElement = document.getElementById("root");
if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
                <App />
            </ClerkProvider>
        </React.StrictMode>,
    );
}
