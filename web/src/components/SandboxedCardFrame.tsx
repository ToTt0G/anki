// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import React, { useEffect, useMemo, useRef, useState } from "react";
import { SANDBOX_BOOTSTRAP_SCRIPT, SANDBOX_BOOTSTRAP_SHA256 } from "../core/csp-constants";
import { loadMathJaxAssets, MathJaxAssets, selectMathJaxSourcesForHtml } from "../core/mathjax";
import { sanitizeCardCss, sanitizeCardHtml } from "../core/sanitize";

export { SANDBOX_BOOTSTRAP_SCRIPT, SANDBOX_BOOTSTRAP_SHA256 };

interface Props {
    html: string;
    css?: string;
    typedValue?: string;
    onCardClick?: () => void;
    onTypedAnswerChange?: (value: string) => void;
    onTypedAnswerSubmit?: (value: string) => void;
}

/**
 * Renders untrusted flashcard HTML and model CSS inside an isolated, opaque-origin
 * sandboxed iframe (`sandbox="allow-scripts"` WITHOUT `allow-same-origin`).
 *
 * Security & functional properties (S01, V01, SEC-05, SEC-07, M-02, U-01, U-06, L-07):
 * - Runs in a unique `null` origin with zero access to parent DOM, Clerk session,
 *   cookies, localStorage, or IndexedDB.
 * - Sanitizes HTML and CSS before injection for defense in depth.
 * - Uses SHA-256 script hashes from `csp-constants` instead of `'unsafe-inline'`.
 * - Embeds only the MathJax extensions actually referenced by the card (U-06).
 * - Captures typed-answer inputs (`{{type:...}}`) and controlled external link clicks (U-01, L-07).
 */
export const SandboxedCardFrame: React.FC<Props> = ({
    html,
    css = "",
    typedValue,
    onCardClick,
    onTypedAnswerChange,
    onTypedAnswerSubmit,
}) => {
    const [mathAssets, setMathAssets] = useState<MathJaxAssets | null>(null);
    const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
    const hasMath = /\\\(|\\\[|\$\$/.test(html);
    useEffect(() => {
        if (!hasMath) { return; }
        let active = true;
        loadMathJaxAssets().then(assets => {
            if (active) { setMathAssets(assets); }
        }).catch(error => console.warn("Could not load offline math renderer:", error));
        return () => {
            active = false;
        };
    }, [hasMath]);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [frameHeight, setFrameHeight] = useState<number>(220);
    const [isDark, setIsDark] = useState<boolean>(() =>
        typeof document !== "undefined"
        && document.documentElement.getAttribute("data-theme") === "dark"
    );

    useEffect(() => {
        if (typeof document === "undefined") { return; }
        const observer = new MutationObserver(() => {
            setIsDark(document.documentElement.getAttribute("data-theme") === "dark");
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-theme"],
        });
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
                return;
            }
            const data = event.data;
            if (!data || typeof data !== "object") { return; }

            if (data.type === "klanki-card-height" && typeof data.height === "number") {
                const clamped = Math.max(160, Math.min(2400, Math.ceil(data.height)));
                setFrameHeight(clamped);
            } else if (data.type === "klanki-card-click") {
                onCardClick?.();
            } else if (data.type === "klanki-type-answer" && typeof data.value === "string") {
                onTypedAnswerChange?.(data.value);
            } else if (data.type === "klanki-type-submit" && typeof data.value === "string") {
                onTypedAnswerChange?.(data.value);
                onTypedAnswerSubmit?.(data.value);
            } else if (data.type === "klanki-card-link" && typeof data.href === "string") {
                // L-07: Narrowly scoped, user-initiated external link opener
                try {
                    const origin = typeof window !== "undefined" ? window.location.origin : "https://klanki.ezryder.us";
                    const parsed = new URL(data.href, origin);
                    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
                        setPendingExternalUrl(parsed.toString());
                    }
                } catch {
                    // ignore malformed URLs
                }
            }
        };

        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [onCardClick, onTypedAnswerChange, onTypedAnswerSubmit]);

    const srcDoc = useMemo(() => {
        const safeHtml = sanitizeCardHtml(html);
        const safeCss = sanitizeCardCss(css);
        const activeMathAssets = hasMath ? mathAssets : null;
        const originUrl = typeof window !== "undefined" ? window.location.origin : "";

        const textColor = isDark ? "#f8fafc" : "#0f172a";
        const bgColor = isDark ? "#0f172a" : "#ffffff";
        const borderColor = isDark ? "#334155" : "#e2e8f0";

        const resolvedHtml = safeHtml.replace(
            /(\b(?:src|href)=["'])(\/[^"']*["'])/gi,
            `$1${originUrl}$2`,
        );

        const scriptHashes = [
            SANDBOX_BOOTSTRAP_SHA256,
            ...(activeMathAssets?.hashes || []),
        ].join(" ");

        // U-06: Only embed the MathJax extensions actually referenced by this card's HTML
        const neededMathSources = activeMathAssets
            ? selectMathJaxSourcesForHtml(html, activeMathAssets.sources)
            : {};

        const configJson = JSON.stringify({
            originUrl,
            hasMath: Boolean(activeMathAssets),
            mathScript: activeMathAssets?.script || "",
            mathSources: neededMathSources,
            typedValue: typedValue ?? "",
        }).replace(/<\//g, "<\\/");

        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${originUrl} data: blob:; media-src ${originUrl} data: blob:; style-src 'unsafe-inline'; font-src ${originUrl} data:; script-src ${scriptHashes};" />
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
    .type-answer-box {
      margin: 12px auto;
      max-width: 360px;
    }
    .type-input {
      width: 100%;
      padding: 8px 12px;
      font-size: 16px;
      border-radius: 6px;
      border: 1px solid ${borderColor};
      background: ${bgColor};
      color: ${textColor};
      text-align: center;
    }
    .type-answer-result {
      margin: 12px auto;
      font-family: monospace;
      font-size: 18px;
    }
    .type-good {
      color: #16a34a;
      font-weight: 600;
    }
    .type-bad {
      color: #dc2626;
      text-decoration: line-through;
      font-weight: 600;
    }
    .type-missed {
      color: #d97706;
      font-weight: 600;
    }
    a[href] {
      color: #0284c7;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div id="card-root" class="card">${resolvedHtml}</div>
  <script id="klanki-card-config" type="application/json">${configJson}</script>
  <script>${SANDBOX_BOOTSTRAP_SCRIPT}</script>
</body>
</html>`;
    }, [html, css, hasMath, mathAssets, isDark]);

    return (
        <>
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
                    display: "block",
                }}
            />
            {pendingExternalUrl && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Open external link"
                    onClick={e => e.stopPropagation()}
                    style={{
                        marginTop: 8,
                        padding: "10px 14px",
                        borderRadius: 8,
                        background: "var(--bg-secondary)",
                        border: "1px solid var(--border-color)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        flexWrap: "wrap",
                        fontSize: 13,
                    }}
                >
                    <span style={{ wordBreak: "break-all", color: "var(--text-secondary)" }}>
                        Open external link:{" "}
                        <strong style={{ color: "var(--text-primary)" }}>{pendingExternalUrl}</strong>?
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" onClick={() => setPendingExternalUrl(null)}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="primary"
                            onClick={() => {
                                const urlToOpen = pendingExternalUrl;
                                setPendingExternalUrl(null);
                                window.open(urlToOpen, "_blank", "noopener,noreferrer");
                            }}
                        >
                            Open Link
                        </button>
                    </div>
                </div>
            )}
        </>
    );
};
