// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Single authoritative source for the sandboxed card bootstrap script,
 * authorized MathJax extension paths, and SHA-256 CSP hashes shared by both
 * the Cloudflare Worker (`server/auth.ts`), the static `_headers` file
 * (`public/_headers`), and `SandboxedCardFrame.tsx` (M-02, U-01, U-06, L-07).
 */
export const SANDBOX_BOOTSTRAP_SCRIPT = `(function() {
  var root = document.getElementById("card-root");
  var cfgEl = document.getElementById("klanki-card-config");
  var cfg = cfgEl ? JSON.parse(cfgEl.textContent || "{}") : {};
  function reportHeight() {
    var h = Math.max(document.body.scrollHeight, root ? root.scrollHeight : 160);
    parent.postMessage({ type: "klanki-card-height", height: h + 16 }, "*");
  }
  window.addEventListener("load", reportHeight);
  if (typeof ResizeObserver !== "undefined" && root) {
    new ResizeObserver(reportHeight).observe(root);
  }
  document.querySelectorAll("img").forEach(function(img) {
    img.addEventListener("load", reportHeight);
  });
  document.querySelectorAll("input.type-input").forEach(function(inp) {
    if (typeof cfg.typedValue === "string" && inp.value !== cfg.typedValue) {
      inp.value = cfg.typedValue;
    }
    inp.addEventListener("input", function(ev) {
      parent.postMessage({ type: "klanki-type-answer", value: ev.target.value || "" }, "*");
    });
    inp.addEventListener("keydown", function(ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        parent.postMessage({ type: "klanki-type-submit", value: ev.target.value || "" }, "*");
      }
      ev.stopPropagation();
    });
  });
  document.addEventListener("click", function(e) {
    var link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      var href = link.getAttribute("href") || "";
      if (href && href !== "#") {
        parent.postMessage({ type: "klanki-card-link", href: href }, "*");
      }
      return;
    }
    var hint = e.target && e.target.closest ? e.target.closest(".cloze-hint") : null;
    if (hint && hint.dataset && hint.dataset.hint) {
      hint.textContent = "[" + hint.dataset.hint + "]";
      hint.classList.remove("cloze-hint");
      reportHeight();
      return;
    }
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "AUDIO" || e.target.tagName === "SUMMARY" || e.target.tagName === "DETAILS")) {
      return;
    }
    parent.postMessage({ type: "klanki-card-click" }, "*");
  });
  reportHeight();
  if (cfg.hasMath && cfg.mathScript) {
    var mathSources = cfg.mathSources || {};
    function runEmbeddedScript(url) {
      if (!url.startsWith("data:text/javascript;base64,")) throw new Error("Unknown math asset");
      var binary = atob(url.slice(url.indexOf(",") + 1));
      var bytes = Uint8Array.from(binary, function(c) { return c.charCodeAt(0); });
      var el = document.createElement("script");
      el.textContent = new TextDecoder().decode(bytes);
      document.head.appendChild(el);
    }
    window.MathJax = {
      loader: {
        paths: { mathjax: (cfg.originUrl || "") + "/vendor/mathjax/es5" },
        source: mathSources,
        require: runEmbeddedScript,
        pathFilters: [[function(data) {
          if (mathSources[data.name]) { data.name = mathSources[data.name]; return false; }
          return true;
        }, -10]]
      },
      svg: { fontCache: "local" },
      tex: { inlineMath: [["\\\\(", "\\\\)"]], displayMath: [["\\\\[", "\\\\]"], ["$$", "$$"]] },
      startup: {
        pageReady: function() {
          return MathJax.startup.defaultPageReady().then(reportHeight);
        }
      }
    };
    runEmbeddedScript(cfg.mathScript);
  }
})();`;

export const SANDBOX_BOOTSTRAP_SHA256 = "'sha256-3YBnffRI/t8nR0UzWuRnY9Bm1MacF0XIiqHJcF+LkWY='";

/**
 * Authorized MathJax scripts whose exact SHA-256 hashes are included in both
 * the Worker CSP and static `_headers` CSP (M-02).
 */
export const AUTHORIZED_MATHJAX_SCRIPTS: ReadonlyArray<{ path: string; key: string; sha256: string }> = [
    {
        path: "/vendor/mathjax/es5/tex-svg.js",
        key: "tex-svg",
        sha256: "'sha256-1CldwzdEg2k1wTmf7s5RWVd7NMXI/7nxxjJM2C4DqII='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/color.js",
        key: "[tex]/color",
        sha256: "'sha256-f9yPfNoWMPNczVeTeboErdnexQxmzrvAWksSkCezJDU='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/mhchem.js",
        key: "[tex]/mhchem",
        sha256: "'sha256-rsLh4cQjEpzz0v6GmAZCM1En0RYXNP/kfdme1nYDhic='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/physics.js",
        key: "[tex]/physics",
        sha256: "'sha256-1Qj4I8LPOVCb3QiPbdF/3iC0gaix1wKqJAYaAPOABsM='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/mathtools.js",
        key: "[tex]/mathtools",
        sha256: "'sha256-BCctaaC2R4PNW2aCDW+CIO5RBAnQsSw4YmQEvp7ZaJw='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/ams.js",
        key: "[tex]/ams",
        sha256: "'sha256-Yk1ZuLhYXT1pqBBrh7rGL4oklbbK6nkGoljOHxX/HqQ='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/amscd.js",
        key: "[tex]/amscd",
        sha256: "'sha256-fcclbrxYIjec359QRVkwnZfF8m4J4hUNJd1G41pqz5Q='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/braket.js",
        key: "[tex]/braket",
        sha256: "'sha256-KrsDLKDq/5+yMiootdFLoFjnk00+VpdMVfV0BZ6Qekw='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/cancel.js",
        key: "[tex]/cancel",
        sha256: "'sha256-DSY+zyZx0cwTE1uLSvzcpNQBUamupRtpQC5ord5M+Mk='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/cases.js",
        key: "[tex]/cases",
        sha256: "'sha256-nBHgZE2r21rfkGWt739iJDQOrsuW5Ip86aJ948cFbzw='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/enclose.js",
        key: "[tex]/enclose",
        sha256: "'sha256-2NXs11q8Qwam1YlELfpmpDRd7hKINHWRvdrxlVE4gWM='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/extpfeil.js",
        key: "[tex]/extpfeil",
        sha256: "'sha256-n1WvJWYEuJp5gLn5A8bzPOPC0OJ5/TR7mkM/5MWN55Q='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/gensymb.js",
        key: "[tex]/gensymb",
        sha256: "'sha256-42R8hI8mrSKNBwQ/HmPFamRtqdIKbA8YCkBn+p4Q+sw='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/newcommand.js",
        key: "[tex]/newcommand",
        sha256: "'sha256-pBZppK6SSrg8vD0I+VrpBJCjPNZJ7YZeg2dQEbhwirk='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/noerrors.js",
        key: "[tex]/noerrors",
        sha256: "'sha256-kxejOwDhFOZ5uzzwffBhAjQhMUEqPaztJbcz2jNPLM0='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/noundefined.js",
        key: "[tex]/noundefined",
        sha256: "'sha256-uQ7Pg4pvU2OyYKTdTpOYEquvBi+RI0/iD9Y9HH6IpD8='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/require.js",
        key: "[tex]/require",
        sha256: "'sha256-olm4bJ9J/qCKu8Bb9OXtUQ5lhwudfRJ0BOhIZJO4rUA='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/unicode.js",
        key: "[tex]/unicode",
        sha256: "'sha256-kD59DRHV1jnrE5Mf09p41Ju/nFm1foKpRdqft7cQE30='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/upgreek.js",
        key: "[tex]/upgreek",
        sha256: "'sha256-QzXXImcbdxhtZJDjJq2tX3J+0tuVTer+zi0QgDy2UaE='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/verb.js",
        key: "[tex]/verb",
        sha256: "'sha256-/a+s48E9TyqeMBO/mG/KBNYxdcae7JmxdwXwBqZSjcc='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/bbox.js",
        key: "[tex]/bbox",
        sha256: "'sha256-c9IIo0Je0n3qftYfWYS0Osz7qJSbrXB30+rEfmaLp2Q='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/boldsymbol.js",
        key: "[tex]/boldsymbol",
        sha256: "'sha256-1ncf7gdy2yZXeWyNDiDhh4uzI39tPtHoKOGDSk/3Q8o='",
    },
    {
        path: "/vendor/mathjax/es5/input/tex/extensions/all-packages.js",
        key: "[tex]/all-packages",
        sha256: "'sha256-tEZh/BNKW1OtPvW/TVh+m0Eul0Ic8z4NqyCV6g6KNJE='",
    },
];

export const ALL_AUTHORIZED_SCRIPT_CSP_HASHES = [
    SANDBOX_BOOTSTRAP_SHA256,
    ...AUTHORIZED_MATHJAX_SCRIPTS.map(s => s.sha256),
];

export function buildProductionCspHeader(): string {
    return [
        "default-src 'self'",
        `script-src 'self' ${
            ALL_AUTHORIZED_SCRIPT_CSP_HASHES.join(" ")
        } 'wasm-unsafe-eval' https://clerk.klanki.ezryder.us https://*.clerk.accounts.dev https://challenges.cloudflare.com`,
        "connect-src 'self' wss://klanki.ezryder.us https://clerk.klanki.ezryder.us https://*.clerk.accounts.dev",
        "img-src 'self' data: blob: https://img.clerk.com https://*.clerk.com",
        "media-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "frame-src 'self' blob: https://challenges.cloudflare.com https://clerk.klanki.ezryder.us https://*.clerk.accounts.dev",
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
    ].join("; ");
}
