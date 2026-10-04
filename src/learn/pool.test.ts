import { describe, expect, it } from "vitest";
import { mulberry32 } from "src/utils/rng";
import { classifyPools } from "src/learn/pool";
import { State } from "src/scheduling/fsrs";
import { makeCard, retrievabilityFn, sched } from "src/learn/test-helpers";

// The real FSRS forgetting curve, not a stub — see retrievabilityFn.
const RETRIEVABILITY = retrievabilityFn();

const today = new Date("2026-01-15T00:00:00Z");

describe("classifyPools", () => {
    it("routes cards with at least one null schedule into newCards", () => {
        const a = makeCard([null, null]);
        const b = makeCard([null, sched("2026-01-15", 5)]);
        const c = makeCard([sched("2026-01-15", 30), sched("2026-01-15", 30)]);
        const pools = classifyPools([a, b, c], today, RETRIEVABILITY, mulberry32(1));
        expect(pools.newCards.map(l => l.card.fields.word)).toEqual(
            expect.arrayContaining([a.card.fields.word, b.card.fields.word]),
        );
        expect(pools.newCards).toHaveLength(2);
    });

    it("splits mature vs young at 21-day interval boundary", () => {
        const matureDue = makeCard([sched("2026-01-10", 21), sched("2026-02-01", 30)]);
        const youngDue = makeCard([sched("2026-01-10", 5), sched("2026-01-10", 10)]);
        const pools = classifyPools([matureDue, youngDue], today, RETRIEVABILITY, mulberry32(1));
        expect(pools.matureDue).toHaveLength(1);
        expect(pools.youngDue).toHaveLength(1);
    });

    it("routes seen-non-due cards to matureAnchors (>=21d) or youngFiller (<12d)", () => {
        const anchor = makeCard([sched("2026-02-15", 30), sched("2026-03-01", 45)]);
        const filler = makeCard([sched("2026-02-15", 5), sched("2026-03-01", 7)]);
        const pools = classifyPools([anchor, filler], today, RETRIEVABILITY, mulberry32(1));
        expect(pools.matureAnchors).toHaveLength(1);
        expect(pools.matureAnchors[0]!.stability).toBe(30);
        expect(pools.youngFiller).toHaveLength(1);
        expect(pools.youngFiller[0]!.card.fields.word).toBe(filler.card.fields.word);
    });

    // B3 is emphatic that maturity is stability and **not** scheduled_days. The
    // two come apart whenever the interval was clamped, so assert the difference
    // rather than relying on fixtures where they happen to coincide.
    it("measures maturity by stability, not by the scheduled interval", () => {
        // Stability 40 (mature) but only a 2-day scheduled interval: the card was
        // last reviewed two days before it fell due.
        const stableButShortInterval = makeCard([
            sched("2026-02-15", 40, { lastReview: new Date(2026, 1, 13) }),
            sched("2026-02-15", 40, { lastReview: new Date(2026, 1, 13) }),
        ], { word: "stableShortIvl" });
        // The mirror: stability 5 (young) sitting on a 300-day interval.
        const fragileButLongInterval = makeCard([
            sched("2026-02-15", 5, { lastReview: new Date(2025, 3, 21) }),
            sched("2026-02-15", 5, { lastReview: new Date(2025, 3, 21) }),
        ], { word: "fragileLongIvl" });

        const pools = classifyPools(
            [stableButShortInterval, fragileButLongInterval], today, RETRIEVABILITY, mulberry32(1),
        );
        // Mature by stability → anchor material, and NOT youngFiller.
        expect(pools.matureAnchors.map(l => l.card.fields.word)).toEqual(["stableShortIvl"]);
        // Young by stability → filler, despite its long interval.
        expect(pools.youngFiller.map(l => l.card.fields.word)).toEqual(["fragileLongIvl"]);
    });

    it("lists a semi-mature non-due card as both youngFiller and an anchor", () => {
        const semi = makeCard([sched("2026-02-15", 12), sched("2026-03-01", 18)]);
        const pools = classifyPools([semi], today, RETRIEVABILITY, mulberry32(1));
        expect(pools.youngFiller).toHaveLength(1);
        expect(pools.matureAnchors).toHaveLength(1);
        expect(pools.matureAnchors[0]!.stability).toBe(12);
    });

    it("keeps a non-due card under the anchor floor out of the anchor pool", () => {
        const pools = classifyPools(
            [makeCard([sched("2026-02-15", 11), sched("2026-03-01", 40)])],
            today,
            RETRIEVABILITY,
            mulberry32(1),
        );
        expect(pools.matureAnchors).toHaveLength(0);
        expect(pools.youngFiller).toHaveLength(1);
    });

    // P4.2: the due ranking is retrievability ASCENDING — least likely to be
    // recalled goes first.
    it("ranks due pools by ascending retrievability", () => {
        // Barely due: reviewed 10 days ago with stability 10, so recall is still
        // near the target retention.
        const barely = makeCard([sched("2026-01-15", 10), sched("2026-01-15", 10)]);
        // Long overdue: same stability, ten further days of decay.
        const veryOverdue = makeCard([sched("2026-01-05", 10), sched("2026-01-05", 10)]);
        const pools = classifyPools([barely, veryOverdue], today, RETRIEVABILITY, mulberry32(1));
        expect(pools.youngDue[0]!.card.fields.word).toBe(veryOverdue.card.fields.word);
        expect(pools.youngDue[1]!.card.fields.word).toBe(barely.card.fields.word);
    });

    // The case that separates retrievability from the overdue ratio it replaced.
    //
    // FSRS's forgetting curve is a function of t/S alone, where t is measured from
    // **last_review** — not from the due date. The old overdueRatio measured
    // lateness from the *due date* instead, so the two agree whenever a card's
    // scheduled interval equals its stability, and diverge when it does not.
    //
    // That divergence is not hypothetical: it is exactly what maximum_interval
    // saturation produces (a card held at 365 days while its stability runs far
    // past that), and what Phase 5's converter produces while it seeds
    // stability from an SM-2 interval.
    //
    // Both cards below are 10 days overdue with stability 100, so overdueRatio
    // scored them identically and fell through to the difficulty tie-break. Their
    // elapsed time differs by 90 days, and retrievability sees it.
    it("ranks on time since last review, not lateness against a clamped due date", () => {
        const longUnseen = makeCard([
            sched("2026-01-05", 100, { lastReview: new Date(2025, 8, 27) }),
            sched("2026-01-05", 100, { lastReview: new Date(2025, 8, 27) }),
        ], { word: "longUnseen" });
        const recentlySeen = makeCard([
            sched("2026-01-05", 100, { lastReview: new Date(2025, 11, 26) }),
            sched("2026-01-05", 100, { lastReview: new Date(2025, 11, 26) }),
        ], { word: "recentlySeen" });

        const rLong = RETRIEVABILITY(longUnseen.card.schedules[0]!, today);
        const rRecent = RETRIEVABILITY(recentlySeen.card.schedules[0]!, today);
        expect(rLong).toBeLessThan(rRecent);

        const pools = classifyPools(
            [recentlySeen, longUnseen], today, RETRIEVABILITY, mulberry32(1),
        );
        // Stability 100 puts both in matureDue; the less-recalled one leads.
        expect(pools.matureDue.map(l => l.card.fields.word))
            .toEqual(["longUnseen", "recentlySeen"]);
    });

    // ⚠️ The §C3 sign flip, asserted explicitly because nothing else would catch
    // it: low ease meant a struggling card, and so does *high* difficulty. Read
    // the wrong way round, the engine would serve the user's easiest cards first
    // and every other test here would still pass.
    it("breaks retrievability ties by HIGHEST difficulty — the shakiest card first", () => {
        const easyCard = makeCard([
            sched("2026-01-10", 5, { difficulty: 2 }),
            sched("2026-01-10", 5, { difficulty: 2 }),
        ]);
        const hardCard = makeCard([
            sched("2026-01-10", 5, { difficulty: 9 }),
            sched("2026-01-10", 5, { difficulty: 9 }),
        ]);
        const pools = classifyPools([easyCard, hardCard], today, RETRIEVABILITY, mulberry32(1));
        expect(pools.youngDue[0]!.card.fields.word).toBe(hardCard.card.fields.word);
        expect(pools.youngDue[1]!.card.fields.word).toBe(easyCard.card.fields.word);
    });

    // Ties are the common case, not the edge case: ts-fsrs floors elapsed time to
    // whole days, so any two faces last reviewed on the same day with equal
    // stability return byte-identical retrievability. The difficulty tie-break is
    // therefore load-bearing.
    it("produces exact retrievability ties for same-day, same-stability faces", () => {
        const a = sched("2026-01-10", 5);
        const b = sched("2026-01-10", 5);
        expect(RETRIEVABILITY(a, today)).toBe(RETRIEVABILITY(b, today));
    });

    it("takes a card's difficulty from its hardest face, not its easiest", () => {
        // One shaky direction is enough to promote a card: the mirror of the
        // min-across-faces stability rule.
        const oneShakyFace = makeCard([
            sched("2026-01-10", 5, { difficulty: 1 }),
            sched("2026-01-10", 5, { difficulty: 9.5 }),
        ]);
        const evenlyMiddling = makeCard([
            sched("2026-01-10", 5, { difficulty: 5 }),
            sched("2026-01-10", 5, { difficulty: 5 }),
        ]);
        const pools = classifyPools([oneShakyFace, evenlyMiddling], today, RETRIEVABILITY, mulberry32(1));
        expect(pools.youngDue[0]!.card.fields.word).toBe(oneShakyFace.card.fields.word);
    });

    it("orders youngFiller by highest difficulty", () => {
        const easier = makeCard([
            sched("2026-02-01", 5, { difficulty: 3 }),
            sched("2026-02-01", 5, { difficulty: 3 }),
        ]);
        const harder = makeCard([
            sched("2026-02-01", 5, { difficulty: 8 }),
            sched("2026-02-01", 5, { difficulty: 8 }),
        ]);
        const pools = classifyPools([easier, harder], today, RETRIEVABILITY, mulberry32(1));
        expect(pools.youngFiller[0]!.card.fields.word).toBe(harder.card.fields.word);
    });

    it("shuffles newCards deterministically with the seeded rng", () => {
        const cards = Array.from({ length: 6 }, () => makeCard([null, null]));
        const order1 = classifyPools(cards, today, RETRIEVABILITY, mulberry32(42)).newCards.map(l => l.card.fields.word);
        const order2 = classifyPools(cards, today, RETRIEVABILITY, mulberry32(42)).newCards.map(l => l.card.fields.word);
        expect(order1).toEqual(order2);
    });
});

// ---------------------------------------------------------------------------
// P4.2b — the New-face leak.
//
// get_retrievability returns exactly 0 for State.New, and 0 is the *most urgent*
// slot in an ascending sort. A New face reaching the due ranking would therefore
// silently jump the entire queue, ahead of genuinely forgotten cards. The pool
// split is supposed to prevent that; these assert it directly rather than trusting
// it, because the failure is invisible — no error, no type complaint, just a Learn
// session that quietly serves new words first.
// ---------------------------------------------------------------------------

describe("classifyPools — New faces never reach the due ranking", () => {
    const RETRIEVABILITY = retrievabilityFn();

    it("confirms the hazard is real: retrievability of a New face is exactly 0", () => {
        const newFace = sched("2026-01-10", 0, { state: State.New, lastReview: null });
        expect(RETRIEVABILITY(newFace, today)).toBe(0);
    });

    // A ScheduleInfo carrying State.New is not the same shape as a null schedule,
    // and only the null case is obvious. This is the one that could slip through.
    it("routes a card with an explicit State.New face into newCards, not a due pool", () => {
        const injected = makeCard([
            sched("2026-01-10", 0, { state: State.New, lastReview: null }),
            sched("2026-01-10", 30),
        ], { word: "injected" });
        const pools = classifyPools([injected], today, RETRIEVABILITY, mulberry32(1));
        expect(pools.newCards.map(l => l.card.fields.word)).toEqual(["injected"]);
        expect(pools.matureDue).toHaveLength(0);
        expect(pools.youngDue).toHaveLength(0);
    });

    it("no face in either due pool is New", () => {
        const cards = [
            makeCard([null, null], { word: "bothNull" }),
            makeCard([sched("2026-01-10", 0, { state: State.New, lastReview: null }),
                      sched("2026-01-10", 5)], { word: "oneNew" }),
            makeCard([sched("2026-01-10", 5), sched("2026-01-10", 5)], { word: "young" }),
            makeCard([sched("2026-01-10", 40), sched("2026-01-10", 40)], { word: "mature" }),
        ];
        const pools = classifyPools(cards, today, RETRIEVABILITY, mulberry32(1));
        for (const loc of [...pools.matureDue, ...pools.youngDue]) {
            for (const schedule of loc.card.schedules) {
                expect(schedule).not.toBeNull();
                expect(schedule!.state).not.toBe(State.New);
            }
        }
        expect(pools.youngDue.map(l => l.card.fields.word)).toEqual(["young"]);
        expect(pools.matureDue.map(l => l.card.fields.word)).toEqual(["mature"]);
    });

    // The deliberate injection the plan asks for: even if a New face somehow
    // reached the ranking, it must not outrank a genuinely-forgotten card. The
    // ranking skips New faces rather than scoring them, so a card whose *other*
    // face is well known ranks on that face alone.
    it("a deliberately injected New face does not outrank a forgotten card", () => {
        const withNewFace = makeCard([
            sched("2026-01-10", 0, { state: State.New, lastReview: null }),
            // Solid, seen recently: high retrievability.
            sched("2026-01-14", 200, { lastReview: new Date(2026, 0, 13) }),
        ], { word: "hasNewFace" });
        const forgotten = makeCard([
            sched("2026-01-01", 3, { lastReview: new Date(2025, 11, 1) }),
            sched("2026-01-01", 3, { lastReview: new Date(2025, 11, 1) }),
        ], { word: "forgotten" });

        // Ranked head to head by feeding both through the due path. `withNewFace`
        // is routed to newCards by classifyPools, so assert on the ranking
        // quantity itself: its non-new face must score far above the forgotten
        // card, i.e. it is NOT more urgent.
        const rNewCardsOtherFace = RETRIEVABILITY(withNewFace.card.schedules[1]!, today);
        const rForgotten = RETRIEVABILITY(forgotten.card.schedules[0]!, today);
        expect(rForgotten).toBeLessThan(rNewCardsOtherFace);

        const pools = classifyPools([withNewFace, forgotten], today, RETRIEVABILITY, mulberry32(1));
        expect(pools.newCards.map(l => l.card.fields.word)).toEqual(["hasNewFace"]);
        expect(pools.youngDue.map(l => l.card.fields.word)).toEqual(["forgotten"]);
    });
});
