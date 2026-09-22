import { describe, expect, it } from "vitest";
import type { ParsedCard } from "src/parsing";
import { buildLearnGroup } from "src/learn/group-builder";
import type { CardLocation, LearnPools } from "src/learn/pool";
import { LEARN_GROUP_SIZE } from "src/learn/constants";
import { makeCard, sched } from "src/learn/test-helpers";

function emptyPools(): LearnPools {
    return {
        newCards: [], matureDue: [], youngDue: [], youngFiller: [], matureAnchors: [],
    };
}

// Build a pool of N distinct cards for the same bucket, using a schedule
// shape that satisfies the bucket's classification (irrelevant here because
// buildLearnGroup ignores classification and drains from the arrays).
function due(interval: number, count: number): CardLocation[] {
    return Array.from({ length: count }, () => makeCard([sched("2026-01-10", interval), sched("2026-01-10", interval)]));
}
function news(count: number): CardLocation[] {
    return Array.from({ length: count }, () => makeCard([null, null]));
}

describe("buildLearnGroup — fill order", () => {
    it("takes matureDue via m formula, then up to floor(G/2) new, then youngDue, then spills", () => {
        const pools: LearnPools = {
            matureDue: due(30, 4),
            youngDue: due(5, 4),
            newCards: news(6),
            youngFiller: [], matureAnchors: [],
        };
        // dueRemaining = 8, matureDue.length = 4, m = round(8 * 4 / 8) = 4
        // → 4 mature + floor(8/2)=4 new = 8, no youngDue fits
        const used = new Set<ParsedCard>();
        const group = buildLearnGroup(pools, used, null);
        expect(group).toHaveLength(LEARN_GROUP_SIZE);
        expect(pools.matureDue).toHaveLength(0);
        expect(pools.newCards).toHaveLength(2);
        expect(pools.youngDue).toHaveLength(4);
    });

    it("clamps m to matureDue length and keeps m>=1 when any mature-due exists", () => {
        const pools: LearnPools = {
            matureDue: due(30, 1),
            youngDue: due(5, 20),
            newCards: [], youngFiller: [], matureAnchors: [],
        };
        // dueRemaining = 21, matureDue = 1, raw m = round(8/21) = 0, clamped to 1
        const group = buildLearnGroup(pools, new Set(), null);
        expect(group).toHaveLength(LEARN_GROUP_SIZE);
        expect(pools.matureDue).toHaveLength(0); // the single mature was pulled
    });

    it("returns a short group when pools run dry", () => {
        const pools: LearnPools = {
            matureDue: [], youngDue: due(5, 2), newCards: news(1),
            youngFiller: [], matureAnchors: [],
        };
        const group = buildLearnGroup(pools, new Set(), null);
        expect(group).toHaveLength(3);
    });

    it("returns an empty group when all pools are empty", () => {
        expect(buildLearnGroup(emptyPools(), new Set(), null)).toHaveLength(0);
    });

    it("places carryover at slot 0 and removes it from source pools", () => {
        const carry = due(30, 1)[0]!;
        const pools: LearnPools = {
            matureDue: [carry, ...due(30, 2)],
            youngDue: due(5, 4),
            newCards: [], youngFiller: [], matureAnchors: [],
        };
        const group = buildLearnGroup(pools, new Set(), carry);
        expect(group[0]).toBe(carry);
        expect(pools.matureDue.some(l => l.card === carry.card)).toBe(false);
    });

    it("carryover bypasses `used` while regular fills add to it", () => {
        const carry = news(1)[0]!;
        const pools: LearnPools = { ...emptyPools(), newCards: news(3) };
        const used = new Set<ParsedCard>();
        used.add(carry.card); // carry is already "used" from the prior group
        const group = buildLearnGroup(pools, used, carry);
        expect(group[0]).toBe(carry);
        expect(group).toHaveLength(4); // carry + 3 news
        // used now contains carry (still) plus every new card drawn
        expect(used.has(carry.card)).toBe(true);
        for (const g of group.slice(1)) expect(used.has(g.card)).toBe(true);
    });

    it("spills overflow order: matureDue → newCards → youngFiller", () => {
        // matureDue=0 initially satisfies m=0. newBudget draws from newCards.
        // After all mainlines exhausted, youngFiller fills the remainder.
        const pools: LearnPools = {
            matureDue: [], youngDue: due(5, 1), newCards: news(2),
            youngFiller: due(5, 5), matureAnchors: [],
        };
        // youngDue: 1, new: 2, filler: rest
        const group = buildLearnGroup(pools, new Set(), null);
        expect(group).toHaveLength(LEARN_GROUP_SIZE);
        expect(pools.youngDue).toHaveLength(0);
        expect(pools.newCards).toHaveLength(0);
        expect(pools.youngFiller).toHaveLength(0); // 5 draws
    });
});
