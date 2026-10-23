// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Instant theme initialization to prevent flash (defaults to light) (SEC-07)
(function() {
    try {
        var theme = localStorage.getItem("klanki_theme_preference") || "light";
        var isDark = theme === "dark"
            || (theme === "system"
                && window.matchMedia
                && window.matchMedia("(prefers-color-scheme: dark)").matches);
        document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    } catch (_e) {
        document.documentElement.setAttribute("data-theme", "light");
    }
})();
