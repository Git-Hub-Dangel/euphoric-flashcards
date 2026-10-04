import { ALLOWED_DATE_FORMATS, PREFERRED_DATE_FORMAT } from "src/scheduling/constants";

// `moment` has left the scheduling core (FSRS plan P3.8), and with it this
// module's `obsidian` import. FSRS speaks native `Date`; the only thing moment
// was still providing was multi-format legacy date parsing, which is now
// parseLegacyDate() below — the one place that tolerance still belongs, since
// Phase 5's converter needs it to read pre-FSRS comments.

export function formatDate(ticks: number, format: string = PREFERRED_DATE_FORMAT): string {
    const d = new Date(ticks);
    let result = format;
    result = result.replaceAll(/YYYY/g, d.getFullYear().toString().padStart(4, "0"));
    result = result.replaceAll(/MM/g, (d.getMonth() + 1).toString().padStart(2, "0"));
    result = result.replaceAll(/DD/g, d.getDate().toString().padStart(2, "0"));
    return result;
}

// Local midnight of the day `d` falls in. Local, not UTC: a due date written as
// "2026-09-30" means that calendar day where the user lives.
export function startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const PREFERRED_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_FIRST_DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;

// Build a local-midnight Date, rejecting the overflow that the Date constructor
// silently performs ("2026-02-31" must not become March 3rd).
function localDate(year: number, month1: number, day: number): Date | null {
    if (month1 < 1 || month1 > 12 || day < 1 || day > 31) return null;
    const d = new Date(year, month1 - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month1 - 1 || d.getDate() !== day) return null;
    return d;
}

// Strict PREFERRED_DATE_FORMAT ("YYYY-MM-DD") parse, at local midnight.
// This is the hot path: the SR comment format is FSRS-only and writes exactly
// this shape, so reads do not need — and must not silently accept — anything
// else (plan §B4: no legacy branch in the hot path).
export function parsePreferredDate(str: string): Date | null {
    const m = PREFERRED_DATE_RE.exec(str.trim());
    if (m === null) return null;
    return localDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

// Tolerant parse across ALLOWED_DATE_FORMATS, for reading *legacy* data only:
// pre-FSRS SR comments (Phase 5's converter) and hand-edited histogram keys in
// data.json. Accepts "YYYY-MM-DD", "DD-MM-YYYY" and the "ddd MMM DD YYYY" shape
// moment used to handle (e.g. "Wed Sep 06 2023"), always at local midnight.
export function parseLegacyDate(str: string): Date | null {
    const trimmed = str.trim();

    const preferred = parsePreferredDate(trimmed);
    if (preferred !== null) return preferred;

    const dayFirst = DAY_FIRST_DATE_RE.exec(trimmed);
    if (dayFirst !== null) {
        return localDate(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
    }

    // "ddd MMM DD YYYY" and friends: hand off to the engine, then normalise to
    // local midnight so every parse in this module returns the same shape.
    const native = new Date(trimmed);
    if (Number.isNaN(native.valueOf())) return null;
    return startOfDay(native);
}

export interface IDayBoundary {
    hour: number;
    minute: number;
    second: number;
}

export interface IDateProvider {
    get now(): Date;
    get today(): Date;
    getDayBoundary(): IDayBoundary | null;
    setDayBoundary(dayBoundary: IDayBoundary | null): void;
}

// The session day that `at` belongs to under `b` (FSRS plan P6.2). Before the
// boundary time the session is still the previous calendar day, which is the
// entire point of the setting. A review at 02:00 under a 04:00 boundary belongs
// to yesterday, so yesterday's cards stay due and today's stay hidden.
//
// A null boundary and a literal 00:00:00 both collapse to plain local midnight
// by construction, since no instant precedes its own day's start.
//
// The previous day is built by calendar arithmetic, never by subtracting a fixed
// 24 hours. A spring-forward day is 23 hours long, so a fixed subtraction lands
// on 23:00 of the day before and floors to the wrong calendar day.
export function dayFor(at: Date, b: IDayBoundary | null): Date {
    const dayStart = startOfDay(at);
    if (b === null) return dayStart;
    const boundary = new Date(
        at.getFullYear(), at.getMonth(), at.getDate(),
        b.hour, b.minute, b.second, 0,
    );
    if (at.valueOf() < boundary.valueOf()) {
        return new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1);
    }
    return dayStart;
}

export class LiveDateProvider implements IDateProvider {
    private dayBoundary: IDayBoundary | null = null;

    get now(): Date {
        return new Date();
    }

    get today(): Date {
        return dayFor(new Date(), this.dayBoundary);
    }

    getDayBoundary(): IDayBoundary | null {
        return this.dayBoundary;
    }

    setDayBoundary(dayBoundary: IDayBoundary | null): void {
        this.dayBoundary = dayBoundary;
    }
}

export class StaticDateProvider implements IDateProvider {
    private d: Date;
    private dayBoundary: IDayBoundary | null = null;

    constructor(d: Date) {
        this.d = d;
    }

    get now(): Date {
        return new Date(this.d.valueOf());
    }

    // Honours the boundary exactly as LiveDateProvider does (P6.2). It did not
    // before, which is what made the setting untestable and is why the feature
    // shipped inert for so long.
    get today(): Date {
        return dayFor(this.d, this.dayBoundary);
    }

    static fromDateStr(str: string): StaticDateProvider {
        const parsed = parseLegacyDate(str);
        if (parsed === null) throw new Error(`StaticDateProvider: unparseable date "${str}"`);
        return new StaticDateProvider(parsed);
    }

    getDayBoundary(): IDayBoundary | null {
        return this.dayBoundary;
    }

    setDayBoundary(dayBoundary: IDayBoundary | null): void {
        this.dayBoundary = dayBoundary;
    }
}

export class DateUtil {
    static strToDayBoundary(str: string): IDayBoundary | null {
        const parts = str.split(":");
        if (parts.length !== 3) return null;
        const hour = parseInt(parts[0] ?? "");
        const minute = parseInt(parts[1] ?? "");
        const second = parseInt(parts[2] ?? "");
        if (
            isNaN(hour) || hour < 0 || hour > 23 ||
            isNaN(minute) || minute < 0 || minute > 59 ||
            isNaN(second) || second < 0 || second > 59
        ) return null;
        return { hour, minute, second };
    }
}

// Referenced only so the tolerated legacy shapes stay documented next to the
// parser that implements them; ALLOWED_DATE_FORMATS is otherwise unused now
// that moment is gone.
export const LEGACY_DATE_FORMATS: readonly string[] = ALLOWED_DATE_FORMATS;

export let globalDateProvider: IDateProvider = new LiveDateProvider();

export function setupStaticDateProvider(dateStr: string): void {
    const boundary = globalDateProvider.getDayBoundary();
    globalDateProvider = StaticDateProvider.fromDateStr(dateStr);
    globalDateProvider.setDayBoundary(boundary);
}

// Push settings.startOfDay into the active provider (P6.1). This is the only
// writer of the day boundary in production, called once at load and again on
// every settings change so a slider-free text field takes effect immediately.
//
// An unparseable value clears the boundary instead of throwing, so a half-typed
// field or a hand-edited data.json degrades to literal midnight rather than
// breaking every due-date comparison in the plugin.
export function applyDayBoundary(startOfDayValue: string): void {
    globalDateProvider.setDayBoundary(DateUtil.strToDayBoundary(startOfDayValue));
}
