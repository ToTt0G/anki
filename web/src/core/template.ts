// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { renderClozeBack, renderClozeFront } from "./cloze";
import { extractTextFromHtml, sanitizeCardCss, sanitizeCardHtml } from "./sanitize";
import { Card, Note, NoteType } from "./types";

export interface RenderedCard {
    frontHtml: string;
    backHtml: string;
    css: string;
}

/**
 * Safely decode a percent-encoded URI component without throwing on malformed `%` sequences (UX-12).
 */
export function safeDecodeURIComponent(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

function escapeHtmlText(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Extract plain text from HTML without ever assigning untrusted content to `innerHTML`
 * in the active parent application document (SEC-05).
 */
export function stripHtml(html: string): string {
    return extractTextFromHtml(html);
}

export function renderCardTemplate(
    card: Card,
    note: Note,
    model: NoteType,
    mediaMap?: Record<string, string>,
): RenderedCard {
    // Map field values by field name
    const fieldsMap: Record<string, string> = {};
    model.flds.forEach((fld, idx) => {
        fieldsMap[fld.name] = note.fields[idx] || "";
    });

    const tmpl = model.tmpls[card.ord] || model.tmpls[0] || {
        name: "Card 1",
        ord: 0,
        qfmt: "{{Front}}",
        afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
    };

    const isCloze = model.type === 1;
    const clozeNum = card.ord + 1;

    function processTemplate(tmplText: string, isBack: boolean, frontProcessed: string): string {
        let out = tmplText;

        // 1. Handle {{FrontSide}} on back template
        if (isBack) {
            out = out.replace(/\{\{FrontSide\}\}/g, frontProcessed);
        }

        // 2. Handle conditional sections: {{#Field}}...{{/Field}}
        out = out.replace(/\{\{#([^}]+)\}\}(.*?)\{\{\/\1\}\}/gs, (_m, fieldName, content) => {
            const val = fieldsMap[fieldName.trim()];
            return val && stripHtml(val).trim().length > 0 ? content : "";
        });

        // 3. Handle inverted conditional sections: {{^Field}}...{{/Field}}
        out = out.replace(/\{\{\^([^}]+)\}\}(.*?)\{\{\/\1\}\}/gs, (_m, fieldName, content) => {
            const val = fieldsMap[fieldName.trim()];
            return !val || stripHtml(val).trim().length === 0 ? content : "";
        });

        // 4. Handle cloze: {{cloze:FieldName}}
        out = out.replace(/\{\{cloze:([^}]+)\}\}/g, (_m, fieldName) => {
            const val = fieldsMap[fieldName.trim()] || "";
            return isBack ? renderClozeBack(val, clozeNum) : renderClozeFront(val, clozeNum);
        });

        // 5. Handle type answer: {{type:FieldName}}
        out = out.replace(/\{\{type:([^}]+)\}\}/g, (_m, fieldName) => {
            const val = fieldsMap[fieldName.trim()] || "";
            if (isBack) {
                return `<div class="type-answer-result"><span class="type-good">${
                    escapeHtmlText(stripHtml(val))
                }</span></div>`;
            } else {
                return `<div class="type-answer-box"><input type="text" class="type-input" placeholder="" /></div>`;
            }
        });

        // 6. Handle hint filter: {{hint:FieldName}}
        out = out.replace(/\{\{hint:([^}]+)\}\}/g, (_m, fieldName) => {
            const val = fieldsMap[fieldName.trim()] || "";
            if (!val) { return ""; }
            return `<details class="anki-hint"><summary>Hint</summary>${val}</details>`;
        });

        // 7. Handle standard {{FieldName}}
        out = out.replace(/\{\{([^}#^/]+)\}\}/g, (full, rawName) => {
            const name = rawName.trim();
            if (name in fieldsMap) {
                const val = fieldsMap[name];
                if (isCloze) {
                    return isBack ? renderClozeBack(val, clozeNum) : renderClozeFront(val, clozeNum);
                }
                return val;
            }
            return full;
        });

        // 8. Replace [sound:filename.mp3] with audio tags (using safeDecodeURIComponent UX-12)
        out = out.replace(/\[sound:([^\]]+)\]/g, (_m, filename) => {
            const rawTrimmed = filename.trim();
            const decodedFilename = safeDecodeURIComponent(rawTrimmed);
            const src = mediaMap && (mediaMap[rawTrimmed] || mediaMap[decodedFilename])
                ? (mediaMap[rawTrimmed] || mediaMap[decodedFilename])
                : `/media/${rawTrimmed}`;
            return `<audio controls class="anki-audio" src="${src}"></audio>`;
        });

        // 9. Resolve images: handles relative src, encoded filenames, and ensures responsive bounds (UX-12)
        out = out.replace(/<img\b([^>]*)src=["']([^"']+)["']([^>]*)>/gi, (_full, beforeAttrs, src, afterAttrs) => {
            const trimmedSrc = src.trim();
            let resolvedSrc = trimmedSrc;

            if (mediaMap) {
                const decodedSrc = safeDecodeURIComponent(trimmedSrc);
                const baseName = trimmedSrc.split("/").pop() || trimmedSrc;
                const decodedBaseName = safeDecodeURIComponent(baseName);

                if (mediaMap[trimmedSrc]) {
                    resolvedSrc = mediaMap[trimmedSrc];
                } else if (mediaMap[decodedSrc]) {
                    resolvedSrc = mediaMap[decodedSrc];
                } else if (mediaMap[baseName]) {
                    resolvedSrc = mediaMap[baseName];
                } else if (mediaMap[decodedBaseName]) {
                    resolvedSrc = mediaMap[decodedBaseName];
                }
            }

            return `<img${beforeAttrs}src="${resolvedSrc}" loading="lazy" class="anki-image"${afterAttrs}>`;
        });

        return out;
    }

    const frontHtml = sanitizeCardHtml(processTemplate(tmpl.qfmt, false, ""));
    const backHtml = sanitizeCardHtml(processTemplate(tmpl.afmt, true, frontHtml));

    return {
        frontHtml,
        backHtml,
        css: sanitizeCardCss(model.css || ""),
    };
}
