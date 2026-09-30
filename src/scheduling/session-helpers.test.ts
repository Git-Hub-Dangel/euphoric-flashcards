import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "src/settings";
import type { EuphoricSettings } from "src/settings";
import { HistogramStore } from "src/scheduling/histogram-store";
import { setupStaticDateProvider } from "src/scheduling/dates";
import { applyResponse, histogramFor, previewAll, retrievabilityOf } from "src/scheduling/session-helpers";
import { FSRS_GRADES, Rating, ratingFor, scheduledDays, State } from "src/scheduling/fsrs";
import type { ScheduleInfo } from "src/scheduling/fsrs";
import { ReviewResponse } from "src/scheduling/review-response";
import type EuphoricFlashcardsPlugin from "src/main";

// session-helpers only ever touches plugin.data.settings and plugin.histogramStore,
// so a minimal stand-in is enough and keeps the obsidian Plugin class out of the
// test. The import of EuphoricFlashcardsPlugin above is type-only and erased.
function fakePlugin(overrides: Partial<EuphoricSettings> = {}): EuphoricFlashcardsPlugin {
    const settings = { ...DEFAULT_SETTINGS, ...overrides };
    return {
        data: { settings, histogram: { data: {}, builtAt: null } },
        histogramStore: new HistogramStore({ data: {}, builtAt: null }),
    } as unknown as EuphoricFlashcardsPlugin;
}

const NOW = new Date(2026, 0, 20, 14, 30, 0);

function reviewed(overrides: Partial<ScheduleInfo> = {}): ScheduleInfo {
    return {
        due: new Date(2026, 0, 20),
        stability: 10,
        difficulty: 5,
        reps: 4,
        lapses: 1,
        state: State.Review,
        last_review: new Date(2026, 0, 10),
        ...overrides,
    };
}

beforeEach(() => {
    setupStaticDateProvider("2026-01-20");
});

describe("previewAll", () => {
    it("returns one schedule per grade", () => {
        const preview = previewAll(reviewed(), fakePlugin(), NOW);
        for (const grade of FSRS_GRADES) {
            expect(preview[grade]).toBeDefined();
            expect(preview[grade].state).toBe(State.Review);
        }
    });

    it("treats a null schedule as a brand-new card", () => {
        const preview = previewAll(null, fakePlugin(), NOW);
        // A New card graded once has exactly one rep and, under B1, lands in Review.
        expect(preview[Rating.Good].reps).toBe(1);
        expect(preview[Rating.Good].state).toBe(State.Review);
        // FSRS does not count a failed New card as a lapse (progress-note finding 4).
        expect(preview[Rating.Again].lapses).toBe(0);
    });

    it("orders the grades by interval", () => {
        const preview = previewAll(reviewed(), fakePlugin(), NOW);
        const days = (g: typeof FSRS_GRADES[number]): number => scheduledDays(preview[g]);
        expect(days(Rating.Again)).toBeLessThanOrEqual(days(Rating.Hard));
        expect(days(Rating.Hard)).toBeLessThanOrEqual(days(Rating.Good));
        expect(days(Rating.Good)).toBeLessThanOrEqual(days(Rating.Easy));
    });

    it("never previews a sub-day interval", () => {
        for (const schedule of [null, reviewed(), reviewed({ stability: 0.3, lapses: 9 })]) {
            const preview = previewAll(schedule, fakePlugin(), NOW);
            for (const grade of FSRS_GRADES) {
                expect(scheduledDays(preview[grade])).toBeGreaterThanOrEqual(1);
            }
        }
    });

    it("increments lapses on Again for a learned card", () => {
        // ...unlike the New case above. Both halves matter: the Phase 4 exit
        // criterion is only meaningful when checked against a learned card.
        const preview = previewAll(reviewed(), fakePlugin(), NOW);
        expect(preview[Rating.Again].lapses).toBe(reviewed().lapses + 1);
    });

    it("floors stability on Again rather than collapsing it to one day", () => {
        // §B2: lapse severity comes from FSRS, which is why the old
        // lapsesIntervalChange reset-to-1-day has no replacement.
        const before = reviewed({ stability: 60 });
        const after = previewAll(before, fakePlugin(), NOW)[Rating.Again];
        expect(after.stability).toBeLessThan(before.stability);
        expect(after.stability).toBeGreaterThan(0);
    });

    it("responds to the target-retention setting", () => {
        const lenient = previewAll(reviewed(), fakePlugin({ requestRetention: 0.7 }), NOW);
        const strict = previewAll(reviewed(), fakePlugin({ requestRetention: 0.99 }), NOW);
        // Demanding higher retention means reviewing sooner.
        expect(scheduledDays(strict[Rating.Good]))
            .toBeLessThan(scheduledDays(lenient[Rating.Good]));
    });
});

// The point of P3.5. Previously the preview and the write each built their own
// algorithm instance and re-snapshotted the histogram independently, so the
// interval on the button could differ from the interval written to the file.
describe("previewAll and applyResponse agree", () => {
    it("produces identical state for every response, from the same instant", () => {
        const plugin = fakePlugin();
        const schedule = reviewed();
        const preview = previewAll(schedule, plugin, NOW);
        for (const response of [
            ReviewResponse.Again, ReviewResponse.Hard, ReviewResponse.Good, ReviewResponse.Easy,
        ]) {
            const written = applyResponse(schedule, response, plugin, NOW);
            const previewed = preview[ratingFor(response)];
            expect(written.due.valueOf()).toBe(previewed.due.valueOf());
            expect(written.stability).toBe(previewed.stability);
            expect(written.difficulty).toBe(previewed.difficulty);
            expect(written.reps).toBe(previewed.reps);
            expect(written.lapses).toBe(previewed.lapses);
            expect(written.state).toBe(previewed.state);
        }
    });

    it("agrees for a new card too", () => {
        const plugin = fakePlugin();
        const preview = previewAll(null, plugin, NOW);
        const written = applyResponse(null, ReviewResponse.Good, plugin, NOW);
        expect(written.due.valueOf()).toBe(preview[Rating.Good].due.valueOf());
        expect(written.stability).toBe(preview[Rating.Good].stability);
    });
});

describe("retrievabilityOf", () => {
    it("is in [0, 1] and falls as a card goes overdue", () => {
        const plugin = fakePlugin();
        const fresh = retrievabilityOf(reviewed({ last_review: new Date(2026, 0, 19) }), plugin, NOW);
        const stale = retrievabilityOf(reviewed({ last_review: new Date(2025, 0, 1) }), plugin, NOW);
        expect(fresh).toBeGreaterThan(0);
        expect(fresh).toBeLessThanOrEqual(1);
        expect(stale).toBeLessThan(fresh);
    });

    // ⚠️ The P4.2b trap, asserted at this layer too: 0 is the *most urgent* slot
    // in an ascending sort, so a New face must never reach the due ranking.
    it("returns exactly 0 for a face with no schedule", () => {
        expect(retrievabilityOf(null, fakePlugin(), NOW)).toBe(0);
    });
});

describe("histogramFor", () => {
    it("is empty when load balancing is off", () => {
        const plugin = fakePlugin({ loadBalance: false });
        plugin.histogramStore.increment("2026-01-25");
        expect(histogramFor(plugin).dueDatesMap.size).toBe(0);
    });

    it("snapshots stored due dates as days from today when load balancing is on", () => {
        const plugin = fakePlugin({ loadBalance: true });
        plugin.histogramStore.increment("2026-01-25");
        plugin.histogramStore.increment("2026-01-25");
        // Static provider is pinned to 2026-01-20, so 2026-01-25 is +5 days.
        expect(histogramFor(plugin).get(5)).toBe(2);
    });
});
