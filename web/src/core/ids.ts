// Collision-resistant monotonic integer ID generator (D06, D11)
// Produces safe positive integers compatible with Anki's SQLite INTEGER PRIMARY KEY schema.

let lastAllocatedId = 0;

/**
 * Generate a collision-resistant positive integer ID.
 * Combines millisecond timestamp with sub-millisecond monotonic increment + random jitter,
 * and checks against optional existing ID sets/maps.
 */
export function generateUniqueId(
  existing?: Record<number | string, unknown> | Set<number>
): number {
  const now = Date.now();
  // Multiply by 1000 only if we wanted microsecond scale, but Anki expects millisecond-scale IDs
  // (e.g. 13-digit epoch ms for revlog and deck/note IDs so new Date(id) represents creation time).
  // Use monotonic progression + collision check to stay in 13-digit epoch ms scale while guaranteeing uniqueness.
  const jitter = Math.floor(Math.random() * 7);
  let candidate = Math.max(now, lastAllocatedId + 1 + jitter);

  if (existing) {
    while (
      existing instanceof Set
        ? existing.has(candidate)
        : Object.prototype.hasOwnProperty.call(existing, candidate)
    ) {
      candidate++;
    }
  }

  lastAllocatedId = candidate;
  return candidate;
}

/**
 * Allocate `count` distinct, strictly increasing integer IDs.
 */
export function generateUniqueIds(
  count: number,
  existing?: Record<number | string, unknown> | Set<number>
): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(generateUniqueId(existing));
  }
  return out;
}
