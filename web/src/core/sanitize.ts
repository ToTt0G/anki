// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Allowlist HTML & CSS Sanitizer and Inert Text Extraction for Untrusted Content (SEC-05, S01, C12)

const DROP_WITH_CONTENT_TAGS = new Set([
    "script",
    "style",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "svg",
    "math",
    "template",
    "noscript",
    "form",
    "textarea",
    "select",
    "button",
    "head",
    "title",
]);

const ALLOWED_TAGS = new Set([
    "div",
    "span",
    "p",
    "br",
    "hr",
    "b",
    "i",
    "u",
    "s",
    "strong",
    "em",
    "sub",
    "sup",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "pre",
    "code",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "img",
    "audio",
    "source",
    "details",
    "summary",
    "ruby",
    "rt",
    "rp",
    "mark",
    "small",
    "del",
    "ins",
    "dl",
    "dt",
    "dd",
    "kbd",
    "samp",
    "var",
    "dfn",
    "abbr",
    "cite",
    "q",
    "a",
    "input",
]);

const VOID_TAGS = new Set(["br", "hr", "img", "source", "input"]);

const GLOBAL_ALLOWED_ATTRS = new Set([
    "class",
    "id",
    "title",
    "dir",
    "lang",
    "data-hint",
    "data-cloze",
]);

const TAG_ALLOWED_ATTRS: Record<string, Set<string>> = {
    a: new Set(["href", "target", "rel"]),
    img: new Set(["src", "alt", "width", "height", "loading"]),
    audio: new Set(["src", "controls", "preload"]),
    source: new Set(["src", "type"]),
    details: new Set(["open"]),
    td: new Set(["colspan", "rowspan"]),
    th: new Set(["colspan", "rowspan", "scope"]),
    input: new Set(["type", "placeholder", "value", "readonly", "disabled"]),
};

const NAMED_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
    colon: ":",
    tab: "\t",
    newline: "\n",
};

/**
 * Decode numeric (decimal & hex) and common named HTML entities so encoded
 * scheme attacks like `java&#x09;script:alert(1)` are caught reliably (SEC-05).
 */
export function decodeHtmlEntities(input: string): string {
    if (!input || !input.includes("&")) { return input; }
    return input.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z0-9]+));?/g, (full, dec, hex, named) => {
        if (dec !== undefined) {
            const code = parseInt(dec, 10);
            if (code > 0 && code <= 0x10ffff) {
                try {
                    return String.fromCodePoint(code);
                } catch {
                    return "";
                }
            }
            return "";
        }
        if (hex !== undefined) {
            const code = parseInt(hex, 16);
            if (code > 0 && code <= 0x10ffff) {
                try {
                    return String.fromCodePoint(code);
                } catch {
                    return "";
                }
            }
            return "";
        }
        if (named !== undefined) {
            const lower = named.toLowerCase();
            if (lower in NAMED_ENTITIES) {
                return NAMED_ENTITIES[lower];
            }
        }
        return full;
    });
}

function escapeAttrValue(val: string): string {
    return val
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Validate a URI attribute (`src` or `href`) after decoding HTML entities and removing
 * ASCII control characters and whitespace (SEC-05).
 */
export function isSafeUriValue(rawUri: string, attrName: "src" | "href"): boolean {
    const decoded = decodeHtmlEntities(rawUri)
        .replace(/[\x00-\x20\x7f]+/g, "")
        .trim();
    if (!decoded) { return true; }

    // Disallow protocol-relative URLs (//evil.example)
    if (decoded.startsWith("//") || decoded.startsWith("\\\\")) {
        return false;
    }

    const lower = decoded.toLowerCase();
    // Check if URI has an explicit scheme (`scheme:...`)
    const schemeMatch = lower.match(/^([a-z][a-z0-9+.-]*):/);
    if (!schemeMatch) {
        // Relative path or fragment (#... or /media/... or filename.png)
        return true;
    }

    const scheme = schemeMatch[1];
    if (scheme === "http" || scheme === "https" || scheme === "blob") {
        return true;
    }
    if (scheme === "mailto" && attrName === "href") {
        return true;
    }
    if (scheme === "data" && attrName === "src") {
        return /^data:(?:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif)|audio\/(?:mpeg|mp3|wav|x-wav|ogg|mp4|webm));base64,[a-z0-9+/=\s]+$/i
            .test(decoded);
    }

    return false;
}

function parseAndSanitizeAttributes(tagName: string, rawAttrs: string): string {
    if (!rawAttrs || !rawAttrs.trim()) {
        return tagName === "input" ? " type=\"text\" class=\"type-input\"" : "";
    }

    // For <input>, only allow the controlled type-answer text box
    if (tagName === "input") {
        return " type=\"text\" class=\"type-input\" placeholder=\"\"";
    }

    const tagAllowed = TAG_ALLOWED_ATTRS[tagName];
    const keptAttrs: string[] = [];
    const seen = new Set<string>();

    // Match attribute name and optional quoted or unquoted value
    const attrRegex = /([^\s=<>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(rawAttrs)) !== null) {
        const attrName = match[1].toLowerCase().replace(/[^a-z0-9_-]/g, "");
        if (!attrName || seen.has(attrName)) { continue; }

        // Never allow any on* event handler or unsafe attribute
        if (attrName.startsWith("on") || attrName === "style" || attrName === "srcdoc" || attrName === "formaction") {
            continue;
        }
        if (!GLOBAL_ALLOWED_ATTRS.has(attrName) && !tagAllowed?.has(attrName)) {
            continue;
        }

        const rawVal = match[2] ?? match[3] ?? match[4] ?? "";
        // Imported cards must not collide with internal sandbox bootstrap nodes.
        if (attrName === "id" && (/^klanki-/i.test(rawVal.trim()) || rawVal.trim() === "card-root")) {
            continue;
        }
        if (attrName === "src" || attrName === "href") {
            if (!isSafeUriValue(rawVal, attrName)) {
                keptAttrs.push(`${attrName}="#"`);
                seen.add(attrName);
                continue;
            }
        }

        seen.add(attrName);
        if (match[2] === undefined && match[3] === undefined && match[4] === undefined) {
            keptAttrs.push(`${attrName}=""`);
        } else {
            keptAttrs.push(`${attrName}="${escapeAttrValue(rawVal)}"`);
        }
    }

    if (tagName === "a" && seen.has("href")) {
        if (!seen.has("rel")) {
            keptAttrs.push("rel=\"noopener noreferrer\"");
        }
    }

    return keptAttrs.length > 0 ? " " + keptAttrs.join(" ") : "";
}

function sanitizeHtmlWithAllowlistParser(input: string): string {
    // 1. Remove HTML comments and processing instructions / declarations
    let cleaned = input
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<![a-zA-Z][^>]*>/g, "")
        .replace(/<\?[\s\S]*?\?>/g, "");

    // 2. Remove complete container blocks whose inner text must also be dropped
    for (const dropTag of DROP_WITH_CONTENT_TAGS) {
        const blockRe = new RegExp(`<\\s*${dropTag}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${dropTag}\\s*>`, "gi");
        let prev = "";
        while (prev !== cleaned) {
            prev = cleaned;
            cleaned = cleaned.replace(blockRe, "");
        }
        // Also strip unclosed opening tags of dangerous containers (e.g. `<script>evil()`)
        const unclosedRe = new RegExp(`<\\s*${dropTag}\\b[^>]*>[^<]*`, "gi");
        cleaned = cleaned.replace(unclosedRe, "");
    }

    // 3. Tokenize all remaining `<...>` tags and rebuild only allowlisted tags & attributes
    return cleaned.replace(/<\s*(\/?)\s*([a-zA-Z0-9:-]+)([^>]*)>/g, (_full, slash, rawName, rest) => {
        const tagName = String(rawName).toLowerCase();
        if (!ALLOWED_TAGS.has(tagName) || DROP_WITH_CONTENT_TAGS.has(tagName)) {
            return "";
        }
        const isClosing = Boolean(slash);
        if (isClosing) {
            if (VOID_TAGS.has(tagName)) { return ""; }
            return `</${tagName}>`;
        }
        const attrs = parseAndSanitizeAttributes(tagName, String(rest || "").replace(/\/\s*$/, ""));
        if (VOID_TAGS.has(tagName)) {
            return `<${tagName}${attrs}>`;
        }
        return `<${tagName}${attrs}>`;
    });
}

function sanitizeViaInertDomParser(html: string): string {
    if (typeof DOMParser === "undefined") { return html; }
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        if (!doc || !doc.body) { return html; }

        const cleanNode = (node: Node): void => {
            const children = Array.from(node.childNodes);
            for (const child of children) {
                if (child.nodeType === 8 /* COMMENT_NODE */) {
                    node.removeChild(child);
                    continue;
                }
                if (child.nodeType === 1 /* ELEMENT_NODE */) {
                    const el = child as Element;
                    const tag = el.tagName.toLowerCase();
                    if (!ALLOWED_TAGS.has(tag) || DROP_WITH_CONTENT_TAGS.has(tag)) {
                        node.removeChild(el);
                        continue;
                    }
                    const tagAllowed = TAG_ALLOWED_ATTRS[tag];
                    for (const attr of Array.from(el.attributes)) {
                        const name = attr.name.toLowerCase();
                        if (
                            (name === "id"
                                && (/^klanki-/i.test(attr.value.trim()) || attr.value.trim() === "card-root"))
                            || name.startsWith("on")
                            || (!GLOBAL_ALLOWED_ATTRS.has(name) && !tagAllowed?.has(name))
                        ) {
                            el.removeAttribute(attr.name);
                            continue;
                        }
                        if ((name === "src" || name === "href") && !isSafeUriValue(attr.value, name)) {
                            el.setAttribute(name, "#");
                        }
                    }
                    if (tag === "input") {
                        for (const attr of Array.from(el.attributes)) {
                            el.removeAttribute(attr.name);
                        }
                        el.setAttribute("type", "text");
                        el.setAttribute("class", "type-input");
                        el.setAttribute("placeholder", "");
                    }
                    cleanNode(el);
                }
            }
        };

        cleanNode(doc.body);
        return doc.body.innerHTML;
    } catch {
        return html;
    }
}

/**
 * Sanitize untrusted flashcard HTML from imported decks or user fields using
 * an explicit tag & attribute allowlist plus inert DOMParser normalization (SEC-05).
 */
export function sanitizeCardHtml(rawHtml: string): string {
    if (!rawHtml) { return ""; }
    const pass1 = sanitizeHtmlWithAllowlistParser(String(rawHtml));
    const pass2 = sanitizeViaInertDomParser(pass1);
    return sanitizeHtmlWithAllowlistParser(pass2);
}

/**
 * Inertly extract plain text from untrusted HTML without ever assigning to
 * `innerHTML` in the active parent application document (SEC-05).
 */
export function extractTextFromHtml(rawHtml: string): string {
    if (!rawHtml) { return ""; }
    const sanitized = sanitizeHtmlWithAllowlistParser(String(rawHtml));
    if (typeof DOMParser !== "undefined") {
        try {
            const doc = new DOMParser().parseFromString(sanitized, "text/html");
            if (doc?.body) {
                return doc.body.textContent || "";
            }
        } catch {
            // Fall through to pure tokenizer text extraction
        }
    }
    return decodeHtmlEntities(sanitized.replace(/<[^>]*>/g, ""));
}

/**
 * Sanitize card model CSS so it cannot import external stylesheets, execute expressions,
 * load unsafe external resources, or break out of a <style> tag.
 */
export function sanitizeCardCss(rawCss: string): string {
    if (!rawCss) { return ""; }
    return String(rawCss)
        .replace(/<\s*\/?\s*style[^>]*>/gi, "")
        .replace(/<\/?[a-z][^>]*>/gi, "")
        .replace(/@import\b[^;]*;?/gi, "")
        .replace(/expression\s*\([^;\}!]*\)/gi, "")
        .replace(/-moz-binding\s*:[^;\}]+;?/gi, "")
        .replace(/behavior\s*:[^;\}]+;?/gi, "")
        .replace(
            /url\s*\(\s*["']?\s*(?:javascript|vbscript|data\s*:\s*(?!image\/(?:png|jpeg|jpg|gif|webp);base64,)|https?:)[^;\}!]*\)/gi,
            "none",
        );
}
