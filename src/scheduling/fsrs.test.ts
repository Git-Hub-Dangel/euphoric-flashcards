import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, REQUEST_RETENTION_MAX, REQUEST_RETENTION_MIN } from "src/settings";
import type { EuphoricSettings } from "src/settings";
import {
    buildFsrsParameters,
    diffInDays,
    emptyCard,
    FSRS_GRADES,
    FsrsEngine,
    fsrsDefaultWeights,
    Rating,
    ratingFor,
    scheduledDays,
    State,
    S_MAX,
    S_MIN,
    toCard,
    toScheduleInfo,
} from "src/scheduling/fsrs";
import type { Card, Grade, ScheduleInfo } from "src/scheduling/fsrs";
import { ReviewResponse } from "src/scheduling/review-response";

const NOW = new Date("2026-01-15T10:00:00Z");

function settings(overrides: Partial<EuphoricSettings> = {}): EuphoricSettings {
    return { ...DEFAULT_SETTINGS, ...overrides };
}

function engine(overrides: Partial<EuphoricSettings> = {}): FsrsEngine {
    return new FsrsEngine(settings(overrides));
}

function addDays(d: Date, days: number): Date {
    return new Date(d.valueOf() + days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Parameter construction (§B1)
// ---------------------------------------------------------------------------

describe("buildFsrsParameters — locked parameters", () => {
    it("hardcodes the four non-negotiable parameters", () => {
        const p = buildFsrsParameters(settings());
        expect(p.enable_short_term).toBe(false);
        expect(p.enable_fuzz).toBe(false);
        expect(p.learning_steps).toEqual([]);
        expect(p.relearning_steps).toEqual([]);
    });

    it("takes request_retention from settings", () => {
        expect(buildFsrsParameters(settings({ requestRetention: 0.85 })).request_retention).toBe(0.85);
    });

    it("maps maximum_interval 1:1 from the existing maximumInterval setting", () => {
        expect(buildFsrsParameters(settings({ maximumInterval: 365 })).maximum_interval).toBe(365);
        expect(buildFsrsParameters(settings({ maximumInterval: 36525 })).maximum_interval).toBe(36525);
    });

    it("uses the library's default weights, unmodified", () => {
        expect([...buildFsrsParameters(settings()).w]).toEqual([...fsrsDefaultWeights()]);
    });

    it("defaults request_retention to 0.9", () => {
        expect(DEFAULT_SETTINGS.requestRetention).toBe(0.9);
    });
});

describe("buildFsrsParameters — defensive clamping", () => {
    // A hand-edited data.json must not reach the scheduler with a value that
    // skews or throws.
    it.each([
        ["below range", 0.1, REQUEST_RETENTION_MIN],
        ["above range", 1.5, REQUEST_RETENTION_MAX],
        ["exactly min", REQUEST_RETENTION_MIN, REQUEST_RETENTION_MIN],
        ["exactly max", REQUEST_RETENTION_MAX, REQUEST_RETENTION_MAX],
    ])("clamps a request_retention %s", (_label, input, expected) => {
        expect(buildFsrsParameters(settings({ requestRetention: input })).request_retention).toBe(
            expected,
        );
    });

    it("falls back to the minimum for a non-finite request_retention", () => {
        expect(buildFsrsParameters(settings({ requestRetention: NaN })).request_retention).toBe(
            REQUEST_RETENTION_MIN,
        );
    });

    it("never produces a maximum_interval below 1", () => {
        expect(buildFsrsParameters(settings({ maximumInterval: 0 })).maximum_interval).toBe(1);
        expect(buildFsrsParameters(settings({ maximumInterval: -10 })).maximum_interval).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// emptyCard
// ---------------------------------------------------------------------------

describe("emptyCard", () => {
    it("is a New card with no history", () => {
        const c = emptyCard(NOW);
        expect(c.state).toBe(State.New);
        expect(c.stability).toBe(0);
        expect(c.difficulty).toBe(0);
        expect(c.reps).toBe(0);
        expect(c.lapses).toBe(0);
        expect(c.last_review).toBeUndefined();
        expect(c.due.valueOf()).toBe(NOW.valueOf());
    });
});

// ---------------------------------------------------------------------------
// The four ratings
// ---------------------------------------------------------------------------

describe("FSRS_GRADES", () => {
    it("is the four real grades in ascending quality, excluding Manual", () => {
        expect(FSRS_GRADES).toEqual([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]);
        expect(FSRS_GRADES).not.toContain(Rating.Manual);
    });
});

describe("FsrsEngine.schedule — the four ratings from a New card", () => {
    const e = engine();
    const base = emptyCard(NOW);

    it("produces a strictly increasing interval from Again to Easy", () => {
        const days = FSRS_GRADES.map((g) => e.schedule(base, g, NOW).scheduled_days);
        expect(days).toEqual([...days].sort((a, b) => a - b));
        expect(new Set(days).size).toBe(4);
        // Pin the shipped numbers so a weight or parameter change is visible in
        // the diff rather than silently rescheduling every user's cards.
        expect(days).toEqual([1, 2, 3, 8]);
    });

    it("produces strictly increasing stability from Again to Easy", () => {
        const s = FSRS_GRADES.map((g) => e.schedule(base, g, NOW).stability);
        expect(s).toEqual([...s].sort((a, b) => a - b));
    });

    it("produces decreasing difficulty as the grade improves", () => {
        const d = FSRS_GRADES.map((g) => e.schedule(base, g, NOW).difficulty);
        expect(d).toEqual([...d].sort((a, b) => b - a));
    });

    it("counts one rep for every grade", () => {
        for (const g of FSRS_GRADES) expect(e.schedule(base, g, NOW).reps).toBe(1);
    });

    it("sets last_review to the review instant", () => {
        for (const g of FSRS_GRADES) {
            expect(e.schedule(base, g, NOW).last_review?.valueOf()).toBe(NOW.valueOf());
        }
    });

    // FSRS does not count failing a New card as a lapse — a lapse is the loss of
    // something previously learned. Phase 4's "Again increments lapses" check
    // must therefore run against a Review card, not a fresh one.
    it("does not count a lapse for Again on a New card, but does on a learned one", () => {
        expect(e.schedule(base, Rating.Again, NOW).lapses).toBe(0);
        const learned = e.schedule(base, Rating.Good, NOW);
        expect(e.schedule(learned, Rating.Again, addDays(NOW, 3)).lapses).toBe(1);
    });

    // maximum_interval is a soft ceiling, not a hard one. LongTermScheduler
    // clamps each grade's interval to maximum_interval and *then* enforces
    // again < hard < good < easy by bumping each one past the previous, so once
    // the intervals saturate the higher grades step over the ceiling: Again
    // lands on it, Hard on +1, Good on +2, Easy on +3. We do not correct this —
    // flattening it would destroy the ordering the interval previews rely on.
    const MAX_INTERVAL_OVERSHOOT = 3;

    it("keeps Again at or below maximum_interval", () => {
        const capped = new FsrsEngine(settings({ maximumInterval: 5 }));
        let card = emptyCard(NOW);
        let t = NOW;
        for (let i = 0; i < 25; i++) {
            card = capped.schedule(card, Rating.Again, t);
            expect(card.scheduled_days).toBeLessThanOrEqual(5);
            t = new Date(card.due);
        }
    });

    it("keeps every grade within maximum_interval + 3", () => {
        const capped = new FsrsEngine(settings({ maximumInterval: 5 }));
        for (const g of FSRS_GRADES) {
            let card = emptyCard(NOW);
            let t = NOW;
            for (let i = 0; i < 25; i++) {
                card = capped.schedule(card, g, t);
                expect(card.scheduled_days).toBeLessThanOrEqual(5 + MAX_INTERVAL_OVERSHOOT);
                t = new Date(card.due);
            }
        }
    });

    // Pinned deliberately: if a future ts-fsrs changes how the ceiling and the
    // ordering interact, this is the test that says so out loud.
    it("documents the saturated overshoot exactly", () => {
        const capped = new FsrsEngine(settings({ maximumInterval: 5 }));
        // Drive stability high enough that all four grades saturate.
        let card = emptyCard(NOW);
        let t = NOW;
        for (let i = 0; i < 10; i++) {
            card = capped.schedule(card, Rating.Easy, t);
            t = new Date(card.due);
        }
        const saturated = capped.previewAll(card, t);
        expect(FSRS_GRADES.map((g) => saturated[g].scheduled_days)).toEqual([5, 6, 7, 8]);
    });

    it("lowers the interval when target retention is raised", () => {
        const lax = new FsrsEngine(settings({ requestRetention: 0.75 }));
        const strict = new FsrsEngine(settings({ requestRetention: 0.95 }));
        const seed = emptyCard(NOW);
        const laxCard = lax.schedule(lax.schedule(seed, Rating.Good, NOW), Rating.Good, addDays(NOW, 3));
        const strictCard = strict.schedule(
            strict.schedule(seed, Rating.Good, NOW),
            Rating.Good,
            addDays(NOW, 3),
        );
        expect(strictCard.scheduled_days).toBeLessThan(laxCard.scheduled_days);
    });
});

// ---------------------------------------------------------------------------
// previewAll
// ---------------------------------------------------------------------------

describe("FsrsEngine.previewAll", () => {
    const e = engine();

    it("returns an entry for each of the four grades", () => {
        const p = e.previewAll(emptyCard(NOW), NOW);
        for (const g of FSRS_GRADES) expect(p[g]).toBeDefined();
        expect(Object.keys(p)).toHaveLength(4);
    });

    // The whole point of the seam: the previewed interval and the written
    // interval must not be able to disagree.
    it("agrees exactly with schedule() for every grade", () => {
        const card = e.schedule(emptyCard(NOW), Rating.Good, NOW);
        const later = addDays(NOW, 5);
        const p = e.previewAll(card, later);
        for (const g of FSRS_GRADES) {
            expect(p[g]).toEqual(e.schedule(card, g, later));
        }
    });

    it("does not mutate the card it previews", () => {
        const card = emptyCard(NOW);
        const before = JSON.stringify(card);
        e.previewAll(card, NOW);
        expect(JSON.stringify(card)).toBe(before);
    });

    it("works on a New card and on a Review card alike", () => {
        const fresh = e.previewAll(emptyCard(NOW), NOW);
        const reviewed = e.previewAll(e.schedule(emptyCard(NOW), Rating.Good, NOW), addDays(NOW, 3));
        for (const g of FSRS_GRADES) {
            expect(fresh[g].scheduled_days).toBeGreaterThanOrEqual(1);
            expect(reviewed[g].scheduled_days).toBeGreaterThanOrEqual(1);
        }
    });
});

// ---------------------------------------------------------------------------
// retrievability
// ---------------------------------------------------------------------------

describe("FsrsEngine.retrievability", () => {
    const e = engine();

    // Load-bearing for the Learn due ranking (plan P4.2 / P4.2b): New cards
    // score 0, which is the *most urgent* end of an ascending sort. Anything
    // that feeds New faces into that ranking silently prioritises them.
    it("returns exactly 0 for a New card", () => {
        expect(e.retrievability(emptyCard(NOW), NOW)).toBe(0);
    });

    it("returns a value in [0, 1] for a reviewed card", () => {
        const card = e.schedule(emptyCard(NOW), Rating.Good, NOW);
        const r = e.retrievability(card, addDays(NOW, 1));
        expect(r).toBeGreaterThan(0);
        expect(r).toBeLessThanOrEqual(1);
    });

    it("decays monotonically as a card goes longer without review", () => {
        const card = e.schedule(emptyCard(NOW), Rating.Good, NOW);
        const samples = [0, 1, 2, 5, 10, 30, 100].map((d) =>
            e.retrievability(card, addDays(NOW, d)),
        );
        for (let i = 1; i < samples.length; i++) {
            expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
        }
        expect(samples[samples.length - 1]!).toBeLessThan(samples[0]!);
    });

    it("scores a more stable card higher than a shakier one at the same elapsed time", () => {
        const shaky = e.schedule(emptyCard(NOW), Rating.Hard, NOW);
        const solid = e.schedule(emptyCard(NOW), Rating.Easy, NOW);
        const at = addDays(NOW, 4);
        expect(e.retrievability(solid, at)).toBeGreaterThan(e.retrievability(shaky, at));
    });

    // ts-fsrs floors elapsed time to whole days, and it measures from the
    // last_review *instant*, not from a calendar boundary. Two reads inside the
    // same 24-hour window after last_review therefore return the identical
    // value, so cards reviewed in the same sitting tie in the Learn ranking and
    // the difficulty tie-break is load-bearing, not incidental.
    it("ties for any two instants within the same 24h window after last_review", () => {
        // last_review is NOW = 10:00 on the 15th, so bucket 0 runs to 10:00 on
        // the 16th — note that it straddles midnight.
        const card = e.schedule(emptyCard(NOW), Rating.Good, NOW);
        const justAfter = e.retrievability(card, new Date("2026-01-15T10:30:00Z"));
        const pastMidnight = e.retrievability(card, new Date("2026-01-16T09:30:00Z"));
        expect(pastMidnight).toBe(justAfter);

        // Crossing the 24h mark from last_review does move it.
        const nextBucket = e.retrievability(card, new Date("2026-01-16T10:30:00Z"));
        expect(nextBucket).toBeLessThan(justAfter);
    });

    it("never exceeds 1 when a card is reviewed ahead of its due date", () => {
        const card = e.schedule(emptyCard(NOW), Rating.Good, NOW);
        expect(e.retrievability(card, NOW)).toBeLessThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// The enable_short_term: false contract (§B1)
// ---------------------------------------------------------------------------

describe("enable_short_term: false — the contract the rest of the plugin relies on", () => {
    const e = engine();

    // Exhaustive over a long mixed walk rather than a couple of spot checks:
    // this is the guarantee that lets day granularity, textInterval and the
    // seven-field comment format survive, so it is worth proving broadly.
    function walk(grades: readonly Grade[], steps: number): Card[] {
        const seen: Card[] = [];
        let card = emptyCard(NOW);
        let t = NOW;
        for (let i = 0; i < steps; i++) {
            const g = grades[i % grades.length]!;
            card = e.schedule(card, g, t);
            seen.push(card);
            t = new Date(card.due);
        }
        return seen;
    }

    it("never yields State.Learning or State.Relearning", () => {
        for (const card of walk(FSRS_GRADES, 400)) {
            expect(card.state).not.toBe(State.Learning);
            expect(card.state).not.toBe(State.Relearning);
        }
    });

    it("puts every outcome from a New card into State.Review, Again included", () => {
        const base = emptyCard(NOW);
        for (const g of FSRS_GRADES) {
            expect(e.schedule(base, g, NOW).state).toBe(State.Review);
        }
    });

    it("never yields scheduled_days < 1", () => {
        for (const card of walk(FSRS_GRADES, 400)) {
            expect(card.scheduled_days).toBeGreaterThanOrEqual(1);
        }
    });

    it("holds scheduled_days >= 1 through a long chain of consecutive Again", () => {
        for (const card of walk([Rating.Again], 40)) {
            expect(card.scheduled_days).toBeGreaterThanOrEqual(1);
            expect(card.state).toBe(State.Review);
        }
    });

    it("holds scheduled_days >= 1 when Again repeats at the same instant", () => {
        let card = emptyCard(NOW);
        for (let i = 0; i < 10; i++) {
            card = e.schedule(card, Rating.Again, NOW);
            expect(card.scheduled_days).toBeGreaterThanOrEqual(1);
            expect(card.state).toBe(State.Review);
        }
    });

    it("keeps learning_steps at 0, so the field never needs persisting", () => {
        for (const card of walk(FSRS_GRADES, 60)) {
            expect(card.learning_steps).toBe(0);
        }
    });

    // There is no stability floor under enable_short_term: false. Stability decays
    // monotonically toward zero (measured 2.3065 to 0.00106 over 40 consecutive
    // Again, no asymptote). The thing that actually keeps a lapse usable is
    // scheduled_days >= 1, asserted here and above. Do not replace this with an
    // assertion that stability stays above some bound, and do not remove the
    // interval clamp elsewhere on the belief that the engine floors stability.
    it("decays stability monotonically on repeated failure while holding the interval at a day", () => {
        const chain = walk([Rating.Again], 40);
        for (let i = 1; i < chain.length; i++) {
            expect(chain[i]!.stability).toBeLessThan(chain[i - 1]!.stability);
            expect(chain[i]!.scheduled_days).toBeGreaterThanOrEqual(1);
        }
        const last = chain[chain.length - 1]!;
        expect(last.stability).toBeLessThan(0.01);
        expect(last.state).toBe(State.Review);
    });
});

// ---------------------------------------------------------------------------
// enable_fuzz: false
// ---------------------------------------------------------------------------

describe("enable_fuzz: false — the histogram is the only jitter source", () => {
    it("is deterministic: identical inputs give identical output", () => {
        const card = emptyCard(NOW);
        for (const g of FSRS_GRADES) {
            const runs = Array.from({ length: 8 }, () => engine().schedule(card, g, NOW));
            for (const r of runs) expect(r).toEqual(runs[0]);
        }
    });

    it("is deterministic across a long walk", () => {
        const run = (): number[] => {
            const e = engine();
            let card = emptyCard(NOW);
            let t = NOW;
            const days: number[] = [];
            for (let i = 0; i < 50; i++) {
                card = e.schedule(card, FSRS_GRADES[i % 4]!, t);
                days.push(card.scheduled_days);
                t = new Date(card.due);
            }
            return days;
        };
        expect(run()).toEqual(run());
    });

    it("exposes no enable_fuzz control anywhere in settings", () => {
        expect("enableFuzz" in DEFAULT_SETTINGS).toBe(false);
        expect("enable_fuzz" in DEFAULT_SETTINGS).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Phase 3: the ScheduleInfo data model and its converters
// ---------------------------------------------------------------------------

describe("ScheduleInfo ↔ Card converters", () => {
    const NOW = new Date(2026, 0, 20, 14, 30, 0);

    const reviewed: ScheduleInfo = {
        due: new Date(2026, 0, 25),
        stability: 12.3456,
        difficulty: 6.5,
        reps: 7,
        lapses: 2,
        state: State.Review,
        last_review: new Date(2026, 0, 15),
    };

    it("round-trips every stored field", () => {
        const back = toScheduleInfo(toCard(reviewed, NOW));
        expect(back.due.valueOf()).toBe(reviewed.due.valueOf());
        expect(back.stability).toBe(reviewed.stability);
        expect(back.difficulty).toBe(reviewed.difficulty);
        expect(back.reps).toBe(reviewed.reps);
        expect(back.lapses).toBe(reviewed.lapses);
        expect(back.state).toBe(reviewed.state);
        expect(back.last_review!.valueOf()).toBe(reviewed.last_review!.valueOf());
    });

    // §B4: these two are derived, never stored. The file therefore cannot
    // disagree with the calendar.
    it("recomputes elapsed_days from last_review and the clock", () => {
        // 15th → 20th is 5 days; the 14:30 wall time is floored away.
        expect(toCard(reviewed, NOW).elapsed_days).toBe(5);
        // Reading the same card later gives a larger elapsed_days from identical
        // stored state — the point of not persisting it.
        expect(toCard(reviewed, new Date(2026, 0, 27)).elapsed_days).toBe(12);
    });

    it("recomputes scheduled_days as last_review → due", () => {
        // 15th → 25th is 10 days, independent of `now`.
        expect(toCard(reviewed, NOW).scheduled_days).toBe(10);
        expect(toCard(reviewed, new Date(2027, 5, 1)).scheduled_days).toBe(10);
    });

    it("always reports learning_steps as 0", () => {
        // Always 0 under B1, which is why B4 does not store it.
        expect(toCard(reviewed, NOW).learning_steps).toBe(0);
    });

    it("never reports negative elapsed or scheduled days", () => {
        const future: ScheduleInfo = { ...reviewed, last_review: new Date(2026, 5, 1) };
        expect(toCard(future, NOW).elapsed_days).toBe(0);
        expect(toCard(future, NOW).scheduled_days).toBe(0);
    });

    // The one place ts-fsrs's `Date | undefined` and B4's `Date | null` meet.
    it("translates a null last_review to an absent property, and back to null", () => {
        const never: ScheduleInfo = { ...reviewed, last_review: null, state: State.New };
        const card = toCard(never, NOW);
        expect(card.last_review).toBeUndefined();
        expect("last_review" in card).toBe(false);
        expect(card.elapsed_days).toBe(0);
        expect(toScheduleInfo(card).last_review).toBeNull();
    });

    it("a card straight out of the engine converts cleanly", () => {
        const engine = new FsrsEngine(settings());
        const graded = engine.schedule(emptyCard(NOW), Rating.Good, NOW);
        const info = toScheduleInfo(graded);
        expect(info.state).toBe(State.Review);
        expect(info.last_review).not.toBeNull();
        expect(info.reps).toBe(1);
        // And converting back preserves what the engine produced.
        expect(toCard(info, NOW).stability).toBe(graded.stability);
    });
});

describe("scheduledDays", () => {
    it("is the whole-day gap from last_review to due", () => {
        expect(scheduledDays({
            due: new Date(2026, 0, 25), stability: 1, difficulty: 5, reps: 1, lapses: 0,
            state: State.Review, last_review: new Date(2026, 0, 15),
        })).toBe(10);
    });

    it("is 0 for a face with no recorded review", () => {
        expect(scheduledDays({
            due: new Date(2026, 0, 25), stability: 0, difficulty: 0, reps: 0, lapses: 0,
            state: State.New, last_review: null,
        })).toBe(0);
    });

    // What the interval previews render. B1 guarantees >= 1, so textInterval
    // never has a sub-day value to format.
    it("matches the engine's own scheduled_days for every grade", () => {
        const engine = new FsrsEngine(settings());
        const now = new Date(2026, 0, 20);
        for (const grade of FSRS_GRADES) {
            const card = engine.schedule(emptyCard(now), grade, now);
            expect(scheduledDays(toScheduleInfo(card))).toBe(card.scheduled_days);
            expect(scheduledDays(toScheduleInfo(card))).toBeGreaterThanOrEqual(1);
        }
    });
});

describe("diffInDays", () => {
    it("floors rather than rounds", () => {
        const a = new Date(2026, 0, 1, 0, 0, 0);
        expect(diffInDays(a, new Date(2026, 0, 1, 23, 59, 59))).toBe(0);
        expect(diffInDays(a, new Date(2026, 0, 2, 0, 0, 0))).toBe(1);
        expect(diffInDays(a, new Date(2026, 0, 2, 23, 59, 59))).toBe(1);
    });

    it("goes negative for a future `to`", () => {
        expect(diffInDays(new Date(2026, 0, 10), new Date(2026, 0, 1))).toBe(-9);
    });
});

// ---------------------------------------------------------------------------
// §C3: the polarity landmine. ReviewResponse is Easy=0..Again=3 and FSRS Rating
// is Again=1..Easy=4 — reversed, EXCEPT that Hard is 2 in both. A naive cast
// inverts three of the four values while the one a spot-check most often lands
// on keeps working.
// ---------------------------------------------------------------------------

describe("ratingFor", () => {
    it("maps every response to the correct FSRS grade", () => {
        expect(ratingFor(ReviewResponse.Again)).toBe(Rating.Again);
        expect(ratingFor(ReviewResponse.Hard)).toBe(Rating.Hard);
        expect(ratingFor(ReviewResponse.Good)).toBe(Rating.Good);
        expect(ratingFor(ReviewResponse.Easy)).toBe(Rating.Easy);
    });

    it("is NOT the identity — the one that would look right is Hard", () => {
        // The trap, pinned: Hard alone survives a naive cast.
        expect(ratingFor(ReviewResponse.Hard) as number).toBe(ReviewResponse.Hard as number);
        // ...and the other three do not.
        expect(ratingFor(ReviewResponse.Again) as number).not.toBe(ReviewResponse.Again as number);
        expect(ratingFor(ReviewResponse.Good) as number).not.toBe(ReviewResponse.Good as number);
        expect(ratingFor(ReviewResponse.Easy) as number).not.toBe(ReviewResponse.Easy as number);
    });

    it("preserves quality order: worse response → shorter interval", () => {
        const engine = new FsrsEngine(settings());
        const now = new Date(2026, 0, 20);
        const days = (r: ReviewResponse): number =>
            engine.schedule(emptyCard(now), ratingFor(r), now).scheduled_days;
        // Again <= Hard <= Good <= Easy. If the mapping were inverted this is the
        // assertion that fails.
        expect(days(ReviewResponse.Again)).toBeLessThanOrEqual(days(ReviewResponse.Hard));
        expect(days(ReviewResponse.Hard)).toBeLessThanOrEqual(days(ReviewResponse.Good));
        expect(days(ReviewResponse.Good)).toBeLessThanOrEqual(days(ReviewResponse.Easy));
        expect(days(ReviewResponse.Again)).toBeLessThan(days(ReviewResponse.Easy));
    });
});

// The overdue credit. Plan section A records that the SM-2 delayDays terms never
// executed, so this is the first time a late review is actually rewarded. Three
// baseline tests covered this axis and died with osr.ts. These replace them.
//
// The quantity under test is elapsed_days, which toCard derives from last_review
// at read time rather than reading it off the file. A card answered late has a
// larger elapsed_days, lower retrievability, and so earns a different schedule
// from the same card answered on time.
describe("a late review is credited for the extra elapsed time", () => {
    // A card due 2026-01-15, last reviewed ten days earlier.
    function seeded(): ScheduleInfo {
        return {
            due: new Date("2026-01-15T10:00:00Z"),
            stability: 10,
            difficulty: 5,
            reps: 3,
            lapses: 0,
            state: State.Review,
            last_review: new Date("2026-01-05T10:00:00Z"),
        };
    }

    it("derives a larger elapsed_days when answered late", () => {
        const punctual = toCard(seeded(), new Date("2026-01-15T10:00:00Z"));
        const late = toCard(seeded(), new Date("2026-02-14T10:00:00Z"));
        expect(punctual.elapsed_days).toBe(10);
        expect(late.elapsed_days).toBe(40);
    });

    it("reports lower retrievability when answered late", () => {
        const e = engine();
        const punctual = e.retrievability(toCard(seeded(), new Date("2026-01-15T10:00:00Z")), new Date("2026-01-15T10:00:00Z"));
        const late = e.retrievability(toCard(seeded(), new Date("2026-02-14T10:00:00Z")), new Date("2026-02-14T10:00:00Z"));
        expect(late).toBeLessThan(punctual);
    });

    it("schedules Good further out when the review was late", () => {
        const e = engine();
        const onTime = new Date("2026-01-15T10:00:00Z");
        const late = new Date("2026-02-14T10:00:00Z");
        const punctual = e.schedule(toCard(seeded(), onTime), Rating.Good, onTime);
        const delayed = e.schedule(toCard(seeded(), late), Rating.Good, late);
        // The extra 30 days of successful retention is credited, so stability
        // and the next interval both come out higher than the punctual case.
        expect(delayed.stability).toBeGreaterThan(punctual.stability);
        expect(delayed.scheduled_days).toBeGreaterThan(punctual.scheduled_days);
    });

    it("still credits the elapsed time on a lapse", () => {
        const e = engine();
        const onTime = new Date("2026-01-15T10:00:00Z");
        const late = new Date("2026-02-14T10:00:00Z");
        const punctual = e.schedule(toCard(seeded(), onTime), Rating.Again, onTime);
        const delayed = e.schedule(toCard(seeded(), late), Rating.Again, late);
        // Forgetting a card held for 40 days is less of a signal than
        // forgetting one held for 10, so the post lapse stability differs.
        expect(delayed.stability).not.toBe(punctual.stability);
        expect(delayed.scheduled_days).toBeGreaterThanOrEqual(1);
        expect(punctual.scheduled_days).toBeGreaterThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// The memory state domain (the Invalid memory state crash)
// ---------------------------------------------------------------------------
//
// ts-fsrs rejects a card whose difficulty is under 1 or whose stability is under
// S_MIN, unless both are exactly 0. The throw used to surface in the middle of
// rendering the response buttons, which left Review and Learn with an empty
// action row and no way to answer. toCard clamps the state back into range.
describe("memory state clamping", () => {
    const AT = new Date("2026-01-15T10:00:00Z");

    function stored(stability: number, difficulty: number): ScheduleInfo {
        return {
            due: new Date("2026-01-16T10:00:00Z"),
            stability,
            difficulty,
            reps: 3,
            lapses: 1,
            state: State.Review,
            last_review: new Date("2026-01-10T10:00:00Z"),
        };
    }

    it("pins S_MIN and S_MAX, so a ts-fsrs bump that moves them is visible", () => {
        expect(S_MIN).toBe(0.001);
        expect(S_MAX).toBe(36500);
    });

    it("floors a stability of zero, which is what the converter seeded", () => {
        const card = toCard(stored(0, 5.0909), AT);
        expect(card.stability).toBe(S_MIN);
        expect(card.difficulty).toBe(5.0909);
    });

    it("floors a stability between zero and S_MIN", () => {
        expect(toCard(stored(0.0005, 5), AT).stability).toBe(S_MIN);
    });

    it("leaves a stability of exactly S_MIN alone", () => {
        expect(toCard(stored(S_MIN, 5), AT).stability).toBe(S_MIN);
    });

    it("clamps difficulty into the one to ten range", () => {
        expect(toCard(stored(5, 0), AT).difficulty).toBe(1);
        expect(toCard(stored(5, 0.5), AT).difficulty).toBe(1);
        expect(toCard(stored(5, 42), AT).difficulty).toBe(10);
    });

    it("absorbs a NaN in either field", () => {
        const card = toCard(stored(NaN, NaN), AT);
        expect(card.stability).toBe(S_MIN);
        expect(card.difficulty).toBe(1);
    });

    // Both fields exactly zero is how ts-fsrs spells an uninitialised card, and
    // it answers that by seeding from the grade. Passing it through untouched is
    // what makes the clamp rewrite only states that would otherwise throw.
    it("passes a wholly uninitialised state through untouched", () => {
        const card = toCard(stored(0, 0), AT);
        expect(card.stability).toBe(0);
        expect(card.difficulty).toBe(0);
    });

    it("does not throw for any state the clamp admits", () => {
        const e = engine();
        const cases: [number, number][] = [
            [0, 5.0909], [0, 1], [0, 10], [0.0005, 5], [S_MIN, 5],
            [5, 0], [5, 0.5], [5, 42], [NaN, NaN], [0, 0], [10, 5],
        ];
        for (const [stability, difficulty] of cases) {
            expect(
                () => e.previewAll(toCard(stored(stability, difficulty), AT), AT),
                `stability ${stability} difficulty ${difficulty}`,
            ).not.toThrow();
        }
    });

    // The floor is real and it is S_MIN. Repeated lapsing asymptotes there
    // rather than decaying to zero, so the engine's own writes can never land in
    // the rejected range. Only a conversion or a hand edit can.
    it("asymptotes at S_MIN under sustained lapsing rather than reaching zero", () => {
        const e = engine();
        let at = new Date("2026-01-15T10:00:00Z");
        let card = emptyCard(at);
        let min = Infinity;
        for (let i = 0; i < 60; i++) {
            card = e.schedule(card, Rating.Again, at);
            min = Math.min(min, card.stability);
            at = new Date(card.due.valueOf());
        }
        expect(min).toBe(S_MIN);
        expect(min).toBeGreaterThanOrEqual(S_MIN);
    });
});
