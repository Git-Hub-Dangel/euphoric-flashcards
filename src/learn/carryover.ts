import type { ParsedCard } from "src/parsing";
import type { GroupCardState } from "src/learn/group-state";
import { LEARN_CARRYOVER_MIN_AGAINS } from "src/learn/constants";

// Pick the group's leech for carryover into the next group. Highest againCount
// wins, ties broken by the largest lastAgainSeq. Cards already carried this
// session are excluded so a chronic leech cannot cycle through every group.
export function selectCarryover(
    states: Map<ParsedCard, GroupCardState>,
    carriedSoFar: Set<ParsedCard>,
): ParsedCard | null {
    let best: ParsedCard | null = null;
    let bestAgain = 0;
    let bestSeq = -Infinity;
    for (const [card, st] of states) {
        if (st.againCount < LEARN_CARRYOVER_MIN_AGAINS) continue;
        if (carriedSoFar.has(card)) continue;
        if (st.againCount > bestAgain
            || (st.againCount === bestAgain && st.lastAgainSeq > bestSeq)) {
            best = card;
            bestAgain = st.againCount;
            bestSeq = st.lastAgainSeq;
        }
    }
    return best;
}
