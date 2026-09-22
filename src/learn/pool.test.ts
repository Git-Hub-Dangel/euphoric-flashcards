import { describe, expect, it } from "vitest";
import { mulberry32 } from "src/utils/rng";
import { classifyPools } from "src/learn/pool";
import { makeCard, sched } from "src/learn/test-helpers";

const today = new Date("2026-01-15T00:00:00Z");

describe("classifyPools", () => {
    it("routes cards with at least one null schedule into newCards", () => {
        const a = makeCard([null, null]);
        const b = makeCard([null, sched("2026-01-15", 5)]);
        const c = makeCard([sched("2026-01-15", 30), sched("2026-01-15", 30)]);
        const pools = classifyPools([a, b, c], today, mulberry32(1));
        expect(pools.newCards.map(l => l.card.fields.word)).toEqual(
            expect.arrayContaining([a.card.fields.word, b.card.fields.word]),
        );
        expect(pools.newCards).toHaveLength(2);
    });

    it("splits mature vs young at 21-day interval boundary", () => {
        const matureDue = makeCard([sched("2026-01-10", 21), sched("2026-02-01", 30)]);
        const youngDue = makeCard([sched("2026-01-10", 5), sched("2026-01-10", 10)]);
        const pools = classifyPools([matureDue, youngDue], today, mulberry32(1));
        expect(pools.matureDue).toHaveLength(1);
        expect(pools.youngDue).toHaveLength(1);
    });

    it("routes seen-non-due cards to matureAnchors (>=21d) or youngFiller (<21d)", () => {
        const anchor = makeCard([sched("2026-02-15", 30), sched("2026-03-01", 45)]);
        const filler = makeCard([sched("2026-02-15", 5), sched("2026-03-01", 7)]);
        const pools = classifyPools([anchor, filler], today, mulberry32(1));
        expect(pools.matureAnchors).toHaveLength(1);
        expect(pools.matureAnchors[0]!.interval).toBe(30);
        expect(pools.youngFiller).toHaveLength(1);
    });

    it("ranks due pools by descending overdue ratio", () => {
        // barely due (overdue 0d, interval 10) → ratio ~1.0
        const barely = makeCard([sched("2026-01-15", 10), sched("2026-01-15", 10)]);
        // very overdue (10d overdue, interval 10) → ratio ~2.0
        const veryOverdue = makeCard([sched("2026-01-05", 10), sched("2026-01-05", 10)]);
        const pools = classifyPools([barely, veryOverdue], today, mulberry32(1));
        expect(pools.youngDue[0]!.card.fields.word).toBe(veryOverdue.card.fields.word);
        expect(pools.youngDue[1]!.card.fields.word).toBe(barely.card.fields.word);
    });

    it("breaks overdue-ratio ties by lowest ease", () => {
        const highEase = makeCard([sched("2026-01-10", 5, 300), sched("2026-01-10", 5, 300)]);
        const lowEase = makeCard([sched("2026-01-10", 5, 200), sched("2026-01-10", 5, 200)]);
        const pools = classifyPools([highEase, lowEase], today, mulberry32(1));
        expect(pools.youngDue[0]!.card.fields.word).toBe(lowEase.card.fields.word);
    });

    it("orders youngFiller by lowest ease", () => {
        const a = makeCard([sched("2026-02-01", 5, 260), sched("2026-02-01", 5, 260)]);
        const b = makeCard([sched("2026-02-01", 5, 210), sched("2026-02-01", 5, 210)]);
        const pools = classifyPools([a, b], today, mulberry32(1));
        expect(pools.youngFiller[0]!.card.fields.word).toBe(b.card.fields.word);
    });

    it("shuffles newCards deterministically with the seeded rng", () => {
        const cards = Array.from({ length: 6 }, () => makeCard([null, null]));
        const order1 = classifyPools(cards, today, mulberry32(42)).newCards.map(l => l.card.fields.word);
        const order2 = classifyPools(cards, today, mulberry32(42)).newCards.map(l => l.card.fields.word);
        expect(order1).toEqual(order2);
    });
});
