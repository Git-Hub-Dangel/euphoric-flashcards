import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "src/settings";
import type { EuphoricSettings } from "src/settings";
import { HistogramStore } from "src/scheduling/histogram-store";
import {
    applyDayBoundary,
    DateUtil,
    dayFor,
    formatDate,
    globalDateProvider,
    LiveDateProvider,
    setupStaticDateProvider,
    StaticDateProvider,
} from "src/scheduling/dates";
import { DueDateHistogram } from "src/scheduling/due-date-histogram";
import { TICKS_PER_DAY } from "src/scheduling/constants";
import { balanceDue, histogramFor, previewAll } from "src/scheduling/session-helpers";
import { isFaceDue } from "src/scheduling/due";
import { Rating, State } from "src/scheduling/fsrs";
import type { ScheduleInfo } from "src/scheduling/fsrs";
import type EuphoricFlashcardsPlugin from "src/main";

// FSRS Phase 6. The startOfDay setting shipped inert through 1.4.1 and the whole
// of the FSRS migration: setDayBoundary had no production call sites and
// StaticDateProvider ignored the boundary, so the feature could not even be
// tested. These are the tests that were impossible before.

const BOUNDARY_4AM = { hour: 4, minute: 0, second: 0 };

// The global provider is module state shared with every other suite, so each
// test here restores it.
afterEach(() => {
    globalDateProvider.setDayBoundary(null);
});

// ---------------------------------------------------------------------------
// P6.2 — the providers resolve the session day
// ---------------------------------------------------------------------------

describe("dayFor", () => {
    it("resolves to the previous day before the boundary", () => {
        const at = new Date(2026, 8, 30, 2, 0, 0);
        expect(formatDate(dayFor(at, BOUNDARY_4AM).valueOf())).toBe("2026-09-29");
    });

    it("resolves to the current day at the boundary instant", () => {
        // The comparison is strict, so 04:00:00 exactly already belongs to the
        // new day. A user who sets 04:00 gets cards at 04:00, not at 04:00:01.
        const at = new Date(2026, 8, 30, 4, 0, 0);
        expect(formatDate(dayFor(at, BOUNDARY_4AM).valueOf())).toBe("2026-09-30");
    });

    it("resolves to the current day after the boundary", () => {
        const at = new Date(2026, 8, 30, 14, 30, 0);
        expect(formatDate(dayFor(at, BOUNDARY_4AM).valueOf())).toBe("2026-09-30");
    });

    it("returns local midnight, not the instant", () => {
        const d = dayFor(new Date(2026, 8, 30, 2, 0, 0), BOUNDARY_4AM);
        expect(d.getHours()).toBe(0);
        expect(d.getMinutes()).toBe(0);
        expect(d.getSeconds()).toBe(0);
    });

    it("is literal midnight with no boundary set", () => {
        const at = new Date(2026, 8, 30, 2, 0, 0);
        expect(formatDate(dayFor(at, null).valueOf())).toBe("2026-09-30");
    });

    it("is literal midnight under a 00:00:00 boundary, including at midnight", () => {
        // No instant precedes its own day's start, so the default value is a
        // no-op by construction rather than by a special case.
        const zero = { hour: 0, minute: 0, second: 0 };
        expect(formatDate(dayFor(new Date(2026, 8, 30, 0, 0, 0), zero).valueOf())).toBe("2026-09-30");
        expect(formatDate(dayFor(new Date(2026, 8, 30, 2, 0, 0), zero).valueOf())).toBe("2026-09-30");
    });

    it("crosses a month boundary backwards", () => {
        const at = new Date(2026, 9, 1, 3, 0, 0);
        expect(formatDate(dayFor(at, BOUNDARY_4AM).valueOf())).toBe("2026-09-30");
    });

    it("crosses a year boundary backwards", () => {
        const at = new Date(2026, 0, 1, 3, 0, 0);
        expect(formatDate(dayFor(at, BOUNDARY_4AM).valueOf())).toBe("2025-12-31");
    });

    it("honours a boundary with minutes and seconds", () => {
        const b = { hour: 4, minute: 30, second: 15 };
        expect(formatDate(dayFor(new Date(2026, 8, 30, 4, 30, 14), b).valueOf())).toBe("2026-09-29");
        expect(formatDate(dayFor(new Date(2026, 8, 30, 4, 30, 15), b).valueOf())).toBe("2026-09-30");
    });
});

describe("StaticDateProvider honours the day boundary", () => {
    it("reports the previous day before the cutoff", () => {
        const p = new StaticDateProvider(new Date(2026, 8, 30, 2, 0, 0));
        p.setDayBoundary(BOUNDARY_4AM);
        expect(formatDate(p.today.valueOf())).toBe("2026-09-29");
    });

    it("leaves `now` alone", () => {
        // Only the session day shifts. `now` stays the honest instant, which is
        // what FSRS schedules from.
        const p = new StaticDateProvider(new Date(2026, 8, 30, 2, 0, 0));
        p.setDayBoundary(BOUNDARY_4AM);
        expect(p.now.getHours()).toBe(2);
        expect(formatDate(p.now.valueOf())).toBe("2026-09-30");
    });

    it("reverts when the boundary is cleared", () => {
        const p = new StaticDateProvider(new Date(2026, 8, 30, 2, 0, 0));
        p.setDayBoundary(BOUNDARY_4AM);
        p.setDayBoundary(null);
        expect(formatDate(p.today.valueOf())).toBe("2026-09-30");
    });
});

describe("LiveDateProvider honours the day boundary", () => {
    it("agrees with dayFor on the current instant", () => {
        // Asserted against dayFor rather than a fixed date because the suite
        // cannot choose the wall clock. The point is that the provider delegates
        // instead of carrying its own copy of the rule.
        const p = new LiveDateProvider();
        p.setDayBoundary({ hour: 23, minute: 59, second: 59 });
        const expected = dayFor(new Date(), { hour: 23, minute: 59, second: 59 });
        expect(formatDate(p.today.valueOf())).toBe(formatDate(expected.valueOf()));
    });
});

// ---------------------------------------------------------------------------
// P6.1 — the setting reaches the provider
// ---------------------------------------------------------------------------

describe("DateUtil.strToDayBoundary", () => {
    it("parses a well formed HH:MM:SS value", () => {
        expect(DateUtil.strToDayBoundary("04:30:15")).toEqual({ hour: 4, minute: 30, second: 15 });
    });

    it("parses the shipped default", () => {
        expect(DateUtil.strToDayBoundary(DEFAULT_SETTINGS.startOfDay)).toEqual({
            hour: 0, minute: 0, second: 0,
        });
    });

    it("rejects the shapes a hand edited settings field produces", () => {
        for (const bad of ["", "4", "04:00", "04:00:00:00", "ab:cd:ef", "24:00:00", "04:60:00", "04:00:60", "-1:00:00"]) {
            expect(DateUtil.strToDayBoundary(bad)).toBeNull();
        }
    });
});

describe("applyDayBoundary", () => {
    it("installs a parsed boundary on the active provider", () => {
        setupStaticDateProvider("2026-01-20");
        applyDayBoundary("04:00:00");
        expect(globalDateProvider.getDayBoundary()).toEqual(BOUNDARY_4AM);
    });

    it("clears the boundary when the value is unusable", () => {
        setupStaticDateProvider("2026-01-20");
        applyDayBoundary("04:00:00");
        applyDayBoundary("not a time");
        // Degrades to literal midnight rather than throwing. A half typed
        // settings field must not break every due date comparison.
        expect(globalDateProvider.getDayBoundary()).toBeNull();
        expect(formatDate(globalDateProvider.today.valueOf())).toBe("2026-01-20");
    });

    it("shifts globalDateProvider.today", () => {
        // The static provider pins the clock to midnight, which is before a
        // 04:00 cutoff, so the session day is the day before.
        setupStaticDateProvider("2026-01-20");
        applyDayBoundary("04:00:00");
        expect(formatDate(globalDateProvider.today.valueOf())).toBe("2026-01-19");
    });

    it("survives a provider swap", () => {
        setupStaticDateProvider("2026-01-20");
        applyDayBoundary("04:00:00");
        setupStaticDateProvider("2026-02-05");
        expect(globalDateProvider.getDayBoundary()).toEqual(BOUNDARY_4AM);
    });
});

// ---------------------------------------------------------------------------
// P6.3 — reconciliation with due.ts and with load balancing
// ---------------------------------------------------------------------------

function sched(due: Date, overrides: Partial<ScheduleInfo> = {}): ScheduleInfo {
    return {
        due,
        stability: 10,
        difficulty: 5,
        reps: 4,
        lapses: 1,
        state: State.Review,
        last_review: new Date(due.valueOf() - 10 * TICKS_PER_DAY),
        ...overrides,
    };
}

describe("isFaceDue across the day boundary", () => {
    // 02:00 on Jan 20 under a 04:00 cutoff. The session day is Jan 19.
    const sessionDay = dayFor(new Date(2026, 0, 20, 2, 0, 0), BOUNDARY_4AM);

    it("holds back a card due today until the cutoff", () => {
        // The point of the whole feature. Studying past midnight must not pull
        // the next day's cards forward.
        expect(isFaceDue(sched(new Date(2026, 0, 20)), sessionDay)).toBe(false);
    });

    it("keeps yesterday's card due before the cutoff", () => {
        expect(isFaceDue(sched(new Date(2026, 0, 19)), sessionDay)).toBe(true);
    });

    it("keeps an overdue card due", () => {
        expect(isFaceDue(sched(new Date(2026, 0, 5)), sessionDay)).toBe(true);
    });

    it("releases the card once the cutoff passes", () => {
        const afterCutoff = dayFor(new Date(2026, 0, 20, 4, 0, 0), BOUNDARY_4AM);
        expect(isFaceDue(sched(new Date(2026, 0, 20)), afterCutoff)).toBe(true);
    });

    it("treats a new face as due regardless of the boundary", () => {
        expect(isFaceDue(null, sessionDay)).toBe(true);
    });
});

describe("isFaceDue is day granular", () => {
    it("ignores a time of day on either side", () => {
        // Every stored due date is a calendar date at local midnight (invariant
        // 40), but an in-memory schedule straight out of FSRS carries the
        // review's time of day. The comparison must not depend on which it got.
        const today = new Date(2026, 0, 20);
        expect(isFaceDue(sched(new Date(2026, 0, 20, 23, 59, 0)), today)).toBe(true);
        expect(isFaceDue(sched(new Date(2026, 0, 20)), new Date(2026, 0, 20, 0, 0, 1))).toBe(true);
        expect(isFaceDue(sched(new Date(2026, 0, 21, 0, 0, 1)), today)).toBe(false);
    });
});

function fakePlugin(overrides: Partial<EuphoricSettings> = {}): EuphoricFlashcardsPlugin {
    const settings = { ...DEFAULT_SETTINGS, ...overrides };
    return {
        data: { settings, histogram: { data: {}, builtAt: null } },
        histogramStore: new HistogramStore({ data: {}, builtAt: null }),
    } as unknown as EuphoricFlashcardsPlugin;
}

function loaded(load: Record<number, number>): DueDateHistogram {
    const h = new DueDateHistogram();
    for (const [offset, count] of Object.entries(load)) h.set(Number(offset), count);
    return h;
}

describe("load balancing under the day boundary", () => {
    // Pre cutoff: the clock reads 02:00 on Jan 20, the session day is Jan 19.
    const NOW = new Date(2026, 0, 20, 2, 0, 0);
    const SESSION_DAY = dayFor(NOW, BOUNDARY_4AM);

    function dueInDays(days: number): Date {
        return new Date(2026, 0, 20 + days, 2, 0, 0);
    }

    it("keys the histogram snapshot off the session day", () => {
        // The pairing P6.3 exists to check. The histogram is keyed in days from
        // today, so once today shifts back a day every offset gains one. A
        // snapshot taken against the unshifted clock would place this card at 5
        // and the scan would read the wrong slot.
        setupStaticDateProvider("2026-01-20");
        applyDayBoundary("04:00:00");
        const plugin = fakePlugin({ loadBalance: true });
        plugin.histogramStore.increment("2026-01-25");
        expect(histogramFor(plugin).get(6)).toBe(1);
        expect(histogramFor(plugin).get(5)).toBe(0);
    });

    it("gates on the interval, not on the shifted offset", () => {
        // A 7-day interval sits at offset 8 from the session day. Reading the
        // offset as the interval would let it past the no-balance gate and start
        // nudging intervals the user was promised exactly (finding 12).
        const due = dueInDays(7);
        expect(balanceDue(due, loaded({ 8: 9 }), SESSION_DAY, NOW)).toBe(due);
    });

    it("picks the fuzz width from the interval, not the shifted offset", () => {
        // 180 is the rung where the ladder actually changes width. A 180-day
        // interval gets +/-3, while offset 181 would get +/-4. Every day the
        // narrower window can reach is full and only the day one step beyond it
        // is free, so a window picked from the offset moves this card and a
        // window picked from the interval leaves it alone.
        const load: Record<number, number> = {};
        for (let d = 177; d <= 184; d++) load[d] = 9;
        const due = dueInDays(180);
        expect(balanceDue(due, loaded(load), SESSION_DAY, NOW).valueOf()).toBe(due.valueOf());
        // The same histogram read one day off does move it, which is what makes
        // the assertion above a real check rather than an empty window.
        expect(balanceDue(due, loaded(load), SESSION_DAY).valueOf()).not.toBe(due.valueOf());
    });

    it("still scans in the session day's keyspace", () => {
        // The interval governs the window, the offset governs the lookup. A
        // 30-day interval sits at offset 31, and crowding the calendar day it
        // wants must move it.
        const due = dueInDays(30);
        const out = balanceDue(due, loaded({ 31: 9 }), SESSION_DAY, NOW);
        expect(out.valueOf()).not.toBe(due.valueOf());
    });

    it("leaves the default boundary arithmetic untouched", () => {
        // `now` defaults to `today`, so every pre Phase 6 call site keeps its
        // exact behaviour. Offset and interval coincide when nothing shifted.
        const today = new Date(2026, 0, 20);
        const due = new Date(2026, 0, 27, 14, 30, 0);
        expect(balanceDue(due, loaded({ 7: 9 }), today)).toBe(due);
        expect(balanceDue(due, loaded({ 7: 9 }), today, new Date(2026, 0, 20, 14, 30, 0))).toBe(due);
    });

    it("balances a whole preview record off the shifted session day", () => {
        setupStaticDateProvider("2026-01-20");
        applyDayBoundary("04:00:00");
        const base = sched(new Date(2026, 0, 19));
        const unbalanced = previewAll(base, fakePlugin({ loadBalance: false }), NOW);
        const target = unbalanced[Rating.Good].due;
        const targetIso = formatDate(target.valueOf());

        const plugin = fakePlugin({ loadBalance: true });
        for (let i = 0; i < 6; i++) plugin.histogramStore.increment(targetIso);
        const balanced = previewAll(base, plugin, NOW);
        // Crowding the calendar date Good wants moves it off that date. Only
        // meaningful if Good is outside the no-balance window to begin with.
        expect(Math.round((target.valueOf() - NOW.valueOf()) / TICKS_PER_DAY)).toBeGreaterThan(7);
        expect(formatDate(balanced[Rating.Good].due.valueOf())).not.toBe(targetIso);
    });
});

// Spring forward makes the preceding day 23 hours long, so subtracting a fixed
// 24 hours lands on 23:00 of the day before and floors to the wrong calendar
// day. TZ is pinned to Europe/Berlin in vitest.config.ts, where the 2026
// transitions are March 29 and October 25. Without that pin these assertions
// would be decorative on a machine in a zone that does not observe DST.
describe("dayFor across a DST transition", () => {
    const BOUNDARY = { hour: 4, minute: 0, second: 0 };

    it("returns the previous calendar day on a spring-forward morning", () => {
        const day = dayFor(new Date(2026, 2, 30, 1, 30), BOUNDARY);
        expect(day.getFullYear()).toBe(2026);
        expect(day.getMonth()).toBe(2);
        expect(day.getDate()).toBe(29);
        expect(day.getHours()).toBe(0);
    });

    it("returns the previous calendar day on a fall-back morning", () => {
        const day = dayFor(new Date(2026, 9, 26, 1, 30), BOUNDARY);
        expect(day.getMonth()).toBe(9);
        expect(day.getDate()).toBe(25);
        expect(day.getHours()).toBe(0);
    });

    it("lands on local midnight of the previous day for every day in two years", () => {
        for (let i = 0; i < 740; i++) {
            const at = new Date(2026, 0, 1 + i, 1, 30);
            const want = new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1);
            expect(dayFor(at, BOUNDARY).valueOf()).toBe(want.valueOf());
        }
    });
});
