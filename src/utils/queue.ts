// Reinsert `item` into `queue` at a random position at least `minLag` items
// past `currentIdx`. Clamped to the queue end: if fewer than `minLag` items
// remain after the current index, the item is appended.
export function reinsertWithMinLag<T>(
    queue: T[],
    currentIdx: number,
    item: T,
    minLag: number,
    rng: () => number = Math.random,
): void {
    const remaining = queue.length - (currentIdx + 1);
    if (remaining <= minLag) {
        queue.push(item);
        return;
    }
    const minInsert = currentIdx + 1 + minLag;
    const maxInsert = queue.length;
    const insertAt = minInsert + Math.floor(rng() * (maxInsert - minInsert + 1));
    queue.splice(insertAt, 0, item);
}
