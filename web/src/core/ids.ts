// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

// Entity IDs use the full safe-integer space, independent of clocks and tabs.
// Inserts additionally reject occupied IDs on the server before changing any rows.
export function generateUniqueId(
    existing?: Record<number | string, unknown> | Set<number>,
): number {
    const words = new Uint32Array(2);
    let candidate: number;
    do {
        crypto.getRandomValues(words);
        candidate = (words[0] & 0x1fffff) * 0x100000000 + words[1];
    } while (
        candidate === 0
        || (existing instanceof Set
            ? existing.has(candidate)
            : existing && Object.prototype.hasOwnProperty.call(existing, candidate))
    );
    return candidate;
}

export function generateUniqueIds(
    count: number,
    existing?: Record<number | string, unknown> | Set<number>,
): number[] {
    const allocated = new Set(existing instanceof Set ? existing : Object.keys(existing || {}).map(Number));
    return Array.from({ length: count }, () => {
        const id = generateUniqueId(allocated);
        allocated.add(id);
        return id;
    });
}

// Review IDs encode time in Anki. Keep these separate from random entity IDs;
// the server resolves timestamp collisions and operation IDs prevent double reviews.
let lastReviewId = 0;
export function generateReviewId(existing: Set<number>): number {
    let id = Math.max(Date.now(), lastReviewId + 1);
    while (existing.has(id)) { id++; }
    lastReviewId = id;
    return id;
}
