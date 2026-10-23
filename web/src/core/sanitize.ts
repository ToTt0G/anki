// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// HTML & CSS Sanitizer for Untrusted Flashcard Content (S01, C12)

const FORBIDDEN_TAGS_REGEX =
    /<\s*\/?\s*(?:script|iframe|frame|frameset|object|embed|applet|base|meta|link|style|form|input|button|select|textarea|noscript|template)\b[^>]*>/gi;

const SCRIPT_BLOCK_REGEX = /<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi;
const STYLE_BLOCK_REGEX = /<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi;
const IFRAME_BLOCK_REGEX = /<\s*iframe\b[^>]*>[\s\S]*?<\s*\/\s*iframe\s*>/gi;
const OBJECT_BLOCK_REGEX = /<\s*object\b[^>]*>[\s\S]*?<\s*\/\s*object\s*>/gi;

// Event handler attributes like onclick=, onerror=, onload=, onmouseover=, etc.
const EVENT_HANDLER_ATTR_REGEX = /\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

// Dangerous URL schemes in href, src, xlink:href, action, formaction, data, poster
const DANGEROUS_URI_ATTR_REGEX =
    /(\s+(?:src|href|xlink:href|action|formaction|data|poster|srcdoc)\s*=\s*["']?\s*)(?:javascript|vbscript|data\s*:\s*(?!image\/(?:png|jpeg|jpg|gif|webp|bmp|avif);base64,))[^"'\s>]*/gi;

/**
 * Sanitize untrusted flashcard HTML from imported decks or user fields.
 * Removes executable scripts, dangerous containers, inline event handlers, and unsafe URI schemes.
 */
export function sanitizeCardHtml(rawHtml: string): string {
    if (!rawHtml) { return ""; }

    let cleaned = String(rawHtml);

    // 1. Remove full script/style/iframe/object blocks
    cleaned = cleaned
        .replace(SCRIPT_BLOCK_REGEX, "")
        .replace(STYLE_BLOCK_REGEX, "")
        .replace(IFRAME_BLOCK_REGEX, "")
        .replace(OBJECT_BLOCK_REGEX, "");

    // 2. Remove any remaining forbidden open/close tags
    cleaned = cleaned.replace(FORBIDDEN_TAGS_REGEX, "");

    // 3. Strip inline on* event handlers (loop to catch nested tricks)
    let prev = "";
    while (prev !== cleaned) {
        prev = cleaned;
        cleaned = cleaned.replace(EVENT_HANDLER_ATTR_REGEX, "");
    }

    // 4. Neutralize javascript:, vbscript:, and non-image data: URIs
    cleaned = cleaned.replace(DANGEROUS_URI_ATTR_REGEX, "$1\"#\"");

    return cleaned;
}

/**
 * Sanitize card model CSS so it cannot import external stylesheets, execute expressions,
 * or break out of a <style> tag.
 */
export function sanitizeCardCss(rawCss: string): string {
    if (!rawCss) { return ""; }
    return String(rawCss)
        .replace(/<\s*\/?\s*style[^>]*>/gi, "")
        .replace(/@import\b[^;]*;?/gi, "")
        .replace(/expression\s*\([^)]*\)/gi, "")
        .replace(/url\s*\(\s*["']?\s*(?:javascript|vbscript|data\s*:\s*text\/html|https?:)[^)]*\)/gi, "none");
}
