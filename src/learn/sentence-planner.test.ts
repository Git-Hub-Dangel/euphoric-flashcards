import { describe, expect, it } from "vitest";
import { mulberry32 } from "src/utils/rng";
import { ReviewResponse } from "src/scheduling/review-response";
import { makeCard, sched } from "src/learn/test-helpers";
import type { GroupCardState } from "src/learn/group-state";
import {
    computeTaskCount,
    computeThresholds,
    pickSentenceWords,
    tasksFiring,
    weightedSampleWithoutReplacement,
} from "src/learn/sentence-planner";
import type { AnchorLocation } from "src/learn/pool";

function history(overrides: Partial<GroupCardState> = {}): GroupCardState {
    return {
        againCount: 0,
        lastAgainSeq: -1,
        worst: null,
        wasNew: false,
        pendingFaces: new Set(),
        facesCleared: [true, true],
        ...overrides,
    };
}

describe("computeTaskCount", () => {
    it("returns 1 for a stable group (no new, no Again)", () => {
        const cards = [makeCard([sched("2026-01-01", 10), sched("2026-01-01", 10)]).card];
        const h = new Map([[cards[0]!, history()]]);
        expect(computeTaskCount(cards, h)).toBe(1);
    });

    it("returns 2 when f>=2 fragile cards", () => {
        const cards = [1, 2, 3].map(() => makeCard([null, null]).card);
        const h = new Map<typeof cards[0], GroupCardState>();
        h.set(cards[0]!, history({ wasNew: true }));
        h.set(cards[1]!, history({ wasNew: true }));
        h.set(cards[2]!, history());
        expect(computeTaskCount(cards, h)).toBe(2);
    });

    it("returns 3 when f>=4 fragile cards", () => {
        const cards = Array.from({ length: 8 }, () => makeCard([null, null]).card);
        const h = new Map<typeof cards[0], GroupCardState>();
        for (let i = 0; i < 4; i++) h.set(cards[i]!, history({ wasNew: true }));
        for (let i = 4; i < 8; i++) h.set(cards[i]!, history());
        expect(computeTaskCount(cards, h)).toBe(3);
    });

    it("caps T at ceil(G/2)", () => {
        // G=3, f=3 → raw T=3, cap = ceil(3/2)=2
        const cards = Array.from({ length: 3 }, () => makeCard([null, null]).card);
        const h = new Map<typeof cards[0], GroupCardState>(
            cards.map(c => [c, history({ wasNew: true })]),
        );
        expect(computeTaskCount(cards, h)).toBe(2);
    });
});

describe("computeThresholds", () => {
    it("T=1 → single trigger at 0.7", () => {
        expect(computeThresholds(1)).toEqual([0.7]);
    });
    it("T=2 → [0.7, 1.0]", () => {
        const t = computeThresholds(2);
        expect(t[0]).toBeCloseTo(0.7);
        expect(t[1]).toBeCloseTo(1.0);
    });
    it("T=3 → evenly spaced between 0.7 and 1.0", () => {
        const t = computeThresholds(3);
        expect(t[0]).toBeCloseTo(0.7);
        expect(t[1]).toBeCloseTo(0.85);
        expect(t[2]).toBeCloseTo(1.0);
    });
});

describe("tasksFiring", () => {
    it("counts pending thresholds crossed on a single answer", () => {
        // T=3 thresholds [0.7, 0.85, 1.0]. Progress jumps from 0.6 → 0.9.
        const t = computeThresholds(3);
        expect(tasksFiring(0.9, t, 0)).toBe(2); // 0.7 and 0.85
    });

    it("respects cursor so already-fired tasks aren't recounted", () => {
        const t = computeThresholds(3);
        expect(tasksFiring(1.0, t, 2)).toBe(1); // only 1.0 remains
    });

    it("returns 0 when progress hasn't reached the next threshold", () => {
        const t = computeThresholds(2);
        expect(tasksFiring(0.6, t, 0)).toBe(0);
    });
});

describe("weightedSampleWithoutReplacement", () => {
    it("is deterministic given the same rng seed", () => {
        const a = weightedSampleWithoutReplacement([1, 2, 3, 4], 2, mulberry32(1));
        const b = weightedSampleWithoutReplacement([1, 2, 3, 4], 2, mulberry32(1));
        expect(a).toEqual(b);
    });

    it("returns at most k indices and skips zero-weight entries", () => {
        const picks = weightedSampleWithoutReplacement([0, 5, 0, 5], 5, mulberry32(1));
        expect(picks).toHaveLength(2);
        expect(picks).toEqual(expect.arrayContaining([1, 3]));
    });

    it("favours heavier weights in the long run", () => {
        // Heavy weight on index 0 should dominate.
        const wins: number[] = [0, 0, 0, 0];
        const rng = mulberry32(9001);
        for (let i = 0; i < 500; i++) {
            const [pick] = weightedSampleWithoutReplacement([10, 1, 1, 1], 1, rng);
            wins[pick!]!++;
        }
        expect(wins[0]).toBeGreaterThan(wins[1]! + wins[2]! + wins[3]!);
    });
});

describe("pickSentenceWords", () => {
    const cardA = makeCard([sched("2026-01-01", 10), sched("2026-01-01", 10)], { word: "a" });
    const cardB = makeCard([sched("2026-01-01", 10), sched("2026-01-01", 10)], { word: "b" });
    const cardC = makeCard([sched("2026-01-01", 10), sched("2026-01-01", 10)], { word: "c" });

    it("assigns weights per the base table with 0.5^u decay", () => {
        // 100 draws of one word from {A (again), B (wasNew), C (fresh)}.
        // Uniform decay counts: with equal appearances, weight ratios are 4:3:1.
        // Expect A to dominate.
        const eligible = [cardA, cardB, cardC];
        const histories = new Map<typeof cardA["card"], GroupCardState>();
        histories.set(cardA.card, history({ againCount: 1 }));
        histories.set(cardB.card, history({ wasNew: true }));
        histories.set(cardC.card, history());
        const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
        const rng = mulberry32(42);
        for (let i = 0; i < 400; i++) {
            const [pick] = pickSentenceWords({
                eligible,
                histories,
                appearanceCounts: new Map(),
                anchors: [],
                wordCount: 1,
                faceIndex: 0,
                rng,
            });
            counts[pick!.card.fields.word]!++;
        }
        expect(counts.a).toBeGreaterThan(counts.b!);
        expect(counts.b).toBeGreaterThan(counts.c!);
    });

    it("falls back to a group word when no anchors exist and wordCount>=2", () => {
        const eligible = [cardA, cardB];
        const histories = new Map<typeof cardA["card"], GroupCardState>();
        histories.set(cardA.card, history());
        histories.set(cardB.card, history());
        const picks = pickSentenceWords({
            eligible,
            histories,
            appearanceCounts: new Map(),
            anchors: [],
            wordCount: 3,
            faceIndex: 0,
            rng: mulberry32(3),
        });
        // All 3 slots go to group words; no anchor.
        expect(picks).toHaveLength(2); // only 2 unique eligible cards available
        expect(picks.every(p => !p.isAnchor)).toBe(true);
    });

    it("draws exactly one anchor when wordCount>=2 and anchors non-empty", () => {
        const eligible = [cardA];
        const anchors: AnchorLocation[] = [
            { ...makeCard([sched("2030-01-01", 60), sched("2030-01-01", 60)]), interval: 60 },
        ];
        const histories = new Map<typeof cardA["card"], GroupCardState>();
        histories.set(cardA.card, history());
        const picks = pickSentenceWords({
            eligible,
            histories,
            appearanceCounts: new Map(),
            anchors,
            wordCount: 3,
            faceIndex: 0,
            rng: mulberry32(3),
        });
        expect(picks.filter(p => p.isAnchor)).toHaveLength(1);
    });

    it("wordCount=1 skips the anchor slot even when anchors exist", () => {
        const eligible = [cardA];
        const anchors: AnchorLocation[] = [
            { ...makeCard([sched("2030-01-01", 60), sched("2030-01-01", 60)]), interval: 60 },
        ];
        const histories = new Map([[cardA.card, history()]]);
        const picks = pickSentenceWords({
            eligible,
            histories,
            appearanceCounts: new Map(),
            anchors,
            wordCount: 1,
            faceIndex: 0,
            rng: mulberry32(3),
        });
        expect(picks).toHaveLength(1);
        expect(picks[0]!.isAnchor).toBe(false);
    });

    it("decay reduces the effective weight of already-appeared cards", () => {
        // Two candidates with same base weight (both worst=Hard → 2). A has
        // appeared 3 times, B zero times. B should almost always be picked.
        const histories = new Map<typeof cardA["card"], GroupCardState>();
        histories.set(cardA.card, history({ worst: ReviewResponse.Hard }));
        histories.set(cardB.card, history({ worst: ReviewResponse.Hard }));
        const appearanceCounts = new Map([[cardA.card, 3]]);
        const rng = mulberry32(101);
        let bWins = 0;
        for (let i = 0; i < 100; i++) {
            const [pick] = pickSentenceWords({
                eligible: [cardA, cardB],
                histories,
                appearanceCounts,
                anchors: [],
                wordCount: 1,
                faceIndex: 0,
                rng,
            });
            if (pick!.card === cardB.card) bWins++;
        }
        expect(bWins).toBeGreaterThan(80);
    });
});
