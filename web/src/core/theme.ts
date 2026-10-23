// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Theme Management for klanki (Light by default; user can switch to Dark or System)

export type ThemeMode = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "klanki_theme_preference";

export function getStoredTheme(): ThemeMode {
    if (typeof window === "undefined") { return "light"; }
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
        return stored;
    }
    return "light";
}

export function setStoredTheme(theme: ThemeMode): void {
    if (typeof window === "undefined") { return; }
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
}

export function getSystemTheme(): "light" | "dark" {
    if (typeof window === "undefined") { return "light"; }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: ThemeMode): void {
    if (typeof document === "undefined") { return; }

    const root = document.documentElement;
    const metaThemeColor = document.querySelector("meta[name=\"theme-color\"]");

    const effective = theme === "system" ? getSystemTheme() : theme;

    if (effective === "dark") {
        root.setAttribute("data-theme", "dark");
        if (metaThemeColor) {
            metaThemeColor.setAttribute("content", "#0f172a");
        }
    } else {
        root.setAttribute("data-theme", "light");
        if (metaThemeColor) {
            metaThemeColor.setAttribute("content", "#0284c7");
        }
    }
}

export function initTheme(): () => void {
    if (typeof window === "undefined") { return () => {}; }

    const current = getStoredTheme();
    applyTheme(current);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => {
        if (getStoredTheme() === "system") {
            applyTheme("system");
        }
    };

    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
}
