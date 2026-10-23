import React, { useEffect, useRef, useState } from "react";
import { sanitizeCardCss, sanitizeCardHtml } from "../core/sanitize";

interface Props {
  html: string;
  css?: string;
  onCardClick?: () => void;
}

/**
 * Renders untrusted flashcard HTML and model CSS inside an isolated, opaque-origin
 * sandboxed iframe (`sandbox="allow-scripts"` WITHOUT `allow-same-origin`).
 *
 * Security properties (S01, V01):
 * - Runs in a unique `null` origin with zero access to parent DOM, Clerk session,
 *   cookies, localStorage, or IndexedDB.
 * - Sanitizes HTML and CSS before injection for defense in depth.
 * - Supports Cloze hint toggles, model CSS (C12), and MathJax/LaTeX rendering (U09).
 */
export const SandboxedCardFrame: React.FC<Props> = ({ html, css = "", onCardClick }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState<number>(220);
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark"
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.getAttribute("data-theme") === "dark");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"]
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Strictly validate message source is our exact sandboxed iframe window
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "klanki-card-height" && typeof data.height === "number") {
        const clamped = Math.max(160, Math.min(2400, Math.ceil(data.height)));
        setFrameHeight(clamped);
      } else if (data.type === "klanki-card-click") {
        onCardClick?.();
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onCardClick]);

  const safeHtml = sanitizeCardHtml(html);
  const safeCss = sanitizeCardCss(css);
  const originUrl = typeof window !== "undefined" ? window.location.origin : "";

  const textColor = isDark ? "#f8fafc" : "#0f172a";
  const bgColor = isDark ? "#0f172a" : "#ffffff";
  const borderColor = isDark ? "#334155" : "#e2e8f0";

  // Rewrite root-relative image/audio URLs (/ep1100/media/...) to absolute origin URLs so they load inside the null-origin srcDoc
  const resolvedHtml = safeHtml.replace(
    /(\b(?:src|href)=["'])(\/[^"']*["'])/gi,
    `$1${originUrl}$2`
  );

  const srcDoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${originUrl} data: blob:; media-src ${originUrl} data: blob:; style-src 'unsafe-inline'; font-src https://cdn.jsdelivr.net data:; script-src 'unsafe-inline' https://cdn.jsdelivr.net;" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: ${bgColor};
      color: ${textColor};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 20px;
      line-height: 1.55;
      overflow-wrap: break-word;
      word-break: break-word;
      text-align: center;
    }
    /* User model CSS (C12), overridden for theme background/text safety */
    ${safeCss}
    .card {
      background-color: transparent !important;
      color: ${textColor} !important;
      padding: 8px 4px;
    }
    hr, #answer, .card-divider {
      width: 100%;
      margin: 20px 0;
      border: 0;
      border-top: 1px dashed ${borderColor};
    }
    img, .anki-image {
      max-width: 100% !important;
      max-height: 50vh;
      height: auto !important;
      border-radius: 8px;
      margin: 10px auto;
      display: block;
      object-fit: contain;
    }
    .cloze {
      font-weight: 600;
      color: #0284c7;
      background: rgba(2, 132, 199, 0.12);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .cloze-hint {
      cursor: pointer;
      opacity: 0.85;
      border-bottom: 1px dotted currentColor;
    }
  </style>
</head>
<body>
  <div id="card-root" class="card">${resolvedHtml}</div>
  <script>
    (function() {
      var root = document.getElementById("card-root");
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
      document.addEventListener("click", function(e) {
        var hint = e.target && e.target.closest ? e.target.closest(".cloze-hint") : null;
        if (hint && hint.dataset && hint.dataset.hint) {
          hint.textContent = "[" + hint.dataset.hint + "]";
          hint.classList.remove("cloze-hint");
          reportHeight();
          return;
        }
        if (e.target && (e.target.tagName === "AUDIO" || e.target.tagName === "SUMMARY" || e.target.tagName === "DETAILS")) {
          return;
        }
        parent.postMessage({ type: "klanki-card-click" }, "*");
      });
      reportHeight();

      // Load MathJax inside sandbox ONLY when LaTeX delimiters exist (U09)
      var text = root ? root.innerHTML : "";
      if (/\\\\\\(|\\\\\\[|\\$\\$/.test(text)) {
        window.MathJax = {
          tex: { inlineMath: [["\\\\(", "\\\\)"]], displayMath: [["\\\\[", "\\\\]"], ["$$", "$$"]] },
          startup: {
            pageReady: function() {
              return MathJax.startup.defaultPageReady().then(reportHeight);
            }
          }
        };
        var s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-chtml.js";
        s.async = true;
        document.head.appendChild(s);
      }
    })();
  </script>
</body>
</html>`;

  return (
    <iframe
      ref={iframeRef}
      title="Flashcard content"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{
        width: "100%",
        height: `${frameHeight}px`,
        border: "none",
        background: "transparent",
        display: "block"
      }}
    />
  );
};
