import { describe, expect, it } from "vitest";
import { mulberry32 } from "src/utils/rng";
import { classifyPools } from "src/learn/pool";
import { LearnSession } from "src/learn/session";
import type { FaceAnswer, LearnStep } from "src/learn/session";
import { makeCard, retrievabilityFn, sched } from "src/learn/test-helpers";
import { DEFAULT_SETTINGS } from "src/settings";
import { FsrsEngine, ratingFor, toCard, toScheduleInfo } from "src/scheduling/fsrs";
import { ReviewResponse } from "src/scheduling/review-response";
import type { LearnSentenceSide } from "src/settings";

const TODAY = new Date("2026-01-15T00:00:00Z");
const RETRIEVABILITY = retrievabilityFn();

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
        const pools = classifyPools(cards, TODAY, RETRIEVABILITY, rng);
        const session = new LearnSession(pools, {
            groupLimit: 1,
            wordCount: 1,
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
        const pools = classifyPools(cards, TODAY, RETRIEVABILITY, rng);
        const session = new LearnSession(pools, {
            groupLimit: 1,
            wordCount: 1,
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
        const pools2 = classifyPools(cards, TODAY, RETRIEVABILITY, mulberry32(7));
        const session2 = new LearnSession(pools2, {
            groupLimit: 1,
            wordCount: 1,
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

    // Regression, P1.1. writtenFaces used to be keyed by
    // `${filePath}|${card.startLine}|${faceIndex}`. Writing a card shifts the
    // startLine of every card below it in the same file (shiftLocationsForDelta
    // mutates ParsedCard.startLine in place), so the key of an already-written
    // face moved and the gate failed open — the face could be written twice in
    // one session. Keying on ParsedCard identity is immune to the shift.
    it("the write gate survives a startLine shift on an already-written face", () => {
        // Eight cards so the group cannot complete on a single answer; a
        // completed group nulls out this.group and would pass vacuously.
        const cards = newCards(8, "s");
        const rng = mulberry32(3);
        const pools = classifyPools(cards, TODAY, RETRIEVABILITY, rng);
        const session = new LearnSession(pools, {
            groupLimit: 1,
            wordCount: 1,
            today: TODAY,
            rng,
        });
        session.start();

        const first = session.nextStep();
        expect(first.kind).toBe("face");
        if (first.kind !== "face") return;
        const item = first.item;

        const firstOutcome = session.submitFaceAnswer(item, "Good");
        expect(firstOutcome.writeIntent).not.toBeNull();
        session.confirmWritten(item);
        expect(firstOutcome.groupCompleted).toBe(false);

        // A write to a card above this one in the same file adds lines, and the
        // line-delta machinery walks every later card's location forward.
        item.card.startLine += 4;
        item.card.endLine += 4;

        // The same face, answered again after the shift, must not write again.
        const secondOutcome = session.submitFaceAnswer(item, "Good");
        expect(secondOutcome.writeIntent).toBeNull();
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
        const pools = classifyPools(all, TODAY, RETRIEVABILITY, rng);
        const session = new LearnSession(pools, {
            groupLimit: 2,
            wordCount: 1,
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
                // B2: the re-drill is answered with the ordinary buttons. It
                // clears the face and writes nothing, because Again already did.
                session.submitFaceAnswer(item, "Good");
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
        return new LearnSession(classifyPools(cards, TODAY, RETRIEVABILITY, rng), {
            groupLimit,
            wordCount: 1,
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
        const pools = classifyPools([...newCards(8, "r"), ...anchors], TODAY, RETRIEVABILITY, mulberry32(3));
        expect(pools.matureAnchors).toHaveLength(16);
        expect(limitFor([...newCards(8, "r"), ...anchors], 3)).toBe(1);
    });

    it("is never recomputed mid-session as pools drain", () => {
        const cards = newCards(10, "c");
        const rng = mulberry32(5);
        const session = new LearnSession(classifyPools(cards, TODAY, RETRIEVABILITY, rng), {
            groupLimit: 3,
            wordCount: 1,
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
        const session = new LearnSession(classifyPools(cards, TODAY, RETRIEVABILITY, rng), {
            groupLimit: 3,
            wordCount: 1,
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
            if (step.isPostAgain) return "Good";
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
        expect(session.nextStep().kind).toBe("done");
    });

    it("cannot overflow when effectiveLimit equals the configured limit", () => {
        // 40 cards fund 5 groups, configured 2 → no headroom for a third
        // group no matter how many Agains land.
        const cards = newCards(40, "c");
        const rng = mulberry32(33);
        const session = new LearnSession(classifyPools(cards, TODAY, RETRIEVABILITY, rng), {
            groupLimit: 2,
            wordCount: 1,
            today: TODAY,
            rng,
        });
        session.start();
        expect(session.getGroupLimit()).toBe(2);

        const agains = new Map<string, number>();
        drain(session, step => {
            if (step.isPostAgain) return "Good";
            const word = step.item.card.fields.word;
            const n = agains.get(word) ?? 0;
            if (n >= 2) return "Good";
            agains.set(word, n + 1);
            return "Again";
        });

        expect(session.getGroupsCompleted()).toBe(2);
        expect(session.nextStep().kind).toBe("done");
    });
});

// Invariant 28. Learn is permanently bidirectional, so sentenceSide is the
// only face-direction control: Front/Back pin every draw, Default rolls one
// face per draw.
describe("LearnSession — sentenceSide override", () => {
    // Runs one group, collecting the faceIndex of every sentence draw
    // (initial plus `redraws` regenerations of each task).
    function collectSentenceFaces(opts: {
        sentenceSide?: LearnSentenceSide;
        seed: number;
        redraws: number;
    }): { faces: Set<0 | 1>; draws: number } {
        const rng = mulberry32(opts.seed);
        const session = new LearnSession(classifyPools(newCards(8, "s"), TODAY, RETRIEVABILITY, rng), {
            groupLimit: 1,
            wordCount: 2,
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

    it("pins every sentence draw to the front face", () => {
        const { faces, draws } = collectSentenceFaces({
            sentenceSide: "Front",
            seed: 41,
            redraws: 20,
        });
        expect(draws).toBeGreaterThan(0);
        expect([...faces]).toEqual([0]);
    });

    it("pins every sentence draw to the back face", () => {
        const { faces, draws } = collectSentenceFaces({
            sentenceSide: "Back",
            seed: 41,
            redraws: 20,
        });
        expect(draws).toBeGreaterThan(0);
        expect([...faces]).toEqual([1]);
    });

    it("keeps the per-draw roll when the override is Default", () => {
        for (const sentenceSide of ["Default", undefined] as const) {
            const { faces, draws } = collectSentenceFaces({
                sentenceSide,
                seed: 41,
                redraws: 40,
            });
            expect(draws).toBeGreaterThan(0);
            expect([...faces].sort()).toEqual([0, 1]);
        }
    });
});

describe("LearnSession — anchor sampling", () => {
    // Nine new cards force two groups; the semi-mature card is anchor material
    // and also youngFiller, so the second group may study it.
    function anchorSession(): { session: LearnSession; semiWord: string } {
        const semi = makeCard([sched("2026-02-15", 14), sched("2026-02-20", 16)], { word: "semi" });
        const cards = [...newCards(9, "n"), semi];
        const rng = mulberry32(5);
        const pools = classifyPools(cards, TODAY, RETRIEVABILITY, rng);
        expect(pools.matureAnchors).toHaveLength(1);
        const session = new LearnSession(pools, {
            groupLimit: 2,
            wordCount: 2,
            today: TODAY,
            rng,
        });
        session.start();
        return { session, semiWord: semi.card.fields.word };
    }

    it("never draws a card as an anchor once the session has studied it", () => {
        const { session, semiWord } = anchorSession();
        const studied = new Set<string>();
        const violations: string[] = [];
        drain(
            session,
            () => "Good",
            step => {
                if (step.kind === "face") studied.add(step.item.card.fields.word);
                if (step.kind === "sentence") {
                    for (const w of step.words) {
                        if (w.isAnchor && studied.has(w.card.fields.word)) {
                            violations.push(w.card.fields.word);
                        }
                    }
                }
            },
        );
        expect(studied.size).toBeGreaterThan(0);
        expect(studied.has(semiWord)).toBe(true);
        expect(violations).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// P4.5 / §B2 — the rating contract.
//
// "The first answer on a face writes. Nothing else in that session does."
// Again is no longer the exception it was under SM-2: it writes Rating.Again
// immediately, and the reshuffle that follows is pure drill.
// ---------------------------------------------------------------------------

describe("B2 rating contract", () => {
    // One new card, one group, so the queue is exactly two faces.
    function oneCardSession(): { session: LearnSession; word: string } {
        const cards = [makeCard([null, null], { word: "solo" })];
        const rng = mulberry32(5);
        const session = new LearnSession(
            classifyPools(cards, TODAY, RETRIEVABILITY, rng),
            { groupLimit: 1, wordCount: 1, today: TODAY, rng },
        );
        session.start();
        return { session, word: "solo" };
    }

    it("Again produces a write intent, and it is Rating.Again's response", () => {
        const { session } = oneCardSession();
        const step = session.nextStep();
        if (step.kind !== "face") throw new Error("expected a face");
        const outcome = session.submitFaceAnswer(step.item, "Again");
        expect(outcome.writeIntent).not.toBeNull();
        expect(outcome.writeIntent!.response).toBe(ReviewResponse.Again);
    });

    // The whole point of the contract: the re-drill must not write a second time.
    it("the post-Again re-drill writes nothing", () => {
        const { session } = oneCardSession();
        const first = session.nextStep();
        if (first.kind !== "face") throw new Error("expected a face");
        const face = first.item;

        const again = session.submitFaceAnswer(face, "Again");
        expect(again.writeIntent).not.toBeNull();
        // The modal confirms after a successful vault write.
        session.confirmWritten(face);

        // Drain until that same face comes back around as the re-drill.
        let redrillIntents = 0;
        let sawRedrill = false;
        for (let guard = 0; guard < 50; guard++) {
            const step = session.nextStep();
            if (step.kind === "done") break;
            if (step.kind === "sentence") { session.dismissSentence(); continue; }
            const isSameFace =
                step.item.card === face.card && step.item.faceIndex === face.faceIndex;
            if (isSameFace) {
                expect(step.isPostAgain).toBe(true);
                sawRedrill = true;
            }
            const outcome = session.submitFaceAnswer(step.item, "Good");
            if (isSameFace && outcome.writeIntent !== null) redrillIntents++;
            if (outcome.writeIntent !== null) session.confirmWritten(step.item);
        }
        expect(sawRedrill).toBe(true);
        expect(redrillIntents).toBe(0);
    });

    it("writes each face exactly once across a full session, however it is answered", () => {
        // Every face is failed once and then cleared, so each one is answered at
        // least twice. Exactly one write per face must come out of that.
        const rng = mulberry32(21);
        const session = new LearnSession(
            classifyPools(newCards(8, "c"), TODAY, RETRIEVABILITY, rng),
            { groupLimit: 1, wordCount: 1, today: TODAY, rng },
        );
        session.start();

        const writes = new Map<string, number>();
        const failed = new Set<string>();
        for (let guard = 0; guard < 500; guard++) {
            const step = session.nextStep();
            if (step.kind === "done") break;
            if (step.kind === "sentence") { session.dismissSentence(); continue; }
            const key = step.item.card.fields.word + ":" + step.item.faceIndex;
            const answer: FaceAnswer = failed.has(key) ? "Good" : "Again";
            failed.add(key);
            const outcome = session.submitFaceAnswer(step.item, answer);
            if (outcome.writeIntent !== null) {
                writes.set(key, (writes.get(key) ?? 0) + 1);
                session.confirmWritten(step.item);
            }
        }

        expect(writes.size).toBe(16);                      // 8 cards x 2 faces
        for (const [key, count] of writes) {
            expect(count, `face ${key} was written ${count} times`).toBe(1);
        }
    });

    // Phase 4's exit criterion couples two layers: the session must emit one
    // write intent for Again, and that intent must land as an FSRS lapse. Neither
    // test alone proves it, so this composes them the way the modal does.
    //
    // ⚠️ Checked against a *learned* card on purpose. FSRS does not count a failed
    // New card as a lapse — Again on State.New gives lapses: 0 — so running this
    // on a new card would fail for entirely the wrong reason.
    it("an Again intent on a learned card lands as an FSRS lapse", () => {
        const learned = sched("2026-01-10", 20, { reps: 6, lapses: 2 });
        const cards = [makeCard([learned, sched("2026-01-10", 20, { reps: 6, lapses: 2 })])];
        const rng = mulberry32(3);
        const session = new LearnSession(
            classifyPools(cards, TODAY, RETRIEVABILITY, rng),
            { groupLimit: 1, wordCount: 1, today: TODAY, rng },
        );
        session.start();

        const step = session.nextStep();
        if (step.kind !== "face") throw new Error("expected a face");
        const outcome = session.submitFaceAnswer(step.item, "Again");
        expect(outcome.writeIntent).not.toBeNull();

        // What the modal does with that intent.
        const before = step.item.card.schedules[step.item.faceIndex]!;
        const engine = new FsrsEngine(DEFAULT_SETTINGS);
        const after = toScheduleInfo(engine.schedule(
            toCard(before, TODAY), ratingFor(outcome.writeIntent!.response), TODAY,
        ));

        expect(after.lapses).toBe(before.lapses + 1);
        // B2: lapse severity is FSRS's stability floor, not a collapse to one day.
        expect(after.stability).toBeLessThan(before.stability);
        expect(after.stability).toBeGreaterThan(0);
    });

    // B2's preview rule is driven off this predicate, so it has to agree with
    // the write path exactly.
    it("willWrite goes false once a face has been written", () => {
        const { session } = oneCardSession();
        const step = session.nextStep();
        if (step.kind !== "face") throw new Error("expected a face");
        expect(session.willWrite(step.item)).toBe(true);
        session.submitFaceAnswer(step.item, "Again");
        session.confirmWritten(step.item);
        expect(session.willWrite(step.item)).toBe(false);
    });

    it("willWrite is false for a face the session may not write at all", () => {
        // Face 1 is not due, so it is drilled but never written (invariant 22).
        const cards = [makeCard([sched("2026-01-10", 5), sched("2030-01-01", 30)])];
        const rng = mulberry32(9);
        const session = new LearnSession(
            classifyPools(cards, TODAY, RETRIEVABILITY, rng),
            { groupLimit: 1, wordCount: 1, today: TODAY, rng },
        );
        session.start();
        for (let guard = 0; guard < 20; guard++) {
            const step = session.nextStep();
            if (step.kind !== "face") break;
            if (step.item.faceIndex === 1) {
                expect(step.item.writeEligible).toBe(false);
                expect(session.willWrite(step.item)).toBe(false);
            }
            session.submitFaceAnswer(step.item, "Good");
        }
    });
});
