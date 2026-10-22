import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./core/theme";
import "./styles/index.css";

// Initialize theme immediately to prevent layout / color flash
initTheme();

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
