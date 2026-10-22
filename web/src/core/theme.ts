// Theme Management for klanki (System, Light, Dark)

export type ThemeMode = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "klanki_theme_preference";

export function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

export function setStoredTheme(theme: ThemeMode): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  applyTheme(theme);
}

export function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: ThemeMode): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');

  if (theme === "system") {
    root.removeAttribute("data-theme");
    const isDark = getSystemTheme() === "dark";
    if (metaThemeColor) {
      metaThemeColor.setAttribute("content", isDark ? "#0f172a" : "#0284c7");
    }
  } else if (theme === "dark") {
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
  if (typeof window === "undefined") return () => {};

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
