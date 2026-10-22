import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { App } from "./App";
import { initTheme } from "./core/theme";
import "./styles/index.css";

// Initialize theme immediately to prevent layout / color flash
initTheme();

const PUBLISHABLE_KEY =
  (import.meta as any).env?.VITE_CLERK_PUBLISHABLE_KEY ||
  "pk_test_bGVnYWwtcHVtYS04NjY0LmNsZXJrLmFjY291bnRzLmRldiQ";

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
        <App />
      </ClerkProvider>
    </React.StrictMode>
  );
}
