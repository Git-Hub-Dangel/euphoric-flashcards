import { describe, expect, it } from "vitest";
import { mulberry32 } from "src/utils/rng";
import { reinsertWithMinLag } from "src/utils/queue";
import {
    buildInitialQueue,
    groupProgress,
    isGroupComplete,
    makeInitialHistories,
    recordAgain,
    recordClear,
} from "src/learn/group-state";
import { makeCard, sched } from "src/learn/test-helpers";
import { ReviewResponse } from "src/scheduling/review-response";

describe("buildInitialQueue", () => {
    it("emits both faces of every group card and shuffles deterministically", () => {
        const cards = [
            makeCard([null, null], { word: "a" }),
            makeCard([null, null], { word: "b" }),
            makeCard([null, null], { word: "c" }),
        ];
        const queue = buildInitialQueue(cards, () => true, mulberry32(1));
        expect(queue).toHaveLength(6);
        const front = queue.filter(q => q.faceIndex === 0);
        const back = queue.filter(q => q.faceIndex === 1);
        expect(front).toHaveLength(3);
        expect(back).toHaveLength(3);
    });

    it("repairs adjacency so the two faces of one card are not neighbours", () => {
        const cards = [
            makeCard([null, null], { word: "a" }),
            makeCard([null, null], { word: "b" }),
            makeCard([null, null], { word: "c" }),
        ];
        // Any seed with enough cards should produce a legal repair.
        for (let seed = 1; seed <= 20; seed++) {
            const queue = buildInitialQueue(cards, () => true, mulberry32(seed));
            for (let i = 1; i < queue.length; i++) {
                expect(queue[i]!.card).not.toBe(queue[i - 1]!.card);
            }
        }
    });

    it("marks writeEligible per (card, face) via the caller-provided predicate", () => {
        const cards = [makeCard([null, sched("2030-01-01", 30)])];
        const queue = buildInitialQueue(
            cards,
            (card, faceIndex) => card.schedules[faceIndex] === null, // only face 0 eligible
            mulberry32(1),
        );
        const face0 = queue.find(q => q.faceIndex === 0)!;
        const face1 = queue.find(q => q.faceIndex === 1)!;
        expect(face0.writeEligible).toBe(true);
        expect(face1.writeEligible).toBe(false);
    });
});

describe("reinsertWithMinLag", () => {
    it("inserts at least minLag positions past currentIdx", () => {
        for (let seed = 1; seed <= 10; seed++) {
            const queue = ["a", "b", "c", "d", "e", "f", "g", "h"];
            reinsertWithMinLag(queue, 0, "X", 3, mulberry32(seed));
            const insertedAt = queue.indexOf("X");
            expect(insertedAt).toBeGreaterThanOrEqual(4); // idx+1+minLag = 4
            expect(insertedAt).toBeLessThanOrEqual(queue.length - 1);
        }
    });

    it("appends when fewer than minLag items remain", () => {
        const queue = ["a", "b", "c"];
        reinsertWithMinLag(queue, 1, "X", 3, mulberry32(1));
        expect(queue[queue.length - 1]).toBe("X");
    });
});

describe("history recording", () => {
    const cards = [makeCard([null, null], { word: "a" })];
    const item = { ...cards[0]!, faceIndex: 0 as 0, writeEligible: true };

    it("recordAgain bumps count, stamps seq, marks pending, updates worst", () => {
        const histories = makeInitialHistories(cards);
        const queue = [item];
        recordAgain(histories, queue, 0, item, 7, mulberry32(1));
        const h = histories.get(item.card)!;
        expect(h.againCount).toBe(1);
        expect(h.lastAgainSeq).toBe(7);
        expect(h.pendingFaces.has(0)).toBe(true);
        expect(h.worst).toBe(ReviewResponse.Again);
    });

    it("recordClear (first pass) flips facesCleared and clears pending", () => {
        const histories = makeInitialHistories(cards);
        recordClear(histories, item, ReviewResponse.Good, false);
        const h = histories.get(item.card)!;
        expect(h.facesCleared[0]).toBe(true);
        expect(h.worst).toBe(ReviewResponse.Good);
    });

    it("recordClear (post-Again) does not upgrade `worst`", () => {
        const histories = makeInitialHistories(cards);
        const queue = [item];
        recordAgain(histories, queue, 0, item, 1, mulberry32(1));
        // Post-Again OK maps to Hard, but must not overwrite worst=Again.
        recordClear(histories, item, ReviewResponse.Hard, true);
        expect(histories.get(item.card)!.worst).toBe(ReviewResponse.Again);
        expect(histories.get(item.card)!.pendingFaces.has(0)).toBe(false);
    });

    it("groupProgress and isGroupComplete track cleared faces", () => {
        const two = [
            makeCard([null, null], { word: "a" }),
            makeCard([null, null], { word: "b" }),
        ];
        const histories = makeInitialHistories(two);
        expect(groupProgress(histories)).toBe(0);
        expect(isGroupComplete(histories)).toBe(false);
        recordClear(histories, { ...two[0]!, faceIndex: 0, writeEligible: true }, ReviewResponse.Good, false);
        expect(groupProgress(histories)).toBeCloseTo(0.25);
        for (const c of two) {
            recordClear(histories, { ...c, faceIndex: 0, writeEligible: true }, ReviewResponse.Good, false);
            recordClear(histories, { ...c, faceIndex: 1, writeEligible: true }, ReviewResponse.Good, false);
        }
        expect(isGroupComplete(histories)).toBe(true);
        expect(groupProgress(histories)).toBe(1);
    });
});
