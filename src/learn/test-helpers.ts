// Shared factories for Learn-mode tests. Not a *.test.ts file so vitest
// doesn't try to run it as a suite.
import type { ParsedCard } from "src/parsing";
import { RepItemScheduleInfoOsr } from "src/scheduling/osr";
import type { ScheduleInfo } from "src/persistence";
import type { CardLocation } from "src/learn/pool";

let counter = 0;

export function sched(dueStr: string, interval: number, ease = 250): ScheduleInfo {
    return RepItemScheduleInfoOsr.fromDueDateStr(dueStr, interval, ease, 0);
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
