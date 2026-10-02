import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "src/settings";
import type { EuphoricSettings } from "src/settings";
import { HistogramStore } from "src/scheduling/histogram-store";
import { formatDate, setupStaticDateProvider, startOfDay } from "src/scheduling/dates";
import { DueDateHistogram } from "src/scheduling/due-date-histogram";
import { TICKS_PER_DAY } from "src/scheduling/constants";
import { applyResponse, balanceDue, histogramFor, previewAll, retrievabilityOf } from "src/scheduling/session-helpers";
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

// ---------------------------------------------------------------------------
// P5.1 — load balancing against the FSRS due date
// ---------------------------------------------------------------------------

// The static provider pins today to 2026-01-20.
const TODAY = new Date(2026, 0, 20);

// A due date `days` out, carrying a time of day so the no-drift assertion below
// has something to lose.
function dueIn(days: number): Date {
    return new Date(2026, 0, 20 + days, 14, 30, 0);
}

function offsetOf(due: Date): number {
    return Math.round((startOfDay(due).valueOf() - TODAY.valueOf()) / TICKS_PER_DAY);
}

// A histogram loaded at the given day offsets from today.
function loaded(load: Record<number, number>): DueDateHistogram {
    const h = new DueDateHistogram();
    for (const [offset, count] of Object.entries(load)) h.set(Number(offset), count);
    return h;
}

// A plugin whose persisted histogram is already loaded at the given day
// offsets. Keys are ISO dates because that is how HistogramStore stores them.
function pluginLoadedAt(
    load: Record<number, number>,
    overrides: Partial<EuphoricSettings> = {},
): EuphoricFlashcardsPlugin {
    const plugin = fakePlugin(overrides);
    for (const [offset, count] of Object.entries(load)) {
        const iso = formatDate(new Date(2026, 0, 20 + Number(offset)).valueOf());
        for (let i = 0; i < count; i++) plugin.histogramStore.increment(iso);
    }
    return plugin;
}

describe("balanceDue", () => {
    it("leaves a due date inside the no-balance window untouched", () => {
        // Offset 5 is at or under BALANCE_MIN_OFFSET, so a crowded day stands.
        // Nudging a short lapse interval is a pedagogical change, not balancing.
        const due = dueIn(5);
        expect(balanceDue(due, loaded({ 5: 9 }), TODAY)).toBe(due);
    });

    it("leaves the boundary day itself untouched", () => {
        const due = dueIn(7);
        expect(balanceDue(due, loaded({ 7: 9 }), TODAY)).toBe(due);
    });

    it("moves a crowded due date to the nearest empty day", () => {
        // 10 is occupied, 9 is empty and probed first (earlier wins).
        const out = balanceDue(dueIn(10), loaded({ 10: 4 }), TODAY);
        expect(offsetOf(out)).toBe(9);
    });

    it("does nothing when the histogram is empty", () => {
        const due = dueIn(40);
        expect(balanceDue(due, new DueDateHistogram(), TODAY)).toBe(due);
    });

    it("stays inside the fuzz window", () => {
        // fuzzFor(10) is 1, so only 9 and 11 are reachable. Both are busier than
        // the original, and the scan only moves on a strict improvement.
        const out = balanceDue(dueIn(10), loaded({ 9: 5, 10: 3, 11: 5 }), TODAY);
        expect(offsetOf(out)).toBe(10);
    });

    it("widens the window for longer intervals", () => {
        // fuzzFor(200) is 5, so the scan can reach three days out where
        // fuzzFor(10) is capped at one. The window either side of 200 is filled
        // so that 197 is the nearest empty day: the scan probes by increasing
        // distance and takes the earlier day of each pair, so it reaches 197 at
        // i=3 only after 199/201 and 198/202 have all been found occupied.
        const out = balanceDue(
            dueIn(200),
            loaded({ 198: 2, 199: 2, 200: 2, 201: 2, 202: 2 }),
            TODAY,
        );
        expect(offsetOf(out)).toBe(197);
    });

    it("takes the nearer empty day before a further one", () => {
        // Both 197 and 202 are free; 202 sits two days out and 197 three, so the
        // distance-ordered probe settles on 202.
        const out = balanceDue(dueIn(200), loaded({ 198: 2, 199: 2, 200: 2, 201: 2 }), TODAY);
        expect(offsetOf(out)).toBe(202);
    });

    // ⚠️ The drift this prevents is silent. `due` carries the review's time of
    // day and scheduledDays FLOORS last_review -> due, so rebuilding the balanced
    // date from midnight would shave a day off the interval rendered on the
    // button while the stored calendar date kept the full one.
    it("preserves the time of day so the rendered interval cannot drift", () => {
        const out = balanceDue(dueIn(10), loaded({ 10: 4 }), TODAY);
        expect(out.getHours()).toBe(14);
        expect(out.getMinutes()).toBe(30);
    });
});

describe("previewAll load balancing", () => {
    it("balances the due dates it hands back", () => {
        const unbalanced = previewAll(reviewed(), fakePlugin(), NOW);
        const target = offsetOf(unbalanced[Rating.Good].due);
        // Only meaningful if Good lands outside the no-balance window.
        expect(target).toBeGreaterThan(7);

        // Crowd exactly the day Good wants and leave its neighbour free.
        const plugin = pluginLoadedAt({ [target]: 6 });
        const balanced = previewAll(reviewed(), plugin, NOW);
        expect(offsetOf(balanced[Rating.Good].due)).not.toBe(target);
        expect(Math.abs(offsetOf(balanced[Rating.Good].due) - target)).toBeLessThanOrEqual(3);
    });

    it("is inert when load balancing is off", () => {
        const empty = previewAll(reviewed(), fakePlugin(), NOW);
        const target = offsetOf(empty[Rating.Good].due);
        const off = previewAll(reviewed(), pluginLoadedAt({ [target]: 6 }, { loadBalance: false }), NOW);
        for (const grade of FSRS_GRADES) {
            expect(off[grade].due.valueOf()).toBe(empty[grade].due.valueOf());
        }
    });

    it("keeps the grades in non-decreasing order against a hostile histogram", () => {
        // Every day in the neighbourhood occupied at varying weights, which is
        // the arrangement that drives the scan's min-tracking path.
        const load: Record<number, number> = {};
        for (let d = 1; d <= 400; d++) load[d] = 1 + (d % 7);
        const preview = previewAll(reviewed({ stability: 200 }), pluginLoadedAt(load), NOW);
        let prev = -Infinity;
        for (const grade of FSRS_GRADES) {
            const offset = offsetOf(preview[grade].due);
            expect(offset).toBeGreaterThanOrEqual(prev);
            prev = offset;
        }
    });

    it("writes the interval it rendered", () => {
        // Invariant 37 at this seam: the balanced due date is what scheduledDays
        // measures, so the button label and the stored date agree by construction.
        const plugin = pluginLoadedAt({ 10: 5, 11: 5, 12: 5 });
        const preview = previewAll(reviewed(), plugin, NOW);
        for (const grade of FSRS_GRADES) {
            const s = preview[grade];
            expect(s.last_review).not.toBeNull();
            const rendered = scheduledDays(s);
            const stored = Math.max(0, Math.floor(
                (s.due.valueOf() - (s.last_review as Date).valueOf()) / TICKS_PER_DAY,
            ));
            expect(rendered).toBe(stored);
        }
    });
});
