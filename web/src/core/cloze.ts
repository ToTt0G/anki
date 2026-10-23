// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Anki Cloze deletion parser and renderer
 * Supports syntax: {{c1::answer}} or {{c1::answer::hint}}
 */

const CLOZE_REGEX = /\{\{c(\d+)::(.*?)(?:::([^}]*))?\}\}/gs;

export function findClozeNumbers(text: string): number[] {
    const set = new Set<number>();
    let match: RegExpExecArray | null;
    const re = new RegExp(CLOZE_REGEX.source, "gs");
    while ((match = re.exec(text)) !== null) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > 0) {
            set.add(num);
        }
    }
    return Array.from(set).sort((a, b) => a - b);
}

export function renderClozeFront(text: string, clozeNum: number): string {
    return text.replace(CLOZE_REGEX, (_full, numStr, answer, hint) => {
        const num = parseInt(numStr, 10);
        if (num === clozeNum) {
            const placeholder = hint ? `[${hint}]` : "[...]";
            return `<span class="cloze">${placeholder}</span>`;
        } else {
            return answer;
        }
    });
}

export function renderClozeBack(text: string, clozeNum: number): string {
    return text.replace(CLOZE_REGEX, (_full, numStr, answer) => {
        const num = parseInt(numStr, 10);
        if (num === clozeNum) {
            return `<span class="cloze">${answer}</span>`;
        } else {
            return answer;
        }
    });
}

export function wrapInCloze(text: string, clozeNum: number, hint?: string): string {
    if (hint) {
        return `{{c${clozeNum}::${text}::${hint}}}`;
    }
    return `{{c${clozeNum}::${text}}}`;
}
