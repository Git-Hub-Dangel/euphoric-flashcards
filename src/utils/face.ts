import type { CardSide } from "src/settings";

// Resolve a two-faced card orientation from the user-facing side setting.
// Shuffle picks each call, so any batch of words sharing one draw should
// call this once and reuse the result across the batch (matches Conjure
// Sentences' "one orientation per sentence draw" behaviour).
export function resolveFaceIndex(side: CardSide, rng: () => number = Math.random): 0 | 1 {
    if (side === "Front") return 0;
    if (side === "Back") return 1;
    return rng() < 0.5 ? 0 : 1;
}
