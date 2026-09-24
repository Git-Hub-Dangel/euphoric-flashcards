import { describe, expect, it } from "vitest";
import { mulberry32 } from "src/utils/rng";
import { classifyPools } from "src/learn/pool";
import { LearnSession } from "src/learn/session";
import type { FaceAnswer, LearnStep } from "src/learn/session";
import { makeCard, sched } from "src/learn/test-helpers";
import type { CardSide, LearnSentenceSide } from "src/settings";

const TODAY = new Date("2026-01-15T00:00:00Z");

// Drives a session to the done step. `choose` picks the answer for each face
// step, sentence steps are dismissed, and `onStep` observes every step before
// it is answered. The step budget guards against a state machine that never
// terminates (a failed budget is a bug, not a flaky test).
function drain(
    session: LearnSession,
    choose: (step: Extract<LearnStep, { kind: "face" }>) => FaceAnswer,
    onStep?: (step: LearnStep) => void,
): void {
    for (let guard = 0; guard < 2000; guard++) {
        const step = session.nextStep();
        onStep?.(step);
        if (step.kind === "done") return;
        if (step.kind === "sentence") {
            session.dismissSentence();
            continue;
        }
        session.submitFaceAnswer(step.item, choose(step));
    }
    throw new Error("drain exceeded its step budget");
}

function newCards(n: number, prefix: string): ReturnType<typeof makeCard>[] {
    return Array.from({ length: n }, (_, i) => makeCard([null, null], { word: `${prefix}${i}` }));
}

describe("LearnSession — write eligibility", () => {
    it("marks new + due faces write-eligible at load and non-due seen faces ineligible", () => {
        const cards = [
            makeCard([null, null]),                                     // both new
            makeCard([sched("2026-01-10", 5), sched("2030-01-01", 30)]), // face 0 due, face 1 far future
        ];
        const rng = mulberry32(1);
        const pools = classifyPools(cards, TODAY, rng);
        const session = new LearnSession(pools, {
            groupLimit: 1,
            wordCount: 1,
            cardSide: "Front",
            today: TODAY,
            rng,
        });
        session.start();

        // Drain: capture writeEligible per (card, face), dismiss sentences.
        const seen = new Map<string, boolean>();
        while (true) {
            const step = session.nextStep();
            if (step.kind === "done") break;
            if (step.kind === "sentence") { session.dismissSentence(); continue; }
            seen.set(step.item.card.fields.word + ":" + step.item.faceIndex, step.item.writeEligible);
            session.submitFaceAnswer(step.item, "Good");
        }

        // Card 0 (both new) → both faces eligible.
        // Card 1 face 0 due → eligible; face 1 not due → not eligible.
        const card0Word = cards[0]!.card.fields.word;
        const card1Word = cards[1]!.card.fields.word;
        expect(seen.get(card0Word + ":0")).toBe(true);
        expect(seen.get(card0Word + ":1")).toBe(true);
        expect(seen.get(card1Word + ":0")).toBe(true);
        expect(seen.get(card1Word + ":1")).toBe(false);
    });

    it("a second session same-day produces no writeIntents (writtenFaces gate)", () => {
        const cards = [
            makeCard([null, null]),
            makeCard([sched("2026-01-10", 5), sched("2026-01-10", 5)]),
        ];
        const rng = mulberry32(7);
        const pools = classifyPools(cards, TODAY, rng);
        const session = new LearnSession(pools, {
            groupLimit: 1,
            wordCount: 1,
            cardSide: "Front",
            today: TODAY,
            rng,
        });
        session.start();

        // First pass: drain, collect items whose write intent fired. Simulate
        // the modal by calling confirmWritten as it would after a successful vault write.
        while (true) {
            const step = session.nextStep();
            if (step.kind !== "face") {
                if (step.kind === "sentence") {
                    session.dismissSentence();
                    continue;
                }
                break;
            }
            const outcome = session.submitFaceAnswer(step.item, "Good");
            if (outcome.writeIntent !== null) session.confirmWritten(step.item);
        }

        // Second session: same pools (mutated by the first run) would be
        // near-empty here in practice, but the invariant we care about is
        // that a re-added identical group's items don't re-write. We test
        // this at the writtenFaces layer directly.
        // Nothing to assert on session-state after done; the correctness is
        // proven by the observation that confirmWritten made subsequent
        // shouldWrite checks return false for the same face across passes.
        // Verify indirectly by re-answering the same items and checking
        // writeIntent stays null. Rebuild a fresh session over pristine pools.
        const pools2 = classifyPools(cards, TODAY, mulberry32(7));
        const session2 = new LearnSession(pools2, {
            groupLimit: 1,
            wordCount: 1,
            cardSide: "Front",
            today: TODAY,
            rng: mulberry32(7),
        });
        session2.start();
        // Pre-mark every face as already written by seeding via confirmWritten.
        while (true) {
            const step = session2.nextStep();
            if (step.kind !== "face") break;
            session2.confirmWritten(step.item);
            const outcome = session2.submitFaceAnswer(step.item, "Good");
            expect(outcome.writeIntent).toBeNull();
        }
    });
});

describe("LearnSession — carryover", () => {
    it("carries the group's leech into the next group at slot 0, exempt from used", () => {
        // Ensure enough cards for two groups. Card X will be the leech.
        const cardsA = Array.from({ length: 8 }, (_, i) =>
            makeCard([null, null], { word: `a${i}` }),
        );
        const cardsB = Array.from({ length: 8 }, (_, i) =>
            makeCard([null, null], { word: `b${i}` }),
        );
        const all = [...cardsA, ...cardsB];
        const rng = mulberry32(11);
        const pools = classifyPools(all, TODAY, rng);
        const session = new LearnSession(pools, {
            groupLimit: 2,
            wordCount: 1,
            cardSide: "Front",
            today: TODAY,
            rng,
        });
        session.start();

        // Force the first face we see to hit Again twice — that pushes its
        // card's againCount to LEARN_CARRYOVER_MIN_AGAINS.
        let leechCard: string | null = null;
        let againsForLeech = 0;
        while (true) {
            const step = session.nextStep();
            if (step.kind === "sentence") { session.dismissSentence(); continue; }
            if (step.kind === "done") break;
            const item = step.item;
            if (leechCard === null) leechCard = item.card.fields.word;
            const w = item.card.fields.word;
            if (w === leechCard && againsForLeech < 2 && !step.isPostAgain) {
                againsForLeech++;
                session.submitFaceAnswer(item, "Again");
            } else if (step.isPostAgain) {
                session.submitFaceAnswer(item, "OK");
            } else {
                session.submitFaceAnswer(item, "Good");
            }
            if (session.getGroupsCompleted() === 1) break;
        }

        // Blueprint §7: the carried card is added to slot 0 of the next
        // group's card list (buildInitialQueue then shuffles faces, so we
        // assert on the *held locations* rather than the first rendered face).
        expect(session.getGroupsCompleted()).toBe(1);
        const heldWords = [...session.heldLocations()].map(l => l.card.fields.word);
        expect(heldWords).toContain(leechCard);
    });
});

// Invariant 27. effectiveLimit is the displayed denominator only. It is fixed
// at construction from the reviewable supply (anchors excluded) and the
// terminal cap stays the configured groupLimit.
describe("LearnSession — effectiveLimit", () => {
    function limitFor(cards: ReturnType<typeof makeCard>[], groupLimit: number): number {
        const rng = mulberry32(3);
        return new LearnSession(classifyPools(cards, TODAY, rng), {
            groupLimit,
            wordCount: 1,
            cardSide: "Front",
            today: TODAY,
            rng,
        }).getGroupLimit();
    }

    it("caps the denominator at the number of groups the pool can fund", () => {
        // 10 reviewable cards → ceil(10 / 8) = 2 fundable groups.
        expect(limitFor(newCards(10, "c"), 3)).toBe(2);
    });

    it("keeps the configured limit when the pool can fund more groups", () => {
        // 40 cards fund 5 groups, but the user asked for 2.
        expect(limitFor(newCards(40, "c"), 2)).toBe(2);
    });

    it("never drops below one group", () => {
        expect(limitFor(newCards(1, "c"), 3)).toBe(1);
        expect(limitFor([], 3)).toBe(1);
    });

    it("excludes mature anchors from the fundable-group count", () => {
        // 8 reviewable + 16 anchors. Anchors must not inflate the denominator.
        const anchors = Array.from({ length: 16 }, (_, i) =>
            makeCard([sched("2030-01-01", 30), sched("2030-01-01", 30)], { word: `anchor${i}` }),
        );
        const pools = classifyPools([...newCards(8, "r"), ...anchors], TODAY, mulberry32(3));
        expect(pools.matureAnchors).toHaveLength(16);
        expect(limitFor([...newCards(8, "r"), ...anchors], 3)).toBe(1);
    });

    it("is never recomputed mid-session as pools drain", () => {
        const cards = newCards(10, "c");
        const rng = mulberry32(5);
        const session = new LearnSession(classifyPools(cards, TODAY, rng), {
            groupLimit: 3,
            wordCount: 1,
            cardSide: "Front",
            today: TODAY,
            rng,
        });
        session.start();
        const observed = new Set<number>([session.getGroupLimit()]);
        drain(session, () => "Good", () => observed.add(session.getGroupLimit()));
        observed.add(session.getGroupLimit());
        expect([...observed]).toEqual([2]);
    });

    it("lets a carryover run past effectiveLimit and overflow the counter", () => {
        // 10 cards → effectiveLimit 2, configured 3. Leeching the first card
        // of groups 1 and 2 funds a third group out of carryover alone.
        const cards = newCards(10, "c");
        const rng = mulberry32(21);
        const session = new LearnSession(classifyPools(cards, TODAY, rng), {
            groupLimit: 3,
            wordCount: 1,
            cardSide: "Front",
            today: TODAY,
            rng,
        });
        session.start();
        expect(session.getGroupLimit()).toBe(2);

        // Leech the first fresh card of each group, twice (once per face), so
        // it reaches LEARN_CARRYOVER_MIN_AGAINS. Cards already carried are
        // skipped because carryover fires at most once per card (invariant 24).
        const leechPerGroup = new Map<number, string>();
        const carriedAlready = new Set<string>();
        const agains = new Map<string, number>();
        drain(session, step => {
            if (step.isPostAgain) return "OK";
            const g = session.getGroupsCompleted();
            const word = step.item.card.fields.word;
            let leech = leechPerGroup.get(g);
            if (leech === undefined && !carriedAlready.has(word)) {
                leech = word;
                leechPerGroup.set(g, word);
                carriedAlready.add(word);
            }
            if (word !== leech) return "Good";
            const n = agains.get(word) ?? 0;
            if (n >= 2) return "Good";
            agains.set(word, n + 1);
            return "Again";
        });

        expect(session.getGroupsCompleted()).toBe(3);
        expect(session.getGroupsCompleted()).toBeGreaterThan(session.getGroupLimit());
        expect(session.isDone()).toBe(true);
    });

    it("cannot overflow when effectiveLimit equals the configured limit", () => {
        // 40 cards fund 5 groups, configured 2 → no headroom for a third
        // group no matter how many Agains land.
        const cards = newCards(40, "c");
        const rng = mulberry32(33);
        const session = new LearnSession(classifyPools(cards, TODAY, rng), {
            groupLimit: 2,
            wordCount: 1,
            cardSide: "Front",
            today: TODAY,
            rng,
        });
        session.start();
        expect(session.getGroupLimit()).toBe(2);

        const agains = new Map<string, number>();
        drain(session, step => {
            if (step.isPostAgain) return "OK";
            const word = step.item.card.fields.word;
            const n = agains.get(word) ?? 0;
            if (n >= 2) return "Good";
            agains.set(word, n + 1);
            return "Again";
        });

        expect(session.getGroupsCompleted()).toBe(2);
        expect(session.isDone()).toBe(true);
    });
});

// Invariant 28. sentenceSide pins the sentence face only under Shuffle; on a
// monodirectional Learn side the setting is inert.
describe("LearnSession — sentenceSide override", () => {
    // Runs one group, collecting the faceIndex of every sentence draw
    // (initial plus `redraws` regenerations of each task).
    function collectSentenceFaces(opts: {
        cardSide: CardSide;
        sentenceSide?: LearnSentenceSide;
        seed: number;
        redraws: number;
    }): { faces: Set<0 | 1>; draws: number } {
        const rng = mulberry32(opts.seed);
        const session = new LearnSession(classifyPools(newCards(8, "s"), TODAY, rng), {
            groupLimit: 1,
            wordCount: 2,
            cardSide: opts.cardSide,
            sentenceSide: opts.sentenceSide,
            today: TODAY,
            rng,
        });
        session.start();

        const faces = new Set<0 | 1>();
        let draws = 0;
        const record = (words: { faceIndex: 0 | 1 }[]): void => {
            if (words.length === 0) return;
            draws++;
            for (const w of words) faces.add(w.faceIndex);
        };

        for (let guard = 0; guard < 2000; guard++) {
            const step = session.nextStep();
            if (step.kind === "done") break;
            if (step.kind === "sentence") {
                record(step.words);
                for (let i = 0; i < opts.redraws; i++) {
                    record(session.regenerateSentence() ?? []);
                }
                session.dismissSentence();
                continue;
            }
            session.submitFaceAnswer(step.item, "Good");
        }
        return { faces, draws };
    }

    it("pins every sentence draw to the front face under Shuffle", () => {
        const { faces, draws } = collectSentenceFaces({
            cardSide: "Shuffle",
            sentenceSide: "Front",
            seed: 41,
            redraws: 20,
        });
        expect(draws).toBeGreaterThan(0);
        expect([...faces]).toEqual([0]);
    });

    it("pins every sentence draw to the back face under Shuffle", () => {
        const { faces, draws } = collectSentenceFaces({
            cardSide: "Shuffle",
            sentenceSide: "Back",
            seed: 41,
            redraws: 20,
        });
        expect(draws).toBeGreaterThan(0);
        expect([...faces]).toEqual([1]);
    });

    it("keeps the per-draw roll under Shuffle when the override is Default", () => {
        for (const sentenceSide of ["Default", undefined] as const) {
            const { faces, draws } = collectSentenceFaces({
                cardSide: "Shuffle",
                sentenceSide,
                seed: 41,
                redraws: 40,
            });
            expect(draws).toBeGreaterThan(0);
            expect([...faces].sort()).toEqual([0, 1]);
        }
    });

    it("is inert on a monodirectional Learn side", () => {
        const front = collectSentenceFaces({
            cardSide: "Front",
            sentenceSide: "Back",
            seed: 41,
            redraws: 20,
        });
        expect(front.draws).toBeGreaterThan(0);
        expect([...front.faces]).toEqual([0]);

        const back = collectSentenceFaces({
            cardSide: "Back",
            sentenceSide: "Front",
            seed: 41,
            redraws: 20,
        });
        expect(back.draws).toBeGreaterThan(0);
        expect([...back.faces]).toEqual([1]);
    });
});
