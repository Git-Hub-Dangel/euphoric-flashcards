import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, EuphoricSettings } from "src/settings";
import { DueDateHistogram } from "src/scheduling/due-date-histogram";
import { osrSchedule, textInterval, RepItemScheduleInfoOsr, SRAlgorithmOsr } from "src/scheduling/osr";
import { ReviewResponse } from "src/scheduling/review-response";
import { setupStaticDateProvider } from "src/scheduling/dates";

// Settings that exactly match the upstream plugin's DEFAULT_SETTINGS, used to
// pin numeric outputs against the upstream test suite as equivalence proof.
const UPSTREAM_DEFAULTS: EuphoricSettings = {
    ...DEFAULT_SETTINGS,
    defaultIntervalChange: 0.5, // upstream used this value for Hard (was lapsesIntervalChange)
    lapsesIntervalChange: 0.5,  // upstream default; fork default is 0.01
    maximumInterval: 36525,     // upstream default; fork default is 365
};

const emptyHistogram = new DueDateHistogram();

// ---------------------------------------------------------------------------
// Equivalence tests — every expected value matches the upstream scheduling.test.ts
// ---------------------------------------------------------------------------

describe("osrSchedule — upstream defaults, no delay", () => {
    it("Easy: ease +20, interval = ceil((interval * ease/100) * easyBonus)", () => {
        expect(
            osrSchedule(ReviewResponse.Easy, 1, UPSTREAM_DEFAULTS.baseEase, 0, UPSTREAM_DEFAULTS, emptyHistogram),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase + 20, interval: 4 });
    });

    it("Good: ease unchanged, interval = (interval * ease/100) rounded", () => {
        expect(
            osrSchedule(ReviewResponse.Good, 1, UPSTREAM_DEFAULTS.baseEase, 0, UPSTREAM_DEFAULTS, emptyHistogram),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase, interval: 3 });
    });

    it("Hard: ease -20, interval = max(1, interval * lapsesIntervalChange)", () => {
        expect(
            osrSchedule(ReviewResponse.Hard, 1, UPSTREAM_DEFAULTS.baseEase, 0, UPSTREAM_DEFAULTS, emptyHistogram),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase - 20, interval: 1 });
    });
});

describe("osrSchedule — upstream defaults, 2-day delay", () => {
    const delay = 2 * 24 * 3600 * 1000;

    it("Easy with delay", () => {
        expect(
            osrSchedule(ReviewResponse.Easy, 10, UPSTREAM_DEFAULTS.baseEase, delay, UPSTREAM_DEFAULTS, emptyHistogram),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase + 20, interval: 42 });
    });

    it("Good with delay", () => {
        expect(
            osrSchedule(ReviewResponse.Good, 10, UPSTREAM_DEFAULTS.baseEase, delay, UPSTREAM_DEFAULTS, emptyHistogram),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase, interval: 28 });
    });

    it("Hard with delay: (interval + delay/4) * lapsesIntervalChange", () => {
        expect(
            osrSchedule(ReviewResponse.Hard, 10, UPSTREAM_DEFAULTS.baseEase, delay, UPSTREAM_DEFAULTS, emptyHistogram),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase - 20, interval: 5 });
    });
});

describe("osrSchedule — Again response", () => {
    it("Again: interval → 0, ease -20", () => {
        const result = osrSchedule(ReviewResponse.Again, 10, UPSTREAM_DEFAULTS.baseEase, 0, UPSTREAM_DEFAULTS, emptyHistogram);
        expect(result.interval).toBe(0);
        expect(result.ease).toBe(UPSTREAM_DEFAULTS.baseEase - 20);
    });

    it("Again does not drop ease below 130", () => {
        const result = osrSchedule(ReviewResponse.Again, 5, 140, 0, UPSTREAM_DEFAULTS, emptyHistogram);
        expect(result.ease).toBe(130);
    });
});

describe("osrSchedule — load balancing (small interval, disabled)", () => {
    it("interval <= 7: no fuzzing applied, returns raw calculated interval", () => {
        const dueDates = new DueDateHistogram({ 0: 1, 1: 1, 2: 1, 3: 4 });
        expect(
            osrSchedule(ReviewResponse.Good, 1, UPSTREAM_DEFAULTS.baseEase, 0, UPSTREAM_DEFAULTS, dueDates),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase, interval: 3 });
    });
});

describe("osrSchedule — load balancing (interval > 7)", () => {
    it("7 < interval <= 21: fuzz = 1", () => {
        const dueDates = new DueDateHistogram({ 17: 4, 18: 5, 19: 3 });
        expect(
            osrSchedule(ReviewResponse.Good, 7, UPSTREAM_DEFAULTS.baseEase, 0, UPSTREAM_DEFAULTS, dueDates),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase, interval: 19 });
    });

    it("21 < interval <= 180: fuzz = floor(interval * 0.05) capped at 3", () => {
        const dueDates = new DueDateHistogram({ 23: 5, 26: 1 });
        expect(
            osrSchedule(ReviewResponse.Good, 10, UPSTREAM_DEFAULTS.baseEase, 0, UPSTREAM_DEFAULTS, dueDates),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase, interval: 25 });
    });

    it("picks least-used slot in window", () => {
        const dueDates = new DueDateHistogram({
            2: 5, 59: 8, 60: 9, 61: 3, 62: 5, 63: 4, 64: 4, 65: 8, 66: 2, 67: 10,
        });
        expect(
            osrSchedule(ReviewResponse.Good, 25, UPSTREAM_DEFAULTS.baseEase, 0, UPSTREAM_DEFAULTS, dueDates),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase, interval: 66 });
    });

    it("interval > 180: fuzz = floor(interval * 0.025) capped at 7", () => {
        const dueDates = new DueDateHistogram({
            1245: 7, 1246: 4, 1247: 2, 1248: 9, 1249: 5,
            1250: 4, 1251: 1, 1252: 1, 1254: 1,
        });
        expect(
            osrSchedule(ReviewResponse.Good, 500, UPSTREAM_DEFAULTS.baseEase, 0, UPSTREAM_DEFAULTS, dueDates),
        ).toEqual({ ease: UPSTREAM_DEFAULTS.baseEase, interval: 1253 });
    });
});

// ---------------------------------------------------------------------------
// textInterval — same thresholds as upstream (m = interval/3.04375, y = interval/36.525)
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
// SRAlgorithmOsr — card-level methods (use our defaults)
// ---------------------------------------------------------------------------

describe("SRAlgorithmOsr — card scheduling", () => {
    beforeEach(() => {
        setupStaticDateProvider("2023-09-06");
    });

    it("cardGetResetSchedule with null schedule: interval=1, ease=baseEase, due 1 day out", () => {
        const algo = new SRAlgorithmOsr(DEFAULT_SETTINGS);
        const result = algo.cardGetResetSchedule(null);
        expect(result.interval).toBe(1);
        expect(result.latestEase).toBe(DEFAULT_SETTINGS.baseEase);
        expect(result.dueDate.format("YYYY-MM-DD")).toBe("2023-09-07");
        expect(result.isDue()).toBe(false);
    });

    it("cardGetResetSchedule with existing schedule: applies lapsesIntervalChange", () => {
        const algo = new SRAlgorithmOsr({ ...DEFAULT_SETTINGS, lapsesIntervalChange: 0.5 });
        const old = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-01", 10, DEFAULT_SETTINGS.baseEase, 0);
        const result = algo.cardGetResetSchedule(old);
        expect(result.interval).toBe(5);
        expect(result.latestEase).toBe(DEFAULT_SETTINGS.baseEase);
    });

    it("cardGetNewSchedule Good → non-zero interval, ease = baseEase", () => {
        const algo = new SRAlgorithmOsr(DEFAULT_SETTINGS);
        const result = algo.cardGetNewSchedule(ReviewResponse.Good, emptyHistogram);
        expect(result.interval).toBeGreaterThanOrEqual(1);
        expect(result.latestEase).toBe(DEFAULT_SETTINGS.baseEase);
    });

    it("cardCalcUpdatedSchedule Good grows interval", () => {
        const algo = new SRAlgorithmOsr(UPSTREAM_DEFAULTS);
        const initial = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-06", 10, UPSTREAM_DEFAULTS.baseEase, 0);
        const updated = algo.cardCalcUpdatedSchedule(ReviewResponse.Good, initial, emptyHistogram);
        expect(updated.interval).toBeGreaterThan(10);
    });

    it("cardCalcUpdatedSchedule Again zeroes interval", () => {
        const algo = new SRAlgorithmOsr(DEFAULT_SETTINGS);
        const initial = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-06", 10, DEFAULT_SETTINGS.baseEase, 0);
        const updated = algo.cardCalcUpdatedSchedule(ReviewResponse.Again, initial, emptyHistogram);
        expect(updated.interval).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// RepItemScheduleInfoOsr — serialisation
// ---------------------------------------------------------------------------

describe("RepItemScheduleInfoOsr — formatScheduleAsSRHtmlComment", () => {
    beforeEach(() => {
        setupStaticDateProvider("2023-09-06");
    });

    it("formats as !YYYY-MM-DD,interval,ease", () => {
        const info = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-06", 4, 270, 0);
        expect(info.formatScheduleAsSRHtmlComment()).toBe("!2023-09-06,4,270");
    });

    it("new card uses dummyDueDateForNewCard", () => {
        const info = RepItemScheduleInfoOsr.getNewSchedule(DEFAULT_SETTINGS);
        expect(info.formatScheduleAsSRHtmlComment()).toContain(RepItemScheduleInfoOsr.dummyDueDateForNewCard);
    });
});
