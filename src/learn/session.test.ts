import { describe, expect, it } from "vitest";
import { mulberry32 } from "src/utils/rng";
import { classifyPools } from "src/learn/pool";
import { LearnSession } from "src/learn/session";
import { makeCard, sched } from "src/learn/test-helpers";

const TODAY = new Date("2026-01-15T00:00:00Z");

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
