// In-place Fisher-Yates shuffle. Returns the same array for chaining.
// The rng seam enables deterministic tests; production callers pass Math.random.
export function fisherYates<T>(arr: T[], rng: () => number = Math.random): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
}
