import { describe, expect, it } from "vitest";
import type { ParsedCard } from "src/parsing";
import { selectCarryover } from "src/learn/carryover";
import type { LearnCardHistory } from "src/learn/group-state";
import { makeCard } from "src/learn/test-helpers";

function hist(again: number, seq: number): LearnCardHistory {
    return {
        againCount: again,
        lastAgainSeq: seq,
        worst: null,
        wasNew: false,
        pendingFaces: new Set(),
        facesCleared: [true, true],
    };
}

describe("selectCarryover", () => {
    it("returns null when no card has >= LEARN_CARRYOVER_MIN_AGAINS", () => {
        const a = makeCard([null, null]);
        const b = makeCard([null, null]);
        const map = new Map<ParsedCard, LearnCardHistory>([
            [a.card, hist(1, 3)],
            [b.card, hist(0, 0)],
        ]);
        expect(selectCarryover(map, new Set())).toBeNull();
    });

    it("returns the card with the highest againCount", () => {
        const a = makeCard([null, null]);
        const b = makeCard([null, null]);
        const map = new Map<ParsedCard, LearnCardHistory>([
            [a.card, hist(2, 5)],
            [b.card, hist(4, 1)],
        ]);
        expect(selectCarryover(map, new Set())).toBe(b.card);
    });

    it("breaks ties by largest lastAgainSeq", () => {
        const a = makeCard([null, null]);
        const b = makeCard([null, null]);
        const map = new Map<ParsedCard, LearnCardHistory>([
            [a.card, hist(2, 10)],
            [b.card, hist(2, 20)],
        ]);
        expect(selectCarryover(map, new Set())).toBe(b.card);
    });

    it("skips cards already in carriedSoFar", () => {
        const a = makeCard([null, null]);
        const b = makeCard([null, null]);
        const map = new Map<ParsedCard, LearnCardHistory>([
            [a.card, hist(3, 5)],
            [b.card, hist(2, 10)],
        ]);
        expect(selectCarryover(map, new Set([a.card]))).toBe(b.card);
    });

    it("returns null when every qualifying card is already carried", () => {
        const a = makeCard([null, null]);
        const map = new Map<ParsedCard, LearnCardHistory>([[a.card, hist(3, 5)]]);
        expect(selectCarryover(map, new Set([a.card]))).toBeNull();
    });
});
