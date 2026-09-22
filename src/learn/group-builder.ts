import type { ParsedCard } from "src/parsing";
import { LEARN_GROUP_SIZE } from "src/learn/constants";
import type { AnchorLocation, CardLocation, LearnPools } from "src/learn/pool";

// Draw up to LEARN_GROUP_SIZE cards, mutating the source pools by splicing
// the chosen entries out. Fill order (blueprint §4):
//   0. carryover slot (bypasses `used`)
//   1. m cards from matureDue, where m = round(G * D_mature / D_due) clamped
//      to [1, matureDue.length] whenever any mature-due exists (0 otherwise)
//   2. up to floor(G/2) from newCards
//   3. youngDue in rank order
//   4. overflow spill: matureDue → newCards → youngFiller
export function buildLearnGroup(
    pools: LearnPools,
    used: Set<ParsedCard>,
    carryover: CardLocation | null,
): CardLocation[] {
    const group: CardLocation[] = [];
    const G = LEARN_GROUP_SIZE;

    if (carryover !== null) {
        group.push(carryover);
        removeCardFromPool(pools.newCards, carryover.card);
        removeCardFromPool(pools.matureDue, carryover.card);
        removeCardFromPool(pools.youngDue, carryover.card);
        removeCardFromPool(pools.youngFiller, carryover.card);
        removeAnchor(pools.matureAnchors, carryover.card);
        used.add(carryover.card);
    }

    const dueRemaining = pools.matureDue.length + pools.youngDue.length;
    let m = 0;
    if (pools.matureDue.length > 0 && dueRemaining > 0) {
        m = Math.round((G * pools.matureDue.length) / dueRemaining);
        m = Math.max(1, Math.min(m, pools.matureDue.length, G - group.length));
    }
    drawFromPool(pools.matureDue, m, group, used);

    const newBudget = Math.min(Math.floor(G / 2), G - group.length);
    drawFromPool(pools.newCards, newBudget, group, used);

    drawFromPool(pools.youngDue, G - group.length, group, used);

    drawFromPool(pools.matureDue, G - group.length, group, used);
    drawFromPool(pools.newCards, G - group.length, group, used);
    drawFromPool(pools.youngFiller, G - group.length, group, used);

    return group;
}

function drawFromPool(
    pool: CardLocation[],
    take: number,
    group: CardLocation[],
    used: Set<ParsedCard>,
): void {
    for (let i = 0; i < take && pool.length > 0; i++) {
        const loc = pool.shift()!;
        group.push(loc);
        used.add(loc.card);
    }
}

function removeCardFromPool(pool: CardLocation[], card: ParsedCard): void {
    const idx = pool.findIndex(l => l.card === card);
    if (idx !== -1) pool.splice(idx, 1);
}

function removeAnchor(pool: AnchorLocation[], card: ParsedCard): void {
    const idx = pool.findIndex(l => l.card === card);
    if (idx !== -1) pool.splice(idx, 1);
}
