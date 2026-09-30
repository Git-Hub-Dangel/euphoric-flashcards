import { describe, expect, it } from "vitest";

import { DueDateHistogram } from "src/scheduling/due-date-histogram";
import { textInterval } from "src/scheduling/interval-text";
import {
    formatDate,
    LiveDateProvider,
    parseLegacyDate,
    parsePreferredDate,
    setupStaticDateProvider,
    startOfDay,
    StaticDateProvider,
    globalDateProvider,
} from "src/scheduling/dates";

// The SM-2 arithmetic suites that used to live here are gone with osr.ts
// (FSRS plan P3.6): osrSchedule, SRAlgorithmOsr's card-level methods, and
// RepItemScheduleInfoOsr's comment formatting. Their FSRS replacements are
// tested in fsrs.test.ts (the engine) and comment-parser.test.ts (the format).
//
// The load-balancing cases that exercised osrSchedule's fuzz branch are now
// direct tests of DueDateHistogram.findLeastUsedIntervalOverRange, which is the
// part that survives untouched. P5.1 re-points it at FSRS's due date; these pin
// the scan behaviour it must still have afterwards.

// ---------------------------------------------------------------------------
// textInterval — unchanged by the migration, moved to interval-text.ts
// ---------------------------------------------------------------------------

describe("textInterval", () => {
    it("short: days below 1 month", () => {
        expect(textInterval(1, true)).toBe("1d");
        // cutoff: Math.round(interval/3.04375)/10 < 1  →  interval < 28.9  →  28 is last "day" value
        expect(textInterval(28, true)).toBe("28d");
    });

    it("short: 30d rounds to exactly 1mo → displayed as months", () => {
        // Math.round(30/3.04375)/10 = Math.round(9.857)/10 = 10/10 = 1.0 → NOT < 1
        expect(textInterval(30, true)).toBe("1mo");
    });

    it("short: months", () => {
        expect(textInterval(41, true)).toBe("1.3mo");
    });

    it("short: years", () => {
        expect(textInterval(366, true)).toBe("1yr");
        expect(textInterval(1000, true)).toBe("2.7yr");
    });

    it("long form — days", () => {
        expect(textInterval(1, false)).toBe("1 day(s)");
    });

    it("long form — months", () => {
        expect(textInterval(41, false)).toBe("1.3 month(s)");
    });

    it("long form — years", () => {
        expect(textInterval(366, false)).toBe("1 year(s)");
        expect(textInterval(1000, false)).toBe("2.7 year(s)");
    });

    it("null/undefined → New", () => {
        expect(textInterval(null)).toBe("New");
        expect(textInterval(undefined)).toBe("New");
    });
});

// ---------------------------------------------------------------------------
// DueDateHistogram — the scan P5.1 will re-point at FSRS's due date
// ---------------------------------------------------------------------------

describe("DueDateHistogram.findLeastUsedIntervalOverRange", () => {
    it("returns the interval untouched when that day is empty", () => {
        const h = new DueDateHistogram();
        h.set(20, 5);
        expect(h.findLeastUsedIntervalOverRange(10, 3)).toBe(10);
    });

    it("moves to the nearest empty day within the fuzz window", () => {
        const h = new DueDateHistogram();
        h.set(10, 4);
        // i=1 probes 9 first (earlier wins the tie), and 9 is empty
        expect(h.findLeastUsedIntervalOverRange(10, 3)).toBe(9);
    });

    it("prefers the earlier day when probing a symmetric pair", () => {
        const h = new DueDateHistogram();
        h.set(10, 4);
        h.set(9, 1);
        h.set(11, 1);
        // 9 and 11 are both occupied and equal; 9 is probed first and kept
        expect(h.findLeastUsedIntervalOverRange(10, 1)).toBe(9);
    });

    it("picks the least-used day when every day in the window is occupied", () => {
        const h = new DueDateHistogram();
        h.set(9, 5);
        h.set(10, 4);
        h.set(11, 1);
        expect(h.findLeastUsedIntervalOverRange(10, 1)).toBe(11);
    });

    it("keeps the original day when nothing in the window is strictly better", () => {
        const h = new DueDateHistogram();
        for (let d = 8; d <= 12; d++) h.set(d, 3);
        // Every candidate ties the original at 3, and the scan only moves on a
        // strict improvement — so the requested day stands.
        expect(h.findLeastUsedIntervalOverRange(10, 1)).toBe(10);
    });

    it("never looks beyond the fuzz window", () => {
        const h = new DueDateHistogram();
        // Everything from 6 to 12 is occupied and equally loaded; 13 is the only
        // free day anywhere near, and it sits three days out.
        for (let d = 6; d <= 12; d++) h.set(d, 3);
        // Out of reach at ±1, so the requested day stands.
        expect(h.findLeastUsedIntervalOverRange(10, 1)).toBe(10);
        // In reach at ±3. Note the probe order: each i tries the earlier day
        // first, so a free day below the target would win — 7 is occupied here
        // precisely so 13 is unambiguously the answer.
        expect(h.findLeastUsedIntervalOverRange(10, 3)).toBe(13);
    });
});

// ---------------------------------------------------------------------------
// dates.ts — rewritten in P3.8: native Date, no moment, no obsidian import
// ---------------------------------------------------------------------------

describe("parsePreferredDate", () => {
    it("parses YYYY-MM-DD at local midnight", () => {
        const d = parsePreferredDate("2026-09-30");
        expect(d).not.toBeNull();
        expect(d!.getFullYear()).toBe(2026);
        expect(d!.getMonth()).toBe(8);
        expect(d!.getDate()).toBe(30);
        expect(d!.getHours()).toBe(0);
        expect(d!.getMinutes()).toBe(0);
    });

    it("is strict: rejects the other formats the legacy parser allows", () => {
        expect(parsePreferredDate("30-09-2026")).toBeNull();
        expect(parsePreferredDate("Wed Sep 06 2023")).toBeNull();
        expect(parsePreferredDate("2026-9-30")).toBeNull();
        expect(parsePreferredDate("")).toBeNull();
        expect(parsePreferredDate("nonsense")).toBeNull();
    });

    // The Date constructor rolls overflow forward (Feb 31 → Mar 3). A due date
    // that does not exist must read as unparseable, not as a different day.
    it("rejects impossible dates instead of rolling them forward", () => {
        expect(parsePreferredDate("2026-02-31")).toBeNull();
        expect(parsePreferredDate("2026-13-01")).toBeNull();
        expect(parsePreferredDate("2026-00-10")).toBeNull();
        expect(parsePreferredDate("2026-04-00")).toBeNull();
    });

    it("accepts a genuine leap day and rejects a false one", () => {
        expect(parsePreferredDate("2024-02-29")).not.toBeNull();
        expect(parsePreferredDate("2026-02-29")).toBeNull();
    });

    it("round-trips through formatDate", () => {
        const d = parsePreferredDate("2026-09-30")!;
        expect(formatDate(d.valueOf())).toBe("2026-09-30");
    });
});

describe("parseLegacyDate", () => {
    it("accepts every ALLOWED_DATE_FORMATS shape moment used to handle", () => {
        expect(formatDate(parseLegacyDate("2023-09-06")!.valueOf())).toBe("2023-09-06");
        expect(formatDate(parseLegacyDate("06-09-2023")!.valueOf())).toBe("2023-09-06");
        expect(formatDate(parseLegacyDate("Wed Sep 06 2023")!.valueOf())).toBe("2023-09-06");
    });

    it("normalises to local midnight whatever the input precision", () => {
        const d = parseLegacyDate("Wed Sep 06 2023 14:35:00")!;
        expect(d.getHours()).toBe(0);
        expect(formatDate(d.valueOf())).toBe("2023-09-06");
    });

    it("returns null for unparseable input", () => {
        expect(parseLegacyDate("not a date")).toBeNull();
        expect(parseLegacyDate("")).toBeNull();
    });
});

describe("startOfDay", () => {
    it("floors to local midnight without shifting the calendar day", () => {
        const d = startOfDay(new Date(2026, 8, 30, 23, 59, 59));
        expect(d.getFullYear()).toBe(2026);
        expect(d.getMonth()).toBe(8);
        expect(d.getDate()).toBe(30);
        expect(d.getHours()).toBe(0);
    });
});

describe("date providers", () => {
    it("StaticDateProvider.today is midnight, now is the exact instant", () => {
        const p = new StaticDateProvider(new Date(2026, 8, 30, 14, 30, 0));
        expect(p.now.getHours()).toBe(14);
        expect(p.today.getHours()).toBe(0);
        expect(formatDate(p.today.valueOf())).toBe("2026-09-30");
    });

    it("setupStaticDateProvider installs a provider parsed from a date string", () => {
        setupStaticDateProvider("2023-09-06");
        expect(formatDate(globalDateProvider.today.valueOf())).toBe("2023-09-06");
    });

    it("StaticDateProvider.now returns a fresh Date each read", () => {
        const p = new StaticDateProvider(new Date(2026, 8, 30, 14, 30, 0));
        const a = p.now;
        a.setFullYear(1999);
        expect(p.now.getFullYear()).toBe(2026);
    });

    // P6.2's job. Recorded here so the gap is a documented expectation rather
    // than a surprise: the provider stores the boundary and ignores it.
    it("StaticDateProvider still ignores the day boundary (Phase 6 implements it)", () => {
        const p = new StaticDateProvider(new Date(2026, 8, 30, 2, 0, 0));
        p.setDayBoundary({ hour: 4, minute: 0, second: 0 });
        expect(p.getDayBoundary()).toEqual({ hour: 4, minute: 0, second: 0 });
        expect(formatDate(p.today.valueOf())).toBe("2026-09-30");
    });

    it("LiveDateProvider.today is midnight of the current day by default", () => {
        const p = new LiveDateProvider();
        expect(p.today.getHours()).toBe(0);
        expect(formatDate(p.today.valueOf())).toBe(formatDate(Date.now()));
    });
});
