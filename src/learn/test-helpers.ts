// Shared factories for Learn-mode tests. Not a *.test.ts file so vitest
// doesn't try to run it as a suite.
import type { ParsedCard } from "src/parsing";
import type { ScheduleInfo } from "src/scheduling/fsrs";
import { State } from "src/scheduling/fsrs";
import { TICKS_PER_DAY } from "src/scheduling/constants";
import { parsePreferredDate, startOfDay } from "src/scheduling/dates";
import type { CardLocation } from "src/learn/pool";

let counter = 0;

// Every Learn fixture flows through this one function, which is why the FSRS
// plan (P3.1) has it rewritten before any fixture is touched.
//
// `stability` sits where SM-2's `interval` used to, because it is the quantity
// that replaced it: the maturity and anchor thresholds both read stability now
// (plan §B3), and a fixture that used to mean "a 30-day card" still means
// "a well-known card" when read as stability.
//
// Everything else is defaulted to a plausible reviewed card so a call site only
// states what it actually cares about:
//   - state    Review. Under B1's enable_short_term: false, Learning and
//              Relearning never occur, so Review is the only realistic value
//              for a face that has a schedule at all. A New face is `null` in
//              ParsedCard.schedules, not a ScheduleInfo with state New.
//   - difficulty 5, mid-scale on FSRS's 1..10. Callers testing the difficulty
//              ordering pass it explicitly — and note the sign: high difficulty
//              is a *shaky* card, the opposite of high ease (plan §C3).
//   - last_review due − stability days, floored to local midnight, mirroring
//              the converter's seeding rule (§B5). Floored because that is all
//              the comment format stores (dates, not instants), so an unfloored
//              fixture would be one the app could never actually read back.
export function sched(
    dueStr: string,
    stability: number,
    opts: {
        difficulty?: number;
        reps?: number;
        lapses?: number;
        lastReview?: Date | null;
        state?: State;
    } = {},
): ScheduleInfo {
    const due = parsePreferredDate(dueStr);
    if (due === null) throw new Error(`sched(): unparseable due date "${dueStr}"`);
    const lastReview =
        opts.lastReview !== undefined
            ? opts.lastReview
            : startOfDay(new Date(due.valueOf() - stability * TICKS_PER_DAY));
    return {
        due,
        stability,
        difficulty: opts.difficulty ?? 5,
        reps: opts.reps ?? 1,
        lapses: opts.lapses ?? 0,
        state: opts.state ?? State.Review,
        last_review: lastReview,
    };
}

export function makeCard(
    schedules: [ScheduleInfo | null, ScheduleInfo | null],
    opts: { word?: string; startLine?: number; endLine?: number; filePath?: string } = {},
): CardLocation {
    const idx = ++counter;
    return {
        card: {
            fields: {
                word: opts.word ?? `card${idx}`,
                explanation: null,
                examples: [],
                type: null,
                translation: `t${idx}`,
            },
            schedules,
            startLine: opts.startLine ?? 0,
            endLine: opts.endLine ?? 0,
            rawLines: [],
            originalComment: null,
        } satisfies ParsedCard,
        filePath: opts.filePath ?? "file.md",
    };
}
